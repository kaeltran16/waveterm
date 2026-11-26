import { describe, expect, it } from "vitest";
import { commitMark } from "./commitmark";

const TICK = { kind: "tick" };

describe("commitMark", () => {
    it.each<[string, MetaType | undefined, boolean, unknown]>([
        [
            "ticks an agent whose last commit came after its last edit",
            { "agent:lasteditts": 100, "agent:lastcommitts": 200 },
            true,
            TICK,
        ],
        [
            "clears once the agent edits again after committing",
            { "agent:lasteditts": 300, "agent:lastcommitts": 200 },
            true,
            null,
        ],
        ["ticks a commit with no recorded edit", { "agent:lastcommitts": 200 }, true, TICK],
        ["does not tick an agent that has only edited", { "agent:lasteditts": 100 }, true, null],
        ["does not tick without meta", undefined, true, null],
        ["does not tick with empty meta", {}, true, null],
        [
            "ticks a commit made during the latest turn",
            { "agent:turnstartts": 150, "agent:lastcommitts": 200 },
            true,
            TICK,
        ],
        [
            "does not carry a commit from an earlier turn into a later one",
            { "agent:lastcommitts": 200, "agent:turnstartts": 300 },
            true,
            null,
        ],
        [
            "does not tick an agent that is still working, even with committed work",
            { "agent:lasteditts": 100, "agent:lastcommitts": 200 },
            false,
            null,
        ],
        [
            "marks a commit made in a worktree with its branch",
            { "agent:lastcommitts": 200, "agent:lastcommitbranch": "feat/x" },
            true,
            { kind: "branch", branch: "feat/x" },
        ],
        [
            "shows no branch mark while still working",
            { "agent:lastcommitts": 200, "agent:lastcommitbranch": "feat/x" },
            false,
            null,
        ],
        [
            "shows no branch mark once edited after the commit",
            { "agent:lastcommitts": 200, "agent:lasteditts": 300, "agent:lastcommitbranch": "feat/x" },
            true,
            null,
        ],
    ])("%s", (_name, meta, done, want) => {
        expect(commitMark(meta, done)).toEqual(want);
    });
});
