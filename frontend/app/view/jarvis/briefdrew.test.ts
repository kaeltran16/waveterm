import { describe, expect, it } from "vitest";
import { drewOn } from "./briefdrew";
import type { GroundingCard, JarvisConversation } from "./jarviscontract";

function card(over: Partial<GroundingCard> & { navTarget: string }): GroundingCard {
    return {
        n: 1,
        sourceType: "task",
        title: "attention polling",
        project: "waveterm",
        ageMs: 0,
        freshness: "fresh",
        ...over,
    };
}

function convo(turns: GroundingCard[][]): JarvisConversation {
    return {
        id: "c1",
        title: "why",
        scope: { mode: "all", chips: [], attached: [] },
        turns: turns.map((grounding) => ({
            role: "jarvis" as const,
            workingSteps: [],
            segments: [{ text: "answer" }],
            grounding,
            terminal: "answered" as const,
        })),
    };
}

describe("drewOn", () => {
    it("dedupes a source cited across turns and counts the citations", () => {
        const out = drewOn(convo([[card({ navTarget: "task:a" })], [card({ navTarget: "task:a" })]]));
        expect(out.rows).toHaveLength(1);
        expect(out.rows[0].citations).toBe(2);
    });

    it("keeps first-cited order", () => {
        const out = drewOn(
            convo([[card({ navTarget: "task:b" }), card({ navTarget: "task:a" })], [card({ navTarget: "task:c" })]])
        );
        expect(out.rows.map((r) => r.key)).toEqual(["task:b", "task:a", "task:c"]);
    });

    // invariant 7: a thread resting on something that has since gone stale must say so
    it("reports the worst freshness when a source went stale between citations", () => {
        const out = drewOn(
            convo([
                [card({ navTarget: "task:a", freshness: "fresh", ageMs: 1000 })],
                [card({ navTarget: "task:a", freshness: "stale", ageMs: 90_000 })],
            ])
        );
        expect(out.rows[0].freshness).toBe("stale");
    });

    it("does not let a later fresh reading mask an earlier unavailable one", () => {
        const out = drewOn(
            convo([
                [card({ navTarget: "task:a", freshness: "unavailable" })],
                [card({ navTarget: "task:a", freshness: "fresh" })],
            ])
        );
        expect(out.rows[0].freshness).toBe("unavailable");
    });

    // the all-work ask reports no freshness at all, so its citations arrive unverified. That is weaker
    // footing than a checked-fresh reading and must not be reported as one.
    it("prefers an unverified reading over a fresh one", () => {
        const out = drewOn(
            convo([
                [card({ navTarget: "task:a", freshness: "fresh" })],
                [card({ navTarget: "task:a", freshness: "unverified" })],
            ])
        );
        expect(out.rows[0].freshness).toBe("unverified");
    });

    it("never lets an unverified reading mask a known-stale one", () => {
        const out = drewOn(
            convo([
                [card({ navTarget: "task:a", freshness: "stale" })],
                [card({ navTarget: "task:a", freshness: "unverified" })],
            ])
        );
        expect(out.rows[0].freshness).toBe("stale");
    });

    it("carries the age of the reading whose freshness won, so label and age agree", () => {
        const out = drewOn(
            convo([
                [card({ navTarget: "task:a", freshness: "fresh", ageMs: 1000 })],
                [card({ navTarget: "task:a", freshness: "stale", ageMs: 90_000 })],
            ])
        );
        expect(out.rows[0].ageMs).toBe(90_000);
    });

    it("keeps every source type, not just dossiers", () => {
        const out = drewOn(
            convo([
                [
                    card({ navTarget: "task:a", sourceType: "task" }),
                    card({ navTarget: "memory:m", sourceType: "memory" }),
                ],
            ])
        );
        expect(out.rows.map((r) => r.sourceType)).toEqual(["task", "memory"]);
    });

    it("ignores a user turn's absence of grounding and a card with no target", () => {
        const c = convo([[card({ navTarget: "task:a" }), card({ navTarget: "" })]]);
        c.turns.push({ role: "user", text: "and?", attachments: [] });
        const out = drewOn(c);
        expect(out.rows.map((r) => r.key)).toEqual(["task:a"]);
    });

    it("mentions the dedupe only when it did something", () => {
        const one = drewOn(convo([[card({ navTarget: "task:a" })]]));
        expect(one.meta).toBe("1 source");
        const two = drewOn(convo([[card({ navTarget: "task:a" }), card({ navTarget: "task:b" })]]));
        expect(two.meta).toBe("2 sources");
        const deduped = drewOn(convo([[card({ navTarget: "task:a" })], [card({ navTarget: "task:a" })]]));
        expect(deduped.meta).toBe("1 source across 2 citations");
    });

    it("states nothing rather than zero for a thread that has cited nothing", () => {
        expect(drewOn(convo([[]]))).toEqual({ rows: [], meta: "" });
    });
});
