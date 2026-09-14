// frontend/app/view/code/codehistory.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: the Code surface's back/forward stack over opened files. An array and an index —
// deliberately not open-file tabs (see the design spec, decision 5).

export interface HistoryEntry {
    path: string;
    // the line a jump targeted, overwritten with the caret's line when the entry is left; null opens
    // the file wherever its editor was last parked
    line: number | null;
}

export interface History {
    stack: HistoryEntry[];
    idx: number; // -1 when the stack is empty
}

export const EMPTY_HISTORY: History = { stack: [], idx: -1 };

// Pushing while parked mid-stack drops everything ahead, the way a browser does. A jump to another
// line of the open file is a move, so "back" can return from a search hit in the same file.
export function push(h: History, path: string, line: number | null = null): History {
    const cur = currentEntry(h);
    if (cur != null && cur.path === path && (line == null || line === cur.line)) {
        return h; // re-opening what is already shown is not a move
    }
    const stack = [...h.stack.slice(0, h.idx + 1), { path, line }];
    return { stack, idx: stack.length - 1 };
}

// called just before leaving the current entry, so walking back lands where the caret was
export function withLine(h: History, line: number | null): History {
    const cur = currentEntry(h);
    if (cur == null || line == null || cur.line === line) {
        return h;
    }
    const stack = [...h.stack];
    stack[h.idx] = { ...cur, line };
    return { stack, idx: h.idx };
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

export function currentEntry(h: History): HistoryEntry | null {
    return h.idx >= 0 ? h.stack[h.idx] : null;
}

// The finder's empty state. Walking the stack from its end is an approximation once you have walked
// back, but it needs no second record of visits. The open file is left out, so Ctrl+P then Enter
// returns to the previous one.
export function recentPaths(h: History): string[] {
    const open = currentEntry(h)?.path;
    const seen = new Set<string>();
    for (let i = h.stack.length - 1; i >= 0; i--) {
        const path = h.stack[i].path;
        if (path !== open) {
            seen.add(path);
        }
    }
    return [...seen];
}
