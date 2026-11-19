// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The workspace pane's Canvas tab, its pure half: one row per board with a fixed-size preview, which view the tab
// shows, and how [ and ] move the selection among the rows.

import { boardLabel, paneState, shownBoard, stepTab, type CanvasBoard } from "./canvasmodel";
import type { CanvasState } from "./canvasstore";

// a row's preview box is 112×70 with a 3px inset: the board fits the space inside it
const PREVIEW_INNER_W = 106;
const PREVIEW_INNER_H = 64;

export type TabView = "boards" | "no-boards" | "removed" | "server-down";

export type TabRow = { board: CanvasBoard; label: string; size: string; selected: boolean };

// probing keeps the (empty) list, so attaching a canvas never flashes "No boards yet" before the first poll
export function tabView(s: CanvasState): TabView {
    const pane = paneState(s);
    if (pane === "removed" || pane === "server-down") {
        return pane;
    }
    return s.status === "ready" && s.boards.length === 0 ? "no-boards" : "boards";
}

export function tabRows(s: CanvasState): TabRow[] {
    const selected = s.boards.length > 0 ? shownBoard(s).name : null;
    return s.boards.map((board) => ({
        board,
        label: boardLabel(board.name),
        size: `${board.w}×${board.h}`,
        selected: board.name === selected,
    }));
}

// the whole board, centred on the axis it leaves free
export function previewFit(w: number, h: number): { scale: number; left: number; top: number } {
    const scale = Math.min(PREVIEW_INNER_W / w, PREVIEW_INNER_H / h);
    return { scale, left: (PREVIEW_INNER_W - w * scale) / 2, top: (PREVIEW_INNER_H - h * scale) / 2 };
}

// the list has no All: [ and ] walk the boards from the one it shows selected
export function stepListBoard(s: CanvasState, delta: number): string | null {
    return stepTab(
        s.boards.map((b) => b.name),
        shownBoard(s).name,
        delta
    );
}
