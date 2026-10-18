// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// the store records fixture actions on window; vitest runs in node, so give it one first
vi.hoisted(() => {
    (globalThis as any).window = {};
});
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        StorageReportCommand: vi.fn(),
        StorageScanCommand: vi.fn(),
        StorageClearCommand: vi.fn(),
        StorageDeleteCommand: vi.fn(),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { toastsAtom } from "@/app/cockpit/notificationstore";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import {
    clearStorageFixture,
    loadStorage,
    setStorageFixture,
    startClear,
    startDelete,
    startScan,
    startStoragePoll,
    STORAGE_POLL_MS,
    storageReportAtom,
} from "./storagestore";

const report = (scants: number, extra: Partial<StorageReportData> = {}): StorageReportData => ({
    scants,
    items: [],
    ...extra,
});

let stop: (() => void) | null = null;

beforeEach(() => {
    vi.useFakeTimers();
    clearStorageFixture();
    vi.resetAllMocks();
    globalStore.set(storageReportAtom, null);
    globalStore.set(toastsAtom, []);
    window.__storageLastAction = undefined;
});

afterEach(() => {
    stop?.();
    stop = null;
    vi.useRealTimers();
});

describe("loadStorage", () => {
    it("puts the snapshot in the atom", async () => {
        vi.mocked(RpcApi.StorageReportCommand).mockResolvedValue(report(5));
        await loadStorage();
        expect(globalStore.get(storageReportAtom)?.scants).toBe(5);
    });
    it("drops a reply that lands after the fixture was set", async () => {
        let resolve: (r: StorageReportData) => void = () => {};
        vi.mocked(RpcApi.StorageReportCommand).mockReturnValue(new Promise((r) => (resolve = r)));
        const loading = loadStorage();
        setStorageFixture(report(1));
        resolve(report(99));
        await loading;
        expect(globalStore.get(storageReportAtom)?.scants).toBe(1);
    });
    it("shows a failed load as a toast with the command's message", async () => {
        vi.mocked(RpcApi.StorageReportCommand).mockRejectedValue(new Error("EC-TIME: timeout"));
        await loadStorage();
        const toasts = globalStore.get(toastsAtom);
        expect(toasts).toHaveLength(1);
        expect(toasts[0].message).toBe("EC-TIME: timeout");
        expect(toasts[0].level).toBe("error");
    });
});

describe("loadStorage failure streak and fixture", () => {
    const load = vi.mocked(RpcApi.StorageReportCommand);
    const toastMessages = () => globalStore.get(toastsAtom).map((t) => t.message);

    it("sends no RPC and keeps the fixture report while in fixture mode", async () => {
        setStorageFixture(report(1));
        load.mockResolvedValue(report(99));
        await loadStorage();
        expect(load).not.toHaveBeenCalled();
        expect(globalStore.get(storageReportAtom)?.scants).toBe(1);
    });
    it("toasts once per failing streak and again after a load succeeds", async () => {
        load.mockResolvedValueOnce(report(1));
        await loadStorage();
        load.mockRejectedValueOnce(new Error("first"));
        await loadStorage();
        load.mockRejectedValueOnce(new Error("second"));
        await loadStorage();
        expect(toastMessages()).toEqual(["first"]);
        load.mockResolvedValueOnce(report(2));
        await loadStorage();
        load.mockRejectedValueOnce(new Error("third"));
        await loadStorage();
        expect(toastMessages()).toEqual(["first", "third"]);
    });
    it("does not toast a failure that lands after the fixture was set", async () => {
        load.mockResolvedValueOnce(report(1));
        await loadStorage();
        let reject: (e: Error) => void = () => {};
        load.mockReturnValueOnce(new Promise((_, rej) => (reject = rej)));
        const loading = loadStorage();
        setStorageFixture(report(5));
        reject(new Error("late"));
        await loading;
        expect(toastMessages()).toEqual([]);
    });
});

describe("actions", () => {
    it("in fixture mode sends no RPC and records the action", async () => {
        setStorageFixture(report(1));
        await startClear(["a", "b"]);
        expect(window.__storageLastAction).toEqual({ kind: "clear", ids: ["a", "b"] });
        await startDelete("x", "tip1");
        expect(window.__storageLastAction).toEqual({ kind: "delete", id: "x", tip: "tip1" });
        await startScan();
        expect(window.__storageLastAction).toEqual({ kind: "scan" });
        expect(RpcApi.StorageClearCommand).not.toHaveBeenCalled();
        expect(RpcApi.StorageDeleteCommand).not.toHaveBeenCalled();
        expect(RpcApi.StorageScanCommand).not.toHaveBeenCalled();
        expect(RpcApi.StorageReportCommand).not.toHaveBeenCalled();
    });
    it("outside fixture mode clears through the RPC, then reloads", async () => {
        vi.mocked(RpcApi.StorageClearCommand).mockResolvedValue(undefined);
        vi.mocked(RpcApi.StorageReportCommand).mockResolvedValue(report(5, { clearing: true }));
        await startClear(["a", "b"]);
        expect(RpcApi.StorageClearCommand).toHaveBeenCalledWith({}, { ids: ["a", "b"] });
        expect(globalStore.get(storageReportAtom)?.clearing).toBe(true);
        expect(window.__storageLastAction).toBeUndefined();
    });
    it("deletes and scans through the RPC", async () => {
        vi.mocked(RpcApi.StorageReportCommand).mockResolvedValue(report(5));
        await startDelete("x", "tip1");
        expect(RpcApi.StorageDeleteCommand).toHaveBeenCalledWith({}, { id: "x", tip: "tip1" });
        await startScan();
        expect(RpcApi.StorageScanCommand).toHaveBeenCalledWith({});
    });
    it("shows a rejected action as a toast with the command's message", async () => {
        vi.mocked(RpcApi.StorageScanCommand).mockRejectedValue(new Error("a storage scan or clear is already running"));
        vi.mocked(RpcApi.StorageReportCommand).mockResolvedValue(report(5));
        await startScan();
        expect(globalStore.get(toastsAtom).map((t) => t.message)).toEqual([
            "a storage scan or clear is already running",
        ]);
    });
});

describe("poll", () => {
    it("refreshes every STORAGE_POLL_MS while a job runs, and stops when it ends", async () => {
        globalStore.set(storageReportAtom, report(1, { scanning: true }));
        vi.mocked(RpcApi.StorageReportCommand)
            .mockResolvedValueOnce(report(1, { scanning: true }))
            .mockResolvedValueOnce(report(2));
        stop = startStoragePoll();
        await vi.advanceTimersByTimeAsync(STORAGE_POLL_MS);
        expect(RpcApi.StorageReportCommand).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(STORAGE_POLL_MS);
        expect(globalStore.get(storageReportAtom)?.scants).toBe(2);
        await vi.advanceTimersByTimeAsync(STORAGE_POLL_MS * 3);
        expect(RpcApi.StorageReportCommand).toHaveBeenCalledTimes(2);
    });
    it("does not start a second load while one is still in flight", async () => {
        globalStore.set(storageReportAtom, report(1, { scanning: true }));
        let finish: (r: StorageReportData) => void = () => {};
        vi.mocked(RpcApi.StorageReportCommand).mockReturnValue(new Promise((r) => (finish = r)));
        stop = startStoragePoll();
        await vi.advanceTimersByTimeAsync(STORAGE_POLL_MS * 4);
        expect(RpcApi.StorageReportCommand).toHaveBeenCalledTimes(1);
        finish(report(2));
        await vi.advanceTimersByTimeAsync(0);
    });
    it("never polls in fixture mode", async () => {
        setStorageFixture(report(1, { scanning: true }));
        stop = startStoragePoll();
        await vi.advanceTimersByTimeAsync(STORAGE_POLL_MS * 3);
        expect(RpcApi.StorageReportCommand).not.toHaveBeenCalled();
    });
});
