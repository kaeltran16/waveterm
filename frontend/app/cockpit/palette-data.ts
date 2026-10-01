// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { rowsWithChannel, type ProjectRow } from "@/app/view/agents/projectsstore";
import { ensureRunEvents } from "@/app/view/agents/runeventstore";
import { isTerminal } from "@/app/view/agents/runmodel";
import { atom, type PrimitiveAtom } from "jotai";

export interface ProjectRun {
    channelId: string;
    run: Run;
}

interface ChannelRunsResult {
    channelId: string;
    runs?: Run[];
    error?: unknown;
}

// every channel's runs; the palette lists runs outside the active project too
export const allRunsAtom = atom<ProjectRun[]>([]) as PrimitiveAtom<ProjectRun[]>;

let latestAllRunsLoad = 0;

// a failed channel keeps its previous runs: dropping them on one bad request would make live runs vanish from the palette
export function mergeChannelRuns(prev: ProjectRun[], results: ChannelRunsResult[]): ProjectRun[] {
    const out: ProjectRun[] = [];
    for (const res of results) {
        if (res.error !== undefined) {
            out.push(...prev.filter((p) => p.channelId === res.channelId));
            continue;
        }
        for (const run of res.runs ?? []) {
            out.push({ channelId: res.channelId, run });
        }
    }
    return out;
}

export async function loadAllRuns(channels: Channel[]): Promise<void> {
    const loadId = ++latestAllRunsLoad;
    const results = await Promise.all(
        channels.map(async (c): Promise<ChannelRunsResult> => {
            try {
                const rtn = await RpcApi.GetChannelRunsCommand(TabRpcClient, { channelid: c.oid });
                return { channelId: c.oid, runs: rtn.runs ?? [] };
            } catch (error) {
                console.warn("palette: loading runs failed for channel", c.oid, error);
                return { channelId: c.oid, error };
            }
        })
    );
    if (loadId !== latestAllRunsLoad) {
        return;
    }
    const runs = mergeChannelRuns(globalStore.get(allRunsAtom), results);
    globalStore.set(allRunsAtom, runs);
    // Relaunch reads a run's events to see its lead is down, and only the grid loads them for its own runs
    for (const p of runs) {
        if (!isTerminal(p.run.status)) {
            ensureRunEvents(p.run.id, p.channelId);
        }
    }
}

// the channel launch rows start in: the active one, else the most recently used project's, else the only project's
export function palettePickChannel(
    active: Channel | null,
    rows: ProjectRow[],
    lastPicked: string | null
): Channel | null {
    if (active != null) {
        return active;
    }
    const ready = rowsWithChannel(rows);
    const picked = ready.find((r) => r.name === lastPicked);
    if (picked != null) {
        return picked.channel;
    }
    return ready.length === 1 ? ready[0].channel : null;
}
