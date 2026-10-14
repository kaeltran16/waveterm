import { describe, expect, it } from "vitest";
import { hasCommittedWork } from "./commitmark";

describe("hasCommittedWork", () => {
    it("ticks an agent whose last commit came after its last edit", () => {
        expect(hasCommittedWork({ "agent:lasteditts": 100, "agent:lastcommitts": 200 }, true)).toBe(true);
    });

    it("clears once the agent edits again after committing", () => {
        expect(hasCommittedWork({ "agent:lasteditts": 300, "agent:lastcommitts": 200 }, true)).toBe(false);
    });

    it("ticks a commit with no recorded edit", () => {
        expect(hasCommittedWork({ "agent:lastcommitts": 200 }, true)).toBe(true);
    });

    it("does not tick an agent that has only edited", () => {
        expect(hasCommittedWork({ "agent:lasteditts": 100 }, true)).toBe(false);
    });

    it("does not tick without meta", () => {
        expect(hasCommittedWork(undefined, true)).toBe(false);
        expect(hasCommittedWork({}, true)).toBe(false);
    });

    it("does not tick an agent that is still working, even with committed work", () => {
        expect(hasCommittedWork({ "agent:lasteditts": 100, "agent:lastcommitts": 200 }, false)).toBe(false);
    });
});
