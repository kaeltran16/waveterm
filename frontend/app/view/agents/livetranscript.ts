// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Live narration for working agents: opens StreamAgentTranscriptCommand per visible
// agent, accumulates raw JSONL lines, and projects them with projectTranscript (the
// unchanged seam) into liveEntriesByIdAtom. lastActivityByIdAtom stamps each chunk for
// the liveness cue. The open stream IS the subscription — stopTranscriptStream cancels
// the generator, which cancels the backend ctx and tears down the fsnotify watcher.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import type { AgentEntry } from "./agentsviewmodel";
import { projectTranscript } from "./transcriptprojection";

const STREAM_TAIL_LINES = 300;
// The server applies a 5s default request timeout (DefaultTimeoutMs) to every RPC, streams
// included — which would tear down the fsnotify watcher during any quiet stretch of an agent's
// work. Pass an effectively-infinite timeout (one year, matching the timeoutYear convention);
// the stream is instead ended explicitly via gen.return() when the panel unmounts.
const STREAM_TIMEOUT_MS = 31536000000;

export const liveEntriesByIdAtom = atom<Record<string, AgentEntry[]>>({}) as PrimitiveAtom<Record<string, AgentEntry[]>>;
export const lastActivityByIdAtom = atom<Record<string, number>>({}) as PrimitiveAtom<Record<string, number>>;

interface StreamHandle {
    stop: () => void;
}
const streams = new Map<string, StreamHandle>();

export function startTranscriptStream(id: string, path: string): void {
    if (!path || streams.has(id)) {
        return;
    }
    const gen = RpcApi.StreamAgentTranscriptCommand(TabRpcClient, { path, taillines: STREAM_TAIL_LINES }, { timeout: STREAM_TIMEOUT_MS });
    let cancelled = false;
    streams.set(id, {
        stop: () => {
            cancelled = true;
            void gen.return?.(undefined);
        },
    });
    const lines: string[] = [];
    void (async () => {
        try {
            for await (const chunk of gen) {
                if (cancelled) {
                    break;
                }
                if (!chunk?.lines?.length) {
                    continue;
                }
                lines.push(...chunk.lines);
                const entries = projectTranscript(lines);
                globalStore.set(liveEntriesByIdAtom, { ...globalStore.get(liveEntriesByIdAtom), [id]: entries });
                globalStore.set(lastActivityByIdAtom, { ...globalStore.get(lastActivityByIdAtom), [id]: Date.now() });
            }
        } catch {
            // stream ended or errored — keep the last entries, just stop updating
        } finally {
            streams.delete(id);
        }
    })();
}

export function stopTranscriptStream(id: string): void {
    const handle = streams.get(id);
    if (!handle) {
        return;
    }
    handle.stop();
    streams.delete(id);
}
