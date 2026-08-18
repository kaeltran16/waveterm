// Copyright 2026, Command Line Inc.
//
// Run-lifecycle event state: per-run atom, initial load via JarvisRunEventsCommand, live append via
// the run:event broadcast (scoped to run:<id>, so only the focused run's card receives it).

import { useEffect } from "react";
import { atom, useAtomValue, type PrimitiveAtom } from "jotai";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { fireAndForget } from "@/util/util";

const eventsAtoms = new Map<string, PrimitiveAtom<RunEvent[]>>();
const loadedRuns = new Set<string>();

function eventsAtomFor(runId: string) {
    let a = eventsAtoms.get(runId);
    if (!a) {
        a = atom<RunEvent[]>([]) as PrimitiveAtom<RunEvent[]>;
        eventsAtoms.set(runId, a);
    }
    return a;
}

async function load(runId: string, channelId: string): Promise<void> {
    if (loadedRuns.has(runId)) {
        return;
    }
    loadedRuns.add(runId);
    try {
        const rtn = await RpcApi.JarvisRunEventsCommand(TabRpcClient, { channelid: channelId, runid: runId, limit: 200 });
        globalStore.set(eventsAtomFor(runId), rtn.events ?? []);
    } catch {
        loadedRuns.delete(runId); // allow retry on transient failure
    }
}

let subscribed = false;
function ensureSubscription() {
    if (subscribed) {
        return;
    }
    subscribed = true;
    // unscoped singleton: only the focused run card holds an atom, so the runid filter is cheap
    // enough to be the whole subscription story (a run:event for a run nobody is watching has no atom).
    waveEventSubscribeSingle({
        eventType: "run:event",
        handler: (event) => {
            const data = event.data as RunEventData | undefined;
            if (data?.runid == null || data.event == null) {
                return;
            }
            const target = eventsAtoms.get(data.runid);
            if (!target) {
                return; // no card is watching this run
            }
            globalStore.set(target, (prev) => {
                const next = prev.filter((e) => e.id !== data.event.id);
                next.unshift(data.event);
                return next.slice(0, 200);
            });
        },
    });
}

// Subscribe a run card to its live event stream and load history once.
export function useRunEvents(runId: string, channelId: string): RunEvent[] {
    ensureSubscription();
    useEffect(() => {
        fireAndForget(() => load(runId, channelId));
    }, [runId, channelId]);
    return useAtomValue(eventsAtomFor(runId));
}