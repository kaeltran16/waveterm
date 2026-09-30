// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import { cardHasContent, dismissKey, rosterLoadPhase, splitRecentlyIdle, toggleInSet } from "./cockpitsurfacemodel";

function agent(over: Partial<AgentVM>): AgentVM {
    return { id: "t1", name: "claude", task: "", state: "working", ...over };
}

describe("dismissKey", () => {
    it("keys a dismissal by id and idle episode", () => {
        expect(dismissKey({ id: "t1", idleSince: 500 })).toBe("t1:500");
    });
    it("uses an empty episode suffix when idleSince is absent", () => {
        expect(dismissKey({ id: "t1", idleSince: undefined })).toBe("t1:");
    });
});

describe("rosterLoadPhase", () => {
    it("is loading, never empty, while an empty roster has not been read yet", () => {
        expect(rosterLoadPhase(false, 0)).toBe("loading");
    });
    it("is empty once the roster has been read and holds no agents", () => {
        expect(rosterLoadPhase(true, 0)).toBe("empty");
    });
    it("is ready whenever there are agents to show, read or not", () => {
        expect(rosterLoadPhase(false, 2)).toBe("ready");
        expect(rosterLoadPhase(true, 1)).toBe("ready");
    });
});

describe("splitRecentlyIdle", () => {
    const now = 100_000;
    it("routes within-grace, non-dismissed idle agents to recently and the rest to parked", () => {
        // isRecentlyIdle uses agentsviewmodel's IDLE_GRACE_MS; fresh idleSince = recent, old = parked.
        const fresh = agent({ id: "fresh", state: "idle", idleSince: now - 1000 });
        const old = agent({ id: "old", state: "idle", idleSince: now - 10 * 60_000 });
        const { recently, parked } = splitRecentlyIdle([fresh, old], now, new Set());
        expect(recently.map((a) => a.id)).toEqual(["fresh"]);
        expect(parked.map((a) => a.id)).toEqual(["old"]);
    });
    it("moves a dismissed-but-recent agent to parked (dismissal wins)", () => {
        const fresh = agent({ id: "fresh", state: "idle", idleSince: now - 1000 });
        const dismissed = new Set([dismissKey(fresh)]);
        const { recently, parked } = splitRecentlyIdle([fresh], now, dismissed);
        expect(recently).toEqual([]);
        expect(parked.map((a) => a.id)).toEqual(["fresh"]);
    });
});

describe("toggleInSet", () => {
    it("adds an absent id", () => {
        expect([...toggleInSet(new Set(["a"]), "b")].sort()).toEqual(["a", "b"]);
    });
    it("removes a present id", () => {
        expect([...toggleInSet(new Set(["a", "b"]), "a")]).toEqual(["b"]);
    });
    it("does not mutate the input set", () => {
        const input = new Set(["a"]);
        toggleInSet(input, "b");
        expect([...input]).toEqual(["a"]);
    });
});

describe("cardHasContent", () => {
    it("hides a just-launched agent that has reported nothing yet", () => {
        expect(cardHasContent(agent({ state: "working" }), false)).toBe(false);
    });
    it("hides an idle agent that never produced a transcript entry", () => {
        expect(cardHasContent(agent({ state: "idle" }), false)).toBe(false);
    });
    it("shows an agent once its transcript has entries", () => {
        expect(cardHasContent(agent({ state: "idle" }), true)).toBe(true);
    });
    it("shows seeded previous info before the live stream arrives", () => {
        expect(cardHasContent(agent({ previousInfo: [{ kind: "message", text: "hi" }] }), false)).toBe(true);
    });
    it("shows a working agent with a live activity line", () => {
        expect(cardHasContent(agent({ state: "working", activity: "reading a.ts" }), false)).toBe(true);
    });
    it("ignores an idle reason, which the card never renders", () => {
        expect(cardHasContent(agent({ state: "idle", activity: "done" }), false)).toBe(false);
    });
    it("always shows an asking agent", () => {
        expect(cardHasContent(agent({ state: "asking" }), false)).toBe(true);
    });
});
