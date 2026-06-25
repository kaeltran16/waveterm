import { describe, expect, test } from "vitest";
import { validateScenario } from "./validate.mjs";

describe("validateScenario", () => {
    test("accepts a minimal valid roster", () => {
        const r = validateScenario([{ id: "a", name: "alpha", state: "working" }]);
        expect(r.ok).toBe(true);
        expect(r.errors).toEqual([]);
    });

    test("rejects a bad state, missing id, and duplicate id", () => {
        const r = validateScenario([
            { id: "a", name: "alpha", state: "nope" },
            { name: "no-id", state: "idle" },
            { id: "a", name: "dupe", state: "idle" },
        ]);
        expect(r.ok).toBe(false);
        expect(r.errors.length).toBeGreaterThanOrEqual(3);
    });

    test("rejects an asking agent whose ask has an empty questions array", () => {
        const r = validateScenario([{ id: "a", name: "alpha", state: "asking", ask: { questions: [] } }]);
        expect(r.ok).toBe(false);
    });

    test("allows an asking agent with no ask (plain-text question)", () => {
        const r = validateScenario([{ id: "a", name: "alpha", state: "asking" }]);
        expect(r.ok).toBe(true);
    });
});

import { SCENARIOS } from "./scenarios.mjs";

const FIXED_NOW = 1_700_000_000_000;

describe("SCENARIOS", () => {
    test("every scenario produces a valid roster", () => {
        for (const [name, build] of Object.entries(SCENARIOS)) {
            const r = validateScenario(build(FIXED_NOW));
            expect(r.ok, `${name}: ${r.errors.join("; ")}`).toBe(true);
        }
    });

    test("mixed has all three states", () => {
        const states = new Set(SCENARIOS.mixed(FIXED_NOW).map((a) => a.state));
        expect(states.has("asking")).toBe(true);
        expect(states.has("working")).toBe(true);
        expect(states.has("idle")).toBe(true);
    });

    test("all-asking is non-empty and entirely asking", () => {
        const roster = SCENARIOS["all-asking"](FIXED_NOW);
        expect(roster.length).toBeGreaterThan(0);
        expect(roster.every((a) => a.state === "asking")).toBe(true);
    });

    test("empty is an empty array", () => {
        expect(SCENARIOS.empty(FIXED_NOW)).toEqual([]);
    });

    test("relative time fields resolve against now", () => {
        const idle = SCENARIOS.mixed(FIXED_NOW).find((a) => a.idleSince != null);
        expect(idle.idleSince).toBeLessThanOrEqual(FIXED_NOW);
    });
});
