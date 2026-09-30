// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { describe, expect, it } from "vitest";
import { askAgent, inlineSelections, needsGroups, needsRows } from "./palette-needs";

const agent = (over: Partial<AgentVM>) =>
    ({ id: "t1", name: "juno", state: "asking", blockId: "b1", ...over }) as AgentVM;
const item = (kind: string, key = `${kind}:x`) =>
    ({ kind, key, source: "", text: "", action: "", phaseidx: 0, waitingsince: 0 }) as AttentionItem;
const oneQ = { questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }] };

describe("palette-needs", () => {
    it("resolves an ask to its agent by block, with or without a channel", () => {
        expect(askAgent(item("ask", "ask:block:b1"), [agent({})])?.id).toBe("t1");
        expect(askAgent(item("ask", "ask:block:zz"), [agent({})])).toBeUndefined();
    });

    it("never resolves a non-ask item, even one whose key names a block", () => {
        expect(askAgent(item("gate", "ask:block:b1"), [agent({})])).toBeUndefined();
    });

    it("groups by kind and drops radar triage", () => {
        const g = needsGroups(
            needsRows(
                [
                    item("gate"),
                    item("ask", "ask:block:b1"),
                    item("dag-blocked"),
                    item("radar-triage"),
                    item("run-unverified"),
                ],
                [agent({ ask: oneQ })]
            )
        );
        expect(g.map((x) => [x.group, x.rows.length])).toEqual([
            ["asks", 1],
            ["reviews", 1],
            ["blocked", 2],
        ]);
    });

    it("escalations are asks, dag gates reviews, and unknown kinds blocked", () => {
        const rows = needsRows([item("escalation"), item("dag-gate"), item("run-land-held"), item("mystery")], []);
        expect(rows.map((r) => r.group)).toEqual(["asks", "reviews", "blocked", "blocked"]);
    });

    it("keeps server order within a group and drops empty groups", () => {
        const g = needsGroups(
            needsRows([item("dag-blocked", "a"), item("gate", "g"), item("run-unverified", "b")], [])
        );
        expect(g.map((x) => [x.group, x.rows.map((r) => r.item.key)])).toEqual([
            ["reviews", ["g"]],
            ["blocked", ["a", "b"]],
        ]);
    });

    it("a doc review ask is a review with no inline options", () => {
        const review = {
            questions: [
                {
                    header: "Spec review",
                    question: "/abs/spec.md\n- one",
                    options: [{ label: "Approve" }, { label: "Request changes" }],
                },
            ],
        };
        const [row] = needsRows([item("ask", "ask:block:b1")], [agent({ ask: review })]);
        expect(row).toMatchObject({ group: "reviews", review: true, options: [] });
    });

    it("inline options only for one single-select question", () => {
        expect(needsRows([item("ask", "ask:block:b1")], [agent({ ask: oneQ })])[0].options).toEqual(["A", "B"]);
        const multi = { questions: [{ question: "q", multiSelect: true, options: [{ label: "A" }] }] };
        expect(needsRows([item("ask", "ask:block:b1")], [agent({ ask: multi })])[0].options).toEqual([]);
        const two = { questions: [oneQ.questions[0], oneQ.questions[0]] };
        expect(needsRows([item("ask", "ask:block:b1")], [agent({ ask: two })])[0].options).toEqual([]);
        expect(needsRows([item("ask", "ask:block:none")], [agent({ ask: oneQ })])[0].options).toEqual([]);
    });

    it("inlineSelections rejects an out-of-range digit", () => {
        const [row] = needsRows([item("ask", "ask:block:b1")], [agent({ ask: oneQ })]);
        expect(inlineSelections(row, 1)).toEqual({ 0: new Set([1]) });
        expect(inlineSelections(row, 5)).toBeNull();
        expect(inlineSelections(row, -1)).toBeNull();
        const [bare] = needsRows([item("ask", "ask:block:none")], [agent({ ask: oneQ })]);
        expect(inlineSelections(bare, 0)).toBeNull();
    });
});
