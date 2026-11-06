import { describe, expect, it } from "vitest";
import { leadLandFacts } from "./leadland";
import type { RunInfo } from "./runlineage";

const COMMIT = "d29f0d2".padEnd(40, "a");

function run(over: Partial<RunInfo> = {}): RunInfo {
    return {
        runId: "run-1",
        channelId: "ch",
        title: "Resource linking",
        project: "waveterm",
        base: "main",
        land: { state: "landed", commit: COMMIT },
        dag: {
            oid: "dag-1",
            runid: "run-1",
            tasks: [
                { id: "t-1", label: "wire the parser", state: "done" },
                { id: "t-2", label: "", state: "done" },
            ],
        } as TaskGroup,
        digest: {
            report: {
                workerms: 0,
                answered: 0,
                forwarded: 0,
                commits: [
                    { taskid: "t-1", commit: "abc1234".padEnd(40, "0") },
                    { taskid: "t-2", commit: "def5678".padEnd(40, "0") },
                ],
            },
        } as DagStatusDigest,
        ...over,
    };
}

describe("leadLandFacts", () => {
    it("names where a landed run went, that its worktree is gone, and what landed", () => {
        expect(leadLandFacts(run())).toEqual({
            branch: "landed on main · d29f0d2",
            files: "worktree removed after landing",
            commits: [
                { sha: "abc1234", subject: "wire the parser" },
                // a task with no label is named by its id, as the run sheet does
                { sha: "def5678", subject: "t-2" },
            ],
        });
    });

    it("is null for a run that has not landed", () => {
        expect(leadLandFacts(run({ land: undefined }))).toBeNull();
        expect(leadLandFacts(run({ land: { state: "held", reason: "dirty" } }))).toBeNull();
        expect(leadLandFacts(undefined)).toBeNull();
    });

    it("leaves out what it does not know: no base, no commit, no digest", () => {
        expect(leadLandFacts(run({ base: undefined, land: { state: "landed" }, digest: undefined }))).toEqual({
            branch: "landed",
            files: "worktree removed after landing",
            commits: [],
        });
    });
});
