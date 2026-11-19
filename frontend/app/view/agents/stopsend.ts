// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Stop and send now, for pi: pi's Esc aborts the turn and moves its queued steers back into its editor, unsent, so
// once the abort settles Enter submits them, keeping the queued foot's "Esc to stop and send now" true. Claude sends
// its own queue on Esc. The one Stop for an agent: the Rendered box (button and Esc), the header's Interrupt turn and
// the palette's agent:interrupt all call stopAgent.

import { pushToast } from "@/app/cockpit/notificationstore";
import { globalStore } from "@/app/store/jotaiStore";
import { driveAgent } from "./agentactions";
import { sentPromptsAtom } from "./agentsend";
import type { AgentVM } from "./agentsviewmodel";
import { entriesAtomFor } from "./livetranscriptatoms";
import { PI_HARNESS } from "./picommands";
import { piFootList } from "./queuedprompts";
import { getAgentStatusAtom, getPromptBoundaryAtom } from "./session-models/agentstatusstore";

// how long a stop waits for pi's idle report before leaving the steers in its editor
export const PI_STOP_SETTLE_MS = 10_000;

const ESC = "\x1b";
const ENTER = "\r";

export type StopSendIO = {
    // types into the agent's terminal
    type: (data: string) => void;
    // calls back on each idle state report of the agent's block; returns the unsubscribe
    onIdle: (cb: () => void) => () => void;
    // no idle report came in time
    warn: () => void;
};

// whether a Stop sends the agent's queue at once, rather than the bare Esc
export function sendsQueuedOnStop(harness: string | undefined, queued: number): boolean {
    return harness === PI_HARNESS && queued > 0;
}

// Types Esc, then Enter once on the next idle report; with none within PI_STOP_SETTLE_MS types nothing more and warns.
// Returns a cancel that drops the wait.
export function stopAndSend(io: StopSendIO): () => void {
    let open = true;
    // a no-op until subscribed, should the idle callback run inside onIdle
    let unsubscribe = () => {};
    // true for the first caller only: the idle report, the timeout or the cancel
    const close = (): boolean => {
        if (!open) {
            return false;
        }
        open = false;
        unsubscribe();
        clearTimeout(timer);
        return true;
    };
    io.type(ESC);
    const timer = setTimeout(() => {
        if (close()) {
            io.warn();
        }
    }, PI_STOP_SETTLE_MS);
    unsubscribe = io.onIdle(() => {
        if (close()) {
            io.type(ENTER);
        }
    });
    return () => {
        close();
    };
}

// pi's queued foot as the Rendered view draws it, read from the same atoms, so a Stop from outside the view sees it too
function piQueued(agent: Pick<AgentVM, "id" | "state">, blockId: string): number {
    const sent = globalStore.get(sentPromptsAtom(blockId));
    const entries = globalStore.get(entriesAtomFor(agent.id));
    const since = globalStore.get(getPromptBoundaryAtom(`block:${blockId}`));
    return piFootList(sent, entries, agent.state === "working", since).length;
}

// per block, the cancel of a stop still waiting to send pi's queue, so a second Stop cannot press Enter twice. Kept
// at module level, as the view that started a stop may unmount before pi settles
const pendingStops = new Map<string, () => void>();

// Stop: the bare Esc, or for pi with a queued foot, Esc and then Enter once pi's abort settles, which submits the
// steers pi moved back into its editor
export function stopAgent(agent: Pick<AgentVM, "id" | "state" | "agent" | "blockId">): void {
    const blockId = agent.blockId;
    if (!blockId) {
        return;
    }
    pendingStops.get(blockId)?.();
    pendingStops.delete(blockId);
    const queued = agent.agent === PI_HARNESS ? piQueued(agent, blockId) : 0;
    if (!sendsQueuedOnStop(agent.agent, queued)) {
        driveAgent(blockId, ESC);
        return;
    }
    const statusAtom = getAgentStatusAtom(`block:${blockId}`);
    const cancel = stopAndSend({
        type: (data) => driveAgent(blockId, data),
        onIdle: (cb) =>
            globalStore.sub(statusAtom, () => {
                if (globalStore.get(statusAtom)?.state === "idle") {
                    cb();
                }
            }),
        warn: () =>
            pushToast({
                title: "Queued messages not sent",
                message: "Pi did not settle after the stop, so the queued messages stayed in its editor.",
                level: "warn",
            }),
    });
    pendingStops.set(blockId, cancel);
}
