// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentEntry } from "./agentsviewmodel";
import { boardKey, turnBoards, turnEntries, workingStep, workingTurn } from "./brainstormworking";

const CWD = "C:/proj";
const DIR = "C:\\proj\\.superpowers\\design";

function act(path: string, over: Partial<Extract<AgentEntry, { kind: "action" }>> = {}): AgentEntry {
    return {
        kind: "action",
        verb: "wrote",
        target: path.split(/[\\/]/).pop() ?? path,
        detail: { kind: "edit", files: [{ path, badge: "A", adds: 1, dels: 0, lines: [] }] },
        ...over,
    };
}

const user: AgentEntry = { kind: "user", text: "make it" };
const message: AgentEntry = { kind: "message", text: "on it" };

describe("turnEntries", () => {
    it("is what follows the last user entry", () => {
        const a = act(`${DIR}\\lag\\project\\A.dc.html`);
        expect(turnEntries([message, user, a, user, message])).toEqual([message]);
        expect(turnEntries([user, a])).toEqual([a]);
    });

    it("is cut by a command that is not a skill", () => {
        const a = act(`${DIR}\\lag\\project\\A.dc.html`);
        expect(turnEntries([a, { kind: "command", name: "/compact" }, message])).toEqual([message]);
    });

    it("is not cut by a skill command", () => {
        const a = act(`${DIR}\\lag\\project\\A.dc.html`);
        const skill: AgentEntry = { kind: "command", name: "/arc:design", isSkill: true };
        expect(turnEntries([a, skill, message])).toEqual([a, skill, message]);
    });

    it("is every entry when none is a prompt", () => {
        expect(turnEntries([message, message])).toEqual([message, message]);
        expect(turnEntries([])).toEqual([]);
    });
});

describe("turnBoards", () => {
    const page = `${DIR}\\lag\\project\\Page.dc.html`;
    const trend = `${DIR}\\lag\\project\\Page-trend.dc.html`;
    const names = (es: AgentEntry[], cwd = CWD) => turnBoards(es, cwd).boards.map((b) => `${b.canvas}/${b.name}`);

    it("lists each board the turn wrote, in first-write order, the last one latest", () => {
        const r = turnBoards([user, act(page), act(trend)], CWD);
        expect(r.boards).toEqual([
            { canvas: "lag", name: "Page.dc.html" },
            { canvas: "lag", name: "Page-trend.dc.html" },
        ]);
        expect(r.latest).toEqual({ canvas: "lag", name: "Page-trend.dc.html" });
    });

    it("keeps first-write order on an edit of an earlier board, which becomes the latest", () => {
        const r = turnBoards([user, act(page), act(trend), act(page, { verb: "edited" })], CWD);
        expect(r.boards.map((b) => b.name)).toEqual(["Page.dc.html", "Page-trend.dc.html"]);
        expect(r.latest?.name).toBe("Page.dc.html");
    });

    it("includes a board on a second canvas", () => {
        expect(names([user, act(page), act(`${DIR}\\other\\project\\B.dc.html`)])).toEqual([
            "lag/Page.dc.html",
            "other/B.dc.html",
        ]);
    });

    it("leaves out a write before the last prompt", () => {
        expect(names([act(page), user, act(trend)])).toEqual(["lag/Page-trend.dc.html"]);
    });

    it("matches a cwd spelled in another case and separator", () => {
        expect(names([user, act(page)], "c:\\proj\\")).toEqual(["lag/Page.dc.html"]);
    });

    it("takes a relative path against the cwd", () => {
        expect(names([user, act(".superpowers/design/lag/project/R.dc.html")])).toEqual(["lag/R.dc.html"]);
    });

    it("is not fooled by an unrelated action", () => {
        expect(turnBoards([user, message, { kind: "action", verb: "ran", target: "ls" }], CWD)).toEqual({
            boards: [],
            latest: null,
        });
    });

    it.each([
        ["a pending write", act(page, { pending: true })],
        ["a failed edit", act(page, { verb: "edited", outcome: "fail" })],
        ["another project", act("D:/elsewhere/.superpowers/design/lag/project/X.dc.html")],
        ["the feedback folder", act("C:/proj/.superpowers/design/lag/feedback/X.dc.html")],
        ["a nested folder", act("C:/proj/.superpowers/design/lag/project/sub/X.dc.html")],
        ["a plain html file", act("C:/proj/.superpowers/design/lag/project/X.html")],
        ["an action with no detail", { kind: "action", verb: "wrote", target: "X.dc.html" } as AgentEntry],
    ])("rejects %s", (_label, entry) => {
        expect(turnBoards([user, entry], CWD)).toEqual({ boards: [], latest: null });
    });
});

describe("boardKey", () => {
    it("joins canvas and name", () => {
        expect(boardKey({ canvas: "lag", name: "A.dc.html" })).toBe("lag/A.dc.html");
    });
});

describe("workingStep", () => {
    it("is the latest action of the turn, a pending one included", () => {
        const a = act(`${DIR}\\lag\\project\\Page-trend.dc.html`);
        expect(workingStep([user, a])).toEqual({ verb: "wrote", target: "Page-trend.dc.html" });
        expect(workingStep([user, a, { kind: "action", verb: "ran", target: "npm test", pending: true }])).toEqual({
            verb: "ran",
            target: "npm test",
        });
    });

    it("is null for a turn with no action", () => {
        expect(workingStep([user, message])).toBeNull();
    });

    it("ignores an action before the last prompt", () => {
        expect(workingStep([act("C:/proj/x.ts"), user])).toBeNull();
    });
});

describe("workingTurn", () => {
    const entries = [user, act(`${DIR}\\lag\\project\\Page.dc.html`)];

    it("is null unless the agent is working", () => {
        expect(workingTurn({ state: "idle" }, entries, CWD, 0, 1000)).toBeNull();
        expect(workingTurn({ state: "asking" }, entries, CWD, 0, 1000)).toBeNull();
    });

    it("carries the step, the boards and the elapsed time", () => {
        const now = 1_000_000;
        expect(workingTurn({ state: "working" }, entries, CWD, now - 102_000, now)).toEqual({
            step: { verb: "wrote", target: "Page.dc.html" },
            elapsed: "1m 42s",
            boards: [{ canvas: "lag", name: "Page.dc.html" }],
            latest: { canvas: "lag", name: "Page.dc.html" },
        });
    });

    it("keeps the step when the turn start is unknown", () => {
        const t = workingTurn({ state: "working" }, entries, CWD, undefined, 1000);
        expect(t?.elapsed).toBeNull();
        expect(t?.step?.verb).toBe("wrote");
    });

    it("has no step and no boards for a turn with no entries", () => {
        expect(workingTurn({ state: "working" }, [], CWD, 0, 5000)).toEqual({
            step: null,
            elapsed: "5s",
            boards: [],
            latest: null,
        });
    });
});
