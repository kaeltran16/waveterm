// frontend/app/view/code/codehistory.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: the Code surface's back/forward stack over opened file paths. An array and an index —
// deliberately not open-file tabs (see the design spec, decision 5).

export interface History {
    stack: string[];
    idx: number; // -1 when the stack is empty
}

export const EMPTY_HISTORY: History = { stack: [], idx: -1 };

// pushing while parked mid-stack drops everything ahead, the way a browser does
export function push(h: History, path: string): History {
    if (h.idx >= 0 && h.stack[h.idx] === path) {
        return h; // re-opening what is already shown is not a move
    }
    const stack = [...h.stack.slice(0, h.idx + 1), path];
    return { stack, idx: stack.length - 1 };
}

export function back(h: History): History {
    return canBack(h) ? { stack: h.stack, idx: h.idx - 1 } : h;
}

export function forward(h: History): History {
    return canForward(h) ? { stack: h.stack, idx: h.idx + 1 } : h;
}

export function canBack(h: History): boolean {
    return h.idx > 0;
}

export function canForward(h: History): boolean {
    return h.idx >= 0 && h.idx < h.stack.length - 1;
}

export function currentPath(h: History): string | null {
    return h.idx >= 0 ? h.stack[h.idx] : null;
}
