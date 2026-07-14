// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Memory-surface state + loaders. Module-level jotai atoms written by async loaders via globalStore,
// mirroring filesstore.ts. Read path: loadMemory() scans the vault. Detail: selectNote() reads body.
// Mutations rescan so the graph/list stay consistent (no live fsnotify watch in this phase).

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
export const memViewAtom = atom<MemView>("list") as PrimitiveAtom<MemView>;
export const memSelectedIdAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

// Non-null when a pending candidate is the current detail selection. Pending takes precedence over
// memSelectedIdAtom; selecting a saved note (selectNote) clears this, and vice versa.
export const memSelectedPendingPathAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

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
        globalStore.set(memLoadedAtom, true);
        const sel = globalStore.get(memSelectedIdAtom);
        const notes = g.notes ?? [];
        if ((!sel || !notes.some((n) => n.id === sel)) && notes.length) {
            void selectNote(notes[0].id);
        }
    } catch {
        globalStore.set(memNotesAtom, []);
        globalStore.set(memEdgesAtom, []);
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
        const r = await RpcApi.MemoryReadCommand(TabRpcClient, { path: n.path, source: n.source }, { timeout: MEM_RPC_TIMEOUT_MS });
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
    globalStore.set(memSelectedIdAtom, null);
    globalStore.set(memBodyAtom, null);
    await loadMemory();
}

// Confirm before deleting a note — shared by the memory list context menu and the
// detail-pane Delete button, matching the confirmCloseAgent pattern.
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
    await Promise.all([loadReview(), loadMemory()]);
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
    await Promise.all([loadReview(), loadMemory()]);
}

// Cleanup queue: hub notes the distiller flagged as superseded (strong) or stale (weak).
// MemoryPruneCandidate is an ambient generated wire type (frontend/types/gotypes.d.ts).
export const memPruneAtom = atom<MemoryPruneCandidate[]>([]) as PrimitiveAtom<MemoryPruneCandidate[]>;

export async function loadPrune(): Promise<void> {
    try {
        const r = await RpcApi.MemoryPruneListCommand(TabRpcClient, { timeout: MEM_RPC_TIMEOUT_MS });
        globalStore.set(memPruneAtom, r.candidates ?? []);
    } catch {
        globalStore.set(memPruneAtom, []);
    }
}

// Confirmed removal (human action). Reuses deleteNote (rescans the graph) then refreshes the queue.
export async function prune(path: string): Promise<void> {
    await deleteNote(path);
    await loadPrune();
}
