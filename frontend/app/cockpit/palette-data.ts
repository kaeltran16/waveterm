// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { dedupeByProject } from "@/app/view/agents/projectlabel";
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
    if (loadId === latestAllRunsLoad) {
        globalStore.set(allRunsAtom, mergeChannelRuns(globalStore.get(allRunsAtom), results));
    }
}

// the channel launch rows start in: the active one, else the last-picked project's, else the only project's
export function palettePickChannel(
    active: Channel | null,
    channels: Channel[] | null,
    lastPicked: string | null,
    projectLabel: (c: Channel) => string
): Channel | null {
    if (active != null) {
        return active;
    }
    if (channels == null) {
        return null;
    }
    const projects = dedupeByProject(channels);
    if (lastPicked != null) {
        const picked = projects.find((c) => projectLabel(c) === lastPicked);
        if (picked != null) {
            return picked;
        }
    }
    return projects.length === 1 ? projects[0] : null;
}
