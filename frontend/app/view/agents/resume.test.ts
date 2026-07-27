import { describe, expect, it } from "vitest";
import { readResumeCard } from "./resume";

function run(meta: Record<string, unknown>): Run {
    return { oid: "run-1", meta } as unknown as Run;
}

describe("readResumeCard", () => {
    it("returns a view-model for a captured boundary", () => {
        const vm = readResumeCard(
            run({
                "jarvis:resume": {
                    taskId: "task-7",
                    summary: "Blocked on the token-refresh test; middleware extracted.",
                    status: "paused",
                    updated: 1750000000000,
                },
            })
        );
        expect(vm).not.toBeNull();
        expect(vm?.taskId).toBe("task-7");
        expect(vm?.status).toBe("paused");
        expect(vm?.summary).toContain("token-refresh");
    });

    it("returns null when there is no resume meta", () => {
        expect(readResumeCard(run({}))).toBeNull();
    });

    it("returns null for an empty summary — there is nothing to resurface", () => {
        expect(readResumeCard(run({ "jarvis:resume": { taskId: "t", summary: "   ", status: "paused" } }))).toBeNull();
    });

    it("returns null when dismissed via the meta flag", () => {
        expect(
            readResumeCard(
                run({
                    "jarvis:resume": { taskId: "t", summary: "where it stands", status: "paused", updated: 1 },
                    "jarvis:resume:dismissed": true,
                })
            )
        ).toBeNull();
    });
});
