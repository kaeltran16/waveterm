// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Jarvis graph surface (U3) state + loaders. Module-scope jotai atoms written by async loaders via
// globalStore (mirrors memstore), so state survives the nav-switch unmount. Snapshot
// semantics: the base graph loads once per open; a dossier's attribution blooms lazily on focus and
// is cached. No live push this cycle.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, type PrimitiveAtom } from "jotai";

// vault scan/read are local FS ops; bound them so a dead backend rejects instead of hanging on "Loading…".
const GRAPH_RPC_TIMEOUT_MS = 5000;
// a record's bloom resolves attribution across every run; the first after wavesrv starts fills the git
// subject cache, which takes ~10 s on a real profile. A visible wait beats a wrong "no edges".
const BLOOM_RPC_TIMEOUT_MS = 15000;

export type BloomStatus = "loading" | "failed";

export const graphBaseAtom = atom<{ nodes: GraphNode[]; links: GraphLink[] } | null>(null) as PrimitiveAtom<{
    nodes: GraphNode[];
    links: GraphLink[];
} | null>;
export const graphLoadedAtom = atom(false) as PrimitiveAtom<boolean>;
export const graphErrorAtom = atom(false) as PrimitiveAtom<boolean>;
export const graphSelectedIdAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const graphBloomAtom = atom<Map<string, { runs: GraphNode[]; links: GraphLink[] }>>(new Map()) as PrimitiveAtom<
    Map<string, { runs: GraphNode[]; links: GraphLink[] }>
>;
// a record's bloom while it is in flight or after it failed; absent once it lands (or before it is asked)
export const graphBloomStatusAtom = atom<Map<string, BloomStatus>>(new Map()) as PrimitiveAtom<
    Map<string, BloomStatus>
>;

export async function loadGraph(): Promise<void> {
    try {
        const g = await RpcApi.VaultGraphCommand(TabRpcClient, { timeout: GRAPH_RPC_TIMEOUT_MS });
        globalStore.set(graphBaseAtom, { nodes: g.nodes ?? [], links: g.links ?? [] });
        globalStore.set(graphErrorAtom, false);
        globalStore.set(graphLoadedAtom, true);
    } catch {
        globalStore.set(graphErrorAtom, true);
        globalStore.set(graphLoadedAtom, true);
    }
}

// Select a node. For a task, also resolve + cache its attribution bloom (focusDossier); other kinds
// just select.
export function selectNode(id: string | null): void {
    globalStore.set(graphSelectedIdAtom, id);
}

// Select a run node, but only if the bloom that would carry it actually returned it. VaultGraph emits no
// run nodes, so a run is selectable only through its record's bloom — selecting an id with no node behind
// it would leave the overlay claiming a selection the canvas cannot draw.
export function selectBloomedRun(dossierId: string, runORef: string): boolean {
    const bloom = globalStore.get(graphBloomAtom).get(dossierId);
    if (!bloom?.runs?.some((r) => r.id === runORef)) {
        return false;
    }
    selectNode(runORef);
    return true;
}

// Select a node the way the canvas does: a task also blooms its attribution, other kinds just select.
export function pickNode(n: { id: string; kind: string }): void {
    if (n.kind === "task") fireAndForget(() => focusDossier(n.id));
    else selectNode(n.id);
}

function setBloomStatus(dossierId: string, status: BloomStatus | null): void {
    globalStore.set(graphBloomStatusAtom, (prev) => {
        const next = new Map(prev);
        if (status == null) next.delete(dossierId);
        else next.set(dossierId, status);
        return next;
    });
}

// only a record's newest request writes its status, so an older call settling late cannot mark a
// record failed (or loaded) over the one still in flight
let bloomSeq = 0;
const latestBloom = new Map<string, number>();

async function loadBloom(dossierId: string): Promise<void> {
    const req = ++bloomSeq;
    latestBloom.set(dossierId, req);
    setBloomStatus(dossierId, "loading");
    try {
        const r = await RpcApi.ResolveDossierEdgesCommand(
            TabRpcClient,
            { dossierid: dossierId },
            { timeout: BLOOM_RPC_TIMEOUT_MS }
        );
        // the latest map, not one read before the await: two overlapping blooms must both land
        globalStore.set(graphBloomAtom, (prev) =>
            new Map(prev).set(dossierId, { runs: r.runs ?? [], links: r.links ?? [] })
        );
        if (latestBloom.get(dossierId) === req) setBloomStatus(dossierId, null);
    } catch (e) {
        console.warn(`graph: resolving edges for ${dossierId} failed`, e);
        if (latestBloom.get(dossierId) === req) setBloomStatus(dossierId, "failed");
    }
}

export async function focusDossier(dossierId: string): Promise<void> {
    globalStore.set(graphSelectedIdAtom, dossierId);
    if (globalStore.get(graphBloomAtom).has(dossierId)) return; // cached
    await loadBloom(dossierId);
}

export function retryBloom(dossierId: string): Promise<void> {
    return loadBloom(dossierId);
}

// The base graph is the vault's node set and a correction does not change it; the bloom IS the attribution,
// so that is the only part that goes stale.
export function invalidateBloom(dossierId: string): void {
    const next = new Map(globalStore.get(graphBloomAtom));
    if (next.delete(dossierId)) {
        globalStore.set(graphBloomAtom, next);
    }
}
