// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { globalStore } from "@/app/store/jotaiStore";
import { atom } from "jotai";
import type { AgentsViewModel } from "./agents";
import { boardUnseen } from "./canvasmodel";
import { canvasOnScreen, pollAndMerge, pollCanvasOnce, type CanvasIO, type HttpStatus } from "./canvaspoller";
import {
    attachCanvas,
    detachCanvas,
    getCanvas,
    setCanvasMode,
    showInlineBoard,
    updateCanvas,
    type CanvasState,
} from "./canvasstore";
import { viewModeAtom } from "./renderedmode";
import { closeWorkspaceTab, openWorkspaceTab } from "./workspacestore";

// nothing in its roster, so every agent is in the Terminal view, where the canvas's mode says whether it shows
const TERMINAL = { agentsAtom: atom([]) } as unknown as AgentsViewModel;

const NOW = 50_000;
const BASE = "http://127.0.0.1:5005/canvas/tok";
const STALE_BASE = "http://127.0.0.1:4004/canvas/old";

function state(over: Partial<CanvasState> = {}): CanvasState {
    return {
        topic: "t",
        dir: "/p/.superpowers/design/t",
        projectDir: "/p",
        mode: "canvas",
        board: null,
        all: false,
        boards: [],
        base: null,
        status: "probing",
        lastModifiedMs: null,
        lastViewedMs: 0,
        marking: false,
        mark: null,
        reloadKey: 0,
        ...over,
    };
}

type Served = { files: Record<string, number>; json?: unknown };

// a fake wavesrv: it serves the design folder under BASE, each file with a Last-Modified; any other base refuses.
// served null is a wavesrv that refuses to serve the folder at all
function fakeIO(
    served: Served | null,
    opts: { dirExists?: boolean } = {}
): CanvasIO & { urls: string[]; serves: string[] } {
    const urls: string[] = [];
    const serves: string[] = [];
    const answer = (url: string): { status: HttpStatus; lastModified: number | null } => {
        urls.push(url);
        const prefix = `${BASE}/t/project/`;
        if (served == null || !url.startsWith(prefix)) {
            return { status: "error", lastModified: null };
        }
        const lm = served.files[url.slice(prefix.length)];
        return lm == null ? { status: 404, lastModified: null } : { status: 200, lastModified: lm };
    };
    return {
        urls,
        serves,
        dirExists: async (path) => {
            expect(path).toBe("/p/.superpowers/design/t/project");
            return opts.dirExists ?? true;
        },
        serve: async (designDir) => {
            serves.push(designDir);
            return served == null ? null : BASE;
        },
        get: async (url) => ({ ...answer(url), json: served?.json }),
        head: async (url) => answer(url),
    };
}

const JSON_TWO = {
    order: ["Main.dc.html", "States.dc.html"],
    boards: { "Main.dc.html": { x: 0, y: 0 }, "States.dc.html": { x: 1520, y: 0, w: 900, h: 600 } },
};
const BOARDS_TWO = [
    { name: "Main.dc.html", x: 0, y: 0, w: 1440, h: 900 },
    { name: "States.dc.html", x: 1520, y: 0, w: 900, h: 600 },
];

describe("pollCanvasOnce", () => {
    it("reports a deleted canvas folder as removed, without touching the network", async () => {
        const io = fakeIO({ files: { "Main.dc.html": 1 } }, { dirExists: false });
        expect(await pollCanvasOnce(state(), io, NOW)).toEqual({ status: "removed" });
        expect(io.urls).toEqual([]);
        expect(io.serves).toEqual([]);
    });

    it("is server-down when wavesrv refuses to serve the folder", async () => {
        const io = fakeIO(null);
        expect(await pollCanvasOnce(state(), io, NOW)).toEqual({ base: null, status: "server-down" });
        expect(io.urls).toEqual([]);
    });

    it("asks wavesrv to serve the project's design folder, then reads the boards and the newest Last-Modified", async () => {
        const io = fakeIO({
            files: { "Main.dc.html": 1000, "States.dc.html": 3000, "canvas.json": 2000 },
            json: JSON_TWO,
        });
        expect(await pollCanvasOnce(state(), io, NOW)).toEqual({
            base: BASE,
            status: "ready",
            boards: BOARDS_TWO,
            lastModifiedMs: 3000,
            boardModifiedMs: { "Main.dc.html": 1000, "States.dc.html": 3000 },
            lastViewedMs: NOW,
            boardViewedMs: { "Main.dc.html": NOW },
        });
        expect(io.serves).toEqual(["/p/.superpowers/design"]);
    });

    it("is server-down when canvas.json cannot be read, whatever the board files answer", async () => {
        const io = fakeIO({ files: { "Main.dc.html": 1000 } });
        const failing: CanvasIO = { ...io, get: async () => ({ status: "error", lastModified: null }) };
        expect(await pollCanvasOnce(state({ base: BASE }), failing, NOW)).toEqual({
            base: null,
            status: "server-down",
        });
    });

    it("reads the one Main board when canvas.json is not served, however the server's body reads", async () => {
        const io = fakeIO({ files: { "Main.dc.html": 1000 }, json: JSON_TWO });
        expect(await pollCanvasOnce(state({ base: BASE }), io, NOW)).toEqual({
            base: BASE,
            status: "ready",
            boards: [{ name: "Main.dc.html", x: 0, y: 0, w: 1440, h: 900 }],
            lastModifiedMs: 1000,
            boardModifiedMs: { "Main.dc.html": 1000 },
            lastViewedMs: NOW,
            boardViewedMs: { "Main.dc.html": NOW },
        });
    });

    it("is server-down when any one board file does not answer", async () => {
        const io = fakeIO({
            files: { "Main.dc.html": 1000, "States.dc.html": 3000, "canvas.json": 2000 },
            json: JSON_TWO,
        });
        const oneDown: CanvasIO = {
            ...io,
            head: async (url) =>
                url.endsWith("States.dc.html") ? { status: "error", lastModified: null } : io.head(url),
        };
        expect(await pollCanvasOnce(state({ base: BASE }), oneDown, NOW)).toEqual({
            base: null,
            status: "server-down",
        });
    });

    it("leaves lastViewedMs alone in terminal mode", async () => {
        const io = fakeIO({ files: { "Main.dc.html": 1000 } });
        const patch = await pollCanvasOnce(state({ mode: "terminal" }), io, NOW);
        expect(patch.lastViewedMs).toBeUndefined();
        expect(patch.status).toBe("ready");
    });

    it("reloads the boards when any board's Last-Modified moves in canvas mode, since all are on screen", async () => {
        const io = fakeIO({
            files: { "Main.dc.html": 1000, "States.dc.html": 5000, "canvas.json": 500 },
            json: JSON_TWO,
        });
        const shownMoved = state({ base: BASE, board: "States.dc.html", lastModifiedMs: 1000, reloadKey: 4 });
        expect((await pollCanvasOnce(shownMoved, io, NOW)).reloadKey).toBe(5);
        const otherMoved = state({ base: BASE, board: "Main.dc.html", lastModifiedMs: 1000, reloadKey: 4 });
        expect((await pollCanvasOnce(otherMoved, io, NOW)).reloadKey).toBe(5);
        const unchanged = state({ base: BASE, lastModifiedMs: 5000, reloadKey: 4 });
        expect((await pollCanvasOnce(unchanged, io, NOW)).reloadKey).toBeUndefined();
        const inTerminal = state({ base: BASE, board: "States.dc.html", lastModifiedMs: 1000, mode: "terminal" });
        expect((await pollCanvasOnce(inTerminal, io, NOW)).reloadKey).toBeUndefined();
    });

    it("reloads a board a brainstorm opened full size, which leaves the canvas in terminal mode", async () => {
        const io = fakeIO({ files: { "Main.dc.html": 5000 } });
        const fullSize = state({
            base: BASE,
            board: "Main.dc.html",
            lastModifiedMs: 1000,
            mode: "terminal",
            reloadKey: 4,
        });
        expect((await pollCanvasOnce(fullSize, io, NOW, true)).reloadKey).toBe(5);
    });

    it("does not reload on the first read", async () => {
        const io = fakeIO({ files: { "Main.dc.html": 1000 } });
        expect((await pollCanvasOnce(state({ base: BASE }), io, NOW)).reloadKey).toBeUndefined();
    });

    it("drops a base that stopped answering, so the next tick asks wavesrv again", async () => {
        const io = fakeIO({ files: { "Main.dc.html": 1000 } });
        const stale = state({ base: STALE_BASE, status: "ready" });
        expect(await pollCanvasOnce(stale, io, NOW)).toEqual({ base: null, status: "server-down" });
        const patch = await pollCanvasOnce({ ...stale, base: null }, io, NOW);
        expect(patch.base).toBe(BASE);
        expect(patch.status).toBe("ready");
    });

    it("carries each served board's Last-Modified, leaving out a board whose file is not there", async () => {
        const io = fakeIO({ files: { "Main.dc.html": 1000, "canvas.json": 500 }, json: JSON_TWO });
        const patch = await pollCanvasOnce(state({ base: BASE, mode: "terminal" }), io, NOW);
        expect(patch.boardModifiedMs).toEqual({ "Main.dc.html": 1000 });
        expect(patch.boardViewedMs).toBeUndefined();
    });

    it("marks only the boards on screen as viewed: the pane's shown board, or every one under All", async () => {
        const io = fakeIO({
            files: { "Main.dc.html": 1000, "States.dc.html": 3000, "canvas.json": 500 },
            json: JSON_TWO,
        });
        const viewed = { "States.dc.html": 7 };
        const one = await pollCanvasOnce(
            state({ base: BASE, board: "States.dc.html", boardViewedMs: viewed }),
            io,
            NOW
        );
        expect(one.boardViewedMs).toEqual({ "States.dc.html": NOW });
        const all = await pollCanvasOnce(state({ base: BASE, all: true }), io, NOW);
        expect(all.boardViewedMs).toEqual({ "Main.dc.html": NOW, "States.dc.html": NOW });
    });

    it("counts a Rendered card's inline board as on screen, apart from the canvas pane", async () => {
        const io = fakeIO({
            files: { "Main.dc.html": 1000, "States.dc.html": 3000, "canvas.json": 500 },
            json: JSON_TWO,
        });
        const inline = state({
            base: BASE,
            mode: "terminal",
            inlineBoard: "States.dc.html",
            boardViewedMs: { "Main.dc.html": 9 },
        });
        const patch = await pollCanvasOnce(inline, io, NOW);
        expect(patch.boardViewedMs).toEqual({ "Main.dc.html": 9, "States.dc.html": NOW });
        // the canvas-wide stamp is the pane's: the header's unseen dot is not cleared by a card
        expect(patch.lastViewedMs).toBeUndefined();
    });

    it("reloads when the inline board's own file changes, and not for another board's", async () => {
        const io = fakeIO({
            files: { "Main.dc.html": 1000, "States.dc.html": 5000, "canvas.json": 500 },
            json: JSON_TWO,
        });
        const was = { "Main.dc.html": 1000, "States.dc.html": 3000 };
        const base = {
            base: BASE,
            mode: "terminal" as const,
            lastModifiedMs: 3000,
            boardModifiedMs: was,
            reloadKey: 2,
        };
        expect((await pollCanvasOnce(state({ ...base, inlineBoard: "States.dc.html" }), io, NOW)).reloadKey).toBe(3);
        expect(
            (await pollCanvasOnce(state({ ...base, inlineBoard: "Main.dc.html" }), io, NOW)).reloadKey
        ).toBeUndefined();
        // a board seen for the first time is not a change
        const first = state({ ...base, boardModifiedMs: undefined, inlineBoard: "States.dc.html" });
        expect((await pollCanvasOnce(first, io, NOW)).reloadKey).toBeUndefined();
    });

    it("keeps a known base and does not ask wavesrv again while it answers", async () => {
        const io = fakeIO({ files: { "Main.dc.html": 1000 } });
        await pollCanvasOnce(state({ base: BASE }), io, NOW);
        expect(io.serves).toEqual([]);
        expect(io.urls.every((u) => u.startsWith(`${BASE}/`))).toBe(true);
    });
});

describe("pollAndMerge", () => {
    const AGENT = "agent-poll";
    const LATER = NOW + 10_000;

    // the agent's canvas, already served, with the given state on top
    function attached(over: Partial<CanvasState>): void {
        attachCanvas(AGENT, { topic: "t", dir: "/p/.superpowers/design/t", projectDir: "/p" }, 0);
        updateCanvas(AGENT, (s) => ({ ...s, base: BASE, status: "ready", ...over }));
    }

    // a poll during whose reads `during` runs, as a tab click or mode switch landing while it is in flight would
    function pollWith(during: () => void): CanvasIO {
        const io = fakeIO({
            files: { "Main.dc.html": 1000, "States.dc.html": 5000, "canvas.json": 500 },
            json: JSON_TWO,
        });
        return {
            ...io,
            get: async (url) => {
                during();
                return io.get(url);
            },
        };
    }

    beforeEach(() => {
        vi.spyOn(Date, "now").mockReturnValue(NOW);
    });
    afterEach(() => {
        detachCanvas(AGENT);
        vi.restoreAllMocks();
    });

    it("keeps a board shown while the poll was reading as viewed at the show", async () => {
        attached({ mode: "terminal", inlineBoard: "Main.dc.html", boardViewedMs: { "Main.dc.html": 9 } });
        await pollAndMerge(
            TERMINAL,
            AGENT,
            pollWith(() => showInlineBoard(AGENT, "States.dc.html", LATER))
        );
        const s = getCanvas(AGENT);
        expect(s.boardViewedMs).toEqual({ "Main.dc.html": NOW, "States.dc.html": LATER });
        expect(boardUnseen(s, "States.dc.html")).toBe(false);
    });

    it("keeps a canvas-mode switch made while the poll was reading", async () => {
        attached({ mode: "canvas", lastViewedMs: 7 });
        await pollAndMerge(
            TERMINAL,
            AGENT,
            pollWith(() => setCanvasMode(AGENT, "canvas", LATER))
        );
        expect(getCanvas(AGENT).lastViewedMs).toBe(LATER);
    });

    it("records the boards on screen as viewed at the poll's time when nothing else moved them", async () => {
        attached({ mode: "canvas", board: "States.dc.html", lastViewedMs: 7, boardViewedMs: { "States.dc.html": 7 } });
        await pollAndMerge(
            TERMINAL,
            AGENT,
            pollWith(() => {})
        );
        const s = getCanvas(AGENT);
        expect(s.boardViewedMs).toEqual({ "States.dc.html": NOW });
        expect(s.lastViewedMs).toBe(NOW);
        expect(s.boardModifiedMs).toEqual({ "Main.dc.html": 1000, "States.dc.html": 5000 });
    });

    it("counts the Canvas tab as on screen in Rendered, and the Terminal view's mode not at all", async () => {
        const rendered = {
            agentsAtom: atom([{ id: AGENT, name: AGENT, task: "", state: "idle", agent: "claude", blockId: "blk" }]),
        } as unknown as AgentsViewModel;
        globalStore.set(viewModeAtom(AGENT), "rendered");
        attached({ mode: "canvas", board: "States.dc.html", lastViewedMs: 7, boardViewedMs: { "States.dc.html": 7 } });
        await pollAndMerge(
            rendered,
            AGENT,
            pollWith(() => {})
        );
        expect(getCanvas(AGENT).lastViewedMs).toBe(7);
        openWorkspaceTab(AGENT, { kind: "canvas" });
        await pollAndMerge(
            rendered,
            AGENT,
            pollWith(() => {})
        );
        expect(getCanvas(AGENT).lastViewedMs).toBe(NOW);
        expect(getCanvas(AGENT).boardViewedMs).toEqual({ "States.dc.html": NOW });
        closeWorkspaceTab(AGENT, "canvas");
    });
});

describe("canvasOnScreen", () => {
    it("is the canvas pane or tab while the canvas shows", () => {
        expect(canvasOnScreen("canvas", null)).toBe(true);
        expect(canvasOnScreen(null, null)).toBe(false);
    });
    it("is a brainstorm's full-size board while the brainstorm shows", () => {
        expect(canvasOnScreen("brainstorm", { board: "Main.dc.html" })).toBe(true);
    });
    it("is off while the brainstorm shows no board, or does not show", () => {
        expect(canvasOnScreen("brainstorm", { board: null })).toBe(false);
        expect(canvasOnScreen(null, { board: "Main.dc.html" })).toBe(false);
    });
});
