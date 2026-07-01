// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import { activeMentionQuery, avatarColor, channelHasAsk, highlightSegments, mentionCandidates } from "./channelderive";
import type { RosterEntry } from "./channelmessages";

describe("avatarColor", () => {
    it("is deterministic for the same name", () => {
        expect(avatarColor("codex")).toBe(avatarColor("codex"));
    });

    it("pins 'you' to the accent token, case-insensitively", () => {
        expect(avatarColor("you")).toBe("var(--color-accent)");
        expect(avatarColor("YOU")).toBe("var(--color-accent)");
    });

    it("returns a palette token for other names", () => {
        const palette = new Set([
            "var(--color-avatar-1)",
            "var(--color-avatar-2)",
            "var(--color-avatar-3)",
            "var(--color-avatar-4)",
            "var(--color-avatar-5)",
            "var(--color-avatar-6)",
        ]);
        expect(palette.has(avatarColor("claude"))).toBe(true);
        expect(palette.has(avatarColor("antigravity"))).toBe(true);
    });
});

const agent = (id: string, state: AgentVM["state"]): AgentVM =>
    ({ id, name: id, task: "", state }) as AgentVM;

const chan = (messages: unknown[]): Channel => ({ messages } as unknown as Channel);

describe("channelHasAsk", () => {
    it("is true when a dispatched worker is asking", () => {
        const ch = chan([{ kind: "dispatch", reforef: "tab:a1" }]);
        expect(channelHasAsk(ch, [agent("a1", "asking")])).toBe(true);
    });

    it("is false when the dispatched worker is only working", () => {
        const ch = chan([{ kind: "dispatch", reforef: "tab:a1" }]);
        expect(channelHasAsk(ch, [agent("a1", "working")])).toBe(false);
    });

    it("is false when no dispatch/directive references an asking agent", () => {
        const ch = chan([{ kind: "human", reforef: "" }]);
        expect(channelHasAsk(ch, [agent("a1", "asking")])).toBe(false);
    });

    it("is true via a directive (steer) reference too", () => {
        const ch = chan([{ kind: "directive", reforef: "tab:a2" }]);
        expect(channelHasAsk(ch, [agent("a2", "asking")])).toBe(true);
    });

    it("is false for a channel with no messages", () => {
        expect(channelHasAsk(chan([]), [agent("a1", "asking")])).toBe(false);
    });
});

const roster = (...names: string[]): RosterEntry[] => names.map((name, i) => ({ id: `t${i}`, name }));

describe("mentionCandidates", () => {
    it("includes installed runtimes tagged as runtime", () => {
        const c = mentionCandidates(["claude", "codex"], []);
        expect(c).toContainEqual({ name: "claude", kind: "runtime" });
        expect(c).toContainEqual({ name: "codex", kind: "runtime" });
    });

    it("includes the jarvis manager handle", () => {
        expect(mentionCandidates([], [])).toContainEqual({ name: "jarvis", kind: "manager" });
    });

    it("includes live roster names tagged as agent", () => {
        expect(mentionCandidates([], roster("loom"))).toContainEqual({ name: "loom", kind: "agent" });
    });

    it("orders runtimes, then jarvis, then agents", () => {
        const names = mentionCandidates(["claude"], roster("loom")).map((c) => c.name);
        expect(names).toEqual(["claude", "jarvis", "loom"]);
    });

    it("dedupes case-insensitively, keeping the runtime over a same-named agent", () => {
        const c = mentionCandidates(["claude"], roster("Claude"));
        expect(c.filter((x) => x.name.toLowerCase() === "claude")).toEqual([{ name: "claude", kind: "runtime" }]);
    });
});

describe("activeMentionQuery", () => {
    it("returns null when there is no @ before the caret", () => {
        expect(activeMentionQuery("hello world", 11)).toBeNull();
    });

    it("triggers with an empty query right after a bare @", () => {
        expect(activeMentionQuery("@", 1)).toEqual({ query: "", start: 0 });
    });

    it("returns the token typed so far, up to the caret (not the end of string)", () => {
        // "@claude", caret between 'l' and 'a' -> query is "cl"
        expect(activeMentionQuery("@claude fix", 3)).toEqual({ query: "cl", start: 0 });
    });

    it("triggers on a mid-string @ preceded by whitespace", () => {
        expect(activeMentionQuery("ask @co", 7)).toEqual({ query: "co", start: 4 });
    });

    it("returns null when whitespace separates the @ from the caret", () => {
        expect(activeMentionQuery("@foo bar", 8)).toBeNull();
    });

    it("returns null when the @ is glued to a preceding non-space (e.g. an email)", () => {
        expect(activeMentionQuery("email@x", 7)).toBeNull();
    });
});

describe("highlightSegments", () => {
    const known = new Set(["claude", "codex", "jarvis"]);

    it("returns an empty array for empty text", () => {
        expect(highlightSegments("", known)).toEqual([]);
    });

    it("returns a single plain segment when there is no mention", () => {
        expect(highlightSegments("just text", known)).toEqual([{ text: "just text", mention: false }]);
    });

    it("marks a leading known @token as a mention", () => {
        expect(highlightSegments("@claude fix it", known)).toEqual([
            { text: "@claude", mention: true },
            { text: " fix it", mention: false },
        ]);
    });

    it("marks a mid-string known @token preceded by whitespace", () => {
        expect(highlightSegments("ask @codex now", known)).toEqual([
            { text: "ask ", mention: false },
            { text: "@codex", mention: true },
            { text: " now", mention: false },
        ]);
    });

    it("does not highlight an unknown @token", () => {
        expect(highlightSegments("@nope hi", known)).toEqual([{ text: "@nope hi", mention: false }]);
    });

    it("does not highlight an @ glued to a preceding non-space", () => {
        expect(highlightSegments("a@claude", known)).toEqual([{ text: "a@claude", mention: false }]);
    });

    it("matches the known target case-insensitively", () => {
        expect(highlightSegments("@Claude go", known)).toEqual([
            { text: "@Claude", mention: true },
            { text: " go", mention: false },
        ]);
    });
});
