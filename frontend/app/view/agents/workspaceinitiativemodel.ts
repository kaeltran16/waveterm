// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: the workspace pane's Initiative tab chunk list. Chunk state comes from effortChunkRows; nothing here derives
// it again.

import type { ChunkTone } from "@/app/view/jarvis/effortmodel";
import { effortChunkRows } from "@/app/view/jarvis/effortstore";
import { noteStamp } from "@/app/view/jarvis/initiativework";

// an open chunk shows this many of its newest notes; the rest stay in Hub
export const NOTES_SHOWN = 3;

export type InitiativeNote = { at: string; text: string };

export type InitiativeChunkRow = {
    // 1-based, the plan's order
    n: number;
    label: string;
    status: string;
    tone: ChunkTone;
    // newest first
    notes: InitiativeNote[];
    older: number;
    // a chunk with no notes has nothing to open
    openable: boolean;
};

export function initiativeChunkRows(effort: Effort): InitiativeChunkRow[] {
    return effortChunkRows(effort).map((r, i) => {
        const newest = [...r.trail].reverse();
        return {
            n: i + 1,
            label: r.label,
            status: r.status,
            tone: r.tone,
            notes: newest.slice(0, NOTES_SHOWN).map((n) => ({ at: noteStamp(n.ts), text: n.text })),
            older: Math.max(0, newest.length - NOTES_SHOWN),
            openable: newest.length > 0,
        };
    });
}

// the chunk whose notes show: the tab's choice, or the first active chunk while the tab has made none (undefined)
export function openChunk(rows: InitiativeChunkRow[], open: number | null | undefined): number | null {
    const n = open === undefined ? rows.find((r) => r.tone === "active")?.n : open;
    return rows.find((r) => r.n === n)?.openable ? n : null;
}
