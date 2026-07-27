import { describe, expect, it } from "vitest";
import { isAnswerTurn, isCitation } from "./jarviscontract";
import { FIXTURES, FIXTURE_STATES } from "./jarvisfixtures";

describe("jarvis fixtures satisfy the contract", () => {
    it("exposes one fixture per declared state", () => {
        for (const state of FIXTURE_STATES) {
            expect(FIXTURES[state]).toBeDefined();
        }
        expect(Object.keys(FIXTURES).sort()).toEqual([...FIXTURE_STATES].sort());
    });

    it("every citationRef resolves to a grounding card in the same turn", () => {
        for (const conv of Object.values(FIXTURES)) {
            for (const turn of conv.turns) {
                if (!isAnswerTurn(turn)) continue;
                const ns = new Set(turn.grounding.map((g) => g.n));
                for (const seg of turn.segments) {
                    if (isCitation(seg)) expect(ns.has(seg.citationRef)).toBe(true);
                }
            }
        }
    });

    it("notfound turns carry no grounding; weak turns carry at least one candidate", () => {
        const nf = FIXTURES.notfound.turns.find(isAnswerTurn)!;
        expect(nf.terminal).toBe("notfound");
        expect(nf.grounding).toHaveLength(0);
        const wk = FIXTURES.weak.turns.find(isAnswerTurn)!;
        expect(wk.terminal).toBe("weak");
        expect(wk.grounding.length).toBeGreaterThan(0);
    });

    it("the stale fixture surfaces stale/unavailable freshness (not hidden)", () => {
        const turn = FIXTURES.stale.turns.find(isAnswerTurn)!;
        const freshnesses = turn.grounding.map((g) => g.freshness);
        expect(freshnesses).toContain("stale");
        expect(freshnesses).toContain("unavailable");
    });

    it("the empty fixture has no turns", () => {
        expect(FIXTURES.empty.turns).toHaveLength(0);
    });
});
