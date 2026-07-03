// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { describePlan, parseMentions, planDelegate, planMessage, tierFromMeta } from "./channelmessages";

describe("parseMentions", () => {
    it("returns no mentions for plain text", () => {
        expect(parseMentions("hello there")).toEqual({ mentions: [], body: "hello there" });
    });

    it("extracts leading mentions and strips them from the body", () => {
        expect(parseMentions("@codex build the auth refactor")).toEqual({
            mentions: ["codex"],
            body: "build the auth refactor",
        });
    });

    it("lowercases mentions and keeps interior text intact", () => {
        expect(parseMentions("@API-Auth do the thing")).toEqual({ mentions: ["api-auth"], body: "do the thing" });
    });
});

const roster = [
    { id: "t1", name: "api-auth", blockId: "b1" },
    { id: "t2", name: "web", blockId: "b2" },
];

describe("planMessage", () => {
    it("plans a dispatch when the mention is a known runtime", () => {
        expect(planMessage("@codex build it", roster)).toEqual({
            kind: "dispatch",
            runtime: "codex",
            text: "build it",
        });
    });

    it("plans a steer when the mention is a live worker name", () => {
        expect(planMessage("@api-auth run the tests", roster)).toEqual({
            kind: "steer",
            targetId: "t1",
            blockId: "b1",
            text: "run the tests",
        });
    });

    it("plans a plain post when there is no actionable mention", () => {
        expect(planMessage("just a note", roster)).toEqual({ kind: "post", text: "just a note" });
    });

    it("treats an unknown mention as a plain post", () => {
        expect(planMessage("@nobody hi", roster)).toEqual({ kind: "post", text: "@nobody hi" });
    });

    it("plans a consult when prefixed with ask + a runtime", () => {
        expect(planMessage("ask @claude does this have races?", roster)).toEqual({
            kind: "consult",
            runtimes: ["claude"],
            text: "does this have races?",
        });
    });
    it("fans a consult out across multiple runtimes", () => {
        expect(planMessage("ask @codex @claude review this", roster)).toEqual({
            kind: "consult",
            runtimes: ["codex", "claude"],
            text: "review this",
        });
    });
    it("treats ask with no known runtime as a plain post (kept verbatim)", () => {
        expect(planMessage("ask @nobody anything", roster)).toEqual({ kind: "post", text: "ask @nobody anything" });
    });
    it("does not consult without the ask keyword (leading @runtime still dispatches)", () => {
        expect(planMessage("@claude build it", roster)).toEqual({ kind: "dispatch", runtime: "claude", text: "build it" });
    });
});

describe("planMessage @jarvis", () => {
    it("routes @jarvis with a focus body to a jarvis plan", () => {
        expect(planMessage("@jarvis what's blocked?", [])).toEqual({ kind: "jarvis", text: "what's blocked?" });
    });
    it("routes a bare @jarvis to a jarvis plan with empty text", () => {
        expect(planMessage("@jarvis", [])).toEqual({ kind: "jarvis", text: "" });
    });
    it("treats jarvis as reserved even if a roster worker is named jarvis", () => {
        expect(planMessage("@jarvis go", [{ id: "t1", name: "jarvis" }]).kind).toBe("jarvis");
    });
});

describe("planMessage @jarvis mode override", () => {
    it("parses a bare @jarvis with no mode", () => {
        const p = planMessage("@jarvis what's the fleet doing?", []);
        expect(p).toEqual({ kind: "jarvis", text: "what's the fleet doing?", mode: undefined });
    });
    it("parses @jarvis:manage <goal>", () => {
        const p = planMessage("@jarvis:manage add rate limiting", []);
        expect(p).toEqual({ kind: "jarvis", text: "add rate limiting", mode: "manage" });
    });
    it("parses @jarvis:report and @jarvis:fanout", () => {
        expect(planMessage("@jarvis:report do x", [])).toMatchObject({ kind: "jarvis", mode: "report" });
        expect(planMessage("@jarvis:fanout do y", [])).toMatchObject({ kind: "jarvis", mode: "fanout" });
    });
});

describe("tierFromMeta", () => {
    it("reads the nested tier from meta booleans", () => {
        expect(tierFromMeta({})).toBe("concierge");
        expect(tierFromMeta({ "gatekeeper:enabled": true })).toBe("gatekeeper");
        expect(tierFromMeta({ "gatekeeper:enabled": true, "delegator:enabled": true })).toBe("delegator");
    });
});

describe("describePlan", () => {
    const ctx = { tier: "concierge" as const, projectName: "payments-api", roster, delegatorMode: "report" as const };

    it("flags a dispatch as spawning a worker in the channel's project (warn tone)", () => {
        expect(describePlan(planMessage("@claude build it", roster), ctx)).toEqual({
            label: "→ spawns a worker in payments-api",
            tone: "warn",
        });
    });

    it("describes a consult as a one-shot review naming its runtimes (neutral)", () => {
        expect(describePlan(planMessage("ask @codex @claude review this", roster), ctx)).toEqual({
            label: "→ one-shot review · codex, claude",
            tone: "neutral",
        });
    });

    it("names the steered worker resolved from the roster", () => {
        expect(describePlan(planMessage("@api-auth run the tests", roster), ctx)).toEqual({
            label: "→ steers api-auth",
            tone: "neutral",
        });
    });

    it("describes @jarvis as an observe-only ask on a non-delegator channel", () => {
        expect(describePlan(planMessage("@jarvis what's blocked?", roster), ctx)).toEqual({
            label: "→ asks Jarvis",
            tone: "neutral",
        });
    });

    it("flags @jarvis <goal> as dispatching a worker on a delegator channel (warn)", () => {
        const delegatorCtx = { ...ctx, tier: "delegator" as const };
        expect(describePlan(planMessage("@jarvis add caching", roster), delegatorCtx)).toEqual({
            label: "→ Jarvis dispatches a worker",
            tone: "warn",
        });
    });

    it("keeps a bare @jarvis on a delegator channel an observe-only ask (empty goal)", () => {
        const delegatorCtx = { ...ctx, tier: "delegator" as const };
        expect(describePlan(planMessage("@jarvis", roster), delegatorCtx)).toEqual({
            label: "→ asks Jarvis",
            tone: "neutral",
        });
    });

    it("returns null for a plain post (no chip)", () => {
        expect(describePlan(planMessage("just a note", roster), ctx)).toBeNull();
    });
});

describe("planDelegate", () => {
    it("returns summary when not a delegator channel", () => {
        expect(planDelegate({ tier: "gatekeeper", defaultMode: "report", goal: "do x" }))
            .toEqual({ action: "summary" });
    });
    it("returns summary for a delegator channel with an empty goal (bare @jarvis)", () => {
        expect(planDelegate({ tier: "delegator", defaultMode: "manage", goal: "" }))
            .toEqual({ action: "summary" });
    });
    it("Report dispatches the plain goal (no /goal wrapper)", () => {
        expect(planDelegate({ tier: "delegator", defaultMode: "report", goal: "add x" }))
            .toEqual({ action: "dispatch", task: "add x", mode: "report" });
    });
    it("Manage wraps the goal in /goal", () => {
        expect(planDelegate({ tier: "delegator", defaultMode: "manage", goal: "add x" }))
            .toEqual({ action: "dispatch", task: "/goal add x", mode: "manage" });
    });
    it("a per-message override beats the channel default", () => {
        expect(planDelegate({ tier: "delegator", defaultMode: "report", override: "manage", goal: "add x" }))
            .toEqual({ action: "dispatch", task: "/goal add x", mode: "manage" });
    });
    it("Fan-out degrades to a single /goal dispatch in v1", () => {
        expect(planDelegate({ tier: "delegator", defaultMode: "fanout", goal: "add x" }))
            .toEqual({ action: "dispatch", task: "/goal add x", mode: "fanout" });
    });
});