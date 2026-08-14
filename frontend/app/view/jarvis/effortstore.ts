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
        chunks: effort.chunks.map((c) => ({ label: c.label, status: c.status, owner: c.owner })),
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

// fetch-once cache fill shared by the card expand, the detail subject, and re-entry paths; a
// successful mutate has already replaced the cache entry, so callers may skip this. Failures are
// recorded in effortDetailErrorAtom and re-thrown so callers can decide (the expand helpers swallow).
export async function loadEffortDetail(oref: string): Promise<void> {
    if (globalStore.get(effortDetailAtom).has(oref)) {
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
export async function appendChunkNote(oref: string, chunk: string | null, text: string): Promise<void> {
    await mutateEffort(oref, [{ op: "appendNote", chunk: chunk ?? undefined, note: text }]);
}
