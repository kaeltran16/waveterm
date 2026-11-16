// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentEntry } from "./agentsviewmodel";
import { lastPrompt, pinnedPrompt } from "./pinnedprompt";

const user = (text: string): AgentEntry => ({ kind: "user", text });
const msg = (text: string): AgentEntry => ({ kind: "message", text });
const SCROLLER = { top: 100 };

describe("pinnedPrompt", () => {
    const entries = [user("first"), msg("a"), user("  second  "), msg("b")];

    it("pins the last prompt once its bubble is wholly above the scroller's top", () => {
        expect(pinnedPrompt(entries, { bottom: 99 }, SCROLLER)).toEqual({ index: 2, text: "second" });
        expect(pinnedPrompt(entries, { bottom: 100 }, SCROLLER)).toEqual({ index: 2, text: "second" });
    });

    it("pins nothing while any of the bubble is in view, or with no bubble laid out", () => {
        expect(pinnedPrompt(entries, { bottom: 101 }, SCROLLER)).toBeNull();
        expect(pinnedPrompt(entries, null, SCROLLER)).toBeNull();
    });

    it("pins nothing without a user entry", () => {
        expect(pinnedPrompt([msg("a"), msg("b")], { bottom: 0 }, SCROLLER)).toBeNull();
        expect(pinnedPrompt([], { bottom: 0 }, SCROLLER)).toBeNull();
    });
});

describe("lastPrompt", () => {
    it("skips the user entries Arc typed", () => {
        const entries = [user("fix it"), msg("ok"), user("wake: task t-2 landed"), user("brainstorm: pick one")];
        expect(lastPrompt(entries)).toEqual({ index: 0, text: "fix it" });
    });

    it("a run agent's first prompt is its brief, so it is not pinned", () => {
        const ctx = { role: { kind: "lead" as const, runId: "r-1" } };
        expect(lastPrompt([user("the brief"), msg("ok")], ctx)).toBeNull();
        expect(lastPrompt([user("the brief"), msg("ok"), user("and this")], ctx)).toEqual({
            index: 2,
            text: "and this",
        });
        expect(lastPrompt([user("a plain prompt")])).toEqual({ index: 0, text: "a plain prompt" });
    });
});
