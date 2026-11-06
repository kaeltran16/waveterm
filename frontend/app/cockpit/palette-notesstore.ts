// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The only place the frontend calls the note RPCs. The list is read each time the palette opens, and again
// after every write, failed or not: an agent may have added, renamed or deleted a note meanwhile.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import type { NoteDraft } from "./palette-notes";

// null until the first load
export const paletteNotesAtom = atom<UserNote[] | null>(null) as PrimitiveAtom<UserNote[] | null>;

export async function loadPaletteNotes(): Promise<void> {
    const notes = await RpcApi.NoteListCommand(TabRpcClient);
    globalStore.set(paletteNotesAtom, notes ?? []);
}

// The outcome is the write's alone. A failed reload never rejects: after a write that landed, the caller
// would take it for a failed save and a retry would add the note twice. The list is read again on the next open.
async function reloadAfter<T>(write: () => Promise<T>): Promise<T> {
    try {
        return await write();
    } finally {
        await loadPaletteNotes().catch((err) => console.warn("palette: reloading notes failed", err));
    }
}

// Resolves the draft as saved, with the note's id and its new rev. overwrite: save over a note changed since
// it was opened, sending no base rev.
export function saveNoteDraft(d: NoteDraft, overwrite = false): Promise<NoteDraft> {
    const saved = { title: d.title, body: d.body };
    return reloadAfter(async () => {
        if (d.id == null) {
            const note = await RpcApi.NoteAddCommand(TabRpcClient, { title: d.title, body: d.body });
            return { ...d, id: note.id, rev: note.rev, saved };
        }
        const { rev } = await RpcApi.NoteUpdateCommand(TabRpcClient, {
            id: d.id,
            title: d.title,
            body: d.body,
            baserev: overwrite ? undefined : d.rev,
        });
        // the new rev reaches the list now, not by the reload alone: a failed reload must not leave a reopened
        // note on the rev this save replaced, which the next save would take for a conflict
        const id = d.id;
        globalStore.set(paletteNotesAtom, (notes) =>
            notes?.map((n) => (n.id === id ? { ...n, title: d.title.trim(), body: d.body.trim(), rev } : n))
        );
        return { ...d, rev, saved };
    });
}

export function deletePaletteNote(id: string): Promise<void> {
    return reloadAfter(() => RpcApi.NoteDeleteCommand(TabRpcClient, { id }));
}
