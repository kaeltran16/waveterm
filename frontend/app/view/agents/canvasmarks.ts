// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: the marks a user draws on a board, and what they become when sent to the agent.

import { handoffLine } from "@/app/view/code/codehandoff";

export const MARK_MIN_PX = 10;

export type Mark = { x: number; y: number; w: number; h: number; note: string };
export type Box = { x0: number; y0: number; x1: number; y1: number };
export type DOMRectLike = { left: number; top: number; width: number; height: number };

// numbered captures only; three digits at least, so a name past 999 still counts toward the next one
const FEEDBACK_NAME = /^(\d{3,})\.png$/;
const FEEDBACK_PAD = 3;

export function boxToMark(b: Box): Mark | null {
    const w = Math.abs(b.x1 - b.x0);
    const h = Math.abs(b.y1 - b.y0);
    if (w <= MARK_MIN_PX || h <= MARK_MIN_PX) {
        return null;
    }
    return { x: Math.min(b.x0, b.x1), y: Math.min(b.y0, b.y1), w, h, note: "" };
}

export function addMark(marks: Mark[], b: Box): Mark[] {
    const m = boxToMark(b);
    return m == null ? marks : [...marks, m];
}

export function removeMark(marks: Mark[], i: number): Mark[] {
    return marks.filter((_, j) => j !== i);
}

export function setMarkNote(marks: Mark[], i: number, note: string): Mark[] {
    return marks.map((m, j) => (j === i ? { ...m, note } : m));
}

export function nextFeedbackName(entryNames: string[]): string {
    let max = 0;
    for (const name of entryNames) {
        const m = FEEDBACK_NAME.exec(name);
        if (m != null) {
            max = Math.max(max, Number(m[1]));
        }
    }
    return `${String(max + 1).padStart(FEEDBACK_PAD, "0")}.png`;
}

export function feedbackRelPath(topic: string, name: string): string {
    return `.superpowers/design/${topic}/feedback/${name}`;
}

export function canvasHandoffLine(relPath: string, board: string, marks: Mark[]): string {
    const parts = marks.map((m, i) => `${i + 1} ${m.note.replace(/\s+/g, " ").trim() || "(no note)"}`);
    return handoffLine({ rel: relPath, note: `marks on ${board}: ${parts.join("; ")}` });
}

// the window capture is in device pixels; the board rect is in CSS pixels
export function cropRect(
    board: DOMRectLike,
    innerWidth: number,
    bitmap: { width: number; height: number }
): { sx: number; sy: number; sw: number; sh: number } {
    const scale = innerWidth > 0 ? bitmap.width / innerWidth : 1;
    const clamp = (v: number, max: number) => Math.min(max, Math.max(0, Math.round(v)));
    const sx = clamp(board.left * scale, bitmap.width);
    const sy = clamp(board.top * scale, bitmap.height);
    return {
        sx,
        sy,
        sw: clamp(board.width * scale, bitmap.width - sx),
        sh: clamp(board.height * scale, bitmap.height - sy),
    };
}
