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

describe("buildViewData", () => {
    it("maps tasks to nodes and deps to edges", () => {
        const { nodes, edges } = buildViewData(group);
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
        const { nodes } = buildViewData(group);
        const ship = nodes.find((n) => n.id === "t-2")!;
        expect(ship.gate).toBe(true);
        expect(ship.actions).toEqual(["approve", "sendback"]);
        const perf = nodes.find((n) => n.id === "t-3")!;
        expect(perf.actions).toEqual(["retry", "skip"]);
    });
});
