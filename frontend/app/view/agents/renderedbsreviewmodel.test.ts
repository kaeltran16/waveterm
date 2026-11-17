// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import type { BrainstormFile, BrainstormPart } from "./brainstormmodel";
import { pickPart, sendBrainstorm } from "./brainstormsend";
import { attachBrainstorm, brainstormsAtom, getBrainstorm, shownPicks, updateBrainstorm } from "./brainstormstore";
import { reviewCardView, reviewPicksLine } from "./renderedbsreviewmodel";

const part = (id: string, o: Partial<BrainstormPart> = {}): BrainstormPart => ({
    id,
    title: id,
    state: "yours",
    body: `${id} body`,
    ...o,
});
const changed = (id: string): BrainstormPart =>
    part(id, { state: "guess", body: `${id} now. Same.`, was: `${id} was. Same.`, why: "answer 3" });

const FILE: BrainstormFile = {
    v: 1,
    title: "Run memory pressure",
    spec: "docs/specs/mem.md",
    question: null,
    working: null,
    parts: [
        changed("queue"),
        changed("gate"),
        changed("share"),
        part("fresh", { state: "guess", body: "a new guess" }),
        part("intent"),
        part("notes", { kind: "note" }),
    ],
    history: [],
    done: false,
    check: { yours: [], calls: [], answered: [], touched: ["queue", "gate", "share"] },
    run: null,
};

describe("reviewPicksLine", () => {
    it("counts the choices made and the decisions still open", () => {
        expect(reviewPicksLine({ picked: 1, open: 2 })).toBe("1 choice made, 2 still open");
        expect(reviewPicksLine({ picked: 3, open: 1 })).toBe("3 choices made, 1 still open");
    });

    it("says only the choices when none is left open", () => {
        expect(reviewPicksLine({ picked: 2, open: 0 })).toBe("2 choices made");
    });
});

describe("reviewCardView", () => {
    it("sections the review as checkReview does, with Keep all while more than one change waits", () => {
        const v = reviewCardView(FILE, {});
        expect(v.changed.map((r) => r.id)).toEqual(["queue", "gate", "share"]);
        expect(v.fresh.map((r) => r.id)).toEqual(["fresh"]);
        expect(v.unchanged.map((p) => p.id)).toEqual(["intent"]);
        expect(v.notes.map((p) => p.id)).toEqual(["notes"]);
        expect(v.keepAll).toBe(3);
        expect(v.picks).toBeNull();
        expect(v.summary).toContain("changed 3 decisions you had confirmed");
    });

    it("no Keep all for a single waiting change", () => {
        const one = { ...FILE, parts: [changed("queue"), part("intent")] };
        expect(reviewCardView(one, {}).keepAll).toBeNull();
    });

    it("a pick shows the picks line and the Send label, counting the guess still to confirm", () => {
        const v = reviewCardView(FILE, { queue: "keep" });
        expect(v.picks).toEqual({ line: "1 choice made, 3 still open", send: "Send 1 choice", picked: 1, open: 3 });
        expect(reviewCardView(FILE, { queue: "keep", gate: "restore" }).picks?.send).toBe("Send 2 choices");
    });

    it("drops a pick that no longer fits its decision", () => {
        expect(reviewCardView(FILE, { fresh: "keep" }).picks).toBeNull();
    });
});

describe("picking from the review card", () => {
    const AGENT = { id: "a1", name: "mem", blockId: "blk-1", project: "arc" } as AgentVM;
    const fakeIO = () => {
        const sent: string[] = [];
        return { sent, prompt: async (_b: string, text: string) => void sent.push(text), stopJudge: async () => {} };
    };

    beforeEach(() => {
        attachBrainstorm(AGENT.id, { topic: "mem", cwd: "/p" }, 0);
        updateBrainstorm(AGENT.id, (s) => ({ ...s, file: FILE }));
    });
    afterEach(() => globalStore.set(brainstormsAtom, {}));

    it("a pick is held in the brainstorm state the pane reads, and pressing it again takes it back", async () => {
        const io = fakeIO();
        await pickPart(AGENT, "queue", "keep", io, 1000);
        expect(shownPicks(getBrainstorm(AGENT.id)!)).toEqual({ queue: "keep" });
        expect(reviewCardView(FILE, shownPicks(getBrainstorm(AGENT.id)!)).picks?.picked).toBe(1);
        await pickPart(AGENT, "queue", "keep", io, 1000);
        expect(shownPicks(getBrainstorm(AGENT.id)!)).toEqual({});
        expect(io.sent).toEqual([]);
    });

    it("the pick that settles every decision sends the settle line", async () => {
        const io = fakeIO();
        await pickPart(AGENT, "queue", "keep", io, 1000);
        await pickPart(AGENT, "gate", "restore", io, 1000);
        await pickPart(AGENT, "share", "keep", io, 1000);
        expect(io.sent).toEqual([]);
        await pickPart(AGENT, "fresh", "confirm", io, 1000);
        expect(io.sent).toEqual(["brainstorm: settle keep queue, share; restore gate; confirm fresh"]);
    });

    it("Keep all sends the keep-every-change line", async () => {
        const io = fakeIO();
        await sendBrainstorm(AGENT, { kind: "keep-all" }, io, 1000);
        expect(io.sent).toEqual(["brainstorm: keep every change"]);
    });
});
