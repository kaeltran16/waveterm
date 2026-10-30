// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentAsk, AgentVM } from "./agentsviewmodel";
import { parseDocReview, shouldAutoOpen } from "./docreview";

const OPTIONS = [{ label: "Accept all and proceed" }, { label: "Request changes" }];

const ask = (header: string, question: string, options = OPTIONS, askId = "a1"): AgentAsk => ({
    askId,
    questions: [{ question, header, options }],
});

describe("parseDocReview", () => {
    it("reads a Plan review ask and splits intro from items", () => {
        const q =
            "C:/repo/docs/plans/2026-09-30-x.md\nThe reviewer found four problems; the plan now fixes them.\n- Task 3 depended on Task 5\n- Verify line missed the wsh package\n- Task 2 had no test\n- Setup was absent";
        expect(parseDocReview(ask("Plan review", q))).toEqual({
            kind: "review",
            path: "C:/repo/docs/plans/2026-09-30-x.md",
            intro: ["The reviewer found four problems; the plan now fixes them."],
            items: [
                "Task 3 depended on Task 5",
                "Verify line missed the wsh package",
                "Task 2 had no test",
                "Setup was absent",
            ],
            approveIndex: 0,
            requestIndex: 1,
        });
    });
    // a quick run's worker asks this one when its goal says to get the plan approved (BuildQuickPrompt)
    it("reads a Plan approval ask as the approval kind", () => {
        const q =
            "C:/wt/opal-watch/docs/superpowers/plans/2026-10-30-watch-workout-remote.md\nBuild the Watch remote on the phone's session.\n- HR and kcal in two new columns\n- distance into distance_km";
        const opts = [{ label: "Approve and proceed (Recommended)" }, { label: "Request changes" }];
        expect(parseDocReview(ask("Plan approval", q, opts))).toEqual({
            kind: "approval",
            path: "C:/wt/opal-watch/docs/superpowers/plans/2026-10-30-watch-workout-remote.md",
            intro: ["Build the Watch remote on the phone's session."],
            items: ["HR and kcal in two new columns", "distance into distance_km"],
            approveIndex: 0,
            requestIndex: 1,
        });
        expect(parseDocReview(ask(" plan APPROVAL", "/r/plan.md"))?.kind).toBe("approval");
    });
    it("tolerates a backticked path, CRLF, and header case and spacing", () => {
        expect(parseDocReview(ask("plan Review ", "`/r/plan.md`\r\n- one"))?.path).toBe("/r/plan.md");
        expect(parseDocReview(ask("  PLAN review", "/r/plan.md"))?.path).toBe("/r/plan.md");
    });
    it("skips blank lines, so the path is the first line with text", () => {
        const r = parseDocReview(ask("Plan review", "\n\n/r/plan.md\n\nA note.\n\n- one"));
        expect(r?.path).toBe("/r/plan.md");
        expect(r?.intro).toEqual(["A note."]);
        expect(r?.items).toEqual(["one"]);
    });
    it("trims each line, so indented text and trailing spaces still read", () => {
        const r = parseDocReview(ask("Plan review", "  /r/plan.md  \n   Some intro   \n   - one  "));
        expect(r?.path).toBe("/r/plan.md");
        expect(r?.intro).toEqual(["Some intro"]);
        expect(r?.items).toEqual(["one"]);
    });
    it("takes the whole text after the dash as the item, without its padding", () => {
        expect(parseDocReview(ask("Plan review", "/r/plan.md\n-   padded item"))?.items).toEqual(["padded item"]);
    });
    it("keeps every intro line when there are no items", () => {
        expect(parseDocReview(ask("Plan review", "/r/plan.md\nline one\nline two"))?.intro).toEqual([
            "line one",
            "line two",
        ]);
    });
    it("strips only the backticks around the path, not one inside it", () => {
        expect(parseDocReview(ask("Plan review", "`/r/a`b.md`"))?.path).toBe("/r/a`b.md");
    });
    it("falls back to an ordinary question when the convention is not met", () => {
        expect(parseDocReview(ask("Flake fix", "/r/plan.md"))).toBeNull();
        // the bare header a worker used before it was told the convention (run 3e019630, 2026-10-30)
        expect(parseDocReview(ask("Plan", "/r/plan.md"))).toBeNull();
        expect(
            parseDocReview(
                ask("Plan approval", "Chunk 17 plan is at docs/superpowers/plans/x.md. Approve building it?")
            )
        ).toBeNull();
        // the lead no longer asks a Spec review: the design session's Approve is the spec's approval
        expect(parseDocReview(ask("Spec review", "/r/spec.md\n- one"))).toBeNull();
        expect(parseDocReview(ask("Plan review", "Does the plan look right?"))).toBeNull();
        expect(parseDocReview(ask("Plan review", "/r/plan.txt"))).toBeNull();
        expect(parseDocReview(ask("Plan review", "/r/Main.dc.html"))).toBeNull();
        // the path must be the first line, not merely somewhere in the question
        expect(parseDocReview(ask("Plan review", "Please review the plan\n/r/plan.md\n- one"))).toBeNull();
        expect(parseDocReview(undefined)).toBeNull();
    });
    it("needs exactly one question", () => {
        const two: AgentAsk = {
            questions: [
                { question: "/r/plan.md", header: "Plan review", options: OPTIONS },
                { question: "Anything else?", header: "Other" },
            ],
        };
        expect(parseDocReview(two)).toBeNull();
    });
    it("finds the approve and request options", () => {
        const opts = [{ label: "Request changes" }, { label: "Looks good (Recommended)" }];
        const r = parseDocReview(ask("Plan review", "/r/p.md", opts));
        expect(r?.requestIndex).toBe(0);
        expect(r?.approveIndex).toBe(1);
        const marked = parseDocReview(
            ask("Plan review", "/r/p.md", [
                { label: "Accept all and proceed" },
                { label: "Request changes (Recommended)" },
            ])
        );
        expect(marked?.requestIndex).toBe(1);
        expect(marked?.approveIndex).toBe(0);
    });
    it("finds the request option by its leading words, whatever its padding", () => {
        const r = parseDocReview(
            ask("Plan review", "/r/p.md", [
                { label: "Accept all and proceed" },
                { label: "  Request changes and re-plan " },
            ])
        );
        expect(r?.requestIndex).toBe(1);
        expect(r?.approveIndex).toBe(0);
    });
    it("reports no request option as -1", () => {
        const r = parseDocReview(
            ask("Plan review", "/r/p.md", [{ label: "Accept all and proceed" }, { label: "Later" }])
        );
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
        agent: agent(ask("Plan review", "/r/p.md")),
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
        expect(shouldAutoOpen({ ...base(), agent: agent(ask("Flake", "/r/p.md")) })).toBe(false);
        expect(shouldAutoOpen({ ...base(), agent: undefined })).toBe(false);
    });
});
