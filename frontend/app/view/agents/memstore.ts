// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Memory-surface state + loaders. Module-level jotai atoms written by async loaders via globalStore,
// mirroring filesstore.ts. Read path: loadMemory() scans the vault. Detail: selectNote() reads body.
// Mutations rescan so the graph/list stay consistent (no live fsnotify watch in this phase).

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import type { MemEdge, MemNote } from "./memtypes";

export type MemView = "graph" | "list";

export const memNotesAtom = atom<MemNote[]>([]) as PrimitiveAtom<MemNote[]>;
export const memEdgesAtom = atom<MemEdge[]>([]) as PrimitiveAtom<MemEdge[]>;
export const memLoadedAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;
export const memViewAtom = atom<MemView>("list") as PrimitiveAtom<MemView>;
export const memSelectedIdAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const memBodyAtom = atom<{ body: string; mtime: number } | null>(null) as PrimitiveAtom<{
    body: string;
    mtime: number;
} | null>;
export const memSearchAtom = atom<string>("") as PrimitiveAtom<string>;

export async function loadMemory(): Promise<void> {
    try {
        const g = await RpcApi.MemoryScanCommand(TabRpcClient);
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
    globalStore.set(memSelectedIdAtom, id);
    globalStore.set(memBodyAtom, null);
    const n = noteById(id);
    if (!n) return;
    try {
        const r = await RpcApi.MemoryReadCommand(TabRpcClient, { path: n.path, source: n.source });
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
        await loadMemory();
    }
    return { ingested, skipped };
}

export async function deleteNote(path: string): Promise<void> {
    await RpcApi.MemoryDeleteCommand(TabRpcClient, { path });
    globalStore.set(memSelectedIdAtom, null);
    globalStore.set(memBodyAtom, null);
    await loadMemory();
}
