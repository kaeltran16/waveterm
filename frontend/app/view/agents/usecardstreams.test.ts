import { describe, expect, it } from "vitest";
import { diffStreamSet } from "./usecardstreams";

describe("diffStreamSet", () => {
    it("starts newly-wanted ids and stops no-longer-wanted ids", () => {
        const current = new Set(["a", "b"]);
        const r = diffStreamSet(current, ["b", "c"]);
        expect(r.toStart).toEqual(["c"]);
        expect(r.toStop).toEqual(["a"]);
    });

    it("is a no-op when the set is unchanged", () => {
        const r = diffStreamSet(new Set(["a", "b"]), ["a", "b"]);
        expect(r.toStart).toEqual([]);
        expect(r.toStop).toEqual([]);
    });

    it("starts all from empty and stops all to empty", () => {
        expect(diffStreamSet(new Set(), ["a", "b"]).toStart).toEqual(["a", "b"]);
        expect(diffStreamSet(new Set(["a", "b"]), []).toStop).toEqual(["a", "b"]);
    });

    it("ignores duplicate wanted ids", () => {
        const r = diffStreamSet(new Set(), ["a", "a"]);
        expect(r.toStart).toEqual(["a"]);
    });
});
