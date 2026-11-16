// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Live narration for working agents: opens StreamAgentTranscriptCommand per visible
// agent, accumulates raw JSONL lines, and projects them with the agent's projector
// (transcriptregistry) into liveEntriesByIdAtom. lastActivityByIdAtom stamps each chunk for
// the liveness cue. The open stream IS the subscription — stopTranscriptStream cancels
// the generator, which cancels the backend ctx and tears down the fsnotify watcher.

import { globalStore } from "@/app/store/jotaiStore";
import { addWSReconnectHandler, removeWSReconnectHandler } from "@/app/store/ws";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import {
    dropLiveId,
    earlierByIdAtom,
    lastActivityByIdAtom,
    liveEntriesByIdAtom,
    tasksByIdAtom,
    type EarlierTurns,
} from "./livetranscriptatoms";
import { parseTranscriptLines, type TranscriptRecord } from "./transcriptrecords";
import { projectorFor } from "./transcriptregistry";

const STREAM_TAIL_LINES = 300;
// live-card working set; per-chunk projection runs over this window, not the whole session, so
// cost is O(window) not O(total lines). Full history stays on disk (focus/interior view). Must
// comfortably exceed what the timeline can render (TIMELINE_RENDER_CAP) so the view is always backed.
const MAX_RETAINED_LINES = 4000;

export function capLines<T>(lines: T[], max: number): T[] {
    return lines.length > max ? lines.slice(lines.length - max) : lines;
}
// The server applies a 5s default request timeout (DefaultTimeoutMs) to every RPC, streams
// included — which would tear down the fsnotify watcher during any quiet stretch of an agent's
// work. Pass an effectively-infinite timeout (one year, matching the timeoutYear convention);
// the stream is instead ended explicitly via gen.return() when the panel unmounts.
const STREAM_TIMEOUT_MS = 31536000000;

// The whole-map atoms are defined in livetranscriptatoms.ts (the leaf module also owning the
// per-id slices derived from them); re-exported here so existing consumers importing from
// this file keep working unchanged.
export { lastActivityByIdAtom, liveEntriesByIdAtom, tasksByIdAtom } from "./livetranscriptatoms";

interface StreamHandle {
    stop: () => void;
    path: string;
    agent?: string;
    // each line is parsed once, on arrival: projecting from lines re-parsed the whole retained window twice per chunk
    // on the UI thread
    records: TranscriptRecord[];
    // the records hold the file from its first line, so retention is not capped
    whole: boolean;
    // records streamed while a whole-file read is in flight; null when none is
    during: TranscriptRecord[] | null;
    publish: () => void;
}
const streams = new Map<string, StreamHandle>();

const uuidOf = (r: TranscriptRecord): unknown => (r as { uuid?: unknown } | null)?.uuid;

// A whole-file read followed by the records streamed while it ran: those the read already holds (by uuid) are not
// added twice. A record with no uuid cannot be matched, so it is kept.
export function mergeFullRead(full: TranscriptRecord[], during: TranscriptRecord[]): TranscriptRecord[] {
    const seen = new Set(full.map(uuidOf).filter((u) => u != null));
    return [...full, ...during.filter((r) => uuidOf(r) == null || !seen.has(uuidOf(r)))];
}

function setEarlier(id: string, value: EarlierTurns | null): void {
    const cur = globalStore.get(earlierByIdAtom);
    if ((cur[id] ?? null) === value) {
        return;
    }
    const next = { ...cur };
    if (value == null) {
        delete next[id];
    } else {
        next[id] = value;
    }
    globalStore.set(earlierByIdAtom, next);
}

// readWhole reopens a stream that already held the whole file (restartActiveStreams), so it stays whole
export function startTranscriptStream(id: string, path: string, agent?: string, readWhole = false): void {
    if (!path || streams.has(id)) {
        return;
    }
    const projector = projectorFor(agent, path);
    // Pi's parent-linked active branch cannot be reconstructed from a bounded tail, so it is the
    // only runtime that requests the complete file (taillines -1) and keeps every streamed line
    // while the session is open. Every other runtime tails STREAM_TAIL_LINES and caps retention.
    const isPi = agent?.toLowerCase() === "pi" || path.replace(/\\/g, "/").includes("/.pi/agent/sessions/");
    const whole = isPi || readWhole;
    const tailLines = whole ? -1 : STREAM_TAIL_LINES;
    const gen = RpcApi.StreamAgentTranscriptCommand(
        TabRpcClient,
        { path, taillines: tailLines },
        { timeout: STREAM_TIMEOUT_MS }
    );
    let cancelled = false;
    const handle: StreamHandle = {
        path,
        agent,
        stop: () => {
            cancelled = true;
            void gen.return?.(undefined);
        },
        records: [],
        whole,
        during: null,
        publish: () => {
            const records = handle.records;
            const entries = projector.projectRecords(records);
            globalStore.set(liveEntriesByIdAtom, { ...globalStore.get(liveEntriesByIdAtom), [id]: entries });
            globalStore.set(lastActivityByIdAtom, { ...globalStore.get(lastActivityByIdAtom), [id]: Date.now() });
            const tasks = projector.extractTasks?.(records);
            if (tasks != null) {
                globalStore.set(tasksByIdAtom, { ...globalStore.get(tasksByIdAtom), [id]: tasks });
            }
        },
    };
    streams.set(id, handle);
    void (async () => {
        let first = true;
        try {
            for await (const chunk of gen) {
                if (cancelled) {
                    break;
                }
                if (first) {
                    // a tail that came back full may have cut the file's start off
                    first = false;
                    const full = (chunk?.lines?.length ?? 0) >= STREAM_TAIL_LINES;
                    // a non-pi stream is only whole once Show earlier read the file
                    setEarlier(id, whole ? (isPi ? null : "shown") : full ? "hidden" : null);
                }
                if (!chunk?.lines?.length) {
                    continue;
                }
                const added = parseTranscriptLines(chunk.lines);
                handle.records.push(...added);
                handle.during?.push(...added);
                if (!handle.whole) {
                    handle.records = capLines(handle.records, MAX_RETAINED_LINES);
                }
                handle.publish();
            }
        } catch (err) {
            // keep the last entries and do not restart: the errors left (permissions, a path with no existing
            // ancestor) would fail again on every retry
            console.error("transcript stream ended", id, path, err);
        } finally {
            // a stale generator (from a stream restarted mid-flight, e.g. on ws reconnect) may
            // resolve after its replacement is already registered; only delete if we're still it
            if (streams.get(id) === handle) {
                streams.delete(id);
            }
        }
    })();
}

// Stops the generator without touching the atoms — used by restartActiveStreams, where the id
// is still wanted and the stale entries should stay visible until the fresh stream re-tails.
function stopStreamOnly(id: string): void {
    const handle = streams.get(id);
    if (!handle) {
        return;
    }
    handle.stop();
    streams.delete(id);
}

export function stopTranscriptStream(id: string): void {
    stopStreamOnly(id);
    dropLiveId(id);
}

// Reads the stream's whole file once and puts it in place of the retained tail; chunks keep appending after it, with
// retention uncapped from then on.
export async function showEarlierTranscript(id: string): Promise<void> {
    const handle = streams.get(id);
    if (handle == null || handle.whole || handle.during != null) {
        return;
    }
    handle.during = [];
    setEarlier(id, "loading");
    try {
        const rtn = await RpcApi.GetAgentTranscriptCommand(TabRpcClient, { path: handle.path, maxlines: -1 });
        if (streams.get(id) !== handle) {
            return;
        }
        handle.records = mergeFullRead(parseTranscriptLines(rtn?.lines ?? []), handle.during);
        handle.whole = true;
        // one batch with the entries, so the view remounts its feed on the render that brings the earlier rows
        handle.publish();
        setEarlier(id, "shown");
    } catch (err) {
        console.error("transcript whole-file read failed", id, handle.path, err);
        if (streams.get(id) === handle) {
            setEarlier(id, "hidden");
        }
    } finally {
        handle.during = null;
    }
}

// On a websocket reconnect the old generators are hung (a socket drop never errored/returned them),
// and useCardStreams won't re-drive start (its wanted-set is unchanged). Stop every active stream and
// re-open it; the fresh startTranscriptStream re-tails STREAM_TAIL_LINES (a small, acceptable catch-up), or re-reads
// the whole file when Show earlier had already read it, so the earlier rows do not vanish.
// Uses stopStreamOnly (not stopTranscriptStream) so the last-known entries stay visible instead of
// vanishing and reappearing once the re-tail lands.
export function restartActiveStreams(): void {
    const active = [...streams.entries()].map(([id, h]) => ({ id, path: h.path, agent: h.agent, whole: h.whole }));
    for (const { id } of active) {
        stopStreamOnly(id);
    }
    for (const { id, path, agent, whole } of active) {
        startTranscriptStream(id, path, agent, whole);
    }
}

addWSReconnectHandler(restartActiveStreams);
if (import.meta.hot) {
    import.meta.hot.dispose(() => removeWSReconnectHandler(restartActiveStreams));
}
