// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import {
    dismissKey,
    isCockpitEmpty,
    shownForChip,
    splitRecentlyIdle,
    toggleInSet,
} from "./cockpitsurfacemodel";

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

describe("isCockpitEmpty", () => {
    it("is true only when every section is empty", () => {
        expect(isCockpitEmpty([], [], [])).toBe(true);
        expect(isCockpitEmpty([agent({})], [], [])).toBe(false);
        expect(isCockpitEmpty([], [agent({})], [])).toBe(false);
        expect(isCockpitEmpty([], [], [agent({})])).toBe(false);
    });
});

describe("shownForChip", () => {
    const all = [
        agent({ id: "a", state: "asking" }),
        agent({ id: "w", state: "working" }),
        agent({ id: "i", state: "idle" }),
    ];
    it("returns everything for the all chip", () => {
        expect(shownForChip(all, "all").map((a) => a.id)).toEqual(["a", "w", "i"]);
    });
    it("filters to the matching state for a status chip", () => {
        expect(shownForChip(all, "working").map((a) => a.id)).toEqual(["w"]);
        expect(shownForChip(all, "asking").map((a) => a.id)).toEqual(["a"]);
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
