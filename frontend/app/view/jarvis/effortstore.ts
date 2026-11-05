// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The effort store: an on-demand full-effort cache, and the mutate helpers that write through it. The
// briefing refreshes from the effort:update event every write publishes (subscribeEffortUpdates).

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { atom, type PrimitiveAtom } from "jotai";
import { loadBriefingAsync, stateRpcTimeoutMs } from "./briefingstore";
import { chunkTone, type ChunkTone } from "./effortmodel";
import { createEffortSync } from "./effortsync";
import { chunkRef, type EditChunk } from "./trackeredit";

export const effortDetailAtom = atom<Map<string, Effort>>(new Map()) as PrimitiveAtom<Map<string, Effort>>;

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
    return (effort.chunks ?? []).map((c) => {
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

const effortOid = (oref: string) => oref.replace(/^effort:/, "");

async function mutateEffort(oref: string, ops: EffortOp[]): Promise<void> {
    const rtn = await RpcApi.EffortMutateCommand(
        TabRpcClient,
        { effortoid: effortOid(oref), ops, author: "you" },
        { timeout: stateRpcTimeoutMs }
    );
    const cache = new Map(globalStore.get(effortDetailAtom));
    cache.set(oref, rtn.effort);
    globalStore.set(effortDetailAtom, cache);
    // the briefing and archived lists refresh from the effort:update event this write publishes
}

// the archived initiatives the Brief can reveal (design L251, "Show N archived"); the briefing leg drops
// archived efforts server-side, so these come from the effort list with includearchived.
export const archivedEffortsAtom = atom<EffortSummary[]>([]) as PrimitiveAtom<EffortSummary[]>;
// resolves with the whole list, archived included, for a caller that needs more than the archived half
export async function loadArchivedEfforts(): Promise<EffortSummary[]> {
    const rtn = await RpcApi.EffortListCommand(TabRpcClient, { includearchived: true }, { timeout: stateRpcTimeoutMs });
    const all = rtn.efforts ?? [];
    globalStore.set(
        archivedEffortsAtom,
        all.filter((e) => e.status === "archived")
    );
    return all;
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

// The last failed load per oref, so an initiative whose plan never arrived can say why and offer a retry:
// effort sync refreshes only orefs already cached, so nothing else would ever load it again.
export const effortLoadErrorAtom = atom<Map<string, string>>(new Map()) as PrimitiveAtom<Map<string, string>>;

function setLoadError(oref: string, message: string | null): void {
    const cur = globalStore.get(effortLoadErrorAtom);
    if (message == null && !cur.has(oref)) {
        return;
    }
    const next = new Map(cur);
    if (message == null) {
        next.delete(oref);
    } else {
        next.set(oref, message);
    }
    globalStore.set(effortLoadErrorAtom, next);
}

// Cache fill for the sheet and the composer; a successful mutate has already replaced the cache entry, so
// callers may skip this. A failure is recorded under the oref (effortLoadErrorAtom) and still throws to the
// caller. The stale entry is left in place across a refetch on purpose — dropping it first would blank an
// open sheet's rows.
export async function loadEffortDetail(oref: string, freshTs?: number): Promise<void> {
    if (effortDetailIsFresh(globalStore.get(effortDetailAtom).get(oref), freshTs)) {
        return;
    }
    let rtn: CommandEffortGetRtnData;
    try {
        rtn = await RpcApi.EffortGetCommand(
            TabRpcClient,
            { effortoid: effortOid(oref) },
            { timeout: stateRpcTimeoutMs }
        );
    } catch (e) {
        setLoadError(oref, e instanceof Error ? e.message : String(e));
        throw e;
    }
    const cache = new Map(globalStore.get(effortDetailAtom));
    cache.set(oref, rtn.effort);
    globalStore.set(effortDetailAtom, cache);
    setLoadError(oref, null);
}

// wavesrv publishes effort:update on every effort write and delete, including the ones made outside this
// store (`wsh effort`, an agent's tick, the engine's chunk marks). Called once from the always-mounted shell.
export function subscribeEffortUpdates(model: AgentsViewModel): () => void {
    const sync = createEffortSync({
        surface: () => globalStore.get(model.surfaceAtom),
        cachedORefs: () => [...globalStore.get(effortDetailAtom).keys()],
        listEfforts: loadArchivedEfforts,
        reloadBriefing: loadBriefingAsync,
        refreshDetail: loadEffortDetail,
        dropDetails: (orefs) => {
            const cache = new Map(globalStore.get(effortDetailAtom));
            orefs.forEach((oref) => cache.delete(oref));
            globalStore.set(effortDetailAtom, cache);
        },
    });
    const unsubscribe = waveEventSubscribeSingle({ eventType: "effort:update", handler: sync.poke });
    return () => {
        unsubscribe();
        sync.cancel();
    };
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
// "" clears the project
export async function setEffortProject(oref: string, project: string): Promise<void> {
    await mutateEffort(oref, [{ op: "setProject", project }]);
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
}

export type EffortDetails = { title: string; project: string; ticket: string; parent: string };

const bareOid = (s: string) => s.trim().replace(/^effort:/, "");

// only what changed, so saving details that were never touched writes nothing to the trail
export function detailOps(cur: EffortDetails, next: EffortDetails): EffortOp[] {
    const ops: EffortOp[] = [];
    if (next.title.trim() !== cur.title.trim()) {
        ops.push({ op: "rename", title: next.title.trim() });
    }
    if (next.project.trim() !== cur.project.trim()) {
        ops.push({ op: "setProject", project: next.project.trim() });
    }
    if (next.ticket.trim() !== cur.ticket.trim()) {
        ops.push({ op: "setTicket", ticket: next.ticket.trim() });
    }
    if (bareOid(next.parent) !== bareOid(cur.parent)) {
        ops.push({ op: "link", parentoid: bareOid(next.parent) });
    }
    return ops;
}

export async function renameEffort(oref: string, title: string): Promise<void> {
    await mutateEffort(oref, [{ op: "rename", title: title.trim() }]);
}
export async function setEffortDetails(oref: string, cur: EffortDetails, next: EffortDetails): Promise<void> {
    const ops = detailOps(cur, next);
    if (ops.length > 0) {
        await mutateEffort(oref, ops);
    }
}
export async function renameChunk(oref: string, chunks: EditChunk[], label: string, next: string): Promise<void> {
    await mutateEffort(oref, [{ op: "renameChunk", chunk: chunkRef(chunks, label), label: next.trim() }]);
}
export async function moveChunk(oref: string, chunks: EditChunk[], label: string, at: number): Promise<void> {
    await mutateEffort(oref, [{ op: "moveChunk", chunk: chunkRef(chunks, label), at }]);
}
// one batch: a chunk restaged but not yet moved would render as a one-chunk run of its new stage
export async function moveChunkToStage(
    oref: string,
    chunks: EditChunk[],
    label: string,
    stage: string,
    at: number
): Promise<void> {
    const ref = chunkRef(chunks, label);
    await mutateEffort(oref, [
        { op: "setChunkStage", chunk: ref, stage },
        { op: "moveChunk", chunk: ref, at },
    ]);
}
// highest position first, so an index ref (see chunkRef) is never shifted by an earlier removal
export async function removeChunks(oref: string, chunks: EditChunk[], labels: string[]): Promise<void> {
    const idx = (l: string) => chunks.findIndex((c) => c.label === l);
    const ordered = [...labels].sort((a, b) => idx(b) - idx(a));
    await mutateEffort(
        oref,
        ordered.map((label) => ({ op: "removeChunk", chunk: chunkRef(chunks, label) }))
    );
}
export async function addChunkAt(oref: string, label: string, stage: string, at?: number): Promise<void> {
    await mutateEffort(oref, [{ op: "addChunk", label: label.trim(), stage: stage || undefined, at }]);
}
export async function editNote(oref: string, chunk: string, at: number, ts: number, text: string): Promise<void> {
    await mutateEffort(oref, [{ op: "editNote", chunk, at, notets: ts, note: text.trim() }]);
}
export async function removeNote(oref: string, chunk: string, at: number, ts: number): Promise<void> {
    await mutateEffort(oref, [{ op: "removeNote", chunk, at, notets: ts }]);
}
