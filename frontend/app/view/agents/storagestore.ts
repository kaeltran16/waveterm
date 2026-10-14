// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The only place the frontend calls the Storage RPCs. wavesrv runs every scan, clear and delete as a
// background job, so each action only starts one and the report is polled while it runs.

import { pushToast } from "@/app/cockpit/notificationstore";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { pollWanted } from "./storagemodel";

export const STORAGE_POLL_MS = 1000;

// null until the first report lands; a jotai atom so it survives the Settings surface unmounting
export const storageReportAtom = atom<StorageReportData | null>(null) as PrimitiveAtom<StorageReportData | null>;

export type StorageAction =
    | { kind: "scan" }
    | { kind: "clear"; ids: string[] }
    | { kind: "delete"; id: string; tip: string }
    | { kind: "open"; runId: string };

// DEV fixture state: while set, no RPC is sent and every reply that still arrives is dropped
let fixture = false;
let inFlight = false;
let loadFailing = false;

function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

export function isStorageFixture(): boolean {
    return fixture;
}

export function setStorageFixture(r: StorageReportData): void {
    fixture = true;
    globalStore.set(storageReportAtom, r);
}

export function clearStorageFixture(): void {
    fixture = false;
}

// in fixture mode an action lands here instead of on wavesrv, so a CDP scenario can read what was sent
export function recordStorageAction(a: StorageAction): void {
    window.__storageLastAction = a;
}

export async function loadStorage(): Promise<void> {
    if (fixture) {
        return;
    }
    inFlight = true;
    try {
        const r = await RpcApi.StorageReportCommand(TabRpcClient);
        loadFailing = false;
        if (!fixture) {
            globalStore.set(storageReportAtom, r ?? null);
        }
    } catch (e) {
        // the poll retries every second; one toast per failing streak
        if (!loadFailing && !fixture) {
            pushToast({ title: "Couldn’t read the storage report", message: errorText(e), level: "error" });
        }
        loadFailing = true;
    } finally {
        inFlight = false;
    }
}

async function run(action: StorageAction, failTitle: string, send: () => Promise<void>): Promise<void> {
    if (fixture) {
        recordStorageAction(action);
        return;
    }
    try {
        await send();
    } catch (e) {
        if (!fixture) {
            pushToast({ title: failTitle, message: errorText(e), level: "error" });
        }
    }
    // the job's own state (scanning, clearing) arrives with the report, which starts the poll
    await loadStorage();
}

export function startScan(): Promise<void> {
    return run({ kind: "scan" }, "Couldn’t start the scan", () => RpcApi.StorageScanCommand(TabRpcClient));
}

export function startClear(ids: string[]): Promise<void> {
    return run({ kind: "clear", ids }, "Couldn’t start the clear", () =>
        RpcApi.StorageClearCommand(TabRpcClient, { ids })
    );
}

export function startDelete(id: string, tip: string): Promise<void> {
    return run({ kind: "delete", id, tip }, "Couldn’t start the delete", () =>
        RpcApi.StorageDeleteCommand(TabRpcClient, { id, tip })
    );
}

export function startStoragePoll(): () => void {
    const timer = setInterval(() => {
        if (!fixture && !inFlight && pollWanted(globalStore.get(storageReportAtom))) {
            void loadStorage();
        }
    }, STORAGE_POLL_MS);
    return () => clearInterval(timer);
}

declare global {
    interface Window {
        __storageLastAction?: StorageAction;
        __setStorageScenario?: (name: string) => void;
    }
}
