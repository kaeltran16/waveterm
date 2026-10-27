// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Remote mode's status for Settings > Remote and the app bar's pill. Loaded once and kept current by the
// remote:status event, which wavesrv publishes on every change (the phone's off button included); the
// always-mounted app bar holds the subscription.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";

// turning on starts cloudflared, which can outlast the 5 s default
const REMOTE_SWITCH_TIMEOUT_MS = 15_000;

export const remoteStatusAtom = atom<RemoteStatusData | null>(null) as PrimitiveAtom<RemoteStatusData | null>;

export async function loadRemoteStatus(): Promise<void> {
    try {
        globalStore.set(remoteStatusAtom, await RpcApi.RemoteStatusCommand(TabRpcClient));
    } catch (e) {
        console.error("load remote mode status", e);
    }
}

export function subscribeRemoteStatus(): () => void {
    return waveEventSubscribeSingle({
        eventType: "remote:status",
        handler: (event) => {
            const data = event.data as RemoteStatusData | undefined;
            if (data != null) {
                globalStore.set(remoteStatusAtom, data);
            }
        },
    });
}

// throws the RPC's error for the caller to show
export async function setRemoteOn(on: boolean): Promise<void> {
    const opts = { timeout: REMOTE_SWITCH_TIMEOUT_MS };
    const status = on
        ? await RpcApi.RemoteOnCommand(TabRpcClient, opts)
        : await RpcApi.RemoteOffCommand(TabRpcClient, opts);
    globalStore.set(remoteStatusAtom, status);
}
