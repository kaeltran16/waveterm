import { describe, expect, it } from "vitest";
import {
    addDraftTask,
    deleteDraftTask,
    draftFromSubtasks,
    renameDraftTask,
    setDraftDependency,
    setDraftGate,
    setDraftParallelism,
    setDraftRoute,
    toDagSubmitPayload,
    validateDraft,
} from "./draftmodel";

const harnesses = [
    {
        runtime: "pi",
        label: "Pi",
        installed: true,
        consultcapable: true,
        runworkercapable: true,
        routecapabilities: [
            { runtime: "pi", tier: "capable", resolvedmodel: "pi-capable" },
            { runtime: "pi", tier: "cheap", resolvedmodel: "pi-cheap" },
        ],
    },
] as HarnessInfo[];

function baseDraft() {
    return draftFromSubtasks("Ship feature", ["plan", "build", "test"]);
}

describe("draftFromSubtasks", () => {
    it("creates deterministic independent tasks with stable defaults", () => {
        expect(baseDraft()).toEqual({
            title: "Ship feature",
            parallelism: 2,
            tasks: [
                { id: "t-1", label: "plan", deps: [], gate: false, route: null },
                { id: "t-2", label: "build", deps: [], gate: false, route: null },
                { id: "t-3", label: "test", deps: [], gate: false, route: null },
            ],
        });
        expect(draftFromSubtasks("Ship feature", ["plan", "build"])).toEqual(
            draftFromSubtasks("Ship feature", ["plan", "build"])
        );
    });
});

describe("draft reducers", () => {
    it("adds using the first unused positive id, renames, and deletes with dependency cleanup", () => {
        const draft = baseDraft();
        const withGap = deleteDraftTask(draft, "t-2");
        const added = addDraftTask(withGap, "review");
        expect(added.tasks.map((t) => t.id)).toEqual(["t-1", "t-3", "t-2"]);
        expect(added.tasks[2].label).toBe("review");

        const linked = setDraftDependency(added, "t-3", "t-1", true);
        const renamed = renameDraftTask(linked, "t-1", "design");
        expect(renamed.tasks[0].label).toBe("design");
        const deleted = deleteDraftTask(renamed, "t-1");
        expect(deleted.tasks.map((t) => t.id)).toEqual(["t-3", "t-2"]);
        expect(deleted.tasks[1].deps).toEqual([]);
        expect(draft.tasks[0].label).toBe("plan");
        expect(draft.tasks[2].deps).toEqual([]);
    });

    it("rejects duplicate and self dependencies without mutation", () => {
        const draft = setDraftDependency(baseDraft(), "t-2", "t-1", true);
        expect(setDraftDependency(draft, "t-2", "t-1", true)).toBe(draft);
        expect(setDraftDependency(draft, "t-2", "t-2", true)).toBe(draft);
        expect(setDraftDependency(draft, "missing", "t-1", true)).toBe(draft);
        expect(setDraftDependency(draft, "t-2", "missing", true)).toBe(draft);
    });

    it("rejects dependencies that would create a cycle without mutation", () => {
        const linked = setDraftDependency(setDraftDependency(baseDraft(), "t-2", "t-1", true), "t-3", "t-2", true);
        expect(setDraftDependency(linked, "t-1", "t-3", true)).toBe(linked);
        expect(linked.tasks.map((t) => t.deps)).toEqual([[], ["t-1"], ["t-2"]]);
    });

    it("toggles gates, routes, and only accepts bounded positive parallelism", () => {
        const draft = baseDraft();
        const gated = setDraftGate(draft, "t-2", true);
        const routed = setDraftRoute(gated, "t-2", { runtime: "pi", tier: "cheap" });
        expect(routed.tasks[1]).toMatchObject({ gate: true, route: { runtime: "pi", tier: "cheap" } });
        expect(setDraftRoute(routed, "t-2", null).tasks[1].route).toBeNull();
        expect(setDraftParallelism(routed, 4).parallelism).toBe(4);
        expect(setDraftParallelism(routed, 0)).toBe(routed);
        expect(setDraftParallelism(routed, -1)).toBe(routed);
        expect(setDraftParallelism(routed, 1.5)).toBe(routed);
        expect(setDraftParallelism(routed, Infinity)).toBe(routed);
    });

    it("does not mutate frozen inputs", () => {
        const draft = baseDraft();
        Object.freeze(draft.tasks);
        draft.tasks.forEach((task) => Object.freeze(task));
        const result = addDraftTask(draft);
        expect(result.tasks).toHaveLength(4);
        expect(draft.tasks).toHaveLength(3);
    });
});

describe("validateDraft and payload", () => {
    it("reports blank, empty, dependency, and invalid backend route errors", () => {
        const invalid = setDraftRoute(setDraftDependency(baseDraft(), "t-2", "t-1", true), "t-1", {
            runtime: "unknown",
            tier: "capable",
        });
        invalid.title = " ";
        invalid.tasks[1].label = " ";
        const errors = validateDraft(invalid, harnesses);
        expect(errors.some((error) => error.includes("title"))).toBe(true);
        expect(errors.some((error) => error.includes("t-2"))).toBe(true);
        expect(errors.some((error) => error.includes("route"))).toBe(true);
        expect(validateDraft({ title: "", parallelism: 1, tasks: [] }, harnesses).length).toBeGreaterThan(0);
    });

    it("produces the exact submit shape and omits route fields for inherited tasks", () => {
        const draft = setDraftRoute(setDraftGate(setDraftDependency(baseDraft(), "t-2", "t-1", true), "t-2", true), "t-1", {
            runtime: "pi",
            tier: "cheap",
        });
        expect(toDagSubmitPayload(draft)).toEqual({
            title: "Ship feature",
            parallelism: 2,
            tasks: [
                { id: "t-1", label: "plan", deps: [], gate: false, state: "pending", runspec: { runtime: "pi", tier: "cheap" } },
                { id: "t-2", label: "build", deps: ["t-1"], gate: true, state: "pending" },
                { id: "t-3", label: "test", deps: [], gate: false, state: "pending" },
            ],
        });
    });
});
