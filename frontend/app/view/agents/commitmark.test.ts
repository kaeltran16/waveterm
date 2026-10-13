import { describe, expect, it } from "vitest";
import { hasCommittedWork } from "./commitmark";

describe("hasCommittedWork", () => {
    it("ticks an agent whose last commit came after its last edit", () => {
        expect(hasCommittedWork({ "agent:lasteditts": 100, "agent:lastcommitts": 200 })).toBe(true);
    });

    it("clears once the agent edits again after committing", () => {
        expect(hasCommittedWork({ "agent:lasteditts": 300, "agent:lastcommitts": 200 })).toBe(false);
    });

    it("ticks a commit with no recorded edit", () => {
        expect(hasCommittedWork({ "agent:lastcommitts": 200 })).toBe(true);
    });

    it("does not tick an agent that has only edited", () => {
        expect(hasCommittedWork({ "agent:lasteditts": 100 })).toBe(false);
    });

    it("does not tick without meta", () => {
        expect(hasCommittedWork(undefined)).toBe(false);
        expect(hasCommittedWork({})).toBe(false);
    });
});
