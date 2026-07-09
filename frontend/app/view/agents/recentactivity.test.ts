// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentEntry, AgentVM } from "./agentsviewmodel";
import { buildRecentActivity } from "./recentactivity";

const mk = (id: string, state: AgentVM["state"], extra: Partial<AgentVM> = {}): AgentVM => ({
    id,
    name: id,
    task: "",
    state,
    ...extra,
});

const msg = (text: string): AgentEntry => ({ kind: "message", text });
const act = (verb: string, target: string): AgentEntry => ({ kind: "action", verb, target });

describe("buildRecentActivity", () => {
    it("uses the last entry per agent and orders by lastActivity desc", () => {
        const agents = [mk("a", "working"), mk("b", "asking")];
        const entries = { a: [msg("hi"), act("Read", "foo.ts")], b: [msg("question?")] };
        const last = { a: 100, b: 200 };
        const out = buildRecentActivity(agents, entries, last, 5, 0);
        expect(out.map((i) => i.id)).toEqual(["b", "a"]);
        expect(out[0]).toEqual({ id: "b", agent: "b", text: "question?", typeLabel: "said", ts: 200, state: "asking" });
        expect(out[1]).toEqual({ id: "a", agent: "a", text: "Read foo.ts", typeLabel: "Read", ts: 100, state: "working" });
    });
    it("labels a user entry 'you'", () => {
        const out = buildRecentActivity([mk("a", "working")], { a: [{ kind: "user", text: "go" }] }, { a: 5 }, 5, 0);
        expect(out[0].typeLabel).toBe("you");
        expect(out[0].text).toBe("go");
    });
    it("describes a command entry with its slash name and args", () => {
        const out = buildRecentActivity([mk("a", "working")], { a: [{ kind: "command", name: "/review", args: "PR #402" }] }, { a: 5 }, 5, 0);
        expect(out[0]).toMatchObject({ text: "/review PR #402", typeLabel: "command" });
    });

    it("describes a skill command with a slash-prefixed leaf name", () => {
        const out = buildRecentActivity([mk("a", "working")], { a: [{ kind: "command", name: "brainstorming", args: "x", isSkill: true }] }, { a: 5 }, 5, 0);
        expect(out[0]).toMatchObject({ text: "/brainstorming x", typeLabel: "skill" });
    });

    it("describes a compaction entry as compacted", () => {
        const out = buildRecentActivity([mk("a", "working")], { a: [{ kind: "compaction", trigger: "manual", preTokens: 1, postTokens: 1 }] }, { a: 5 }, 5, 0);
        expect(out[0]).toMatchObject({ text: "Conversation compacted", typeLabel: "compacted" });
    });

    it("falls back to previousInfo when no live entries exist", () => {
        const agents = [mk("a", "asking", { previousInfo: [msg("seeded")] })];
        const out = buildRecentActivity(agents, {}, {}, 5, 0);
        expect(out[0].text).toBe("seeded");
        expect(out[0].ts).toBe(0);
    });
    it("derives ts from now minus blockedMs/activeMs when no live timestamp", () => {
        const asking = buildRecentActivity([mk("a", "asking", { blockedMs: 60_000, previousInfo: [msg("q")] })], {}, {}, 5, 1_000_000);
        expect(asking[0].ts).toBe(940_000); // now - blockedMs -> a real "1m ago", not 1970
        const working = buildRecentActivity([mk("b", "working", { activeMs: 30_000, previousInfo: [msg("w")] })], {}, {}, 5, 1_000_000);
        expect(working[0].ts).toBe(970_000); // now - activeMs
    });
    it("skips agents with no entries and slices to max", () => {
        const agents = [mk("a", "working"), mk("b", "working"), mk("c", "working")];
        const entries = { a: [msg("a")], b: [msg("b")], c: [msg("c")] };
        const last = { a: 1, b: 2, c: 3 };
        const out = buildRecentActivity(agents, entries, last, 2, 0);
        expect(out.map((i) => i.id)).toEqual(["c", "b"]);
        expect(buildRecentActivity([mk("d", "idle")], entries, last, 2, 0).map((i) => i.id)).toEqual([]);
    });
});
