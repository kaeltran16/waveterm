import { describe, expect, it } from "vitest";
import { fixtureAmbientProvider } from "./ambient";

describe("fixtureAmbientProvider", () => {
    it("returns nothing for a blank oref", () => {
        expect(fixtureAmbientProvider.tagsFor("")).toEqual([]);
        expect(fixtureAmbientProvider.decisionsFor("")).toEqual([]);
    });
    it("is deterministic for a given oref", () => {
        const a = fixtureAmbientProvider.tagsFor("run:abc");
        const b = fixtureAmbientProvider.tagsFor("run:abc");
        expect(a).toEqual(b);
        expect(a.length).toBeGreaterThan(0);
    });
    it("varies tags across orefs (covers more than one task label)", () => {
        const labels = new Set(
            ["run:a", "run:b", "run:c", "radar:d", "memory:e"].map((o) => fixtureAmbientProvider.tagsFor(o)[0]?.label)
        );
        expect(labels.size).toBeGreaterThan(1);
    });
});
