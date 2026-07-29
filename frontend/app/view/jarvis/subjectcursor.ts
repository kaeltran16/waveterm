// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Subjects column commits its cursor on idle rather than on every keypress. Moving the cursor is just a
// highlight; committing it runs selectSubject, which fires a selectChannel RPC, resolves a record scope and
// prunes an unasked thread on the way past. Holding j through thirty subjects cost thirty round trips.
//
// Deliberately NOT a change to listnav.ts's "cursor == selection" contract: five surfaces share it, and the
// same keys meaning different things per surface is a worse cost than the one this removes.

export const CURSOR_COMMIT_MS = 150;

export interface CommitScheduler {
    schedule: (id: string) => void;
    flush: () => void;
    cancel: () => void;
}

export function createCommitScheduler(commit: (id: string) => void, delayMs = CURSOR_COMMIT_MS): CommitScheduler {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: string | null = null;

    const clearTimer = () => {
        if (timer != null) {
            clearTimeout(timer);
            timer = null;
        }
    };
    const take = (): string | null => {
        const next = pending;
        pending = null;
        return next;
    };

    return {
        schedule: (id) => {
            pending = id;
            clearTimer();
            timer = setTimeout(() => {
                timer = null;
                const next = take();
                if (next != null) {
                    commit(next);
                }
            }, delayMs);
        },
        // an explicit selection — Enter, a click — must not wait out the idle window
        flush: () => {
            clearTimer();
            const next = take();
            if (next != null) {
                commit(next);
            }
        },
        cancel: () => {
            clearTimer();
            pending = null;
        },
    };
}
