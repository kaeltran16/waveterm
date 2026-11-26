// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: what the Rendered transcript's board cards draw from the agent's canvas state, and how a canvas reveal row
// draws.

import { parseAddress } from "../jarvis/address";
import { questionBoardLayout, type BrainstormFile } from "./brainstormmodel";
import { servedBoards } from "./canvasmodel";
import type { CanvasState } from "./canvasstore";

// the boards each option's chip names, laid out as the pane's question: chips[i] is row i's boards. null when the
// pane would draw no board for the question
export function questionChips(
    f: BrainstormFile,
    base: string | null,
    onCanvas: string[],
    judging = false
): string[][] | null {
    return questionBoardLayout(f, base, onCanvas, judging)?.rows ?? null;
}

// the standalone Mockup card's states (CanvasEdge): count is the boards it last read before the server went down
export type MockupView =
    | { kind: "probing" }
    | { kind: "empty" }
    | { kind: "boards"; boards: string[] }
    | { kind: "server-down"; count: number }
    | { kind: "removed" };

export function mockupView(s: CanvasState): MockupView {
    switch (s.status) {
        case "removed":
            return { kind: "removed" };
        case "server-down":
            return { kind: "server-down", count: servedBoards(s).length };
        case "probing":
            return { kind: "probing" };
    }
    const boards = servedBoards(s);
    return boards.length > 0 ? { kind: "boards", boards } : { kind: "empty" };
}

// when the newest served board last changed; 0 is a board served with no Last-Modified, which has no age to give
export function boardsUpdatedMs(s: CanvasState): number | null {
    const newest = Math.max(0, ...servedBoards(s).map((b) => s.boardModifiedMs?.[b] ?? 0));
    return newest || null;
}

// the board a card shows: the one picked while it is still a tab, else the first
export function shownOf(boards: string[], want: string | null): string | null {
    return want != null && boards.includes(want) ? want : (boards[0] ?? null);
}

export function boardCount(n: number): string {
    return `${n} ${n === 1 ? "board" : "boards"}`;
}

// the canvas a `wsh ui reveal` address names, else null
export function revealedCanvas(address: string | undefined): { topic: string; board?: string } | null {
    if (!address) {
        return null;
    }
    const t = parseAddress(address);
    return t.kind === "canvas" ? { topic: t.topic, board: t.board } : null;
}

// a canvas reveal row: the Mockup card on the latest (transcriptlayout's lastCanvasReveal), a row that opens the
// canvas on an earlier one, and the plain row for a canvas the agent no longer has
export type CanvasRevealView = "card" | "row-open" | "row";

export function canvasRevealView(o: { latest: boolean; topic: string; canvas: CanvasState | null }): CanvasRevealView {
    if (o.canvas == null || o.canvas.topic !== o.topic) {
        return "row";
    }
    if (o.latest) {
        return "card";
    }
    return o.canvas.status === "removed" ? "row" : "row-open";
}

// the board an earlier reveal's Open canvas opens: the one it named while served, else the card's choice
export function revealBoard(s: CanvasState, named: string | undefined): string | null {
    return shownOf(servedBoards(s), named ?? s.board) ?? s.board ?? s.boards[0]?.name ?? null;
}
