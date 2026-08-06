// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { assembleDefaultGroups, capGroups, isConfidentMatch, MAX_PER_GROUP, type GroupableItem } from "./palette-groups";
import { fuzzyScore } from "./palette-match";

const item = (key: string, kind: GroupableItem["kind"], search: string): GroupableItem => ({ key, kind, search });

// Builds a string that contains `q` as a maximally scattered subsequence: every query character is
// followed by filler, so it matches but never contiguously. Stands in for a long session task that a
// prose goal happens to be a subsequence of.
const scattered = (q: string) => [...q].map((c) => c + "zz").join("");

describe("isConfidentMatch", () => {
    it("accepts a surface name typed against its command row", () => {
        expect(isConfidentMatch("usage", [item("c1", "command", "Go to Usage")])).toBe(true);
    });
    it("rejects a prose goal that only scatter-matches", () => {
        const goal = "fix the flaky projectname test";
        const pool = [item("s1", "session", scattered(goal))];
        expect(fuzzyScore(goal, pool[0].search)).not.toBeNull(); // it really does match...
        expect(isConfidentMatch(goal, pool)).toBe(false); // ...but not densely enough to be a name
    });
    it("rejects an empty pool", () => {
        expect(isConfidentMatch("usage", [])).toBe(false);
    });
    it("rejects an empty query", () => {
        expect(isConfidentMatch("   ", [item("c1", "command", "Go to Usage")])).toBe(false);
    });
});

describe("assembleDefaultGroups", () => {
    const ranked = [item("c1", "command", "Go to Usage"), item("a1", "agent", "worker one")];
    const launchItems = [item("launch:quick", "launch", ""), item("launch:run", "launch", "")];
    const askItems = [item("ask-jarvis", "ask-jarvis", "")];

    it("leads with the ranked groups and trails with one act-on block on a confident match", () => {
        const groups = assembleDefaultGroups({ query: "usage", ranked, launchItems, askItems, recent: [] });
        expect(groups.map((g) => g.kind)).toEqual(["command", "agent", "act-on"]);
        expect(groups[0].items[0].key).toBe("c1"); // Enter navigates
        expect(groups[2].items.map((i) => i.key)).toEqual(["launch:quick", "launch:run", "ask-jarvis"]);
    });

    it("leads with the launch block when nothing matched confidently", () => {
        const goal = "fix the flaky projectname test";
        const groups = assembleDefaultGroups({ query: goal, ranked: [], launchItems, askItems, recent: [] });
        expect(groups.map((g) => g.kind)).toEqual(["launch", "ask-jarvis"]);
        expect(groups[0].items[0].key).toBe("launch:quick"); // Enter dispatches
    });

    it("leads with ask-jarvis when there is no active channel", () => {
        const groups = assembleDefaultGroups({ query: "some goal", ranked: [], launchItems: [], askItems, recent: [] });
        expect(groups.map((g) => g.kind)).toEqual(["ask-jarvis"]);
    });

    it("omits the act-on block when there is nothing to act with", () => {
        const groups = assembleDefaultGroups({ query: "usage", ranked, launchItems: [], askItems: [], recent: [] });
        expect(groups.map((g) => g.kind)).toEqual(["command", "agent"]);
    });

    it("leads with Recent on an empty query and does not repeat those rows below", () => {
        const groups = assembleDefaultGroups({
            query: "",
            ranked,
            launchItems: [],
            askItems: [],
            recent: [ranked[0]],
        });
        expect(groups.map((g) => g.kind)).toEqual(["recent", "agent"]);
        expect(groups[0].items.map((i) => i.key)).toEqual(["c1"]);
    });

    it("leads with the kind holding the best match, not a fixed kind order", () => {
        // a focus task that only scatter-matches must not sit above the command the user actually named:
        // Enter runs the first row, so a fixed focus-task-first order would navigate to the wrong thing
        const cmd = item("c1", "command", "Usage Go to");
        const focus = item("f1", "focus-task", scattered("usage"));
        const groups = assembleDefaultGroups({
            query: "usage",
            ranked: [cmd, focus], // ranked is best-first
            launchItems: [],
            askItems: [],
            recent: [],
        });
        expect(groups[0].kind).toBe("command");
        expect(groups[0].items[0].key).toBe("c1");
        expect(groups.map((g) => g.kind)).toEqual(["command", "focus-task"]);
    });

    it("keeps the fixed kind order on an empty query", () => {
        const cmd = item("c1", "command", "Usage Go to");
        const focus = item("f1", "focus-task", "some task");
        const groups = assembleDefaultGroups({
            query: "",
            ranked: [cmd, focus],
            launchItems: [],
            askItems: [],
            recent: [],
        });
        expect(groups.map((g) => g.kind)).toEqual(["focus-task", "command"]);
    });

    it("drops empty groups", () => {
        const groups = assembleDefaultGroups({
            query: "",
            ranked: [],
            launchItems: [],
            askItems: [],
            recent: [],
        });
        expect(groups).toEqual([]);
    });
});

describe("capGroups", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => item(`s${i}`, "session", `session ${i}`));

    it("caps a long group and reports what it dropped", () => {
        const [g] = capGroups([{ kind: "session", items: many(MAX_PER_GROUP + 7) }]);
        expect(g.items).toHaveLength(MAX_PER_GROUP);
        expect(g.overflow).toBe(7);
    });
    it("leaves a short group untouched and reports no overflow", () => {
        const [g] = capGroups([{ kind: "session", items: many(3) }]);
        expect(g.items).toHaveLength(3);
        expect(g.overflow).toBe(0);
    });
});
