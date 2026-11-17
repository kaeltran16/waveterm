// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: what the Rendered transcript's board cards draw from the agent's canvas state.

import { questionBoardLayout, type BrainstormFile } from "./brainstormmodel";
import { servedBoards } from "./canvasmodel";
import type { CanvasState } from "./canvasstore";

// the boards a question's card draws, laid out as the pane's question: a tab for each board an option (or approach,
// while judging) names, in option order, then the asked part's boards no option names; chips[i] is row i's boards.
// null when the pane would draw none
export function questionTabs(
    f: BrainstormFile,
    base: string | null,
    onCanvas: string[],
    judging = false
): { tabs: string[]; chips: string[][] } | null {
    const layout = questionBoardLayout(f, base, onCanvas, judging);
    if (layout == null) {
        return null;
    }
    return { tabs: [...new Set([...layout.rows.flat(), ...layout.shared])], chips: layout.rows };
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

// the board a card shows: the one picked while it is still a tab, else the first
export function shownOf(boards: string[], want: string | null): string | null {
    return want != null && boards.includes(want) ? want : (boards[0] ?? null);
}

export function boardCount(n: number): string {
    return `${n} ${n === 1 ? "board" : "boards"}`;
}
