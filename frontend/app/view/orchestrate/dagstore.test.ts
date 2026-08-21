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

const owner = { runtime: "claude", tier: "mid" } as Run;
const harnesses = [
    { runtime: "claude", routecapabilities: [{ runtime: "claude", tier: "mid", resolvedmodel: "sonnet" }, { runtime: "claude", tier: "capable", resolvedmodel: "operator default" }] },
    { runtime: "pi", routecapabilities: [{ runtime: "pi", tier: "cheap", resolvedmodel: "pi-cheap" }] },
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
    it("flags gate and failure states", () => {
        const { nodes } = buildViewData(group, owner, harnesses);
        const ship = nodes.find((n) => n.id === "t-2")!;
        expect(ship.gate).toBe(true);
        expect(ship.actions).toEqual(["approve", "sendback"]);
        const perf = nodes.find((n) => n.id === "t-3")!;
        expect(perf.actions).toEqual(["retry", "skip"]);
    });

    it("projects pinned, inherited, legacy, and unavailable routes", () => {
        const routed = {
            ...group,
            tasks: [
                { id: "pinned", label: "Pinned", state: "running", runspec: { runtime: "pi", tier: "cheap" } },
                { id: "inherited", label: "Inherited", state: "running" },
                { id: "legacy", label: "Legacy", state: "running", runspec: { runtime: "pi" } },
                { id: "missing", label: "Missing", state: "running", runspec: { runtime: "missing", tier: "mid" } },
            ],
        } as any;
        const { nodes } = buildViewData(routed, { runtime: "claude", tier: "" } as Run, harnesses);
        expect(nodes.find((n) => n.id === "pinned")!.route).toEqual({ source: "pinned", runtime: "pi", tier: "cheap", resolvedModel: "pi-cheap" });
        expect(nodes.find((n) => n.id === "inherited")!.route).toEqual({ source: "inherited", runtime: "claude", tier: "capable", resolvedModel: "operator default" });
        expect(nodes.find((n) => n.id === "legacy")!.route).toEqual({ source: "pinned", runtime: "pi", tier: "capable", resolvedModel: "unavailable" });
        expect(nodes.find((n) => n.id === "missing")!.route).toEqual({ source: "pinned", runtime: "missing", tier: "mid", resolvedModel: "unavailable" });
    });
});
