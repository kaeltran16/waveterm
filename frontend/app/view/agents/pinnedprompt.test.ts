// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentEntry } from "./agentsviewmodel";
import { lastPrompt, pinnedPrompt, samePin, type PinnedPrompt } from "./pinnedprompt";
import type { EntryRowView } from "./renderedbsrowsmodel";

const user = (text: string): AgentEntry => ({ kind: "user", text });
const msg = (text: string): AgentEntry => ({ kind: "message", text });
const SCROLLER = { top: 100 };

const MARK_LINE = "look at .superpowers/design/mem/feedback/003.png — mark on Main.dc.html: tighter";
const MARK: EntryRowView = {
    kind: "mark",
    crop: ".superpowers/design/mem/feedback/003.png",
    canvas: "mem",
    file: "003.png",
    board: "Main.dc.html",
    note: "tighter",
};
const BUILDER_LINE = "brainstorm: builder answer: Yes";
const BUILDER: EntryRowView = {
    kind: "answer",
    origin: "transcript",
    n: null,
    builder: true,
    question: "Does queued time count?",
    answer: "Yes",
    options: [],
    ownWords: null,
};
// the transcript's rows, as renderedbsrowsmodel's entryRowView gives them for these lines
const rowOf = (e: AgentEntry): EntryRowView | null =>
    e.kind !== "user" ? null : e.text === MARK_LINE ? MARK : e.text === BUILDER_LINE ? BUILDER : null;

describe("pinnedPrompt", () => {
    const prompt: PinnedPrompt = { index: 2, text: "second", row: null };

    it("pins the prompt once its row is wholly above the scroller's top", () => {
        expect(pinnedPrompt(prompt, { bottom: 99 }, SCROLLER)).toBe(prompt);
        expect(pinnedPrompt(prompt, { bottom: 100 }, SCROLLER)).toBe(prompt);
    });

    it("pins nothing while any of the row is in view, or with no row laid out", () => {
        expect(pinnedPrompt(prompt, { bottom: 101 }, SCROLLER)).toBeNull();
        expect(pinnedPrompt(prompt, null, SCROLLER)).toBeNull();
    });

    it("pins nothing without a prompt", () => {
        expect(pinnedPrompt(null, { bottom: 0 }, SCROLLER)).toBeNull();
    });
});

describe("lastPrompt", () => {
    it("is the last user entry, trimmed, with no row for a plain bubble", () => {
        expect(lastPrompt([user("first"), msg("a"), user("  second  "), msg("b")], undefined, rowOf)).toEqual({
            index: 2,
            text: "second",
            row: null,
        });
        expect(lastPrompt([msg("a"), msg("b")])).toBeNull();
        expect(lastPrompt([])).toBeNull();
    });

    it("skips the user entries Arc typed", () => {
        const entries = [user("fix it"), msg("ok"), user("wake: task t-2 landed"), user("brainstorm: pick one")];
        expect(lastPrompt(entries, undefined, rowOf)).toEqual({ index: 0, text: "fix it", row: null });
    });

    it("carries the transcript's row for a mark line, so the bar draws the mark rather than the raw line", () => {
        expect(lastPrompt([user("fix it"), msg("ok"), user(MARK_LINE)], undefined, rowOf)).toEqual({
            index: 2,
            text: MARK_LINE,
            row: MARK,
        });
    });

    it("pins a brainstorm line the transcript draws as your answer's row", () => {
        expect(lastPrompt([user("fix it"), user(BUILDER_LINE), user("brainstorm: check")], undefined, rowOf)).toEqual({
            index: 1,
            text: BUILDER_LINE,
            row: BUILDER,
        });
    });

    it("a run agent's first prompt is its brief, so it is not pinned", () => {
        const ctx = { role: { kind: "lead" as const, runId: "r-1" } };
        expect(lastPrompt([user("the brief"), msg("ok")], ctx)).toBeNull();
        expect(lastPrompt([user("the brief"), msg("ok"), user("and this")], ctx)).toEqual({
            index: 2,
            text: "and this",
            row: null,
        });
        expect(lastPrompt([user("a plain prompt")])).toEqual({ index: 0, text: "a plain prompt", row: null });
    });
});

describe("samePin", () => {
    it("is the same pin when it draws the same, whatever the row object", () => {
        const a: PinnedPrompt = { index: 1, text: MARK_LINE, row: MARK };
        expect(samePin(a, { ...a, row: { ...MARK } })).toBe(true);
        expect(samePin(a, { ...a, row: { ...MARK, note: "looser" } })).toBe(false);
        expect(samePin(a, { ...a, index: 2 })).toBe(false);
        expect(samePin(null, null)).toBe(true);
        expect(samePin(a, null)).toBe(false);
    });
});
