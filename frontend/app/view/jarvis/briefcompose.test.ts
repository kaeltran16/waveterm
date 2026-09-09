// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { resolveComposerLabels } from "./briefcompose";

describe("resolveComposerLabels", () => {
    it("grounds the launch composer in all work", () => {
        expect(resolveComposerLabels({ peek: "launch" })).toEqual({
            scope: "grounded in all work",
            hint: "Ask across your work",
            action: "Ask ⏎",
        });
    });

    it("grounds an unattached thread in all work too", () => {
        const l = resolveComposerLabels({ peek: "thread", title: "vault path layout change", turnCount: 3 });
        expect(l.scope).toBe("grounded in all work");
    });

    it("scopes a session sheet to the session and sends to its lead", () => {
        expect(resolveComposerLabels({ peek: "sheet", kind: "session", name: "task 7" })).toEqual({
            scope: "scoped to this session",
            hint: "Message the lead of this session",
            action: "Send ⏎",
        });
    });

    it("grounds an initiative sheet in the initiative and names it in the hint", () => {
        expect(resolveComposerLabels({ peek: "sheet", kind: "initiative", name: "attention rework" })).toEqual({
            scope: "grounded in this initiative",
            hint: "Ask about attention rework",
            action: "Send ⏎",
        });
    });

    it("reads a thread with turns as a follow-up", () => {
        const l = resolveComposerLabels({ peek: "thread", title: "quota rollup", turnCount: 2 });
        expect(l.hint).toBe("Ask a follow-up in this thread");
        expect(l.action).toBe("Follow up ⏎");
    });

    // regression: branching on the attachment instead of the turn count offered to "Follow up" on a thread
    // that had never been asked anything.
    it("does not read an attached thread with no turns as a follow-up", () => {
        const l = resolveComposerLabels({
            peek: "thread",
            title: "attention poller can drop an ask across a restart",
            turnCount: 0,
            sourceChip: "This finding",
        });
        expect(l.hint).toBe("Ask about attention poller can drop an ask across a restart");
        expect(l.action).toBe("Ask ⏎");
        expect(l.action).not.toBe("Follow up ⏎");
    });

    // regression: the chip said "This session" while the scope line said all work — two answers to the
    // one question the composer exists to answer.
    it("never says all work while the thread's chip names one source", () => {
        const l = resolveComposerLabels({
            peek: "thread",
            title: "task 7 · rebase and squash",
            turnCount: 1,
            sourceChip: "This session",
        });
        expect(l.scope).toBe("grounded in this session");
        expect(l.scope).not.toContain("all work");
    });

    it("offers a standing rule on a session sheet, named for its project", () => {
        expect(resolveComposerLabels({ peek: "sheet", kind: "session", name: "task 7", project: "wave-term" })).toEqual(
            {
                scope: "scoped to this session",
                hint: "Message the lead of this session",
                action: "Send ⏎",
                alt: "⇧⏎ standing rule for wave-term",
            }
        );
    });

    it("offers no standing rule on an initiative sheet", () => {
        const l = resolveComposerLabels({
            peek: "sheet",
            kind: "initiative",
            name: "attention rework",
            project: "wave-term",
        });
        expect(l.alt).toBeUndefined();
    });

    it("offers no standing rule on launch or in a thread", () => {
        expect(resolveComposerLabels({ peek: "launch" }).alt).toBeUndefined();
        expect(resolveComposerLabels({ peek: "thread", title: "quota rollup", turnCount: 2 }).alt).toBeUndefined();
    });

    it("offers no standing rule on a session sheet with no project to stand for", () => {
        expect(resolveComposerLabels({ peek: "sheet", kind: "session", name: "task 7" }).alt).toBeUndefined();
        expect(resolveComposerLabels({ peek: "sheet", kind: "session", project: "  " }).alt).toBeUndefined();
    });

    it("survives a state carrying none of its optional fields", () => {
        expect(resolveComposerLabels({ peek: "thread" })).toEqual({
            scope: "grounded in all work",
            hint: "Ask about this thread",
            action: "Ask ⏎",
        });
        expect(resolveComposerLabels({ peek: "sheet" })).toEqual({
            scope: "scoped to this session",
            hint: "Message the lead of this session",
            action: "Send ⏎",
        });
        expect(resolveComposerLabels({ peek: "sheet", kind: "initiative" }).hint).toBe("Ask about this initiative");
    });
});
