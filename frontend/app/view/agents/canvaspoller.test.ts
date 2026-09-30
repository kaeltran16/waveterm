// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { pollCanvasOnce, type CanvasIO, type HttpStatus } from "./canvaspoller";
import type { CanvasState } from "./canvasstore";

const NOW = 50_000;

function state(over: Partial<CanvasState> = {}): CanvasState {
    return {
        topic: "t",
        dir: "/p/.superpowers/design/t",
        projectDir: "/p",
        mode: "canvas",
        board: null,
        all: false,
        boards: [],
        port: null,
        status: "probing",
        lastModifiedMs: null,
        lastViewedMs: 0,
        marking: false,
        marks: [],
        reloadKey: 0,
        ...over,
    };
}

type Served = { port: number; files: Record<string, number>; json?: unknown };

// a fake python server: one port serving the topic's files, each with a Last-Modified; every other port refuses
function fakeIO(served: Served | null, opts: { dirExists?: boolean } = {}): CanvasIO & { urls: string[] } {
    const urls: string[] = [];
    const answer = (url: string): { status: HttpStatus; lastModified: number | null } => {
        urls.push(url);
        const m = /^http:\/\/127\.0\.0\.1:(\d+)\/t\/project\/(.+)$/.exec(url);
        if (served == null || m == null || Number(m[1]) !== served.port) {
            return { status: "error", lastModified: null };
        }
        const lm = served.files[m[2]];
        return lm == null ? { status: 404, lastModified: null } : { status: 200, lastModified: lm };
    };
    return {
        urls,
        dirExists: async (path) => {
            expect(path).toBe("/p/.superpowers/design/t/project");
            return opts.dirExists ?? true;
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
        const io = fakeIO({ port: 8766, files: { "Main.dc.html": 1 } }, { dirExists: false });
        expect(await pollCanvasOnce(state(), io, NOW)).toEqual({ status: "removed" });
        expect(io.urls).toEqual([]);
    });

    it("is server-down when no port in the range answers", async () => {
        const io = fakeIO(null);
        expect(await pollCanvasOnce(state(), io, NOW)).toEqual({ status: "server-down" });
        expect(io.urls).toHaveLength(20);
    });

    it("finds the serving port, reads the boards and the newest Last-Modified", async () => {
        const io = fakeIO({
            port: 8767,
            files: { "Main.dc.html": 1000, "States.dc.html": 3000, "canvas.json": 2000 },
            json: JSON_TWO,
        });
        expect(await pollCanvasOnce(state(), io, NOW)).toEqual({
            port: 8767,
            status: "ready",
            boards: BOARDS_TWO,
            lastModifiedMs: 3000,
            lastViewedMs: NOW,
        });
    });

    it("leaves lastViewedMs alone in terminal mode", async () => {
        const io = fakeIO({ port: 8766, files: { "Main.dc.html": 1000 } });
        const patch = await pollCanvasOnce(state({ mode: "terminal" }), io, NOW);
        expect(patch.lastViewedMs).toBeUndefined();
        expect(patch.status).toBe("ready");
    });

    it("reloads the boards when any board's Last-Modified moves in canvas mode, since all are on screen", async () => {
        const io = fakeIO({
            port: 8766,
            files: { "Main.dc.html": 1000, "States.dc.html": 5000, "canvas.json": 500 },
            json: JSON_TWO,
        });
        const shownMoved = state({ port: 8766, board: "States.dc.html", lastModifiedMs: 1000, reloadKey: 4 });
        expect((await pollCanvasOnce(shownMoved, io, NOW)).reloadKey).toBe(5);
        const otherMoved = state({ port: 8766, board: "Main.dc.html", lastModifiedMs: 1000, reloadKey: 4 });
        expect((await pollCanvasOnce(otherMoved, io, NOW)).reloadKey).toBe(5);
        const unchanged = state({ port: 8766, lastModifiedMs: 5000, reloadKey: 4 });
        expect((await pollCanvasOnce(unchanged, io, NOW)).reloadKey).toBeUndefined();
        const inTerminal = state({ port: 8766, board: "States.dc.html", lastModifiedMs: 1000, mode: "terminal" });
        expect((await pollCanvasOnce(inTerminal, io, NOW)).reloadKey).toBeUndefined();
    });

    it("does not reload on the first read", async () => {
        const io = fakeIO({ port: 8766, files: { "Main.dc.html": 1000 } });
        expect((await pollCanvasOnce(state({ port: 8766 }), io, NOW)).reloadKey).toBeUndefined();
    });

    it("re-probes when the known port stops answering", async () => {
        const io = fakeIO({ port: 8770, files: { "Main.dc.html": 1000 } });
        const patch = await pollCanvasOnce(state({ port: 8766, status: "ready" }), io, NOW);
        expect(patch.port).toBe(8770);
        expect(patch.status).toBe("ready");
    });

    it("keeps a known port and asks only it while it answers", async () => {
        const io = fakeIO({ port: 8766, files: { "Main.dc.html": 1000 } });
        await pollCanvasOnce(state({ port: 8766 }), io, NOW);
        expect(io.urls.every((u) => u.startsWith("http://127.0.0.1:8766/"))).toBe(true);
    });
});
