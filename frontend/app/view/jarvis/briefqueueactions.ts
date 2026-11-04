// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Waiting on you's in-place actions. The RPCs, the toast and the row opener arrive as deps, so the tests
// drive fakes.

import { queueAction, type QueueAct, type QueueRow } from "./briefingmodel";
import type { UndoOps } from "./briefmutations";
import type { BriefLine, LineTarget } from "./briefrows";

export type QueueActionDeps = {
    rpc: {
        dagAction: (data: CommandDagActionData) => Promise<void>;
        ackRun: (data: CommandAckRunData) => Promise<void>;
        setChunkStatus: (oref: string, chunk: string, status: string, note?: string) => Promise<void>;
    };
    undo: Pick<UndoOps, "notify" | "error">;
    openLine: (target: LineTarget) => void;
    // lands the initiative's plan on the chunk with its notes open
    openChunk: (effortOref: string, label: string) => void;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// what a row's click opens: a blocked chunk lands on itself in its initiative's plan, anything else on
// the row's target
export function openQueueRow(deps: Pick<QueueActionDeps, "openLine" | "openChunk">, q: QueueRow, line: BriefLine) {
    if (q.chunk != null) {
        deps.openChunk(q.chunk.effortOref, q.chunk.label);
    } else if (line.target != null) {
        deps.openLine(line.target);
    }
}

// Retry acts on the exact task the server named, Unblock and Done on the row's chunk, and anything else
// opens the row
export async function actOnQueue(
    deps: QueueActionDeps,
    q: QueueRow,
    line: BriefLine,
    act: QueueAct = queueAction(q)
): Promise<void> {
    const run = async (label: string, fn: () => Promise<void>, undo?: () => void) => {
        try {
            await fn();
            if (undo != null) {
                deps.undo.notify(label, undo);
            } else {
                deps.undo.notify(label);
            }
        } catch (e) {
            deps.undo.error(message(e));
        }
    };
    const chunk = q.chunk;
    // re-blocking writes the needs note back, so the row returns saying what it waits on (its age restarts)
    const reblock = () => {
        if (chunk != null) {
            deps.rpc
                .setChunkStatus(chunk.effortOref, chunk.label, "blocked", chunk.needs || undefined)
                .catch((e) => deps.undo.error(message(e)));
        }
    };
    switch (act.kind) {
        case "unblock-chunk":
        case "done-chunk": {
            if (chunk == null) {
                return;
            }
            const done = act.kind === "done-chunk";
            return run(
                `${done ? "Done" : "Unblocked"} · ${chunk.label}`,
                () => deps.rpc.setChunkStatus(chunk.effortOref, chunk.label, done ? "done" : "pending"),
                reblock
            );
        }
        case "retry-dag":
            return run(`Retrying ${q.taskId}`, () =>
                deps.rpc.dagAction({ channelid: q.channelId, runid: q.runId!, taskid: q.taskId, action: "retry" })
            );
        case "ack-run":
            return run(`Acknowledged · ${q.source || q.title}`, () =>
                deps.rpc.ackRun({ channelid: q.channelId, runid: q.runId! })
            );
        default:
            openQueueRow(deps, q, line);
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
