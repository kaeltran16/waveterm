import { describe, expect, it } from "vitest";
import type { AgentRow } from "./mention-core";
import {
    isTaggable,
    mentionContext,
    mentionQuery,
    needsFetch,
    parseAgents,
    submittedTags,
    suggestions,
    tagOf,
} from "./mention-core";

const reviewer: AgentRow = {
    tabid: "a1b2c3d4-0000-4000-8000-000000000001",
    name: "reviewer",
    harness: "claude",
    state: "idle",
    title: "reviewing the boards diff",
};
const benchmark: AgentRow = {
    tabid: "e5f6a7b8-0000-4000-8000-000000000002",
    name: "waveterm",
    harness: "claude",
    state: "working",
    title: "Benchmark sonnet workers",
};
const explore: AgentRow = {
    tabid: "c9d0e1f2-0000-4000-8000-000000000003",
    name: "waveterm",
    harness: "claude",
    state: "idle",
    title: "Explore improvement areas",
};
const designLead: AgentRow = {
    tabid: "f3a4b5c6-0000-4000-8000-000000000004",
    name: "Design Lead",
    harness: "pi",
    state: "idle",
};
const roster: AgentRow[] = [reviewer, benchmark, explore, designLead];

describe("mentionQuery", () => {
    it("is the text after @@ for a token that starts with it", () => {
        expect(mentionQuery("@@rev")).toBe("rev");
        expect(mentionQuery("@@")).toBe("");
    });
    it("is null for a bare @ token or @@ inside a word", () => {
        expect(mentionQuery("@rev")).toBeNull();
        expect(mentionQuery("x@@")).toBeNull();
    });
});

describe("needsFetch", () => {
    it("fetches when a new tag starts, even at the cached position", () => {
        expect(needsFetch(4, "@@", 4)).toBe(true);
    });
    it("fetches when the token moved", () => {
        expect(needsFetch(4, "@@r", 9)).toBe(true);
    });
    it("reuses the cache while the same token is typed", () => {
        expect(needsFetch(4, "@@re", 4)).toBe(false);
    });
    it("fetches with no cache", () => {
        expect(needsFetch(null, "@@re", 4)).toBe(true);
    });
});

describe("parseAgents", () => {
    it("reads an empty list", () => {
        expect(parseAgents("[]")).toEqual([]);
    });
    it("reads wsh's rows", () => {
        const out = JSON.stringify([{ ...reviewer, projectpath: "/p", project: "p", runid: "" }]);
        expect(parseAgents(out)).toEqual([reviewer]);
    });
    it("throws on a non-array or non-JSON", () => {
        expect(() => parseAgents('{"x":1}')).toThrow();
        expect(() => parseAgents("not json")).toThrow();
    });
});

describe("tagOf", () => {
    it("is the slug of a unique name", () => {
        expect(tagOf(reviewer, roster)).toBe("@@reviewer");
        expect(tagOf(designLead, roster)).toBe("@@design-lead");
    });
    it("adds the short tab id when another row shares the slug", () => {
        expect(tagOf(benchmark, roster)).toBe("@@waveterm-e5f6a7b8");
        expect(tagOf(explore, roster)).toBe("@@waveterm-c9d0e1f2");
    });
    it("falls back to the short tab id for an empty name", () => {
        const nameless = { ...reviewer, name: "" };
        expect(tagOf(nameless, [nameless])).toBe("@@a1b2c3d4");
    });
});

describe("suggestions", () => {
    it("lists every row in wsh's order for an empty query", () => {
        expect(suggestions(roster, "").map((s) => s.text)).toEqual([
            "@@reviewer",
            "@@waveterm-e5f6a7b8",
            "@@waveterm-c9d0e1f2",
            "@@design-lead",
        ]);
    });
    it("matches the title", () => {
        expect(suggestions(roster, "bench").map((s) => s.text)).toEqual(["@@waveterm-e5f6a7b8"]);
    });
    it("matches the tab id, case-insensitively", () => {
        expect(suggestions(roster, "A1B2").map((s) => s.text)).toEqual(["@@reviewer"]);
    });
    it("is empty when nothing matches", () => {
        expect(suggestions(roster, "zzz")).toEqual([]);
        expect(suggestions([], "")).toEqual([]);
    });
    it("describes a row by short id, harness, state and title", () => {
        expect(suggestions(roster, "reviewer")[0]).toEqual({
            text: "@@reviewer",
            label: "@@reviewer",
            description: "a1b2c3d4 claude idle · reviewing the boards diff",
        });
    });
    it("leaves the title out when there is none, and keeps a title on one line", () => {
        expect(suggestions(roster, "design")[0]?.description).toBe("f3a4b5c6 pi idle");
        const multi = { ...reviewer, title: "  line one\n\tline two " };
        expect(suggestions([multi], "")[0]?.description).toBe("a1b2c3d4 claude idle · line one line two");
    });
});

describe("submittedTags", () => {
    it("finds tags, stops at punctuation and dedupes case-insensitively", () => {
        expect(submittedTags("ask @@reviewer, then @@Reviewer and (@@waveterm-e5f6a7b8)")).toEqual([
            "@@reviewer",
            "@@waveterm-e5f6a7b8",
        ]);
        expect(submittedTags("@@reviewer? done")).toEqual(["@@reviewer"]);
    });
    it("ignores diff hunk headers and @@ inside words", () => {
        expect(submittedTags("@@ -1,3 +1,4 @@")).toEqual([]);
        expect(submittedTags("foo@@bar")).toEqual([]);
        expect(submittedTags("@@@x")).toEqual([]);
    });
});

describe("isTaggable", () => {
    it("takes the user's own composer prompts", () => {
        expect(isTaggable({ origin: { kind: "composer" } })).toBe(true);
    });
    it("leaves other origins alone, so a quoted @@x never makes this agent message a third one", () => {
        for (const kind of ["plugin", "bridge", "peer"]) {
            expect(isTaggable({ origin: { kind } })).toBe(false);
        }
    });
    it("leaves slash commands alone", () => {
        expect(isTaggable({ origin: { kind: "composer" }, command: { name: "review" } })).toBe(false);
    });
});

describe("mentionContext", () => {
    it("names the tab and how to reach it", () => {
        const ctx = mentionContext(["@@reviewer"], roster);
        expect(ctx).toContain(reviewer.tabid);
        expect(ctx).toContain(`wsh agents send ${reviewer.tabid}`);
        expect(ctx).toContain(`wsh agents read ${reviewer.tabid}`);
        expect(ctx).toContain(`wsh agents wait ${reviewer.tabid}`);
        expect(ctx).toContain("--wait");
        expect(ctx).toContain("what the user asked");
        expect(ctx).toContain("reviewing the boards diff");
    });
    it("resolves a tag whatever its case", () => {
        expect(mentionContext(["@@REVIEWER"], roster)).toContain(reviewer.tabid);
    });
    it("resolves a hand-typed tab id prefix", () => {
        expect(mentionContext(["@@a1b2"], roster)).toContain(reviewer.tabid);
    });
    it("resolves each duplicate-name tag to its own tab", () => {
        const first = mentionContext(["@@waveterm-e5f6a7b8"], roster);
        expect(first).toContain(benchmark.tabid);
        expect(first).not.toContain(explore.tabid);
        const second = mentionContext(["@@waveterm-c9d0e1f2"], roster);
        expect(second).toContain(explore.tabid);
        expect(second).not.toContain(benchmark.tabid);
    });
    it("resolves a plain slug when exactly one row has it", () => {
        expect(mentionContext(["@@waveterm"], [reviewer, explore])).toContain(explore.tabid);
    });
    it("calls a slug two rows share ambiguous and asks the user which", () => {
        const ctx = mentionContext(["@@waveterm"], roster);
        expect(ctx).toContain("e5f6a7b8");
        expect(ctx).toContain("c9d0e1f2");
        expect(ctx).toContain("ambiguous");
        expect(ctx).toContain("ask the user");
        expect(ctx).not.toContain(`wsh agents send ${benchmark.tabid}`);
    });
    it("resolves a picked duplicate tag after the other duplicate closed", () => {
        expect(mentionContext(["@@waveterm-e5f6a7b8"], [reviewer, benchmark])).toContain(benchmark.tabid);
    });
    it("says a tag names no live agent", () => {
        const ctx = mentionContext(["@@gone"], roster);
        expect(ctx).toContain("@@gone");
        expect(ctx).toContain("no live agent");
    });
    it("calls a too-short or shared id prefix unknown or ambiguous, never a guess", () => {
        expect(mentionContext(["@@a1b"], roster)).toContain("no live agent");
        const twin = { ...explore, tabid: "a1b2ffff-0000-4000-8000-000000000005", name: "other" };
        expect(mentionContext(["@@a1b2"], [reviewer, twin])).toContain("ambiguous");
    });
    it("says when the roster could not be read", () => {
        const ctx = mentionContext(["@@reviewer"], { error: "wsh exited 1: boom" });
        expect(ctx).toContain("boom");
        expect(ctx).toContain("wsh agents list");
        expect(ctx).toContain("@@reviewer");
    });
});
