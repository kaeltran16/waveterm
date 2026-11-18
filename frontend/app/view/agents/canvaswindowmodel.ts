// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The canvas window's pure half: what Esc does, and how its All tab lays the boards out.

import { fitScale, type CanvasBoard, type CanvasLayout } from "./canvasmodel";
import type { CanvasState } from "./canvasstore";

const GRID_COLS = 3;
// the design skill's gaps between frames, in board px before scaling
const GRID_COL_GAP = 80;
const GRID_ROW_GAP = 120;

// one press does one thing: a drawn mark goes first, and only the next press closes the window
export function canvasEscape(s: CanvasState): "drop-mark" | "close" {
    return s.mark != null ? "drop-mark" : "close";
}

// canvas.json positions are free-form, so the window's All ignores them and lays the boards in rows of 3 in canvas
// order, shrunk (never grown) so the widest row fits the width
export function windowGridLayout(boards: CanvasBoard[], paneWidth: number): CanvasLayout {
    const rows: CanvasBoard[][] = [];
    for (let i = 0; i < boards.length; i += GRID_COLS) {
        rows.push(boards.slice(i, i + GRID_COLS));
    }
    const rowWidth = (row: CanvasBoard[]) => row.reduce((w, b) => w + b.w, 0) + (row.length - 1) * GRID_COL_GAP;
    const spanW = Math.max(0, ...rows.map(rowWidth));
    const scale = fitScale(paneWidth, spanW);
    const frames: CanvasLayout["frames"] = [];
    let y = 0;
    for (const row of rows) {
        let x = 0;
        for (const board of row) {
            frames.push({ board, left: x * scale, top: y * scale, width: board.w * scale, height: board.h * scale });
            x += board.w + GRID_COL_GAP;
        }
        y += Math.max(...row.map((b) => b.h)) + GRID_ROW_GAP;
    }
    const spanH = rows.length > 0 ? y - GRID_ROW_GAP : 0;
    return { scale, width: spanW * scale, height: spanH * scale, frames };
}
