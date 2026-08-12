// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Memory-surface state + loaders. Module-level jotai atoms written by async loaders via globalStore,
// mirroring filesstore.ts. Read path: loadMemory() scans the vault. Detail: selectNote() reads body.
// Single-item removals (delete/dismiss/prune) update the atoms locally — a full MemoryScanCommand
// on every one was the surface's latency (the backend walks + parses the whole vault). Mutations
// that change a note's shape (create/save/keep/restore) still rescan so the graph/list stay
// consistent (no live fsnotify watch in this phase).

import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, type PrimitiveAtom } from "jotai";
import type { MemEdge, MemNote } from "./memtypes";

export type MemView = "graph" | "list";

// vault scan/read are local FS ops (fast); bound them so a dead/stalled backend rejects into the
// catch below instead of leaving the pane on "Loading…" forever (the wshrpc call has no default timeout).
const MEM_RPC_TIMEOUT_MS = 5000;

export const memNotesAtom = atom<MemNote[]>([]) as PrimitiveAtom<MemNote[]>;
export const memEdgesAtom = atom<MemEdge[]>([]) as PrimitiveAtom<MemEdge[]>;
export const memLoadedAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;
// true = the last memory scan failed (so an empty list reads as an error, not "no memory yet").
export const memErrorAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;
export const memViewAtom = atom<MemView>("list") as PrimitiveAtom<MemView>;
export const memSelectedIdAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

// Non-null when a pending candidate is the current detail selection. Pending takes precedence over
// memSelectedIdAtom; selecting a saved note (selectNote) clears this, and vice versa.
export const memSelectedPendingPathAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

// Where a deep link into Memory should land. Consumed once on mount by the section that owns it, the same
// shape as pendingRunFocusAtom: the cleanup queue is collapsed by default and its open flag is component
// state, so an escort that only switched surface would land on a section the user still has to find.
export const pendingMemoryFocusAtom = atom<"upkeep" | null>(null) as PrimitiveAtom<"upkeep" | null>;

// Read-and-clear, so two mounts cannot both honour one escort.
export function takePendingMemoryFocus(): "upkeep" | null {
    const want = globalStore.get(pendingMemoryFocusAtom);
    if (want != null) {
        globalStore.set(pendingMemoryFocusAtom, null);
    }
    return want;
}

// Next selection after `removedPath` leaves the pending queue: the note that shifts into its index,
// else the previous, else the first saved note. Pure so it unit-tests without RPC.
export function advanceSelection(
    pendingPaths: string[],
    removedPath: string,
    firstSavedId: string | null
): { pendingPath: string | null; savedId: string | null } {
    const idx = pendingPaths.indexOf(removedPath);
    const remaining = pendingPaths.filter((p) => p !== removedPath);
    const next = remaining[idx] ?? remaining[idx - 1] ?? remaining[0];
    if (next) return { pendingPath: next, savedId: null };
    return { pendingPath: null, savedId: firstSavedId };
}

// Next saved-note selection after `removedId` leaves the list: the note that shifts into its index,
// else the previous, else the first. Pure so it unit-tests without RPC. Mirrors advanceSelection
// (which drives the pending queue) so both paths pick the same "who fills the gap" rule.
export function advanceSavedSelection(ids: string[], removedId: string): string | null {
    const idx = ids.indexOf(removedId);
    if (idx < 0) return null; // removed id not in the list — nothing shifts
    const remaining = ids.filter((id) => id !== removedId);
    const next = remaining[idx] ?? remaining[idx - 1] ?? remaining[0];
    return next ?? null;
}

// Drop a note (and every edge touching it) from the in-memory scan result after a confirmed delete,
// so the list can update without a full vault rescan. Pure so it unit-tests without RPC.
export function removeNoteFromGraph(
    notes: MemNote[],
    edges: MemEdge[],
    removedIds: ReadonlySet<string>
): { notes: MemNote[]; edges: MemEdge[] } {
    return {
        notes: notes.filter((n) => !removedIds.has(n.id)),
        edges: edges.filter((e) => !removedIds.has(e.from) && !removedIds.has(e.to)),
    };
}
export const memBodyAtom = atom<{ body: string; mtime: number } | null>(null) as PrimitiveAtom<{
    body: string;
    mtime: number;
} | null>;
export const memSearchAtom = atom<string>("") as PrimitiveAtom<string>;

// true = the next re-scan is mutation-driven and its list diff should animate (create/delete/harvest);
// false = a search keystroke changed only the rendered subset, so the reflow stays instant. Written by
// the mutation helpers below + the search box; read by MemorySurface into reflowProps.
export const memReflowAnimatedAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;

// Drawer open/closed (shared CollapsibleRail). Module-scope so it persists across MemorySurface
// remounts; default open because the detail view is the point of the tab.
export const memRailOpenAtom = atom<boolean>(true) as PrimitiveAtom<boolean>;

// Edit draft lifted out of the rail component: CollapsibleRail unmounts its content when collapsed,
// so an in-progress draft would be lost on collapse if held in local useState.
export const memEditingAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;
export const memDraftAtom = atom<string>("") as PrimitiveAtom<string>;
export const memConflictAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;

export async function loadMemory(): Promise<void> {
    try {
        const g = await RpcApi.MemoryScanCommand(TabRpcClient, { timeout: MEM_RPC_TIMEOUT_MS });
        globalStore.set(memNotesAtom, g.notes ?? []);
        globalStore.set(memEdgesAtom, g.edges ?? []);
        globalStore.set(memErrorAtom, false);
        globalStore.set(memLoadedAtom, true);
        const sel = globalStore.get(memSelectedIdAtom);
        const notes = g.notes ?? [];
        if ((!sel || !notes.some((n) => n.id === sel)) && notes.length) {
            void selectNote(notes[0].id);
        }
    } catch {
        // surface the scan failure distinctly instead of an empty list; keep any last-good notes.
        globalStore.set(memErrorAtom, true);
        globalStore.set(memLoadedAtom, true);
    }
}

function noteById(id: string): MemNote | undefined {
    return globalStore.get(memNotesAtom).find((n) => n.id === id);
}

export async function selectNote(id: string): Promise<void> {
    globalStore.set(memSelectedPendingPathAtom, null); // selecting a saved note leaves pending mode
    globalStore.set(memSelectedIdAtom, id);
    globalStore.set(memBodyAtom, null);
    globalStore.set(memRailOpenAtom, true); // selecting a note opens a collapsed drawer
    globalStore.set(memEditingAtom, false); // leaving a note drops its edit mode/conflict
    globalStore.set(memConflictAtom, false);
    const n = noteById(id);
    if (!n) return;
    try {
        const r = await RpcApi.MemoryReadCommand(
            TabRpcClient,
            { path: n.path, source: n.source },
            { timeout: MEM_RPC_TIMEOUT_MS }
        );
        if (globalStore.get(memSelectedIdAtom) !== id) return; // selection moved on
        globalStore.set(memBodyAtom, { body: r.body, mtime: r.note.updatedts });
    } catch {
        if (globalStore.get(memSelectedIdAtom) === id) {
            globalStore.set(memBodyAtom, { body: "", mtime: 0 });
        }
    }
}

// Returns { conflict } so the caller can warn instead of clobbering.
export async function saveNote(path: string, content: string, baseMtime: number): Promise<{ conflict: boolean }> {
    const r = await RpcApi.MemoryWriteCommand(TabRpcClient, { path, content, basemtime: baseMtime });
    if (!r.conflict) {
        await loadMemory();
    }
    return { conflict: r.conflict };
}

export async function createNote(name: string, type: string, scope: string, body: string, cwd?: string): Promise<void> {
    globalStore.set(memReflowAnimatedAtom, true); // the create's new row should animate in
    await RpcApi.MemoryCreateCommand(TabRpcClient, { name, type, scope, body, cwd });
    await loadMemory();
}

// Harvest Codex's reusable-knowledge facts for a project into its Claude hub. Reloads the graph only
// when new facts landed (the mtime-guarded no-op case returns 0/0 and must not trigger a rescan).
export async function harvestMemory(cwd: string): Promise<{ ingested: number; skipped: number }> {
    const r = await RpcApi.MemoryHarvestCommand(TabRpcClient, { cwd });
    const ingested = r.ingested ?? 0;
    const skipped = r.skipped ?? 0;
    if (ingested > 0) {
        globalStore.set(memReflowAnimatedAtom, true); // harvested rows should animate in
        await loadMemory();
    }
    return { ingested, skipped };
}

export async function deleteNote(path: string): Promise<void> {
    globalStore.set(memReflowAnimatedAtom, true); // the removed row should play its exit
    await RpcApi.MemoryDeleteCommand(TabRpcClient, { path });
    // no rescan: a delete only removes a known note, so filter it (and its edges) out of the
    // in-memory scan result directly. a full MemoryScanCommand here walks + parses the whole vault.
    const notes = globalStore.get(memNotesAtom);
    const removed = notes.find((n) => n.path === path);
    if (!removed) return; // not in the loaded list; nothing local to update
    const { notes: nextNotes, edges: nextEdges } = removeNoteFromGraph(notes, globalStore.get(memEdgesAtom), new Set([removed.id]));
    globalStore.set(memNotesAtom, nextNotes);
    globalStore.set(memEdgesAtom, nextEdges);
    const sel = globalStore.get(memSelectedIdAtom);
    if (sel !== removed.id) return; // selection untouched, body still valid
    const nextId = advanceSavedSelection(notes.map((n) => n.id), removed.id);
    globalStore.set(memSelectedIdAtom, nextId);
    if (nextId) {
        void selectNote(nextId); // load the shifted-in note's body
    } else {
        globalStore.set(memBodyAtom, null);
    }
}

// Confirm before deleting a note — shared by the memory list context menu and the
// detail-pane Delete button, matching the confirmCloseSession pattern.
export function confirmDeleteNote(path: string, title: string): void {
    modalsModel.pushModal("ConfirmModal", {
        title: "Delete note",
        message: `Delete "${title}"? This removes the file and can't be undone.`,
        confirmLabel: "Delete",
        destructive: true,
        onConfirm: () => fireAndForget(() => deleteNote(path)),
    });
}

// Review tray: agent-distilled candidates not auto-committed, awaiting a human accept/reject.
// MemoryPendingNote is an ambient generated wire type (frontend/types/gotypes.d.ts).
export const memPendingAtom = atom<MemoryPendingNote[]>([]) as PrimitiveAtom<MemoryPendingNote[]>;

export async function loadReview(): Promise<void> {
    try {
        const r = await RpcApi.MemoryReviewListCommand(TabRpcClient, { timeout: MEM_RPC_TIMEOUT_MS });
        globalStore.set(memPendingAtom, r.pending ?? []);
    } catch {
        globalStore.set(memPendingAtom, []);
    }
}

export function selectPending(path: string): void {
    globalStore.set(memSelectedPendingPathAtom, path);
    globalStore.set(memSelectedIdAtom, null);
    globalStore.set(memBodyAtom, null);
    globalStore.set(memRailOpenAtom, true); // open the detail rail on selection
}

function applyPendingSelection(pendingPath: string | null, savedId: string | null): void {
    globalStore.set(memSelectedPendingPathAtom, pendingPath);
    if (pendingPath) {
        globalStore.set(memSelectedIdAtom, null);
        globalStore.set(memBodyAtom, null);
    } else if (savedId) {
        void selectNote(savedId);
    }
}

// Compute the next selection from the CURRENT atoms before the async mutation lands.
function nextAfterPending(path: string): { pendingPath: string | null; savedId: string | null } {
    const paths = globalStore.get(memPendingAtom).map((p) => p.path);
    const firstSaved = globalStore.get(memNotesAtom)[0]?.id ?? null;
    return advanceSelection(paths, path, firstSaved);
}

export async function keepPending(path: string): Promise<void> {
    const next = nextAfterPending(path);
    await RpcApi.MemoryReviewAcceptCommand(TabRpcClient, { path });
    globalStore.set(memReflowAnimatedAtom, true);
    await Promise.all([loadReview(), loadMemory()]);
    applyPendingSelection(next.pendingPath, next.savedId);
}

export async function dismissPending(path: string): Promise<void> {
    const next = nextAfterPending(path);
    await RpcApi.MemoryDeleteCommand(TabRpcClient, { path });
    globalStore.set(memReflowAnimatedAtom, true);
    // no rescan: a dismiss only removes a known pending candidate, so drop it locally instead of
    // re-reading the pending dir (and re-scanning the vault) just to see the same list minus one.
    globalStore.set(memPendingAtom, (prev) => prev.filter((p) => p.path !== path));
    applyPendingSelection(next.pendingPath, next.savedId);
}

export async function keepAllPending(): Promise<void> {
    const pend = globalStore.get(memPendingAtom);
    for (const p of pend) {
        await RpcApi.MemoryReviewAcceptCommand(TabRpcClient, { path: p.path });
    }
    globalStore.set(memReflowAnimatedAtom, true);
    globalStore.set(memSelectedPendingPathAtom, null);
    await Promise.all([loadReview(), loadMemory()]);
}

export async function dismissAllPending(): Promise<void> {
    const pend = globalStore.get(memPendingAtom);
    for (const p of pend) {
        await RpcApi.MemoryDeleteCommand(TabRpcClient, { path: p.path });
    }
    globalStore.set(memReflowAnimatedAtom, true);
    globalStore.set(memSelectedPendingPathAtom, null);
    globalStore.set(memPendingAtom, []);
}

// Cleanup queue: hub notes the distiller flagged as superseded (strong) or stale (weak).
// MemoryPruneCandidate is an ambient generated wire type (frontend/types/gotypes.d.ts).
export const memPruneAtom = atom<MemoryPruneCandidate[]>([]) as PrimitiveAtom<MemoryPruneCandidate[]>;
// true once a read has actually landed. Same reason as memErrorAtom above: loadPrune empties the queue on
// failure, so without this an empty list reads as "the vault is clean" when it may only mean "never read".
// The Memory surface can live with that conflation because the user is looking at it and can retry; the pet
// cannot — it reports vault drift while you are somewhere else, so it must not claim clean on a failed read.
export const memPruneLoadedAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;

// Returns whether the read landed, so a caller that must not proceed on a guess (the pet's boot read) can
// retry rather than accept the empty list.
export async function loadPrune(): Promise<boolean> {
    try {
        const r = await RpcApi.MemoryPruneListCommand(TabRpcClient, { timeout: MEM_RPC_TIMEOUT_MS });
        globalStore.set(memPruneAtom, r.candidates ?? []);
        globalStore.set(memPruneLoadedAtom, true);
        return true;
    } catch {
        globalStore.set(memPruneAtom, []);
        return false;
    }
}

// Confirmed removal (human action). deleteNote now updates the list locally (no rescan), so the
// prune queue only needs the candidate filtered out as well.
export async function prune(path: string): Promise<void> {
    await deleteNote(path);
    globalStore.set(memPruneAtom, (prev) => prev.filter((c) => c.path !== path));
}

// Shared bulk removal: deletes every given path, then rewrites the notes graph and prune queue
// once (a rescan would re-walk the whole vault). Mirrors dismissAllPending.
async function prunePaths(paths: string[]): Promise<void> {
    for (const p of paths) {
        await RpcApi.MemoryDeleteCommand(TabRpcClient, { path: p });
    }
    globalStore.set(memReflowAnimatedAtom, true);
    const notes = globalStore.get(memNotesAtom);
    const removedIds = new Set(notes.filter((n) => paths.includes(n.path)).map((n) => n.id));
    const { notes: nextNotes, edges: nextEdges } = removeNoteFromGraph(notes, globalStore.get(memEdgesAtom), removedIds);
    globalStore.set(memNotesAtom, nextNotes);
    globalStore.set(memEdgesAtom, nextEdges);
    const sel = globalStore.get(memSelectedIdAtom);
    if (sel && removedIds.has(sel)) {
        const nextId = nextNotes[0]?.id ?? null;
        globalStore.set(memSelectedIdAtom, nextId);
        if (nextId) {
            void selectNote(nextId);
        } else {
            globalStore.set(memBodyAtom, null);
        }
    }
    const removedPaths = new Set(paths);
    globalStore.set(memPruneAtom, (prev) => prev.filter((c) => !removedPaths.has(c.path)));
}

// Bulk removal of every superseded candidate.
export async function pruneAllSuperseded(): Promise<void> {
    const paths = globalStore
        .get(memPruneAtom)
        .filter((c) => c.reason === "superseded")
        .map((c) => c.path);
    await prunePaths(paths);
}

// Bulk removal of every candidate in the queue, whatever its reason.
export async function pruneAll(): Promise<void> {
    await prunePaths(globalStore.get(memPruneAtom).map((c) => c.path));
}

// Bulk clears are many irreversible deletes at once, so they confirm first (single-row Remove stays
// one-click). Mirrors confirmDeleteNote.
function confirmPruneAll(count: number, reason: string | null, action: () => Promise<void>): void {
    const label = reason ? `${count} ${reason} note${count === 1 ? "" : "s"}` : `${count} note${count === 1 ? "" : "s"} from the cleanup queue`;
    modalsModel.pushModal("ConfirmModal", {
        title: reason ? "Clear superseded notes" : "Clean up all notes",
        message: `Remove ${label}? This deletes the files and can't be undone.`,
        confirmLabel: "Remove all",
        destructive: true,
        onConfirm: () => fireAndForget(action),
    });
}

export function confirmPruneAllSuperseded(count: number): void {
    confirmPruneAll(count, "superseded", () => pruneAllSuperseded());
}

export function confirmPruneAllNotes(count: number): void {
    confirmPruneAll(count, null, () => pruneAll());
}

// Archived view: notes the gardener auto-archived (recoverable). MemoryArchivedNote is an ambient
// generated wire type (frontend/types/gotypes.d.ts).
export const memArchivedAtom = atom<MemoryArchivedNote[]>([]) as PrimitiveAtom<MemoryArchivedNote[]>;

// Newest archivedat first. Pure so it unit-tests without RPC.
export function sortArchived(items: MemoryArchivedNote[]): MemoryArchivedNote[] {
    return [...items].sort((a, b) => (a.archivedat < b.archivedat ? 1 : a.archivedat > b.archivedat ? -1 : 0));
}

export async function loadArchived(): Promise<void> {
    try {
        const r = await RpcApi.MemoryArchiveListCommand(TabRpcClient, { timeout: MEM_RPC_TIMEOUT_MS });
        globalStore.set(memArchivedAtom, sortArchived(r.archived ?? []));
    } catch {
        globalStore.set(memArchivedAtom, []);
    }
}

// Restore moves an archived note back to its hub; rescan so it reappears in the list/graph.
export async function restoreArchived(path: string): Promise<void> {
    await RpcApi.MemoryRestoreCommand(TabRpcClient, { path });
    globalStore.set(memReflowAnimatedAtom, true);
    await Promise.all([loadArchived(), loadMemory()]);
}
