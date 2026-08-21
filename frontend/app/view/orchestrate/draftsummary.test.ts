import { describe, expect, it } from "vitest";
import type { DagDraftRequest } from "../agents/composercommand";
import { dependencyWaves, projectDraftSummary } from "./draftsummary";
import type { DagDraft } from "./draftmodel";

const request = { channelId: "channel-1", goal: "ship", route: { runtime: "claude", tier: "mid" } } as DagDraftRequest;
const harnesses = [
    {
        runtime: "claude",
        installed: true,
        runworkercapable: true,
        routecapabilities: [{ runtime: "claude", tier: "mid", resolvedmodel: "sonnet" }],
    },
    {
        runtime: "pi",
        installed: true,
        runworkercapable: true,
        routecapabilities: [{ runtime: "pi", tier: "cheap", resolvedmodel: "pi-cheap" }],
    },
] as HarnessInfo[];

const validDraft: DagDraft = {
    title: "ship",
    parallelism: 2,
    tasks: [
        { id: "t-1", label: "Plan", description: "", deps: [], gate: false, route: null },
        { id: "t-2", label: "Build UI", description: "", deps: ["t-1"], gate: false, route: { runtime: "pi", tier: "cheap" } },
        { id: "t-3", label: "Review", description: "", deps: ["t-2"], gate: true, route: null },
        { id: "t-4", label: "Verify", description: "", deps: ["t-3"], gate: false, route: null },
    ],
};

describe("dependencyWaves", () => {
    it("preserves source order within dependency waves", () => {
        const draft: DagDraft = {
            ...validDraft,
            tasks: [
                validDraft.tasks[0],
                { ...validDraft.tasks[1], id: "t-2", label: "Backend", deps: ["t-1"], route: null },
                { ...validDraft.tasks[1], id: "t-3", label: "Frontend", deps: ["t-1"], route: null },
                { ...validDraft.tasks[3], id: "t-4", deps: ["t-2", "t-3"] },
            ],
        };
        expect(dependencyWaves(draft)).toEqual([
            { index: 0, taskIds: ["t-1"] },
            { index: 1, taskIds: ["t-2", "t-3"] },
            { index: 2, taskIds: ["t-4"] },
        ]);
    });

    it("returns no fabricated waves for a cycle or unknown dependency", () => {
        expect(
            dependencyWaves({
                ...validDraft,
                tasks: [
                    { ...validDraft.tasks[0], deps: ["missing"] },
                ],
            }),
        ).toEqual([]);
    });
});

describe("projectDraftSummary", () => {
    it("projects exception-first authorization data", () => {
        const summary = projectDraftSummary({ request, draft: validDraft, fallback: false, warnings: [], harnesses });
        expect(summary.waves).toEqual([
            { index: 0, taskIds: ["t-1"] },
            { index: 1, taskIds: ["t-2"] },
            { index: 2, taskIds: ["t-3"] },
            { index: 3, taskIds: ["t-4"] },
        ]);
        expect(summary.exceptions).toEqual([
            { kind: "gate", taskId: "t-3", label: "Review" },
            { kind: "route", taskId: "t-2", label: "Build UI", route: { runtime: "pi", tier: "cheap" } },
        ]);
        expect(summary.routineTaskIds).toEqual(["t-1", "t-4"]);
    });

    it("blocks only on deterministic validation errors", () => {
        const visibleExceptions = projectDraftSummary({
            request,
            draft: { ...validDraft, tasks: validDraft.tasks.slice(0, 2) },
            fallback: true,
            warnings: ["Planner returned an invalid plan"],
            harnesses,
        });
        expect(visibleExceptions.canLaunch).toBe(true);
        expect(visibleExceptions.fallback).toBe(true);
        expect(visibleExceptions.warnings).toHaveLength(1);

        const invalid = {
            ...validDraft,
            tasks: validDraft.tasks.map((task, index) => (index === 0 ? { ...task, label: " " } : task)),
        };
        const blocked = projectDraftSummary({ request, draft: invalid, fallback: false, warnings: [], harnesses });
        expect(blocked.canLaunch).toBe(false);
        expect(blocked.validationErrors.some((error) => error.includes("label"))).toBe(true);
    });
});
