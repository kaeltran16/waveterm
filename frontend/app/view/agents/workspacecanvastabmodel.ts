// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The workspace pane's Canvas tab, its pure half: one row per board with a fixed-size preview, which view the tab
// shows, and how [ and ] move the selection among the rows.

import { boardLabel, paneState, shownBoard, stepTab, type CanvasBoard } from "./canvasmodel";
import type { CanvasState } from "./canvasstore";
import type { WindowScope } from "./canvaswindowmodel";

// a row's preview box is 112×70 with a 3px inset: the board fits the space inside it
const PREVIEW_INNER_W = 106;
const PREVIEW_INNER_H = 64;

export type TabView = "boards" | "no-boards" | "removed" | "server-down";

// the open question's number and the label of the board's tab in the question's window
export type RowTag = { n: number; label: string };

export type TabRow = { board: CanvasBoard; label: string; size: string; selected: boolean; tag: RowTag | null };

// probing keeps the (empty) list, so attaching a canvas never flashes "No boards yet" before the first poll
export function tabView(s: CanvasState): TabView {
    const pane = paneState(s);
    if (pane === "removed" || pane === "server-down") {
        return pane;
    }
    return s.status === "ready" && s.boards.length === 0 ? "no-boards" : "boards";
}

// question is the open question's window scope; its tabs tag rows only on the brainstorm's own canvas, as opening a
// tagged row through the question attaches the agent to that canvas
export function tabRows(
    s: CanvasState,
    question: WindowScope | null = null,
    brainstormCanvas: string | null = null
): TabRow[] {
    const selected = s.boards.length > 0 ? shownBoard(s).name : null;
    const tags = rowTags(question, s.topic === brainstormCanvas);
    return s.boards.map((board) => ({
        board,
        label: boardLabel(board.name),
        size: `${board.w}×${board.h}`,
        selected: board.name === selected,
        tag: tags.get(board.name) ?? null,
    }));
}

function rowTags(question: WindowScope | null, ownCanvas: boolean): Map<string, RowTag> {
    const source = question?.source;
    if (question == null || source?.kind !== "question" || !ownCanvas) {
        return new Map();
    }
    return new Map(question.tabs.map((t) => [t.board, { n: source.n, label: t.label }]));
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
