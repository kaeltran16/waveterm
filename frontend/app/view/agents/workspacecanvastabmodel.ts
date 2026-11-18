// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The workspace pane's Canvas tab, its pure half: every board stacked in one column at the pane's width, and how
// [ and ] move the selection among them.

import { fitScale, shownBoard, stepTab, type BoardFrame, type CanvasBoard } from "./canvasmodel";
import type { CanvasState } from "./canvasstore";

// the label row above each frame, and the space between one item and the next
export const LIST_LABEL_H = 22;
const LIST_GAP = 18;

// scale is per frame: each board fits the width on its own. labelTop is the item's top, its label row's
export type ListFrame = BoardFrame & { scale: number; labelTop: number };
export type ListLayout = { width: number; height: number; frames: ListFrame[] };

// screen px; a board narrower than the pane keeps its size
export function canvasListLayout(boards: CanvasBoard[], paneWidth: number): ListLayout {
    const frames: ListFrame[] = [];
    let y = 0;
    for (const board of boards) {
        const scale = fitScale(paneWidth, board.w);
        const frame = {
            board,
            scale,
            labelTop: y,
            left: 0,
            top: y + LIST_LABEL_H,
            width: board.w * scale,
            height: board.h * scale,
        };
        frames.push(frame);
        y = frame.top + frame.height + LIST_GAP;
    }
    return {
        width: Math.max(0, ...frames.map((f) => f.width)),
        height: frames.length > 0 ? y - LIST_GAP : 0,
        frames,
    };
}

// the list has no All: [ and ] walk the boards from the one it shows selected
export function stepListBoard(s: CanvasState, delta: number): string | null {
    return stepTab(
        s.boards.map((b) => b.name),
        shownBoard(s).name,
        delta
    );
}
