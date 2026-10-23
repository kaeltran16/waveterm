// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Brief's initiative mutation layer: the writes behind the plan footer, the row's context menu, the
// chunk sidebar's ↑/↓ and a run row's ↳ chunk line. The store, the undo queue and the UI setters arrive as
// deps, so the tests drive fakes and briefsurface.tsx is left with the wiring.

import type { createUndoQueue } from "./briefundo";
import { chunkKey, effortKey } from "./briefundo";
import { groupChunksByStage, stageOptions } from "./effortmodel";
import type * as effortstore from "./effortstore";
import type { ChunkRowModel } from "./effortstore";
import { chunkRowId, stageRowId } from "./inlinetracker";
import type { TrackerEdits } from "./inlinetrackerview";
import {
    appendInStageAt,
    canRemove,
    chunkRef,
    moveTarget,
    stageMoveTarget,
    stageRunLabels,
    stepChunk,
} from "./trackeredit";

export type EffortOps = { togglePause: () => void; archive: () => void; unarchive: () => void; remove: () => void };

export type EffortWrites = Pick<
    typeof effortstore,
    | "setEffortStatus"
    | "unarchiveEffort"
    | "deleteEffort"
    | "setChunkStatus"
    | "renameChunk"
    | "moveChunk"
    | "moveChunkToStage"
    | "removeChunks"
    | "setChunkStage"
    | "addChunkAt"
>;
export type UndoOps = Pick<ReturnType<typeof createUndoQueue>, "notify" | "schedule" | "error">;
export type RunMutation = (fn: () => Promise<void>) => void;

export type MutationDeps = {
    store: EffortWrites;
    undo: UndoOps;
    run: RunMutation;
    setError: (msg: string | null) => void;
    // collapses the Initiatives row with this line id if it is the open one
    closeInitiative: (lineId: string) => void;
};

export const initiativeLineId = (oref: string) => "initiatives:" + oref;

// Every write goes through here so a failure is SHOWN rather than swallowed: the mutate helpers write
// through and refresh the briefing's summary leg, and a rejected op would otherwise leave the row looking
// unchanged with no explanation.
export function mutationRunner(setError: (msg: string | null) => void): RunMutation {
    return (fn) => {
        setError(null);
        fn().catch((e) => setError(e instanceof Error ? e.message : String(e)));
    };
}

// the plan footer and the row's context menu act through these, so the two cannot drift apart
export function effortOps(deps: MutationDeps, oref: string, title: string, status: string): EffortOps {
    const { store, undo, run } = deps;
    return {
        togglePause: () => {
            const next = status === "paused" ? "active" : "paused";
            run(() => store.setEffortStatus(oref, next));
            undo.notify(next === "paused" ? "Paused" : "Resumed", () => run(() => store.setEffortStatus(oref, status)));
        },
        archive: () => {
            run(() => store.setEffortStatus(oref, "archived"));
            undo.notify(`Archived “${title}”`, () => run(() => store.unarchiveEffort(oref)));
        },
        unarchive: () => run(() => store.unarchiveEffort(oref)),
        remove: () => {
            deps.closeInitiative(initiativeLineId(oref));
            undo.schedule([effortKey(oref)], `Deleted “${title}”`, () => store.deleteEffort(oref));
        },
    };
}

// The open initiative's TrackerEdits. Index math runs on the server's list, pending deletes included: the
// server still has them.
export function trackerEdits(
    deps: MutationDeps,
    input: {
        oref: string;
        effort: { title: string; status: string };
        chunks: ChunkRowModel[];
        pendingDeletes: Set<string>;
        ui: Pick<TrackerEdits, "onRename" | "onDetails" | "onActivity">;
    }
): TrackerEdits {
    const { store, undo, run } = deps;
    const { oref, chunks, pendingDeletes } = input;
    const indexOf = (label: string) => chunks.findIndex((c) => c.label === label);
    const ref = (label: string) => chunkRef(chunks, label);
    const scheduleRemove = (labels: string[], text: string) => {
        const pending = chunks.filter((c) => pendingDeletes.has(chunkKey(oref, c.label))).map((c) => c.label);
        if (!canRemove(chunks, [...pending, ...labels])) {
            deps.setError("An initiative keeps at least one chunk.");
            return;
        }
        undo.schedule(
            labels.map((l) => chunkKey(oref, l)),
            text,
            () => store.removeChunks(oref, chunks, labels)
        );
    };
    const status = input.effort.status;
    const ops = effortOps(deps, oref, input.effort.title, status);
    return {
        oid: oref.replace(/^effort:/, ""),
        title: input.effort.title,
        effortStatus: status,
        total: chunks.length,
        stages: stageOptions(chunks),
        onSetStatus: (label, next) => {
            const prev = chunks.find((c) => c.label === label)?.status ?? "pending";
            run(() => store.setChunkStatus(oref, ref(label), next));
            undo.notify(`Marked “${label}” ${next}`, () => run(() => store.setChunkStatus(oref, ref(label), prev)));
        },
        onRenameChunk: (label, next) => run(() => store.renameChunk(oref, chunks, label, next)),
        canMove: (label, dir) => moveTarget(chunks, label, dir) != null,
        onMoveChunk: (label, dir) => {
            const at = moveTarget(chunks, label, dir);
            if (at == null) {
                return;
            }
            const back = indexOf(label) + 1;
            run(() => store.moveChunk(oref, chunks, label, at));
            undo.notify(`Moved “${label}” ${dir}`, () => run(() => store.moveChunk(oref, chunks, label, back)));
        },
        onMoveToStage: (label, stage) => {
            const at = stageMoveTarget(chunks, label, stage);
            const prev = chunks.find((c) => c.label === label);
            if (at == null || prev == null) {
                return;
            }
            const back = indexOf(label) + 1;
            run(() => store.moveChunkToStage(oref, chunks, label, stage, at));
            undo.notify(`Moved to ${stage || "unstaged"}`, () =>
                run(() => store.moveChunkToStage(oref, chunks, label, prev.stage, back))
            );
        },
        onDeleteChunk: (label) => scheduleRemove([label], `Deleted “${label}”`),
        onRenameStage: (at, next) => run(() => store.setChunkStage(oref, stageRunLabels(chunks, at).map(ref), next)),
        onDeleteStage: (at) => {
            const labels = stageRunLabels(chunks, at);
            const name = chunks.find((c) => c.label === labels[0])?.stage || "unstaged";
            scheduleRemove(labels, `Deleted stage “${name}” · ${labels.length} chunk${labels.length === 1 ? "" : "s"}`);
        },
        onAddChunk: (label, stage, runAt) =>
            run(() => store.addChunkAt(oref, label, stage, runAt != null ? appendInStageAt(chunks, runAt) : undefined)),
        onRename: input.ui.onRename,
        onDetails: input.ui.onDetails,
        onActivity: input.ui.onActivity,
        onTogglePause: ops.togglePause,
        onArchive: ops.archive,
        onUnarchive: ops.unarchive,
        onDelete: ops.remove,
    };
}

// Where the chunk sidebar's ↑/↓ lands: the neighbouring chunk the reader can see, and the stage row to
// unfold so it is not hidden. null at either end of the plan.
export function stepTarget(input: {
    chunks: ChunkRowModel[];
    pendingDeletes: Set<string>;
    oref: string;
    lineId: string;
    label: string;
    dir: "prev" | "next";
}): { stageId: string; cursorId: string } | null {
    const visible = input.chunks.filter((c) => !input.pendingDeletes.has(chunkKey(input.oref, c.label)));
    const to = stepChunk(visible, input.label, input.dir);
    if (to == null) {
        return null;
    }
    const stage = visible.find((c) => c.label === to.label)?.stage ?? "";
    // stageRowId's run index is counted on this same filtered list, which is what trackerRows groups
    return { stageId: stageRowId(input.lineId, stage, to.runAt), cursorId: chunkRowId(input.lineId, to.label) };
}

export type RevealDeps = {
    closeSheet: () => void;
    openInitiative: (lineId: string) => void;
    setCursor: (id: string) => void;
    // the plan, loaded first: a never-opened initiative has not fetched it yet
    loadPlan: (oref: string) => Promise<ChunkRowModel[]>;
    openStage: (stageId: string) => void;
};

// a run row's ↳ opens its initiative inline on that chunk, with the chunk's stage unfolded
export async function openChunkInPlan(deps: RevealDeps, effortOref: string, chunk: string): Promise<void> {
    const lineId = initiativeLineId(effortOref);
    deps.closeSheet();
    deps.openInitiative(lineId);
    deps.setCursor(chunkRowId(lineId, chunk));
    // the stage override needs the plan, which a never-opened initiative has not loaded yet
    const chunks = await deps.loadPlan(effortOref);
    const at = groupChunksByStage(chunks).findIndex((g) => g.rows.some((r) => r.label === chunk));
    const stage = chunks.find((c) => c.label === chunk)?.stage ?? "";
    if (at >= 0) {
        deps.openStage(stageRowId(lineId, stage, at));
    }
}
