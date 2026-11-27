// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import {
    anchoredSessions,
    dismissedCursor,
    gridColumns,
    resolveCursor,
    stepCursor,
    type ArrowKey,
    type GridPath,
    type GridTrail,
} from "./cockpitgridmodel";
import type { CockpitSession, SessionState } from "./cockpitsessionmodel";

describe("gridColumns", () => {
    it.each([
        [1600, 3],
        [1100, 3],
        [1099, 2],
        [700, 2],
    ])("%i px wide has %i columns", (width, want) => {
        expect(gridColumns(width)).toBe(want);
    });
});

// five thumbnails in three columns: a full top row (a b c) and a bottom row of two (d e)
const PATH: GridPath = {
    grid: ["a", "b", "c", "d", "e"],
    idle: ["i1", "i2"],
    strip: ["strip:r1", "strip:r2"],
    columns: 3,
};

describe("stepCursor", () => {
    it.each<[string, string, ArrowKey, string, GridPath?]>([
        ["Right steps to the next thumbnail", "a", "ArrowRight", "b"],
        ["Left steps back", "b", "ArrowLeft", "a"],
        ["Left stops at the first thumbnail", "a", "ArrowLeft", "a"],
        ["Right stops at the last thumbnail", "e", "ArrowRight", "e"],
        ["Down drops a row", "b", "ArrowDown", "e"],
        ["Up climbs a row", "d", "ArrowUp", "a"],
        ["Up stops at the top row", "b", "ArrowUp", "b"],
        ["Down over an empty cell lands on the bottom row's last", "c", "ArrowDown", "e"],
        ["Down from the bottom row goes to the Idle line", "d", "ArrowDown", "i1"],
        ["Right walks the Idle names", "i1", "ArrowRight", "i2"],
        ["Right stops at the last Idle name", "i2", "ArrowRight", "i2"],
        ["Left stops at the first Idle name", "i1", "ArrowLeft", "i1"],
        ["Down from the Idle line goes to the strip", "i2", "ArrowDown", "strip:r1"],
        ["Down walks the strip", "strip:r1", "ArrowDown", "strip:r2"],
        ["Down stops at the strip's last line", "strip:r2", "ArrowDown", "strip:r2"],
        ["Up walks the strip back", "strip:r2", "ArrowUp", "strip:r1"],
        ["Left and Right do nothing on the strip", "strip:r1", "ArrowRight", "strip:r1"],
        ["Up from the Idle line with no trail goes to the last thumbnail", "i1", "ArrowUp", "e"],
        ["Up from the strip with no trail goes to the first Idle name", "strip:r1", "ArrowUp", "i1"],
        ["Down from the bottom row skips an empty Idle line", "e", "ArrowDown", "strip:r1", { ...PATH, idle: [] }],
        ["Up from the strip skips an empty Idle line", "strip:r1", "ArrowUp", "e", { ...PATH, idle: [] }],
        ["Down from the bottom row stays with nothing below", "e", "ArrowDown", "e", { ...PATH, idle: [], strip: [] }],
    ])("%s", (_, from, key, want, path = PATH) => {
        expect(stepCursor(path, from, key, {}).id).toBe(want);
    });

    it("Up retraces the way Down came", () => {
        let trail: GridTrail = {};
        let id = "d";
        for (const key of ["ArrowDown", "ArrowRight", "ArrowDown"] as ArrowKey[]) {
            ({ id, trail } = stepCursor(PATH, id, key, trail));
        }
        expect(id).toBe("strip:r1");
        ({ id, trail } = stepCursor(PATH, id, "ArrowUp", trail));
        expect(id).toBe("i2");
        ({ id, trail } = stepCursor(PATH, id, "ArrowUp", trail));
        expect(id).toBe("d");
    });

    it("from nowhere, any arrow lands on the first stop", () => {
        expect(stepCursor(PATH, undefined, "ArrowDown", {}).id).toBe("a");
    });
});

describe("resolveCursor", () => {
    it.each<[string, string | undefined, GridPath, string | undefined]>([
        ["a stop still shown stays", "i2", PATH, "i2"],
        ["a stop gone falls to the first thumbnail", "gone", PATH, "a"],
        ["no thumbnails falls to the first Idle name", "gone", { ...PATH, grid: [] }, "i1"],
        ["nothing at all is no cursor", "gone", { grid: [], idle: [], strip: [], columns: 3 }, undefined],
    ])("%s", (_, cur, path, want) => {
        expect(resolveCursor(path, cur)).toBe(want);
    });
});

describe("dismissedCursor", () => {
    it.each<[string, string, string[], string | undefined]>([
        ["the next thumbnail takes the slot", "b", ["a", "b", "c"], "c"],
        ["the last one hands back to the one before", "c", ["a", "b", "c"], "b"],
        ["the only one leaves no thumbnail", "a", ["a"], undefined],
    ])("%s", (_, id, grid, want) => {
        expect(dismissedCursor(grid, id)).toBe(want);
    });
});

const session = (id: string, state: SessionState): CockpitSession => ({
    agent: { id, name: id, task: "", state: "idle" } as AgentVM,
    state,
    conductor: false,
    runs: [],
});

describe("anchoredSessions", () => {
    it("a session turning to you keeps its slot", () => {
        const before = anchoredSessions([], [session("a", "working"), session("b", "working"), session("c", "turn")]);
        // the roster now lists b first, as the old status-sorted roster did when b started asking
        const after = anchoredSessions(before.order, [
            session("b", "asks"),
            session("a", "working"),
            session("c", "turn"),
        ]);
        expect(after.sessions.map((s) => [s.agent.id, s.state])).toEqual([
            ["a", "working"],
            ["b", "asks"],
            ["c", "turn"],
        ]);
    });

    it("a new session appends, and a dismissed one comes back at the end", () => {
        const before = anchoredSessions([], [session("a", "turn"), session("b", "turn")]);
        const dismissed = anchoredSessions(before.order, [session("b", "turn")]);
        const back = anchoredSessions(dismissed.order, [
            session("a", "turn"),
            session("n", "working"),
            session("b", "turn"),
        ]);
        expect(back.order).toEqual(["b", "a", "n"]);
        expect(back.sessions.map((s) => s.agent.id)).toEqual(["b", "a", "n"]);
    });
});
