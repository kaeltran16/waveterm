// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Waiting on you's in-place actions. The RPCs, the toast and the row opener arrive as deps, so the tests
// drive fakes.

import { queueAction, type QueueRow } from "./briefingmodel";
import type { UndoOps } from "./briefmutations";
import type { BriefLine, LineTarget } from "./briefrows";

export type QueueActionDeps = {
    rpc: {
        dagAction: (data: CommandDagActionData) => Promise<void>;
        ackRun: (data: CommandAckRunData) => Promise<void>;
    };
    undo: Pick<UndoOps, "notify" | "error">;
    openLine: (target: LineTarget) => void;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Retry acts on the exact task the server named, and anything else opens the row's run
export async function actOnQueue(deps: QueueActionDeps, q: QueueRow, line: BriefLine): Promise<void> {
    const act = queueAction(q);
    const run = async (label: string, fn: () => Promise<void>) => {
        try {
            await fn();
            deps.undo.notify(label);
        } catch (e) {
            deps.undo.error(message(e));
        }
    };
    switch (act.kind) {
        case "retry-dag":
            return run(`Retrying ${q.taskId}`, () =>
                deps.rpc.dagAction({ channelid: q.channelId, runid: q.runId!, taskid: q.taskId, action: "retry" })
            );
        case "ack-run":
            return run(`Acknowledged · ${q.source || q.title}`, () =>
                deps.rpc.ackRun({ channelid: q.channelId, runid: q.runId! })
            );
        default:
            if (line.target != null) {
                deps.openLine(line.target);
            }
    }
}

// every run is acked on its own, so one refused ack leaves the rest acked and names how many failed
export async function ackAll(
    deps: Pick<QueueActionDeps, "rpc" | "undo">,
    ackable: { channelId: string; runId: string }[]
): Promise<void> {
    const results = await Promise.allSettled(
        ackable.map((r) => deps.rpc.ackRun({ channelid: r.channelId, runid: r.runId }))
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
        deps.undo.error(`${failed} of ${results.length} acknowledgements failed`);
    } else {
        deps.undo.notify(`Acknowledged ${results.length} unverified runs`);
    }
}
