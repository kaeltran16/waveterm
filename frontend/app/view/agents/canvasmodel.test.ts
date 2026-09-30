// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    boardLabel,
    boardsFromCanvasJson,
    boardUrl,
    buildGoal,
    canvasDir,
    classifyProbe,
    fitScale,
    isUnseen,
    paneState,
    pickFreePort,
    pickServingPort,
    prototypePath,
    stepBoard,
    updatedAgo,
    type CanvasBoard,
} from "./canvasmodel";
import type { CanvasState } from "./canvasstore";

const BOARDS: CanvasBoard[] = [
    { name: "Main.dc.html", w: 1440 },
    { name: "States.dc.html", w: 1440 },
];

function state(over: Partial<CanvasState>): CanvasState {
    return {
        topic: "t",
        dir: "/p/.superpowers/design/t",
        projectDir: "/p",
        mode: "terminal",
        board: null,
        boards: [],
        port: null,
        status: "ready",
        lastModifiedMs: null,
        lastViewedMs: 0,
        marking: false,
        marks: [],
        reloadKey: 0,
        ...over,
    };
}

describe("boardsFromCanvasJson", () => {
    it("reads the design-local shape in its order", () => {
        const json = {
            boards: { "Main.dc.html": { w: 1440 }, "States.dc.html": { w: 1440 } },
            order: ["Main.dc.html", "States.dc.html"],
        };
        expect(boardsFromCanvasJson(json)).toEqual(BOARDS);
    });

    it("drops an order entry naming a board that isn't there", () => {
        const json = { boards: { "Main.dc.html": { w: 1440 } }, order: ["Gone.dc.html", "Main.dc.html"] };
        expect(boardsFromCanvasJson(json)).toEqual([{ name: "Main.dc.html", w: 1440 }]);
    });

    it("falls back to the board keys with Main first when there is no order", () => {
        const json = { boards: { "States.dc.html": { w: 800 }, "Main.dc.html": { w: 1440 } } };
        expect(boardsFromCanvasJson(json)).toEqual([
            { name: "Main.dc.html", w: 1440 },
            { name: "States.dc.html", w: 800 },
        ]);
    });

    it.each([null, "x", 3, {}, { boards: "x" }])("reads malformed %j as the one Main board", (json) => {
        expect(boardsFromCanvasJson(json)).toEqual([{ name: "Main.dc.html", w: 1440 }]);
    });

    it("gives a board with no width the default", () => {
        expect(boardsFromCanvasJson({ boards: { "Main.dc.html": {} } })).toEqual([{ name: "Main.dc.html", w: 1440 }]);
    });
});

describe("boardLabel", () => {
    it("strips the board extension", () => {
        expect(boardLabel("Main.dc.html")).toBe("Main");
    });
});

describe("stepBoard", () => {
    const three = [...BOARDS, { name: "C.dc.html", w: 1440 }];

    it("wraps forward and back", () => {
        expect(stepBoard(three, "C.dc.html", 1)).toBe("Main.dc.html");
        expect(stepBoard(three, "Main.dc.html", -1)).toBe("C.dc.html");
        expect(stepBoard(three, "Main.dc.html", 1)).toBe("States.dc.html");
    });

    it("treats no current board as the first", () => {
        expect(stepBoard(three, null, 1)).toBe("States.dc.html");
        expect(stepBoard(three, null, -1)).toBe("C.dc.html");
    });

    it("has nothing to step to with no boards", () => {
        expect(stepBoard([], null, 1)).toBeNull();
    });
});

describe("port probing", () => {
    it("classifies a probe by its answer", () => {
        expect(classifyProbe({ port: 8766, status: 200 })).toBe("serving");
        expect(classifyProbe({ port: 8766, status: "error" })).toBe("free");
        expect(classifyProbe({ port: 8766, status: 404 })).toBe("taken");
    });

    it("picks the lowest serving and the lowest free port", () => {
        const rs = [
            { port: 8769, status: 200 as const },
            { port: 8768, status: "error" as const },
            { port: 8766, status: 404 },
            { port: 8767, status: 200 },
            { port: 8770, status: "error" as const },
        ];
        expect(pickServingPort(rs)).toBe(8767);
        expect(pickFreePort(rs)).toBe(8768);
    });

    it("has no port when nothing qualifies", () => {
        expect(pickServingPort([{ port: 8766, status: 404 }])).toBeNull();
        expect(pickFreePort([{ port: 8766, status: 200 }])).toBeNull();
    });
});

describe("paneState", () => {
    it("shows the board once ready", () => {
        expect(paneState(state({ status: "ready" }))).toBe("board");
        expect(paneState(state({ status: "probing" }))).toBe("probing");
        expect(paneState(state({ status: "server-down" }))).toBe("server-down");
        expect(paneState(state({ status: "removed" }))).toBe("removed");
    });
});

describe("isUnseen", () => {
    it("is never unseen while the canvas is showing", () => {
        expect(isUnseen(state({ mode: "canvas", lastModifiedMs: 900, lastViewedMs: 100 }))).toBe(false);
    });

    it("is not unseen before anything was read", () => {
        expect(isUnseen(state({ lastModifiedMs: null, lastViewedMs: 100 }))).toBe(false);
    });

    it("is unseen when a board changed after the last look", () => {
        expect(isUnseen(state({ lastModifiedMs: 900, lastViewedMs: 100 }))).toBe(true);
        expect(isUnseen(state({ lastModifiedMs: 100, lastViewedMs: 100 }))).toBe(false);
    });
});

describe("updatedAgo", () => {
    const now = 10_000_000;
    it.each<[number, string]>([
        [0, "updated 0s ago"],
        [59, "updated 59s ago"],
        [60, "updated 1m ago"],
        [3600, "updated 1h ago"],
    ])("reads %ds back", (secs, want) => {
        expect(updatedAgo(now, now - secs * 1000)).toBe(want);
    });

    it("says nothing with no time", () => {
        expect(updatedAgo(now, null)).toBe("");
    });
});

describe("fitScale", () => {
    it("shrinks a board to the pane, never grows it", () => {
        expect(fitScale(1200, 1440)).toBe(1200 / 1440);
        expect(fitScale(2000, 1440)).toBe(1);
    });

    it("is 1 before the pane has a width", () => {
        expect(fitScale(0, 1440)).toBe(1);
        expect(fitScale(1200, 0)).toBe(1);
    });
});

describe("paths", () => {
    it("builds the board url", () => {
        expect(boardUrl(8766, "t", "Main.dc.html")).toBe("http://127.0.0.1:8766/t/project/Main.dc.html");
    });

    it("joins the canvas dir with the cwd's own separator", () => {
        expect(canvasDir("C:\\p", "t")).toBe("C:\\p\\.superpowers\\design\\t");
        expect(canvasDir("/p", "t")).toBe("/p/.superpowers/design/t");
        expect(canvasDir("/p/", "t")).toBe("/p/.superpowers/design/t");
    });

    it("names the project dir and its boards in the goal", () => {
        expect(buildGoal("C:\\p\\.superpowers\\design\\t", BOARDS)).toBe(
            "Build the design in C:\\p\\.superpowers\\design\\t\\project (boards: Main, States)"
        );
        expect(buildGoal("/p/.superpowers/design/t", BOARDS)).toBe(
            "Build the design in /p/.superpowers/design/t/project (boards: Main, States)"
        );
    });

    it("points the prototype at the first board", () => {
        expect(prototypePath("C:\\p\\.superpowers\\design\\t", BOARDS)).toBe(
            "C:\\p\\.superpowers\\design\\t\\project\\Main.dc.html"
        );
        expect(prototypePath("/p/.superpowers/design/t", [BOARDS[1]])).toBe(
            "/p/.superpowers/design/t/project/States.dc.html"
        );
    });
});
