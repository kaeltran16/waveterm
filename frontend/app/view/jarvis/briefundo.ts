// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Undo for the Brief's plan edits. removeChunk and EffortDelete drop the note trail with the object, so
// an inverse op sent after the fact cannot bring the notes back. A destructive edit therefore does not
// happen until its toast has had its window: the item is hidden at once, the RPC goes out when the
// window closes, and Undo simply cancels. Reversible edits (status, archive, move) commit at once and
// their Undo sends the inverse op instead — see notify().

import { globalStore } from "@/app/store/jotaiStore";
import { atom, type PrimitiveAtom } from "jotai";

export const UNDO_WINDOW_MS = 5000;

export type BriefToast = { id: number; text: string; undo?: () => void; error?: boolean };

type Pending = { keys: string[]; commit: () => Promise<void>; timer: ReturnType<typeof setTimeout> };

export function createUndoQueue(io: {
    setHidden: (keys: Set<string>) => void;
    setToast: (t: BriefToast | null) => void;
    windowMs?: number;
}) {
    const windowMs = io.windowMs ?? UNDO_WINDOW_MS;
    const pending = new Map<number, Pending>();
    let nextId = 1;
    let toastId = 0;
    let toastTimer: ReturnType<typeof setTimeout> | undefined;

    const publish = () => io.setHidden(new Set([...pending.values()].flatMap((p) => p.keys)));
    const clearToast = () => {
        clearTimeout(toastTimer);
        io.setToast(null);
    };
    const show = (t: Omit<BriefToast, "id">) => {
        clearTimeout(toastTimer);
        const id = ++toastId;
        io.setToast({ ...t, id });
        // only clear the toast this call put up; a newer one keeps its own lifetime
        toastTimer = setTimeout(() => {
            if (toastId === id) {
                io.setToast(null);
            }
        }, windowMs);
    };
    const error = (text: string) => show({ text, error: true });

    const run = async (id: number): Promise<void> => {
        const p = pending.get(id);
        if (p == null) {
            return;
        }
        clearTimeout(p.timer);
        pending.delete(id);
        try {
            await p.commit();
        } catch (e) {
            error(e instanceof Error ? e.message : String(e));
        } finally {
            publish();
        }
    };

    return {
        schedule(keys: string[], text: string, commit: () => Promise<void>): void {
            const id = nextId++;
            const timer = setTimeout(() => void run(id), windowMs);
            pending.set(id, { keys, commit, timer });
            publish();
            show({
                text,
                undo: () => {
                    const p = pending.get(id);
                    if (p != null) {
                        clearTimeout(p.timer);
                        pending.delete(id);
                        publish();
                    }
                    clearToast();
                },
            });
        },
        notify(text: string, undo?: () => void): void {
            show({
                text,
                undo:
                    undo == null
                        ? undefined
                        : () => {
                              clearToast();
                              undo();
                          },
            });
        },
        error,
        async flushAll(): Promise<void> {
            await Promise.all([...pending.keys()].map(run));
        },
    };
}

export const pendingDeleteKeysAtom = atom<Set<string>>(new Set<string>()) as PrimitiveAtom<Set<string>>;
export const briefToastAtom = atom<BriefToast | null>(null) as PrimitiveAtom<BriefToast | null>;

export const briefUndo = createUndoQueue({
    setHidden: (keys) => globalStore.set(pendingDeleteKeysAtom, keys),
    setToast: (t) => globalStore.set(briefToastAtom, t),
});

export const effortKey = (oref: string) => `effort:${oref}`;
export const chunkKey = (oref: string, label: string) => `chunk:${oref}:${label}`;
export const noteKey = (oref: string, label: string, ts: number) => `note:${oref}:${label}:${ts}`;
