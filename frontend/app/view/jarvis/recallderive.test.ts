import { describe, expect, it } from "vitest";
import type { AnswerSegment, GroundingCard } from "./jarviscontract";
import { ageLabel, citedNs, freshnessLabel, groundingByN, mapWireCard, parseCitations } from "./recallderive";

describe("ageLabel", () => {
    it("renders coarse relative ages", () => {
        expect(ageLabel(30_000)).toBe("just now");
        expect(ageLabel(5 * 60_000)).toBe("5m ago");
        expect(ageLabel(3 * 3_600_000)).toBe("3h ago");
        expect(ageLabel(2 * 86_400_000)).toBe("2d ago");
    });
});

describe("freshnessLabel", () => {
    it("maps freshness to human copy", () => {
        expect(freshnessLabel("fresh")).toBe("Fresh");
        expect(freshnessLabel("stale")).toBe("Stale");
        expect(freshnessLabel("unavailable")).toBe("Unavailable");
    });
});

describe("groundingByN", () => {
    it("indexes cards by citation number", () => {
        const cards: GroundingCard[] = [
            { n: 1, sourceType: "run", title: "a", project: "p", ageMs: 0, freshness: "fresh", navTarget: "run:1" },
            { n: 2, sourceType: "decision", title: "b", project: "p", ageMs: 0, freshness: "fresh", navTarget: "dec:2" },
        ];
        const m = groundingByN(cards);
        expect(m.get(2)?.title).toBe("b");
        expect(m.size).toBe(2);
    });
});

describe("citedNs", () => {
    it("returns the distinct citation refs in order of first appearance", () => {
        const segs: AnswerSegment[] = [{ text: "x" }, { citationRef: 2 }, { text: "y" }, { citationRef: 1 }, { citationRef: 2 }];
        expect(citedNs(segs)).toEqual([2, 1]);
    });
});

describe("parseCitations", () => {
    const cards: GroundingCard[] = [
        { n: 1, sourceType: "run", title: "a", project: "p", ageMs: 0, freshness: "fresh", navTarget: "run:1" },
        { n: 2, sourceType: "decision", title: "b", project: "p", ageMs: 0, freshness: "fresh", navTarget: "dec:2" },
    ];
    it("splits prose into text + in-range citation segments", () => {
        expect(parseCitations("see [1] then [2].", cards)).toEqual([
            { text: "see " },
            { citationRef: 1 },
            { text: " then " },
            { citationRef: 2 },
            { text: "." },
        ]);
    });
    it("ignores out-of-range refs (leaves them as text)", () => {
        expect(parseCitations("ok [5] end", cards)).toEqual([{ text: "ok [5] end" }]);
    });
    it("handles no citations", () => {
        expect(parseCitations("plain text", cards)).toEqual([{ text: "plain text" }]);
    });
    it("handles an empty string", () => {
        expect(parseCitations("", cards)).toEqual([]);
    });
});

describe("mapWireCard", () => {
    it("maps snake/lowercase wire keys to the camelCase view-model", () => {
        const wire = { n: 3, sourcetype: "memory", title: "t", project: "waveterm", agems: 42, freshness: "stale", navtarget: "memory:x" };
        expect(mapWireCard(wire as JarvisGroundingCard)).toEqual({
            n: 3, sourceType: "memory", title: "t", project: "waveterm", ageMs: 42, freshness: "stale", navTarget: "memory:x",
        });
    });
});
