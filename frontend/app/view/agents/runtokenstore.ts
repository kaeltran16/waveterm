// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A run's tokens so far: its task runs' transcripts, summed by the same accounting as the Usage surface. A
// settled task's total is kept; a running one's is read again, at most once a minute per run.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import type { RunInfo } from "./runlineage";

const REFRESH_MS = 60_000;
const SETTLED = new Set(["done", "skipped", "cancelled", "failed"]);

export const runTokensAtom = atom<Record<string, number>>({}) as PrimitiveAtom<Record<string, number>>;

const settled = new Map<string, number>(); // by task run id
const lastLoad = new Map<string, number>(); // by run id

async function taskTokens(channelid: string, task: TaskNode): Promise<number> {
    const kept = settled.get(task.runid!);
    if (kept != null) {
        return kept;
    }
    const path = await RpcApi.RunTranscriptPathCommand(TabRpcClient, { channelid, runid: task.runid! });
    const tokens = path ? (await RpcApi.GetTranscriptTokensCommand(TabRpcClient, { path })).tokens : 0;
    if (SETTLED.has(task.state)) {
        settled.set(task.runid!, tokens);
    }
    return tokens;
}

export async function loadRunTokens(run: RunInfo, now: number): Promise<void> {
    if (!run.channelId || now - (lastLoad.get(run.runId) ?? 0) < REFRESH_MS) {
        return;
    }
    lastLoad.set(run.runId, now);
    const tasks = (run.dag?.tasks ?? []).filter((t) => t.runid);
    try {
        const each = await Promise.all(tasks.map((t) => taskTokens(run.channelId, t)));
        const total = each.reduce((a, b) => a + b, 0);
        globalStore.set(runTokensAtom, (prev) => ({ ...prev, [run.runId]: total }));
    } catch (e) {
        // keep the last total; the next load retries
        lastLoad.delete(run.runId);
        console.warn(`run tokens for ${run.runId}:`, e);
    }
}
