import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stopRunWorkerCommand = vi.fn();
const cancelRunCommand = vi.fn();
const createRunCommand = vi.fn();
const pushModal = vi.fn();

vi.mock("@/app/store/global-atoms", async () => {
    const actual = await vi.importActual<typeof import("@/app/store/global-atoms")>("@/app/store/global-atoms");
    const { atom } = await import("jotai");
    return { ...actual, atoms: { workspaceId: atom("workspace-1") as any } };
});
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        StopRunWorkerCommand: (...args: any[]) => stopRunWorkerCommand(...args),
        CancelRunCommand: (...args: any[]) => cancelRunCommand(...args),
        CreateRunCommand: (...args: any[]) => createRunCommand(...args),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/modalmodel", () => ({
    modalsModel: { pushModal: (...args: any[]) => pushModal(...args) },
}));

import {
    cancelRun,
    cancellingRunIdsAtom,
    confirmCancelRun,
    stopRunWorker,
    stoppingWorkerIdsAtom,
    cacheJarvisProfile,
    resolvedProfileAtom,
    channelOverrideAtom,
    createRun,
} from "./runactions";

function deferred() {
    let resolve!: () => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

beforeEach(() => {
    stopRunWorkerCommand.mockReset();
    cancelRunCommand.mockReset();
    createRunCommand.mockReset();
    pushModal.mockReset();
    globalStore.set(stoppingWorkerIdsAtom, new Set());
    globalStore.set(cancellingRunIdsAtom, new Set());
    globalStore.set(resolvedProfileAtom, {});
    globalStore.set(channelOverrideAtom, {});
});

describe("profile cache", () => {
    it("stores resolved profile and channel override together", () => {
        const response = {
            global: {} as JarvisProfile,
            override: { route: { runtime: "pi", tier: "cheap" } },
            resolved: { defaultmode: "pipeline" } as JarvisProfile,
        } as CommandGetJarvisProfileRtnData;
        cacheJarvisProfile("channel-1", response);
        expect(globalStore.get(resolvedProfileAtom)["channel-1"]).toBe(response.resolved);
        expect(globalStore.get(channelOverrideAtom)["channel-1"]).toBe(response.override);
    });
});

describe("createRun", () => {
    it("sends workerRoute when B1b workers picker is set", async () => {
        createRunCommand.mockResolvedValueOnce({ run: { id: "run-1" } });
        await createRun("channel-1", "ship", { runtime: "claude", tier: "", model: "opus" }, { mode: "orchestrator", workerRoute: { runtime: "pi", model: "opencode/deepseek-v4-pro" } as RoutePin });
        expect(createRunCommand).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workerroute: { runtime: "pi", model: "opencode/deepseek-v4-pro" } }));
    });
    it("omits workerRoute when workers inherit (collapsed)", async () => {
        createRunCommand.mockResolvedValueOnce({ run: { id: "run-2" } });
        await createRun("channel-1", "ship", { runtime: "claude", tier: "", model: "opus" }, { mode: "orchestrator" });
        expect(createRunCommand).toHaveBeenCalledWith(expect.anything(), expect.not.objectContaining({ workerroute: expect.anything() }));
    });
    it("maps deferred orchestrator options to the RPC shape", async () => {
        createRunCommand.mockResolvedValueOnce({ run: { id: "run-1" } });
        await createRun("channel-1", "ship", { runtime: "pi", tier: "mid" }, { mode: "orchestrator", deferStart: true });
        expect(createRunCommand).toHaveBeenCalledWith(expect.anything(), {
            channelid: "channel-1",
            workspaceid: "workspace-1",
            goal: "ship",
            runtime: "pi",
            tier: "mid",
            mode: "orchestrator",
            plangate: undefined,
            deferstart: true,
            radarorigin: undefined,
        });

        createRunCommand.mockResolvedValueOnce({ run: { id: "run-2" } });
        await createRun("channel-1", "direct", { runtime: "pi", tier: "mid" });
        expect(createRunCommand.mock.calls[1][1]).toEqual(
            expect.objectContaining({ runtime: "pi", tier: "mid", mode: undefined, deferstart: undefined }),
        );
    });
});

describe("stopRunWorker", () => {
    it("tracks the stripped tab id while preserving the worker oref in the RPC", async () => {
        const pending = deferred();
        stopRunWorkerCommand.mockReturnValueOnce(pending.promise);

        const call = stopRunWorker("channel-1", "run-1", "tab:worker-1");

        expect([...globalStore.get(stoppingWorkerIdsAtom)]).toEqual(["worker-1"]);
        expect(stopRunWorkerCommand).toHaveBeenCalledWith(expect.anything(), {
            channelid: "channel-1",
            runid: "run-1",
            workeroref: "tab:worker-1",
        });

        pending.resolve();
        await call;
        expect(globalStore.get(stoppingWorkerIdsAtom).size).toBe(0);
    });

    it("removes the in-flight id when the RPC rejects", async () => {
        const pending = deferred();
        stopRunWorkerCommand.mockReturnValueOnce(pending.promise);
        const call = stopRunWorker("channel-1", "run-1", "worker-1");
        const rejected = expect(call).rejects.toThrow("stop failed");

        expect([...globalStore.get(stoppingWorkerIdsAtom)]).toEqual(["worker-1"]);
        pending.reject(new Error("stop failed"));

        await rejected;
        expect(globalStore.get(stoppingWorkerIdsAtom).size).toBe(0);
    });
});

describe("cancelRun", () => {
    it("tracks the run id until cancellation resolves", async () => {
        const pending = deferred();
        cancelRunCommand.mockReturnValueOnce(pending.promise);

        const call = cancelRun("channel-1", "run-1");

        expect([...globalStore.get(cancellingRunIdsAtom)]).toEqual(["run-1"]);
        expect(cancelRunCommand).toHaveBeenCalledWith(expect.anything(), {
            channelid: "channel-1",
            runid: "run-1",
        });

        pending.resolve();
        await call;
        expect(globalStore.get(cancellingRunIdsAtom).size).toBe(0);
    });

    it("removes the in-flight id when cancellation rejects", async () => {
        const pending = deferred();
        cancelRunCommand.mockReturnValueOnce(pending.promise);
        const call = cancelRun("channel-1", "run-1");
        const rejected = expect(call).rejects.toThrow("cancel failed");

        expect([...globalStore.get(cancellingRunIdsAtom)]).toEqual(["run-1"]);
        pending.reject(new Error("cancel failed"));

        await rejected;
        expect(globalStore.get(cancellingRunIdsAtom).size).toBe(0);
    });
});

describe("confirmCancelRun", () => {
    it("cancels directly when no workers are live", async () => {
        cancelRunCommand.mockResolvedValueOnce(undefined);

        confirmCancelRun("channel-1", "run-1", 0);

        expect(pushModal).not.toHaveBeenCalled();
        await vi.waitFor(() =>
            expect(cancelRunCommand).toHaveBeenCalledWith(expect.anything(), {
                channelid: "channel-1",
                runid: "run-1",
            })
        );
    });

    it.each([
        [1, "Stop 1 running worker and cancel this run? Completed phases, transcripts, and artifacts are kept."],
        [2, "Stop 2 running workers and cancel this run? Completed phases, transcripts, and artifacts are kept."],
    ])("confirms before stopping %i live worker(s)", async (liveCount, message) => {
        cancelRunCommand.mockResolvedValueOnce(undefined);

        confirmCancelRun("channel-1", "run-1", liveCount);

        expect(cancelRunCommand).not.toHaveBeenCalled();
        expect(pushModal).toHaveBeenCalledTimes(1);
        const [displayName, props] = pushModal.mock.calls[0];
        expect(displayName).toBe("ConfirmModal");
        expect(props).toEqual(
            expect.objectContaining({
                title: "Cancel run",
                message,
                confirmLabel: "Cancel run",
                cancelLabel: "Keep running",
                destructive: true,
            })
        );

        props.onConfirm();
        await vi.waitFor(() => expect(cancelRunCommand).toHaveBeenCalledTimes(1));
    });
});
