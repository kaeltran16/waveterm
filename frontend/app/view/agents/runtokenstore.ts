// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A run's tokens per role, task and model, from the engine's own accounting (RunUsageCommand). A sealed total is
// kept; a live one is read again, at most once a minute per run.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, useAtomValue, type PrimitiveAtom } from "jotai";
import { useEffect } from "react";

const REFRESH_MS = 60_000;
// totalling reads every session transcript of the run, which can outlast the default rpc budget
const LOAD_TIMEOUT_MS = 30_000;

export interface RunUsage {
    rows: UsageRow[];
    sealed: boolean;
}

export const runUsageAtom = atom<Record<string, RunUsage>>({}) as PrimitiveAtom<Record<string, RunUsage>>;

const lastLoad = new Map<string, number>(); // by run id

export async function loadRunUsage(channelId: string, runId: string, now: number): Promise<void> {
    if (!channelId || globalStore.get(runUsageAtom)[runId]?.sealed || now - (lastLoad.get(runId) ?? 0) < REFRESH_MS) {
        return;
    }
    lastLoad.set(runId, now);
    try {
        const rtn = await RpcApi.RunUsageCommand(
            TabRpcClient,
            { channelid: channelId, runid: runId },
            { timeout: LOAD_TIMEOUT_MS }
        );
        const usage: RunUsage = { rows: rtn?.usage ?? [], sealed: !!rtn?.sealed };
        globalStore.set(runUsageAtom, (prev) => ({ ...prev, [runId]: usage }));
    } catch (e) {
        // keep the last total; the next load retries
        lastLoad.delete(runId);
        console.warn(`run usage for ${runId}:`, e);
    }
}

// useRunUsage loads a run's usage while it is shown, and again each minute until it is sealed
export function useRunUsage(channelId: string | undefined, runId: string | undefined): RunUsage | undefined {
    const usage = useAtomValue(runUsageAtom)[runId ?? ""];
    useEffect(() => {
        if (!channelId || !runId) {
            return;
        }
        const load = () => fireAndForget(() => loadRunUsage(channelId, runId, Date.now()));
        load();
        const timer = setInterval(load, REFRESH_MS);
        return () => clearInterval(timer);
    }, [channelId, runId]);
    return usage;
}
