// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentAsk, AgentVM } from "./agentsviewmodel";
import { parseDocReview, shouldAutoOpen } from "./docreview";

const OPTIONS = [{ label: "Approve" }, { label: "Request changes" }];

const ask = (header: string, question: string, options = OPTIONS, askId = "a1"): AgentAsk => ({
    askId,
    questions: [{ question, header, options }],
});

describe("parseDocReview", () => {
    it("reads a Spec review ask", () => {
        const q =
            "C:/repo/docs/specs/2026-09-24-auth.md\n- Redis sessions, 14-day sliding TTL\n- Accept the legacy sid cookie for one release";
        expect(parseDocReview(ask("Spec review", q))).toEqual({
            kind: "spec",
            path: "C:/repo/docs/specs/2026-09-24-auth.md",
            intro: [],
            items: ["Redis sessions, 14-day sliding TTL", "Accept the legacy sid cookie for one release"],
            approveIndex: 0,
            requestIndex: 1,
        });
    });
    it("reads a Plan review ask and splits intro from items", () => {
        const q =
            "C:/repo/docs/plans/2026-09-30-x.md\nThe reviewer found four problems; the plan now fixes them.\n- Task 3 depended on Task 5\n- Verify line missed the wsh package\n- Task 2 had no test\n- Setup was absent";
        const r = parseDocReview(ask("Plan review", q));
        expect(r?.kind).toBe("plan");
        expect(r?.intro).toEqual(["The reviewer found four problems; the plan now fixes them."]);
        expect(r?.items).toHaveLength(4);
    });
    it("tolerates a backticked path, CRLF, and header case and spacing", () => {
        expect(parseDocReview(ask("spec Review ", "`/r/spec.md`\r\n- one"))?.path).toBe("/r/spec.md");
        expect(parseDocReview(ask("  PLAN review", "/r/plan.md"))?.kind).toBe("plan");
    });
    it("falls back to an ordinary question when the convention is not met", () => {
        expect(parseDocReview(ask("Flake fix", "/r/spec.md"))).toBeNull();
        expect(parseDocReview(ask("Spec review", "Does the spec look right?"))).toBeNull();
        expect(parseDocReview(ask("Spec review", "/r/spec.txt"))).toBeNull();
        expect(parseDocReview(undefined)).toBeNull();
    });
    it("needs exactly one question", () => {
        const two: AgentAsk = {
            questions: [
                { question: "/r/spec.md", header: "Spec review", options: OPTIONS },
                { question: "Anything else?", header: "Other" },
            ],
        };
        expect(parseDocReview(two)).toBeNull();
    });
    it("finds the approve and request options", () => {
        const opts = [{ label: "Request changes" }, { label: "Looks good (Recommended)" }];
        const r = parseDocReview(ask("Spec review", "/r/s.md", opts));
        expect(r?.requestIndex).toBe(0);
        expect(r?.approveIndex).toBe(1);
        const marked = parseDocReview(
            ask("Spec review", "/r/s.md", [{ label: "Approve" }, { label: "Request changes (Recommended)" }])
        );
        expect(marked?.requestIndex).toBe(1);
        expect(marked?.approveIndex).toBe(0);
    });
    it("reports no request option as -1", () => {
        const r = parseDocReview(ask("Spec review", "/r/s.md", [{ label: "Approve" }, { label: "Later" }]));
        expect(r?.requestIndex).toBe(-1);
        expect(r?.approveIndex).toBe(0);
    });
});

describe("shouldAutoOpen", () => {
    const agent = (a?: AgentAsk): AgentVM =>
        ({ id: "lead", name: "lead", task: "t", state: "asking", ask: a }) as AgentVM;
    const base = () => ({
        surface: "agent",
        focusedId: "lead",
        agent: agent(ask("Spec review", "/r/s.md")),
        opened: new Set<string>(),
        editable: false,
    });
    it("opens for the focused agent's fresh doc-review ask on the agent surface", () => {
        expect(shouldAutoOpen(base())).toBe(true);
    });
    it("stays closed off the agent surface", () => {
        expect(shouldAutoOpen({ ...base(), surface: "cockpit" })).toBe(false);
    });
    it("stays closed for an agent that is not focused", () => {
        expect(shouldAutoOpen({ ...base(), focusedId: "other" })).toBe(false);
    });
    it("stays closed once the ask has opened", () => {
        expect(shouldAutoOpen({ ...base(), opened: new Set(["a1"]) })).toBe(false);
    });
    it("stays closed while typing", () => {
        expect(shouldAutoOpen({ ...base(), editable: true })).toBe(false);
    });
    it("stays closed with no ask, an ordinary ask, or no agent", () => {
        expect(shouldAutoOpen({ ...base(), agent: agent(undefined) })).toBe(false);
        expect(shouldAutoOpen({ ...base(), agent: agent(ask("Flake", "/r/s.md")) })).toBe(false);
        expect(shouldAutoOpen({ ...base(), agent: undefined })).toBe(false);
    });
});
