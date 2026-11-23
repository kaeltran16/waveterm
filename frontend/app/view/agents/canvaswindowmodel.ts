// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The canvas window's pure half: what Esc does, and how its All tab lays the boards out.

import { fitScale, shownBoard, type CanvasBoard, type CanvasLayout } from "./canvasmodel";
import type { CanvasState } from "./canvasstore";

// the tab that shows the boards outside a scope's tabs: never a board name, which always ends in .dc.html
export const OTHER_TAB = "other";

// index is the answer's 0-based position in the question, the number a digit key names
export type BandAnswer = {
    index: number;
    label: string;
    detail: string;
    pick: boolean;
    pros: string[];
    cons: string[];
};
export type ScopeBand =
    | { kind: "answers"; answers: BandAnswer[] }
    | { kind: "every" }
    | { kind: "part"; title: string; gist: string };
// board doubles as the tab's key
export type ScopeTab = { board: string; label: string; band: ScopeBand };
export type ScopeSource =
    | { kind: "question"; n: number; text: string; judging: boolean; judged: boolean }
    | { kind: "part"; id: string; title: string };
// a snapshot taken when the window opens, so the tabs stay put while the brainstorm moves on
export type WindowScope = { source: ScopeSource; tabs: ScopeTab[] };

export function windowTabs(scope: WindowScope, boards: CanvasBoard[]): string[] {
    const onCanvas = new Set(boards.map((b) => b.name));
    const tabs = scope.tabs.map((t) => t.board).filter((b) => onCanvas.has(b));
    return otherBoards(scope, boards).length > 0 ? [...tabs, OTHER_TAB] : tabs;
}

export function otherBoards(scope: WindowScope, boards: CanvasBoard[]): CanvasBoard[] {
    const inTabs = new Set(scope.tabs.map((t) => t.board));
    return boards.filter((b) => !inTabs.has(b.name));
}

export function windowTab(scope: WindowScope, s: CanvasState): string {
    const shown = shownBoard(s).name;
    return !s.all && scope.tabs.some((t) => t.board === shown) ? shown : OTHER_TAB;
}

export function digitTab(scope: WindowScope, digit: number): string | null {
    if (scope.source.kind === "part") {
        return scope.tabs[digit]?.board ?? null;
    }
    const tab = scope.tabs.find((t) => t.band.kind === "answers" && t.band.answers.some((a) => a.index === digit));
    return tab?.board ?? null;
}

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
