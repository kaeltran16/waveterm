import { describe, expect, it, vi } from "vitest";
import type { DagDraftRequest } from "../agents/composercommand";
import { launchDagDraft, type DagLaunchDeps } from "./daglaunch";
import { toDagSubmitPayload } from "./draftmodel";

const request = { channelId: "channel-1", goal: "ship", route: { runtime: "pi", tier: "mid" } } as DagDraftRequest;
const draft = {
    title: "Ship",
    parallelism: 1,
    tasks: [{ id: "t-1", label: "Ship", description: "deliver", deps: [], gate: false, route: null }],
};

function run() {
    return { id: "run-1" } as Run;
}

describe("launchDagDraft", () => {
    it("creates then submits the exact payload without mutating the draft", async () => {
        const originalDraft = structuredClone(draft);
        const order: string[] = [];
        const deps: DagLaunchDeps = {
            createDeferredRun: vi.fn(async () => {
                order.push("create");
                return run();
            }),
            submitDag: vi.fn(async (_channelId, _runId, payload) => {
                order.push("submit");
                expect(payload).toEqual(toDagSubmitPayload(draft));
                return { oid: "dag-1" } as TaskGroup;
            }),
            cancelRun: vi.fn(),
        };
        const result = await launchDagDraft(request, draft, deps);
        expect(order).toEqual(["create", "submit"]);
        expect(result).toEqual({ ok: true, channelId: request.channelId, runId: "run-1", dagOref: "dag:dag-1" });
        expect(draft).toEqual(originalDraft);
    });

    it("does not submit or cancel when deferred Run creation fails", async () => {
        const deps: DagLaunchDeps = {
            createDeferredRun: vi.fn().mockRejectedValue("create failed"),
            submitDag: vi.fn(),
            cancelRun: vi.fn(),
        };
        const result = await launchDagDraft(request, draft, deps);
        expect(result).toEqual({ ok: false, error: "Couldn't create the deferred run: create failed" });
        expect(deps.submitDag).not.toHaveBeenCalled();
        expect(deps.cancelRun).not.toHaveBeenCalled();
    });

    it("retries the same submit once before cleanup", async () => {
        const deps: DagLaunchDeps = {
            createDeferredRun: vi.fn().mockResolvedValue(run()),
            submitDag: vi
                .fn()
                .mockRejectedValueOnce("response lost")
                .mockResolvedValueOnce({ oid: "dag-1" } as TaskGroup),
            cancelRun: vi.fn(),
        };
        const result = await launchDagDraft(request, draft, deps);
        expect(result).toEqual({ ok: true, channelId: "channel-1", runId: "run-1", dagOref: "dag:dag-1" });
        expect(deps.submitDag).toHaveBeenCalledTimes(2);
        expect(deps.cancelRun).not.toHaveBeenCalled();
    });

    it("cancels after submit failure and reports the contextual error", async () => {
        const deps: DagLaunchDeps = {
            createDeferredRun: vi.fn().mockResolvedValue(run()),
            submitDag: vi.fn().mockRejectedValue("submit failed"),
            cancelRun: vi.fn().mockResolvedValue(undefined),
        };
        const result = await launchDagDraft(request, draft, deps);
        expect(result).toEqual({
            ok: false,
            error: "DAG submission failed for run run-1: submit failed. Retry failed: submit failed",
        });
        expect(deps.submitDag).toHaveBeenCalledTimes(2);
        expect(deps.cancelRun).toHaveBeenCalledOnce();
    });

    it("returns both submit and cleanup errors when cancellation fails", async () => {
        const deps: DagLaunchDeps = {
            createDeferredRun: vi.fn().mockResolvedValue(run()),
            submitDag: vi.fn().mockRejectedValue("submit failed"),
            cancelRun: vi.fn().mockRejectedValue("cancel failed"),
        };
        const result = await launchDagDraft(request, draft, deps);
        expect(result).toEqual({
            ok: false,
            error: "DAG submission failed for run run-1: submit failed. Retry failed: submit failed. Cleanup also failed: cancel failed",
        });
        expect(deps.submitDag).toHaveBeenCalledTimes(2);
    });
});
