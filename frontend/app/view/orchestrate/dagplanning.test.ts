import { describe, expect, it, vi } from "vitest";
import { createDagPlanningCoordinator } from "./dagplanning";
import type { DagDraftRequest } from "../agents/composercommand";

const request = { channelId: "channel-1", goal: "ship", route: { runtime: "pi", tier: "cheap" } } as DagDraftRequest;
const response = {
    draft: { title: "ship", tasks: [{ id: "t-1", label: "ship" }] },
    fallback: true,
    warnings: ["fallback"],
} as CommandJarvisPlanDagRtnData;

describe("createDagPlanningCoordinator", () => {
    it("deduplicates same-request calls and dispatches one converted result", async () => {
        let resolve!: (value: CommandJarvisPlanDagRtnData) => void;
        const invoke = vi.fn(() => new Promise<CommandJarvisPlanDagRtnData>((r) => (resolve = r)));
        const dispatch = vi.fn();
        const coordinator = createDagPlanningCoordinator(invoke, dispatch);
        const first = coordinator.run(1, request);
        const duplicate = coordinator.run(1, request);
        expect(invoke).toHaveBeenCalledTimes(1);
        resolve(response);
        await Promise.all([first, duplicate]);
        expect(dispatch).toHaveBeenCalledWith(
            expect.objectContaining({ type: "plan-succeeded", requestId: 1, fallback: true, warnings: ["fallback"] }),
        );
        expect(dispatch.mock.calls[0][0].draft).toEqual({
            title: "ship",
            parallelism: 1,
            tasks: [{ id: "t-1", label: "ship", description: "", deps: [], gate: false, route: null }],
        });
    });

    it("allows newer request identities to run concurrently", async () => {
        const resolvers = new Map<number, (value: CommandJarvisPlanDagRtnData) => void>();
        const invoke = vi.fn((next: DagDraftRequest) =>
            new Promise<CommandJarvisPlanDagRtnData>((resolve) => resolvers.set(next.goal === "first" ? 1 : 2, resolve)),
        );
        const dispatch = vi.fn();
        const coordinator = createDagPlanningCoordinator(invoke, dispatch);
        const first = coordinator.run(1, { ...request, goal: "first" });
        const second = coordinator.run(2, { ...request, goal: "second" });
        expect(invoke).toHaveBeenCalledTimes(2);
        resolvers.get(2)!(response);
        resolvers.get(1)!(response);
        await Promise.all([first, second]);
        expect(dispatch.mock.calls.map(([action]) => action.requestId)).toEqual([2, 1]);
    });

    it("keeps transport failure as plan-failed instead of manufacturing fallback", async () => {
        const invoke = vi.fn().mockRejectedValue("offline");
        const dispatch = vi.fn();
        await createDagPlanningCoordinator(invoke, dispatch).run(7, request);
        expect(dispatch).toHaveBeenCalledWith({ type: "plan-failed", requestId: 7, error: "Planning request failed: offline" });
    });
});
