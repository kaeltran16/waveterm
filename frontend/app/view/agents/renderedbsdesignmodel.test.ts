// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import type { BrainstormFile, BrainstormPart, PartState } from "./brainstormmodel";
import { pickPart, sendBrainstorm } from "./brainstormsend";
import { attachBrainstorm, brainstormsAtom, shownPicks, updateBrainstorm } from "./brainstormstore";
import { cardRowPick, designView, waitingLine } from "./renderedbsdesignmodel";

const PART_TITLES: [string, string][] = [
    ["what", "What counts"],
    ["who", "Who it protects"],
    ["approach", "Approach"],
    ["queue", "Final queue"],
    ["banner", "Banner"],
];
const part = (id: string, state: PartState, over: Partial<BrainstormPart> = {}): BrainstormPart => ({
    id,
    title: PART_TITLES.find(([i]) => i === id)?.[1] ?? id,
    state,
    body: "",
    ...over,
});
const parts = (states: PartState[], over: Record<string, Partial<BrainstormPart>> = {}) =>
    PART_TITLES.map(([id], i) => part(id, states[i], over[id]));

const answered = (n: number, into: string[]) => ({ kind: "question" as const, n, q: `q${n}`, a: `a${n}`, into });
const FILE: BrainstormFile = {
    v: 1,
    title: "Run memory pressure",
    spec: "docs/specs/mem.md",
    question: null,
    working: null,
    parts: parts(["yours", "yours", "yours", "guess", "guess"], {
        queue: { gist: "Queue verifies one at a time", boards: ["queue.html"] },
        banner: { gist: "Warn after 20 minutes" },
    }),
    history: [answered(1, ["what"]), answered(2, ["who"]), answered(3, ["approach"])],
    done: true,
    check: null,
    run: null,
};

describe("designView while guesses wait", () => {
    it("says what stands, offers Confirm all for two guesses and one row per decision in the pane's order", () => {
        const v = designView(FILE, "http://b");
        expect(v.settled).toBe(false);
        expect(v.line).toBe(
            "2 decisions are still the agent’s guess. Each reads in one line; open one to read it whole."
        );
        expect(v.confirmAll).toBe(2);
        expect(v.rows.map((r) => r.id)).toEqual(["banner", "queue", "approach", "who", "what"]);
        expect(v.rows[0]).toMatchObject({ title: "Banner", gist: "Warn after 20 minutes", view: "guess" });
        expect(v.waiting).toBe("Waiting for you: confirm the design, then Check with a builder");
    });

    it("offers That's right on a guess, and none on a decision that is already yours", () => {
        const byId = Object.fromEntries(designView(FILE, "http://b").rows.map((r) => [r.id, r]));
        expect(byId.banner.pick).toBe("confirm");
        expect(byId.queue.pick).toBe("confirm");
        expect(byId.what.pick).toBeNull();
    });

    it("one guess has its own That's right, so no Confirm all", () => {
        const f = { ...FILE, parts: parts(["yours", "yours", "yours", "yours", "guess"]) };
        const v = designView(f, "http://b");
        expect(v.confirmAll).toBeNull();
        expect(v.rows[0].pick).toBe("confirm");
    });

    it("links a decision's board only once the canvas is served", () => {
        const withCanvas = { ...FILE, canvas: "mem" };
        const row = (v: ReturnType<typeof designView>) => v.rows.find((r) => r.id === "queue");
        expect(row(designView(withCanvas, "http://b"))?.board).toBe("queue.html");
        expect(row(designView(withCanvas, null))?.board).toBeNull();
        expect(row(designView(FILE, "http://b"))?.board).toBeNull();
    });
});

describe("designView with a reopened decision", () => {
    const reopened = {
        ...FILE,
        parts: parts(["yours", "yours", "yours", "yours", "guess"], {
            banner: { gist: "Warn after 10 minutes", was: "Warn after 20 minutes" },
        }),
    };

    it("marks it changed and gives it That's right, which keeps the agent's change", () => {
        const v = designView(reopened, null);
        expect(v.rows[0]).toMatchObject({ id: "banner", view: "changed", pick: "keep" });
        expect(v.line).toBe(
            "1 decision changed since you confirmed it. Each reads in one line; open one to read it whole."
        );
        expect(v.confirmAll).toBeNull();
    });

    it("counts a changed one apart from the guesses Confirm all confirms", () => {
        const f = {
            ...reopened,
            parts: parts(["yours", "yours", "yours", "guess", "guess"], { banner: { was: "x" } }),
        };
        expect(designView(f, null).confirmAll).toBeNull();
        expect(cardRowPick(f, f.parts[4])).toBe("keep");
    });
});

describe("designView with every decision yours", () => {
    const yours = { ...FILE, parts: parts(["yours", "yours", "yours", "yours", "yours"]) };

    it("is settled, with the builder check next and no waiting line", () => {
        const v = designView(yours, null);
        expect(v.settled).toBe(true);
        expect(v.waiting).toBeNull();
        expect(v.confirmAll).toBeNull();
        expect(v.check).toBe(true);
    });

    it("counts the decisions yours and the guesses confirmed rather than answered", () => {
        expect(designView(yours, null).line).toBe("The design · 5 of 5 yours");
        expect(designView(yours, null).confirmed).toBe("you confirmed 2 guesses");
    });

    it("leaves the confirmed count out when every decision was answered", () => {
        const all = {
            ...yours,
            history: [...yours.history, answered(4, ["queue"]), answered(5, ["banner"])],
        };
        expect(designView(all, null).line).toBe("The design · 5 of 5 yours");
        expect(designView(all, null).confirmed).toBeNull();
    });

    it("a question that answered several parts counts them all as answered", () => {
        const f = { ...yours, history: [answered(1, ["what", "who", "approach", "queue"])] };
        expect(designView(f, null).confirmed).toBe("you confirmed 1 guess");
    });

    it("says nothing of a check already pending", () => {
        expect(designView(yours, null, { kind: "pending", stage: "reading" } as never).check).toBe(false);
    });
});

describe("designView's notes", () => {
    it("lists what the agent found apart from the decisions, which never count them", () => {
        const f = {
            ...FILE,
            parts: [
                ...FILE.parts,
                part("recon", "yours", { kind: "note", title: "Recon", gist: "Three Finals overlapped" }),
            ],
        };
        const v = designView(f, null);
        expect(v.notes).toEqual([{ id: "recon", title: "Recon", gist: "Three Finals overlapped" }]);
        expect(v.rows.map((r) => r.id)).not.toContain("recon");
    });
});

describe("waitingLine", () => {
    it("names what the card waits on", () => {
        expect(waitingLine()).toBe("Waiting for you: confirm the design, then Check with a builder");
    });
});

describe("picking from the card", () => {
    const AGENT = { id: "a1", name: "mem", blockId: "blk-1", project: "arc" } as AgentVM;
    const fakeIO = () => {
        const sent: string[] = [];
        return { sent, prompt: async (_b: string, text: string) => void sent.push(text), stopJudge: async () => {} };
    };

    beforeEach(() => attachBrainstorm(AGENT.id, { topic: "mem", cwd: "/p" }, 0));
    afterEach(() => globalStore.set(brainstormsAtom, {}));

    it("That's right on the first of two guesses is held and shown pressed, sending nothing", async () => {
        updateBrainstorm(AGENT.id, (s) => ({ ...s, file: FILE }));
        const io = fakeIO();
        const row = designView(FILE, null).rows[0];
        await pickPart(AGENT, row.id, row.pick!, io, 1000);
        expect(io.sent).toEqual([]);
        expect(shownPicks(globalStore.get(brainstormsAtom)[AGENT.id])).toEqual({ banner: "confirm" });
    });

    it("That's right on the last waiting guess sends the pane's settle line", async () => {
        updateBrainstorm(AGENT.id, (s) => ({ ...s, file: FILE }));
        const io = fakeIO();
        // the pane's pick path is pickPart, which settles once every guess has one
        for (const row of designView(FILE, null).rows.filter((r) => r.pick != null)) {
            await pickPart(AGENT, row.id, row.pick!, io, 1000);
        }
        expect(io.sent).toEqual(["brainstorm: settle confirm queue, banner"]);
    });

    it("That's right on the reopened decision sends the settle line that keeps it", async () => {
        const f = { ...FILE, parts: parts(["yours", "yours", "yours", "yours", "guess"], { banner: { was: "old" } }) };
        updateBrainstorm(AGENT.id, (s) => ({ ...s, file: f }));
        const io = fakeIO();
        const row = designView(f, null).rows[0];
        await pickPart(AGENT, row.id, row.pick!, io, 1000);
        expect(io.sent).toEqual(["brainstorm: settle keep banner"]);
    });

    it("Confirm all sends the pane's line", async () => {
        updateBrainstorm(AGENT.id, (s) => ({ ...s, file: FILE }));
        const io = fakeIO();
        await sendBrainstorm(AGENT, { kind: "confirm-all" }, io, 1000, "transcript");
        expect(io.sent).toEqual(["brainstorm: confirm every guess"]);
    });

    it("Check with a builder sends the pane's line once every decision is yours", async () => {
        const f = { ...FILE, parts: parts(["yours", "yours", "yours", "yours", "yours"]) };
        updateBrainstorm(AGENT.id, (s) => ({ ...s, file: f }));
        const io = fakeIO();
        await sendBrainstorm(AGENT, { kind: "check" }, io, 1000, "transcript");
        expect(io.sent).toEqual(["brainstorm: check"]);
    });
});
