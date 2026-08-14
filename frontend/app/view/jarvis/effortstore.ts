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

export async function toggleEffort(oref: string): Promise<void> {
    const cur = globalStore.get(expandedEffortOrefAtom);
    if (cur === oref) {
        globalStore.set(expandedEffortOrefAtom, null);
        return;
    }
    if (!globalStore.get(effortDetailAtom).has(oref)) {
        const rtn = await RpcApi.EffortGetCommand(
            TabRpcClient,
            { effortoid: effortOid(oref) },
            { timeout: stateRpcTimeoutMs }
        );
        const cache = new Map(globalStore.get(effortDetailAtom));
        cache.set(oref, rtn.effort);
        globalStore.set(effortDetailAtom, cache);
    }
    globalStore.set(expandedEffortOrefAtom, oref);
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
