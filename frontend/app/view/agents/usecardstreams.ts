// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Shared card-stream lifecycle. The transcript streams (livetranscript) and per-card git tracking
// (cardgitstore) are module-level, idempotent singletons; this hook is the React driver that starts
// what's wanted, stops what's no longer wanted, and tears everything down on unmount. cockpitsurface
// drives it with trackGit (transcript + git + debounced-on-activity git reload); runbody drives it
// transcript-only. The two surfaces never co-mount, so stream ownership never collides.

import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { dropCardGit, refreshCardGit, scheduleCardGit } from "./cardgitstore";
import { lastActivityByIdAtom, startTranscriptStream, stopTranscriptStream } from "./livetranscript";

export type WantedCard = { id: string; path: string; agent?: string; blockId?: string };

// pure: given the currently-streamed ids and the wanted ids, which to start and which to stop.
// dedups wanted ids; order follows wanted (start) / current insertion (stop).
export function diffStreamSet(current: Set<string>, wantedIds: string[]): { toStart: string[]; toStop: string[] } {
    const wanted = new Set(wantedIds);
    const toStart: string[] = [];
    for (const id of wanted) {
        if (!current.has(id)) {
            toStart.push(id);
        }
    }
    const toStop: string[] = [];
    for (const id of current) {
        if (!wanted.has(id)) {
            toStop.push(id);
        }
    }
    return { toStart, toStop };
}

export function useCardStreams(wanted: WantedCard[], opts?: { trackGit?: boolean }): void {
    const trackGit = !!opts?.trackGit;
    const streamedRef = useRef<Set<string>>(new Set());
    const gitTrackedRef = useRef<Map<string, { path?: string; blockId?: string }>>(new Map());
    const gitSeenActivityRef = useRef<Map<string, number>>(new Map());
    const lastActivityById = useAtomValue(lastActivityByIdAtom);

    const wantedKey = wanted.map((w) => w.id).join(",");
    useEffect(() => {
        const byId = new Map<string, WantedCard>();
        for (const w of wanted) {
            byId.set(w.id, w);
        }
        const { toStart, toStop } = diffStreamSet(streamedRef.current, [...byId.keys()]);
        for (const id of toStart) {
            const w = byId.get(id)!;
            startTranscriptStream(id, w.path, w.agent);
            streamedRef.current.add(id);
            if (trackGit) {
                gitTrackedRef.current.set(id, { path: w.path, blockId: w.blockId });
                void refreshCardGit(id, w.path, w.blockId);
            }
        }
        for (const id of toStop) {
            stopTranscriptStream(id);
            streamedRef.current.delete(id);
            if (trackGit) {
                gitTrackedRef.current.delete(id);
                gitSeenActivityRef.current.delete(id);
                dropCardGit(id);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [wantedKey, trackGit]);

    // debounced git re-load when a tracked card narrates. First sighting adopts the current activity
    // stamp as baseline (the enter-time refresh already covered that state) so only advances schedule.
    useEffect(() => {
        if (!trackGit) {
            return;
        }
        for (const [id, meta] of gitTrackedRef.current) {
            const ts = lastActivityById[id];
            if (ts == null) {
                continue;
            }
            const seen = gitSeenActivityRef.current.get(id);
            if (seen == null) {
                gitSeenActivityRef.current.set(id, ts);
                continue;
            }
            if (ts > seen) {
                gitSeenActivityRef.current.set(id, ts);
                scheduleCardGit(id, meta.path, meta.blockId);
            }
        }
    }, [lastActivityById, trackGit]);

    useEffect(() => {
        return () => {
            for (const id of streamedRef.current) {
                stopTranscriptStream(id);
                if (trackGit) {
                    dropCardGit(id);
                }
            }
            streamedRef.current.clear();
            gitTrackedRef.current.clear();
            gitSeenActivityRef.current.clear();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
}
