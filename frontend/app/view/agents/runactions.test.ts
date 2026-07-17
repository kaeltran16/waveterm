import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stopRunWorkerCommand = vi.fn();
const cancelRunCommand = vi.fn();
const pushModal = vi.fn();

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        StopRunWorkerCommand: (...args: any[]) => stopRunWorkerCommand(...args),
        CancelRunCommand: (...args: any[]) => cancelRunCommand(...args),
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
    pushModal.mockReset();
    globalStore.set(stoppingWorkerIdsAtom, new Set());
    globalStore.set(cancellingRunIdsAtom, new Set());
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
