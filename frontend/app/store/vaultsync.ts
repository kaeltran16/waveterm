// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Window-focus trigger for vault sync. The backend loop pulls on a timer; this makes switching back to
// the app pull sooner, throttled so a flurry of focus events costs one sync.

import { RpcApi } from "./wshclientapi";
import { TabRpcClient } from "./wshrpcutil";

export const FOCUS_SYNC_MIN_INTERVAL_MS = 60_000;

export function shouldSyncOnFocus(lastMs: number | null, nowMs: number): boolean {
    return lastMs == null || nowMs - lastMs >= FOCUS_SYNC_MIN_INTERVAL_MS;
}

// wait:false returns at once: a sync can outlive the RPC budget. failures are the backend's to log
// ("no remote" is the normal case for most users), so the rejection is dropped here.
function requestSync() {
    RpcApi.VaultSyncCommand(TabRpcClient, { wait: false }).catch(() => {});
}

// one sync at launch too, so the first open after a switch already pulls.
export function installVaultSyncTriggers() {
    let last: number | null = null;
    const trigger = () => {
        const now = Date.now();
        if (!shouldSyncOnFocus(last, now)) {
            return;
        }
        last = now;
        requestSync();
    };
    window.addEventListener("focus", trigger);
    trigger();
}
