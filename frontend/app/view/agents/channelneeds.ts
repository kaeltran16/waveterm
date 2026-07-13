// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: assemble the channel's unified "Needs you" list — review gates + Jarvis escalations + live-
// worker asks, in that order. Leaf predicates (reviewGate, escalationPending, pendingAsks) live in
// shared modules; only this composition is channels-local.

import { type AgentVM } from "./agentsviewmodel";
import { workerFor } from "./channelsprimitives";
import { type WorkerState } from "./jarvisderive";
import { escalationPending, parseCardData, pendingAsks } from "./jarviscards";
import { reviewGate } from "./runmodel";

export type NeedsItem = { key: string; kind: string; source: string; text: string; action: string; runId?: string };

export function buildNeeds(params: {
    runs: Run[];
    messages: ChannelMessage[];
    agents: AgentVM[];
    snapshot: WorkerState[];
}): NeedsItem[] {
    const { runs, messages, agents, snapshot } = params;

    // owning run of a worker tab oref (for click-to-navigate)
    const runIdOfWorker = (oref: string): string | undefined =>
        runs.find((r) => (r.phases ?? []).some((p) => (p.workerorefs ?? []).includes(oref)))?.id;

    const gateItems: NeedsItem[] = runs
        .filter((r) => reviewGate(r))
        .map((r) => ({ key: `gate:${r.id}`, kind: "review gate", source: r.goal, text: "Approve before Jarvis proceeds.", action: "Review", runId: r.id }));

    const escItems: NeedsItem[] = messages
        .filter((m) => m.kind === "jarvis-escalation")
        .map((m): NeedsItem | null => {
            const card = parseCardData(m);
            if (!card) {
                return null;
            }
            const worker = workerFor(agents, card.workerORef);
            if (!escalationPending(card, worker)) {
                return null;
            }
            return { key: m.id, kind: "escalation", source: worker?.name ?? "worker", text: card.question, action: "Decide", runId: runIdOfWorker(card.workerORef) };
        })
        .filter((x): x is NeedsItem => x != null);

    const asks = pendingAsks(snapshot, messages);
    const askItems: NeedsItem[] = asks.map((w) => ({
        key: w.oref,
        kind: "worker ask",
        source: w.name,
        text: w.askText ?? "Waiting on your reply",
        action: "Answer",
        runId: runIdOfWorker(w.oref),
    }));

    return [...gateItems, ...escItems, ...askItems];
}
