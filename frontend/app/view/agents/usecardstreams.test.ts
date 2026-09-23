import { describe, expect, it } from "vitest";
import { diffStreamSet } from "./usecardstreams";

const streamed = (...ids: string[]) => new Map(ids.map((id) => [id, `/${id}.jsonl`]));
const wanted = (...ids: string[]) => ids.map((id) => ({ id, path: `/${id}.jsonl` }));

describe("diffStreamSet", () => {
    it("starts newly-wanted ids and stops no-longer-wanted ids", () => {
        const r = diffStreamSet(streamed("a", "b"), wanted("b", "c"));
        expect(r.toStart).toEqual(["c"]);
        expect(r.toStop).toEqual(["a"]);
    });

    it("is a no-op when the set is unchanged", () => {
        const r = diffStreamSet(streamed("a", "b"), wanted("a", "b"));
        expect(r.toStart).toEqual([]);
        expect(r.toStop).toEqual([]);
    });

    it("starts all from empty and stops all to empty", () => {
        expect(diffStreamSet(new Map(), wanted("a", "b")).toStart).toEqual(["a", "b"]);
        expect(diffStreamSet(streamed("a", "b"), []).toStop).toEqual(["a", "b"]);
    });

    it("ignores duplicate wanted ids", () => {
        const r = diffStreamSet(new Map(), wanted("a", "a"));
        expect(r.toStart).toEqual(["a"]);
    });

    // /clear starts a new transcript file under the same agent
    it("restarts an id whose transcript path changed", () => {
        const r = diffStreamSet(streamed("a", "b"), [{ id: "a", path: "/a-new.jsonl" }, ...wanted("b")]);
        expect(r.toStop).toEqual(["a"]);
        expect(r.toStart).toEqual(["a"]);
    });
});
