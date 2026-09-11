// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The inline effort tracker's store: one expanded effort at a time, an on-demand full-effort cache,
// and the mutate helpers that write through and refresh the briefing's summary leg.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { loadBriefingAsync, stateRpcTimeoutMs } from "./briefingstore";
import { chunkTone, type ChunkTone } from "./effortmodel";

export const expandedEffortOrefAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const effortDetailAtom = atom<Map<string, Effort>>(new Map()) as PrimitiveAtom<Map<string, Effort>>;
// fetch failures surface inline on the card/detail instead of a dead click; cleared on success.
export const effortDetailErrorAtom = atom<Map<string, string>>(new Map()) as PrimitiveAtom<Map<string, string>>;

export type ChunkRowModel = {
    label: string;
    status: string;
    stage: string;
    tone: ChunkTone;
    latestNote?: string;
    trail: EffortNote[];
    owner?: string;
    workrefs: ChunkWorkRef[];
};

// notes are append-only; the latest entry is the newest
export function effortChunkRows(effort: Effort): ChunkRowModel[] {
    return effort.chunks.map((c) => {
        const trail = [...(c.notes ?? [])].sort((a, b) => a.ts - b.ts);
        return {
            label: c.label,
            status: c.status,
            stage: c.stage ?? "",
            tone: chunkTone(c.status),
            latestNote: trail.length > 0 ? trail[trail.length - 1].text : undefined,
            trail,
            owner: c.owner,
            workrefs: c.workrefs ?? [],
        };
    });
}

// rebuild the wire summary from the full record (same derivation as the backend's summary leg) so
// the detail subject reuses the card math — count line, progress, tones — without a second fetch.
export function effortSummaryOf(effort: Effort): EffortSummary {
    const active =
        effort.chunks.find((c) => c.status === "active")?.label ??
        effort.chunks.find((c) => c.status !== "done" && c.status !== "skipped")?.label;
    return {
        oref: "effort:" + effort.oid,
        title: effort.title,
        project: effort.project,
        ticket: effort.ticket,
        status: effort.status,
        parentoid: effort.parentoid,
        chunks: effort.chunks.map((c) => ({ label: c.label, status: c.status, stage: c.stage, owner: c.owner })),
        done: effort.chunks.filter((c) => c.status === "done").length,
        total: effort.chunks.length,
        activechunk: active,
        updatedts: effort.updatedts,
    };
}

const effortOid = (oref: string) => oref.replace(/^effort:/, "");

async function mutateEffort(oref: string, ops: EffortOp[]): Promise<void> {
    const rtn = await RpcApi.EffortMutateCommand(
        TabRpcClient,
        { effortoid: effortOid(oref), ops },
        { timeout: stateRpcTimeoutMs }
    );
    const cache = new Map(globalStore.get(effortDetailAtom));
    cache.set(oref, rtn.effort);
    globalStore.set(effortDetailAtom, cache);
    void loadBriefingAsync(); // summary leg refresh; failure degrades to the next load
}

// The cache was fetch-once, and only a mutate made THROUGH this store replaced an entry. An effort
// ticked out of band — `wsh effort` in a terminal, or an agent advancing its own chunk — therefore left
// every rendered row frozen at whatever the app read first, while the header's count came off the
// briefing that reloads on each Brief entry. A count disagreeing with the rows beneath it is exactly the
// defect invariant 5 names. The briefing already carries each effort's updatedts, so the load that keeps
// the count honest is also what proves the detail stale: pass it, and the cache can tell.
export function effortDetailIsFresh(cached: Effort | undefined, freshTs?: number): boolean {
    return cached != null && (freshTs == null || cached.updatedts >= freshTs);
}

// Cache fill shared by the card expand, the detail subject, and re-entry paths; a successful mutate has
// already replaced the cache entry, so callers may skip this. Failures are recorded in
// effortDetailErrorAtom and re-thrown so callers can decide (the expand helpers swallow). The stale entry
// is left in place across a refetch on purpose — dropping it first would blank an open tracker's rows.
export async function loadEffortDetail(oref: string, freshTs?: number): Promise<void> {
    if (effortDetailIsFresh(globalStore.get(effortDetailAtom).get(oref), freshTs)) {
        return;
    }
    try {
        const rtn = await RpcApi.EffortGetCommand(
            TabRpcClient,
            { effortoid: effortOid(oref) },
            { timeout: stateRpcTimeoutMs }
        );
        const cache = new Map(globalStore.get(effortDetailAtom));
        cache.set(oref, rtn.effort);
        globalStore.set(effortDetailAtom, cache);
        const errs = new Map(globalStore.get(effortDetailErrorAtom));
        errs.delete(oref);
        globalStore.set(effortDetailErrorAtom, errs);
    } catch (e) {
        const errs = new Map(globalStore.get(effortDetailErrorAtom));
        errs.set(oref, e instanceof Error ? e.message : String(e));
        globalStore.set(effortDetailErrorAtom, errs);
        throw e;
    }
}

export async function expandEffort(oref: string): Promise<void> {
    // expand first so the card opens immediately; the fetch fills it in, or the recorded error shows
    // inline with a retry. A failed fetch must not read as a dead click.
    globalStore.set(expandedEffortOrefAtom, oref);
    await loadEffortDetail(oref).catch(() => {});
}

export async function toggleEffort(oref: string): Promise<void> {
    if (globalStore.get(expandedEffortOrefAtom) === oref) {
        globalStore.set(expandedEffortOrefAtom, null);
        return;
    }
    await expandEffort(oref);
}

export async function advanceChunk(oref: string, note?: string): Promise<void> {
    await mutateEffort(oref, note != null ? [{ op: "advance", note }] : [{ op: "advance" }]);
}
export async function setChunkStatus(oref: string, chunk: string, status: string, note?: string): Promise<void> {
    await mutateEffort(oref, [{ op: "setChunkStatus", chunk, status, note }]);
}
export async function reopenChunk(oref: string, chunk: string): Promise<void> {
    await mutateEffort(oref, [{ op: "reopen", chunk }]);
}
export async function addChunkOp(oref: string, label: string): Promise<void> {
    await mutateEffort(oref, [{ op: "addChunk", label }]);
}

// One batch, so re-staging a whole run is atomic: the server validates every op before applying any,
// and a run half-renamed would split into two groups on screen. Passing "" clears the stage.
export async function setChunkStage(oref: string, chunks: string[], stage: string): Promise<void> {
    await mutateEffort(
        oref,
        chunks.map((chunk) => ({ op: "setChunkStage", chunk, stage }))
    );
}
export async function appendChunkNote(oref: string, chunk: string | null, text: string): Promise<void> {
    await mutateEffort(oref, [{ op: "appendNote", chunk: chunk ?? undefined, note: text }]);
}
export async function setEffortStatus(oref: string, status: string): Promise<void> {
    await mutateEffort(oref, [{ op: "setStatus", status }]);
}

// not setStatus("active"): the server restores whatever the archive replaced, which is the only
// place that knows — an initiative archived while paused or done comes back as it went in.
export async function unarchiveEffort(oref: string): Promise<void> {
    await mutateEffort(oref, [{ op: "unarchive" }]);
}

// hard delete: the record and its whole note trail go. Callers gate this behind an archived status
// and a confirm, mirroring the CLI's own EC-NOT-ARCHIVED refusal.
export async function deleteEffort(oref: string): Promise<void> {
    await RpcApi.EffortDeleteCommand(TabRpcClient, { effortoid: effortOid(oref) }, { timeout: stateRpcTimeoutMs });
    const cache = new Map(globalStore.get(effortDetailAtom));
    cache.delete(oref);
    globalStore.set(effortDetailAtom, cache);
    if (globalStore.get(expandedEffortOrefAtom) === oref) {
        globalStore.set(expandedEffortOrefAtom, null);
    }
    void loadBriefingAsync();
}
