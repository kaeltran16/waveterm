// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({ SetMetaCommand: vi.fn() }));

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: rpc }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { globalStore } from "@/app/store/jotaiStore";
import type { BrainstormFile } from "./brainstormmodel";
import {
    attachBrainstorm,
    brainstormAtom,
    brainstormOwner,
    brainstormsAtom,
    detachBrainstorm,
    dismissBrainstorm,
    getBrainstorm,
    moveReviewCursor,
    openBrainstormAt,
    openBrainstormBoard,
    setBrainstormMode,
    setReviewCursor,
    toggleReviewRow,
    updateBrainstorm,
} from "./brainstormstore";
import { detachCanvas, getCanvas } from "./canvasstore";

const IDS = ["a1", "a2"];
const LAG = { topic: "lag", cwd: "/p" };

afterEach(() => {
    IDS.forEach(detachBrainstorm);
    rpc.SetMetaCommand.mockReset();
});

describe("attachBrainstorm", () => {
    it("starts in terminal mode with nothing read", () => {
        attachBrainstorm("a1", LAG, 100);
        expect(getBrainstorm("a1")).toEqual({
            topic: "lag",
            path: "/p/.superpowers/brainstorm/lag/brainstorm.json",
            cwd: "/p",
            mode: "terminal",
            file: null,
            error: null,
            failedReads: 0,
            removed: false,
            missedStats: 0,
            modifiedMs: null,
            lastViewedMs: 100,
            board: null,
            designOpen: false,
            boards: [],
            base: null,
            turn: { read: [], canvases: {} },
            sent: null,
            picks: {},
            sentCheckAt: null,
            review: { cursor: null, open: {} },
        });
        expect(globalStore.get(brainstormAtom("a1"))?.topic).toBe("lag");
    });

    it("keeps the state when the same brainstorm is revealed again", () => {
        attachBrainstorm("a1", LAG, 100);
        setBrainstormMode("a1", "brainstorm", 200);
        updateBrainstorm("a1", (s) => ({ ...s, modifiedMs: 5 }));
        attachBrainstorm("a1", LAG, 300);
        expect(getBrainstorm("a1")).toMatchObject({ mode: "brainstorm", modifiedMs: 5, lastViewedMs: 200 });
    });

    it("opens a new brainstorm in the mode asked for, and a second attach keeps the mode the user chose", () => {
        attachBrainstorm("a1", LAG, 100, "brainstorm");
        expect(getBrainstorm("a1")).toMatchObject({ mode: "brainstorm", lastViewedMs: 100 });
        setBrainstormMode("a1", "terminal", 200);
        attachBrainstorm("a1", LAG, 300, "brainstorm");
        expect(getBrainstorm("a1")?.mode).toBe("terminal");
    });

    it("keeps the state when the same project is spelled with other slashes or case", () => {
        attachBrainstorm("a1", { topic: "lag", cwd: "C:/Users/me/proj" }, 100);
        setBrainstormMode("a1", "brainstorm", 200);
        attachBrainstorm("a1", { topic: "lag", cwd: "c:\\Users\\me\\proj" }, 300);
        expect(getBrainstorm("a1")).toMatchObject({ mode: "brainstorm", lastViewedMs: 200 });
    });

    it("replaces the old brainstorm when a second topic is revealed on the same agent", () => {
        attachBrainstorm("a1", LAG, 100);
        setBrainstormMode("a1", "brainstorm", 200);
        updateBrainstorm("a1", (s) => ({ ...s, modifiedMs: 5, base: "http://x" }));
        attachBrainstorm("a1", { topic: "other", cwd: "/p" }, 300);
        expect(getBrainstorm("a1")).toMatchObject({
            topic: "other",
            path: "/p/.superpowers/brainstorm/other/brainstorm.json",
            mode: "terminal",
            modifiedMs: null,
            base: null,
        });
        expect(brainstormOwner("lag")).toBeNull();
        expect(Object.keys(globalStore.get(brainstormsAtom))).toEqual(["a1"]);
    });

    it("starts over for the same topic in another project", () => {
        attachBrainstorm("a1", LAG, 100);
        updateBrainstorm("a1", (s) => ({ ...s, base: "http://x" }));
        attachBrainstorm("a1", { topic: "lag", cwd: "/q" }, 200);
        expect(getBrainstorm("a1")).toMatchObject({ cwd: "/q", base: null });
    });
});

describe("brainstorm state", () => {
    it("records when brainstorm mode is entered, not when it is left", () => {
        attachBrainstorm("a1", LAG, 100);
        setBrainstormMode("a1", "brainstorm", 250);
        expect(getBrainstorm("a1")).toMatchObject({ mode: "brainstorm", lastViewedMs: 250 });
        setBrainstormMode("a1", "terminal", 400);
        expect(getBrainstorm("a1")).toMatchObject({ mode: "terminal", lastViewedMs: 250 });
    });

    it("finds the agent that has a topic attached", () => {
        attachBrainstorm("a1", LAG, 100);
        attachBrainstorm("a2", { topic: "other", cwd: "/p" }, 100);
        expect(brainstormOwner("other")).toBe("a2");
        expect(brainstormOwner("nope")).toBeNull();
    });

    it("opens and closes a board", () => {
        attachBrainstorm("a1", LAG, 100);
        openBrainstormBoard("a1", "Main.dc.html");
        expect(getBrainstorm("a1")?.board).toBe("Main.dc.html");
        openBrainstormBoard("a1", null);
        expect(getBrainstorm("a1")?.board).toBeNull();
    });

    it("ignores an update for an agent with nothing attached", () => {
        updateBrainstorm("a2", (s) => ({ ...s, mode: "brainstorm" }));
        expect(getBrainstorm("a2")).toBeNull();
    });
});

describe("review cursor", () => {
    const ids = ["x", "y", "z"];
    const cursor = () => getBrainstorm("a1")?.review.cursor;

    it("starts at the first row from no cursor, whichever way it moves", () => {
        attachBrainstorm("a1", LAG, 100);
        moveReviewCursor("a1", ids, -1);
        expect(cursor()).toBe("x");
        updateBrainstorm("a1", (s) => ({ ...s, review: { ...s.review, cursor: null } }));
        moveReviewCursor("a1", ids, 1);
        expect(cursor()).toBe("x");
    });

    it("moves by one and stops at both ends", () => {
        attachBrainstorm("a1", LAG, 100);
        setReviewCursor("a1", "y");
        moveReviewCursor("a1", ids, 1);
        expect(cursor()).toBe("z");
        moveReviewCursor("a1", ids, 1);
        expect(cursor()).toBe("z");
        setReviewCursor("a1", "x");
        moveReviewCursor("a1", ids, -1);
        expect(cursor()).toBe("x");
    });

    it("restarts at the first row when the cursor's row is gone", () => {
        attachBrainstorm("a1", LAG, 100);
        setReviewCursor("a1", "gone");
        moveReviewCursor("a1", ids, 1);
        expect(cursor()).toBe("x");
    });

    it("leaves the cursor alone with no rows", () => {
        attachBrainstorm("a1", LAG, 100);
        setReviewCursor("a1", "y");
        moveReviewCursor("a1", [], 1);
        expect(cursor()).toBe("y");
    });

    it("toggles one row open and closed, the others untouched", () => {
        attachBrainstorm("a1", LAG, 100);
        toggleReviewRow("a1", "x");
        toggleReviewRow("a1", "y");
        toggleReviewRow("a1", "x");
        expect(getBrainstorm("a1")?.review.open).toEqual({ x: false, y: true });
    });
});

describe("openBrainstormAt", () => {
    const TALK: BrainstormFile = {
        v: 1,
        title: "Consumer lag alerts",
        spec: "docs/specs/lag.md",
        canvas: "lag-canvas",
        question: { n: 4, text: "When should on-call get paged?", part: "thresholds" },
        working: null,
        parts: [
            { id: "intent", title: "Intent", state: "yours", body: "b" },
            { id: "thresholds", title: "When it pages", state: "asked", body: "" },
        ],
        history: [],
        done: false,
        check: null,
        run: null,
    };
    const CHECKING: BrainstormFile = {
        ...TALK,
        question: null,
        done: true,
        check: { yours: [], calls: [], answered: [] },
    };
    const arrange = (f: BrainstormFile) => {
        attachBrainstorm("a1", LAG, 100);
        updateBrainstorm("a1", (s) => ({ ...s, file: f }));
    };
    afterEach(() => IDS.forEach(detachCanvas));

    it("with a part, shows the Brainstorm pane with the design open and the part to open", () => {
        arrange(TALK);
        openBrainstormBoard("a1", "Main.dc.html");
        openBrainstormAt("a1", { part: "intent" });
        expect(getBrainstorm("a1")).toMatchObject({
            mode: "brainstorm",
            designOpen: true,
            board: null,
            partTarget: "intent",
        });
    });

    it("with a part in the check phase, puts the review cursor on it", () => {
        arrange(CHECKING);
        openBrainstormAt("a1", { part: "thresholds" });
        expect(getBrainstorm("a1")).toMatchObject({
            mode: "brainstorm",
            designOpen: true,
            partTarget: "thresholds",
            review: { cursor: "thresholds" },
        });
    });

    it("with a board, shows the pane's board view on that board of the brainstorm's canvas", () => {
        arrange(TALK);
        openBrainstormAt("a1", { board: "States.dc.html" });
        expect(getBrainstorm("a1")).toMatchObject({ mode: "brainstorm", board: "States.dc.html" });
        expect(getCanvas("a1")).toMatchObject({ topic: "lag-canvas", board: "States.dc.html", marking: false });
    });

    it("with a board and mark, turns marking on", () => {
        arrange(TALK);
        openBrainstormAt("a1", { board: "States.dc.html", mark: true });
        expect(getCanvas("a1")).toMatchObject({ board: "States.dc.html", marking: true });
    });

    it("with neither, shows the pane as it was", () => {
        arrange(TALK);
        openBrainstormBoard("a1", "Main.dc.html");
        openBrainstormAt("a1", {});
        expect(getBrainstorm("a1")).toMatchObject({ mode: "brainstorm", board: "Main.dc.html", designOpen: false });
        expect(getBrainstorm("a1")?.partTarget ?? null).toBeNull();
    });

    it("records when the pane was shown, as the header's switch does", () => {
        arrange(TALK);
        openBrainstormAt("a1", {}, 900);
        expect(getBrainstorm("a1")?.lastViewedMs).toBe(900);
    });

    it("does nothing for an agent with no brainstorm", () => {
        openBrainstormAt("a2", { part: "intent" });
        expect(getBrainstorm("a2")).toBeNull();
    });
});

describe("dismissBrainstorm", () => {
    it("detaches and clears the tab's brainstorm meta", async () => {
        rpc.SetMetaCommand.mockResolvedValue(undefined);
        attachBrainstorm("a1", LAG, 100);
        await dismissBrainstorm("a1");
        expect(getBrainstorm("a1")).toBeNull();
        expect(rpc.SetMetaCommand).toHaveBeenCalledWith(expect.anything(), {
            oref: "tab:a1",
            meta: { "session:brainstorm": null },
        });
    });

    it("still detaches when the meta write fails", async () => {
        rpc.SetMetaCommand.mockRejectedValue(new Error("no route"));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        attachBrainstorm("a1", LAG, 100);
        await dismissBrainstorm("a1");
        expect(getBrainstorm("a1")).toBeNull();
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});
