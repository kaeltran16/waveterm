import { describe, expect, it } from "vitest";
import { buildViewData } from "./dagstore";

const group = {
    id: "dag-1",
    runid: "run-1",
    parallelism: 2,
    tasks: [
        { id: "t-0", label: "setup", state: "done" },
        { id: "t-1", label: "api", deps: ["t-0"], state: "running", runid: "r-1" },
        { id: "t-2", label: "ship", deps: ["t-1"], gate: true, state: "done" },
        { id: "t-3", label: "perf", deps: ["t-2"], state: "failed" },
    ],
} as any;

const owner = { runtime: "claude", model: "sonnet" } as Run;
const harnesses = [
    { runtime: "claude", routecapabilities: [{ runtime: "claude", model: "sonnet", resolvedmodel: "claude-sonnet-4-6" }, { runtime: "claude", resolvedmodel: "operator default" }] },
    { runtime: "pi", routecapabilities: [{ runtime: "pi", resolvedmodel: "operator default" }] },
] as HarnessInfo[];

describe("buildViewData", () => {
    it("maps tasks to nodes and deps to edges", () => {
        const { nodes, edges } = buildViewData(group, owner, harnesses);
        expect(nodes).toHaveLength(4);
        expect(edges).toEqual([
            { source: "t-0", target: "t-1" },
            { source: "t-1", target: "t-2" },
            { source: "t-2", target: "t-3" },
        ]);
        // done, non-gate, unreleased -> merge action
        expect(nodes[0].actions).toEqual(["merge"]);
    });
    it("drops the merge action once a task is merged", () => {
        const mergedGroup = {
            ...group,
            tasks: [{ id: "t-0", label: "setup", state: "done", merged: true }],
        } as any;
        const { nodes } = buildViewData(mergedGroup, owner, harnesses);
        expect(nodes[0].actions).toEqual([]);
    });

    it("flags gate and failure states", () => {
        const { nodes } = buildViewData(group, owner, harnesses);
        const ship = nodes.find((n) => n.id === "t-2")!;
        expect(ship.gate).toBe(true);
        expect(ship.actions).toEqual(["approve", "sendback"]);
        const perf = nodes.find((n) => n.id === "t-3")!;
        expect(perf.actions).toEqual(["retry", "skip", "escalate"]);
    });

    it("projects pinned, inherited, runtime-default, and unavailable routes", () => {
        const routed = {
            ...group,
            tasks: [
                { id: "pinned", label: "Pinned", state: "running", runspec: { runtime: "claude", model: "sonnet" } },
                { id: "inherited", label: "Inherited", state: "running" },
                { id: "runtimeonly", label: "RuntimeOnly", state: "running", runspec: { runtime: "pi" } },
                { id: "missing", label: "Missing", state: "running", runspec: { runtime: "missing" } },
                { id: "modelonly", label: "ModelOnly", state: "running", runspec: { model: "sonnet" } },
            ],
        } as any;
        const { nodes } = buildViewData(routed, owner, harnesses);
        expect(nodes.find((n) => n.id === "pinned")!.route).toEqual({ source: "pinned", runtime: "claude", model: "sonnet", resolvedModel: "claude-sonnet-4-6" });
        expect(nodes.find((n) => n.id === "inherited")!.route).toEqual({ source: "inherited", runtime: "claude", model: "sonnet", resolvedModel: "claude-sonnet-4-6" });
        // a runtime-only pin is that runtime's default, never the owner's model
        expect(nodes.find((n) => n.id === "runtimeonly")!.route).toEqual({ source: "pinned", runtime: "pi", model: "", resolvedModel: "operator default" });
        expect(nodes.find((n) => n.id === "missing")!.route).toEqual({ source: "pinned", runtime: "missing", model: "", resolvedModel: "unavailable" });
        // a model-only pin inherits the owner's runtime
        expect(nodes.find((n) => n.id === "modelonly")!.route).toEqual({ source: "pinned", runtime: "claude", model: "sonnet", resolvedModel: "claude-sonnet-4-6" });
    });
});
