// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Undo for the Brief's plan edits. removeChunk and EffortDelete drop the note trail with the object, so
// an inverse op sent after the fact cannot bring the notes back. A destructive edit therefore does not
// happen until its toast has had its window: the item is hidden at once, the RPC goes out when the
// window closes, and Undo simply cancels. Reversible edits (status, archive, move) commit at once and
// their Undo sends the inverse op instead — see notify().

import { ERROR_TOAST_TTL_MS } from "@/app/cockpit/toaststack";
import { globalStore } from "@/app/store/jotaiStore";
import { atom, type PrimitiveAtom } from "jotai";
import { chunkKey } from "./briefingmodel";

export { chunkKey };

export const UNDO_WINDOW_MS = 5000;

// There is one toast, so a newer one replaces the toast a pending delete put up. Every toast shown while a delete
// is pending therefore carries pendingUndo, which cancels all of them; without it the replaced delete's Undo
// was gone while the delete still waited to commit. `undo` is the toast's own (a reversible edit's inverse).
export type BriefToast = {
    id: number;
    text: string;
    undo?: () => void;
    error?: boolean;
    pendingUndo?: { count: number; undo: () => void };
};

type Pending = { keys: string[]; commit: () => Promise<void>; timer: ReturnType<typeof setTimeout> };

export function createUndoQueue(io: {
    setHidden: (keys: Set<string>) => void;
    setToast: (t: BriefToast | null) => void;
    windowMs?: number;
}) {
    const windowMs = io.windowMs ?? UNDO_WINDOW_MS;
    const pending = new Map<number, Pending>();
    let committing = 0;
    let nextId = 1;
    let toastId = 0;
    let toast: Omit<BriefToast, "pendingUndo"> | null = null;
    let expired = false;
    let toastTimer: ReturnType<typeof setTimeout> | undefined;

    const publish = () => io.setHidden(new Set([...pending.values()].flatMap((p) => p.keys)));
    const cancel = (id: number) => {
        clearTimeout(pending.get(id)?.timer);
        pending.delete(id);
    };
    const clearToast = () => {
        clearTimeout(toastTimer);
        toast = null;
        io.setToast(null);
    };
    const undoPending = () => {
        [...pending.keys()].forEach(cancel);
        publish();
        clearToast();
    };
    // a toast past its own lifetime stays while a delete is still pending or committing, so the last word on
    // a delete is never taken down before the delete has landed
    const render = () => {
        if (toast == null) {
            return;
        }
        if (expired && pending.size === 0 && committing === 0) {
            clearToast();
            return;
        }
        io.setToast(pending.size === 0 ? toast : { ...toast, pendingUndo: { count: pending.size, undo: undoPending } });
    };
    const show = (t: Omit<BriefToast, "id" | "pendingUndo">, ttlMs = windowMs) => {
        clearTimeout(toastTimer);
        toast = { ...t, id: ++toastId };
        expired = false;
        toastTimer = setTimeout(() => {
            expired = true;
            render();
        }, ttlMs);
        render();
    };
    const error = (text: string) => show({ text, error: true }, ERROR_TOAST_TTL_MS);

    const run = async (id: number): Promise<void> => {
        const p = pending.get(id);
        if (p == null) {
            return;
        }
        cancel(id);
        committing++;
        render();
        try {
            await p.commit();
        } catch (e) {
            error(e instanceof Error ? e.message : String(e));
        } finally {
            committing--;
            publish();
            render();
        }
    };

    return {
        schedule(keys: string[], text: string, commit: () => Promise<void>): void {
            const id = nextId++;
            const timer = setTimeout(() => void run(id), windowMs);
            pending.set(id, { keys, commit, timer });
            publish();
            show({ text });
        },
        notify(text: string, undo?: () => void): void {
            show({
                text,
                undo:
                    undo == null
                        ? undefined
                        : () => {
                              // a pending delete's Undo stays up until that delete lands. before the inverse, so
                              // a toast the inverse puts up keeps its own lifetime
                              if (toast != null) {
                                  toast = { ...toast, undo: undefined };
                                  expired = true;
                              }
                              render();
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

// Waiting chunks Unblock or Done has acted on, each with when: the Brief hides them until a snapshot that
// started after the act has read the write (withoutSettledChunks).
export const settledChunksAtom = atom<Map<string, number>>(new Map<string, number>()) as PrimitiveAtom<
    Map<string, number>
>;

export function settleChunk(key: string, on: boolean): void {
    globalStore.set(settledChunksAtom, (prev) => {
        const next = new Map(prev);
        if (on) {
            next.set(key, Date.now());
        } else {
            next.delete(key);
        }
        return next;
    });
}

export const briefUndo = createUndoQueue({
    setHidden: (keys) => globalStore.set(pendingDeleteKeysAtom, keys),
    setToast: (t) => globalStore.set(briefToastAtom, t),
});

export const effortKey = (oref: string) => `effort:${oref}`;
export const noteKey = (oref: string, label: string, ts: number) => `note:${oref}:${label}:${ts}`;
