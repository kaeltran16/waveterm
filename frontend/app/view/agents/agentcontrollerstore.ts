// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";

// keyed by bare block id (BlockControllerRuntimeStatus.blockid, not an oref); undefined = no output seen yet
const lastOutputAtoms = new Map<string, PrimitiveAtom<number | undefined>>();

export function getLastOutputAtom(blockId: string): PrimitiveAtom<number | undefined> {
    let outputAtom = lastOutputAtoms.get(blockId);
    if (!outputAtom) {
        outputAtom = atom(undefined) as PrimitiveAtom<number | undefined>;
        lastOutputAtoms.set(blockId, outputAtom);
    }
    return outputAtom;
}

// keyed like lastOutputAtoms; set when the block's shell process reports done, cleared when it runs again
const procExitAtoms = new Map<string, PrimitiveAtom<{ code: number; at: number } | undefined>>();

export function getProcExitAtom(blockId: string): PrimitiveAtom<{ code: number; at: number } | undefined> {
    let exitAtom = procExitAtoms.get(blockId);
    if (!exitAtom) {
        exitAtom = atom(undefined) as PrimitiveAtom<{ code: number; at: number } | undefined>;
        procExitAtoms.set(blockId, exitAtom);
    }
    return exitAtom;
}

// keyed like lastOutputAtoms; the reason the block's controller last refused to start, cleared once it runs
const startErrorAtoms = new Map<string, PrimitiveAtom<string | undefined>>();

export function getStartErrorAtom(blockId: string): PrimitiveAtom<string | undefined> {
    let errAtom = startErrorAtoms.get(blockId);
    if (!errAtom) {
        errAtom = atom(undefined) as PrimitiveAtom<string | undefined>;
        startErrorAtoms.set(blockId, errAtom);
    }
    return errAtom;
}

// every controller start goes through here, so a refusal reaches the roster instead of only the console
export async function resyncController(data: CommandControllerResyncData): Promise<void> {
    const errAtom = getStartErrorAtom(data.blockid);
    try {
        await RpcApi.ControllerResyncCommand(TabRpcClient, data);
    } catch (e) {
        globalStore.set(errAtom, e instanceof Error ? e.message : String(e));
        throw e;
    }
    globalStore.set(errAtom, undefined);
}

// the UI's agent tabs open through the backend. The broadcast carrying the new tab can trail the reply, so the tab
// and its block are loaded here, for a caller that reads them at once.
export async function launchAgentTab(data: CommandLaunchAgentTabData): Promise<CommandLaunchAgentTabRtnData> {
    const rtn = await RpcApi.LaunchAgentTabCommand(TabRpcClient, data);
    await Promise.all([
        WOS.reloadWaveObject(WOS.makeORef("tab", rtn.tabid)),
        WOS.reloadWaveObject(WOS.makeORef("block", rtn.blockid)),
    ]);
    return rtn;
}

// a launch's start outcome, kept as resyncController keeps one: a refusal reaches the roster and is thrown
export function settleLaunchStart(rtn: CommandLaunchAgentTabRtnData): void {
    globalStore.set(getStartErrorAtom(rtn.blockid), rtn.starterror || undefined);
    if (rtn.starterror) {
        throw new Error(rtn.starterror);
    }
}

let subscribed = false;
export function setupControllerStatusSubscription() {
    if (subscribed) {
        return;
    }
    subscribed = true;
    waveEventSubscribeSingle({
        eventType: "controllerstatus",
        handler: (event) => {
            const data = event.data;
            if (!data?.blockid) {
                return;
            }
            if (data.shellprocstatus === "done") {
                globalStore.set(getProcExitAtom(data.blockid), { code: data.shellprocexitcode, at: Date.now() });
            } else if (data.shellprocstatus === "running") {
                globalStore.set(getProcExitAtom(data.blockid), undefined);
                globalStore.set(getStartErrorAtom(data.blockid), undefined);
            }
            if (data.lastoutputts) {
                globalStore.set(getLastOutputAtom(data.blockid), data.lastoutputts);
            }
        },
    });
}
