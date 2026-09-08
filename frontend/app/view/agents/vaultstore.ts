// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Vault-surface view state + the steering/skills loaders (Wave-vault-tab.dc.html).
//
// The split with memstore.ts is deliberate: memstore owns memory DATA and its mutations (scan, read,
// keep, dismiss, prune, archive), this module owns what the surface is currently SHOWING — which
// collection, where the queue cursor is, which pane is open — plus the two agentsync collections,
// which have no data module of their own. Module-level atoms because every surface but Agent
// unmounts on nav switch, so component state would not survive leaving the tab.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";

export type VaultTab = "memory" | "steering" | "skills";
// Which pane the keyboard is driving, and therefore which mode the rail shows.
export type VaultFocus = "queue" | "saved";
export type VaultUpkeep = "cleanup" | "archived" | null;
export type VaultReader = { kind: "pending"; path: string } | { kind: "saved"; id: string } | null;
// "canonical" is the vault's own document; anything else is a harness runtime's read-only projection.
export type VaultDocTab = string;

// Same budget memstore uses: these are local filesystem reads behind an rpc with no default timeout,
// so a stalled backend must reject rather than leave a pane on "Loading…" forever.
const SYNC_RPC_TIMEOUT_MS = 5000;

// ---- collection ----

export const vaultTabAtom = atom<VaultTab>("memory") as PrimitiveAtom<VaultTab>;

// ---- memory: review queue ----

export const vaultQueueOpenAtom = atom<boolean>(true) as PrimitiveAtom<boolean>;
export const vaultCursorAtom = atom<number>(0) as PrimitiveAtom<number>;
// path of the expanded candidate, or null when every row is collapsed.
export const vaultExpandedAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const vaultScopeAtom = atom<string>("all") as PrimitiveAtom<string>;
export const vaultFocusAtom = atom<VaultFocus>("queue") as PrimitiveAtom<VaultFocus>;
export const vaultUpkeepAtom = atom<VaultUpkeep>(null) as PrimitiveAtom<VaultUpkeep>;
export const vaultReaderAtom = atom<VaultReader>(null) as PrimitiveAtom<VaultReader>;
// What this triage sitting has settled, shown beside the queue so bulk actions leave a trace.
export const vaultTallyAtom = atom<{ kept: number; dismissed: number }>({ kept: 0, dismissed: 0 }) as PrimitiveAtom<{
    kept: number;
    dismissed: number;
}>;
// Transient one-line result of the last action, rendered in the footer. Cleared by the next load.
export const vaultStatusAtom = atom<string>("") as PrimitiveAtom<string>;

export function noteTally(keep: boolean, n = 1): void {
    globalStore.set(vaultTallyAtom, (prev) => ({
        kept: prev.kept + (keep ? n : 0),
        dismissed: prev.dismissed + (keep ? 0 : n),
    }));
}

// ---- steering + skills (agentsync) ----

export const vaultHarnessesAtom = atom<AgentSyncHarness[]>([]) as PrimitiveAtom<AgentSyncHarness[]>;
export const vaultSteeringPathAtom = atom<string>("") as PrimitiveAtom<string>;
export const vaultSkillsRootAtom = atom<string>("") as PrimitiveAtom<string>;
const vaultDocAtom = atom<{ content: string; mtime: number }>({ content: "", mtime: 0 }) as PrimitiveAtom<{
    content: string;
    mtime: number;
}>;
export const vaultDraftAtom = atom<string>("") as PrimitiveAtom<string>;
export const vaultDirtyAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;
export const vaultDocTabAtom = atom<VaultDocTab>("canonical") as PrimitiveAtom<VaultDocTab>;
export const vaultProjectionAtom = atom<CommandAgentSyncProjectionRtnData | null>(
    null
) as PrimitiveAtom<CommandAgentSyncProjectionRtnData | null>;
export const vaultSyncErrorAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const vaultSyncBusyAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;

export const vaultSkillsAtom = atom<AgentSyncSkill[]>([]) as PrimitiveAtom<AgentSyncSkill[]>;
export const vaultSkillColumnsAtom = atom<AgentSyncSkillColumn[]>([]) as PrimitiveAtom<AgentSyncSkillColumn[]>;
export const vaultSelectedSkillAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

// The dry run behind "Sync harnesses": what an Apply would write, shown before it writes anything.
export const vaultPlanAtom = atom<AgentSyncAction[] | null>(null) as PrimitiveAtom<AgentSyncAction[] | null>;

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

export async function loadSync(): Promise<void> {
    try {
        const [status, doc] = await Promise.all([
            RpcApi.AgentSyncStatusCommand(TabRpcClient, { timeout: SYNC_RPC_TIMEOUT_MS }),
            RpcApi.AgentSyncSteeringReadCommand(TabRpcClient, { timeout: SYNC_RPC_TIMEOUT_MS }),
        ]);
        globalStore.set(vaultHarnessesAtom, status.harnesses ?? []);
        globalStore.set(vaultSteeringPathAtom, status.steeringdoc ?? "");
        globalStore.set(vaultSkillsRootAtom, status.skillsroot ?? "");
        globalStore.set(vaultDocAtom, { content: doc.content ?? "", mtime: doc.mtime ?? 0 });
        // an outside edit landing while the user has not touched the editor should show through
        if (!globalStore.get(vaultDirtyAtom)) {
            globalStore.set(vaultDraftAtom, doc.content ?? "");
        }
        globalStore.set(vaultSyncErrorAtom, null);
    } catch (e) {
        globalStore.set(vaultSyncErrorAtom, errText(e));
    }
}

export async function loadSkills(): Promise<void> {
    try {
        const r = await RpcApi.AgentSyncSkillsCommand(TabRpcClient, { timeout: SYNC_RPC_TIMEOUT_MS });
        const skills = r.skills ?? [];
        globalStore.set(vaultSkillsAtom, skills);
        globalStore.set(vaultSkillColumnsAtom, r.columns ?? []);
        const sel = globalStore.get(vaultSelectedSkillAtom);
        if ((!sel || !skills.some((s) => s.name === sel)) && skills.length) {
            globalStore.set(vaultSelectedSkillAtom, skills[0].name);
        }
    } catch (e) {
        globalStore.set(vaultSyncErrorAtom, errText(e));
    }
}

// Reads what one harness's steering file holds right now. "canonical" is the vault's own document
// and has no projection to read.
export async function loadProjection(runtime: string): Promise<void> {
    if (runtime === "canonical") {
        globalStore.set(vaultProjectionAtom, null);
        return;
    }
    globalStore.set(vaultProjectionAtom, null);
    try {
        const r = await RpcApi.AgentSyncProjectionCommand(TabRpcClient, { runtime }, { timeout: SYNC_RPC_TIMEOUT_MS });
        if (globalStore.get(vaultDocTabAtom) !== runtime) return; // the tab moved on
        globalStore.set(vaultProjectionAtom, r);
    } catch (e) {
        globalStore.set(vaultSyncErrorAtom, errText(e));
    }
}

export function selectDocTab(tab: VaultDocTab): void {
    globalStore.set(vaultDocTabAtom, tab);
    void loadProjection(tab);
}

// Save, then project immediately: an edit the harnesses have not received yet is the stale state
// this whole collection exists to remove. Returns false on a write conflict so the caller can warn
// instead of reporting a save that did not happen.
export async function saveSteering(): Promise<boolean> {
    const draft = globalStore.get(vaultDraftAtom);
    const base = globalStore.get(vaultDocAtom).mtime;
    globalStore.set(vaultSyncBusyAtom, true);
    globalStore.set(vaultSyncErrorAtom, null);
    try {
        const res = await RpcApi.AgentSyncSteeringWriteCommand(TabRpcClient, { content: draft, basemtime: base });
        if (res.conflict) {
            globalStore.set(
                vaultSyncErrorAtom,
                "The canonical doc changed on disk since you opened it. Revert to pick up the new version before saving."
            );
            return false;
        }
        await RpcApi.AgentSyncApplyCommand(TabRpcClient, { dryrun: false });
        globalStore.set(vaultDirtyAtom, false);
        globalStore.set(vaultStatusAtom, "Canonical doc saved and projected into every present harness");
        await loadSync();
        return true;
    } catch (e) {
        globalStore.set(vaultSyncErrorAtom, errText(e));
        return false;
    } finally {
        globalStore.set(vaultSyncBusyAtom, false);
    }
}

export function revertSteering(): void {
    globalStore.set(vaultDraftAtom, globalStore.get(vaultDocAtom).content);
    globalStore.set(vaultDirtyAtom, false);
    globalStore.set(vaultSyncErrorAtom, null);
}

// The dry run that opens the plan card. Nothing is written until applySync runs.
export async function previewSync(): Promise<void> {
    globalStore.set(vaultSyncBusyAtom, true);
    globalStore.set(vaultSyncErrorAtom, null);
    try {
        const r = await RpcApi.AgentSyncApplyCommand(TabRpcClient, { dryrun: true });
        globalStore.set(vaultPlanAtom, r.actions ?? []);
    } catch (e) {
        globalStore.set(vaultSyncErrorAtom, errText(e));
    } finally {
        globalStore.set(vaultSyncBusyAtom, false);
    }
}

export function closePlan(): void {
    globalStore.set(vaultPlanAtom, null);
}

export async function applySync(): Promise<void> {
    globalStore.set(vaultSyncBusyAtom, true);
    globalStore.set(vaultSyncErrorAtom, null);
    try {
        const r = await RpcApi.AgentSyncApplyCommand(TabRpcClient, { dryrun: false });
        const written = (r.actions ?? []).filter((a) => a.kind !== "skill-conflict").length;
        globalStore.set(vaultPlanAtom, null);
        globalStore.set(
            vaultStatusAtom,
            written ? `Synced — ${written} change${written === 1 ? "" : "s"} written` : "Already in sync"
        );
        await Promise.all([loadSync(), loadSkills()]);
        const tab = globalStore.get(vaultDocTabAtom);
        if (tab !== "canonical") await loadProjection(tab);
    } catch (e) {
        globalStore.set(vaultSyncErrorAtom, errText(e));
    } finally {
        globalStore.set(vaultSyncBusyAtom, false);
    }
}

// Adoption folds a harness's hand-maintained skill directory into the vault and replaces it with a
// link. Whole-vault, not per-skill: pkg/agentsync.Adopt plans every collision at once, and applying
// half a plan is what leaves two sources of truth.
export async function adoptSkills(): Promise<CommandAgentSyncAdoptRtnData | null> {
    globalStore.set(vaultSyncBusyAtom, true);
    globalStore.set(vaultSyncErrorAtom, null);
    try {
        const r = await RpcApi.AgentSyncAdoptCommand(TabRpcClient, { apply: true });
        if (r.blocked) {
            globalStore.set(vaultSyncErrorAtom, (r.reasons ?? []).join(" · ") || "Adoption is blocked.");
            return r;
        }
        globalStore.set(vaultStatusAtom, `Adopted ${(r.moves ?? []).length} skill directories into the vault`);
        await Promise.all([loadSync(), loadSkills()]);
        return r;
    } catch (e) {
        globalStore.set(vaultSyncErrorAtom, errText(e));
        return null;
    } finally {
        globalStore.set(vaultSyncBusyAtom, false);
    }
}
