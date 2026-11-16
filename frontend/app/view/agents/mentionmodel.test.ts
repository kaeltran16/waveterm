// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import {
    appendMentions,
    insertMention,
    keptMentions,
    mentionRows,
    mentionTargets,
    mentionToken,
    type MentionRow,
} from "./mentionmodel";

const vm = (id: string, name: string, extra: Partial<AgentVM> = {}): AgentVM => ({
    id,
    name,
    task: "",
    state: "idle",
    agent: "claude",
    project: "waveterm",
    ...extra,
});

const self = vm("00000000-self", "loom");
const reviewer = vm("a1b2c3d4-0000", "reviewer", { state: "working", task: "Review the motion diff" });
const benchmark = vm("e5f6a7b8-0000", "waveterm", { agent: "pi", task: "Benchmark verify.mjs" });
const explore = vm("c9d0e1f2-0000", "waveterm", { task: "Explore usage attribution" });

describe("mentionToken", () => {
    it("finds the @ token ending at the caret", () => {
        expect(mentionToken("ask @rev", 8)).toEqual({ start: 4, query: "rev" });
        expect(mentionToken("@", 1)).toEqual({ start: 0, query: "" });
    });

    it("ignores an @ inside a word, a @@ and a token the caret has left", () => {
        expect(mentionToken("me@host", 7)).toBeNull();
        expect(mentionToken("@@ -1,3", 2)).toBeNull();
        expect(mentionToken("@rev now", 8)).toBeNull();
    });

    it("stops at a path, so a typed @file is not an agent query", () => {
        expect(mentionToken("@src/a.ts", 9)).toBeNull();
    });
});

describe("mentionTargets", () => {
    it("keeps this project's other claude and pi agents", () => {
        const roster = [
            self,
            reviewer,
            benchmark,
            vm("x", "codexer", { agent: "codex" }),
            vm("y", "elsewhere", { project: "siem" }),
            vm("z", "shell", { kind: "terminal" }),
        ];
        expect(mentionTargets(roster, self).map((a) => a.id)).toEqual([reviewer.id, benchmark.id]);
    });
});

describe("mentionRows", () => {
    const targets = [reviewer, benchmark, explore];

    it("tells same-named tabs apart by their short id", () => {
        expect(mentionRows(targets, "").map((r) => r.tag)).toEqual([
            "reviewer",
            "waveterm-e5f6a7b8",
            "waveterm-c9d0e1f2",
        ]);
    });

    it("matches the tag, the tab id and the title", () => {
        expect(mentionRows(targets, "REV").map((r) => r.tag)).toEqual(["reviewer"]);
        expect(mentionRows(targets, "c9d0").map((r) => r.tag)).toEqual(["waveterm-c9d0e1f2"]);
        expect(mentionRows(targets, "bench").map((r) => r.tag)).toEqual(["waveterm-e5f6a7b8"]);
    });
});

describe("insertMention", () => {
    it("replaces the token with the tag and moves the caret past it", () => {
        const text = "ask @re about it";
        const out = insertMention(text, { start: 4, query: "re" }, 7, "reviewer");
        expect(out.text).toBe("ask @reviewer about it");
        expect(out.caret).toBe("ask @reviewer ".length);
    });
});

const pick = (tag: string, tabId: string): MentionRow => ({
    tabId,
    tag,
    state: "idle",
    harness: "claude",
    id8: tabId.slice(0, 8),
    title: "",
});

describe("keptMentions", () => {
    it("keeps picks still in the text, once each, and only whole tags", () => {
        const picks = [pick("reviewer", "t1"), pick("reviewer", "t1"), pick("lead", "t2"), pick("wave", "t3")];
        expect(keptMentions("ask @reviewer and @waveterm", picks).map((p) => p.tabId)).toEqual(["t1"]);
    });
});

describe("appendMentions", () => {
    it("leaves text with no kept pick as it is", () => {
        expect(appendMentions("read @src/a.ts", [pick("reviewer", "t1")])).toBe("read @src/a.ts");
    });

    it("keeps the text and names each kept pick's tab", () => {
        const out = appendMentions("ask @reviewer", [pick("reviewer", "tab-1"), pick("lead", "tab-2")]);
        expect(out.startsWith("ask @reviewer\n\n")).toBe(true);
        expect(out).toContain("tab-1");
        expect(out).not.toContain("tab-2");
    });
});
