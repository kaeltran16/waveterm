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
// "shared" is the one doc every harness gets; anything else is a harness runtime's own file.
export type VaultDocTab = string;
export const SHARED_TAB = "shared";

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
export const vaultDocTabAtom = atom<VaultDocTab>(SHARED_TAB) as PrimitiveAtom<VaultDocTab>;
export const vaultSyncErrorAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const vaultSyncBusyAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;

// ---- one harness's file, as three zones ----

// The open harness document, or null while it loads. Its own zone is editable; the shared and memory
// zones are read-only here and are edited (or generated) elsewhere.
export const vaultHarnessDocAtom = atom<CommandAgentSyncHarnessReadRtnData | null>(
    null
) as PrimitiveAtom<CommandAgentSyncHarnessReadRtnData | null>;
export const vaultOwnDraftAtom = atom<string>("") as PrimitiveAtom<string>;
export const vaultOwnDirtyAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;
export const vaultMemoryOpenAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;

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

// Reads one harness's steering file whole. The shared doc has no harness file of its own.
export async function loadHarnessDoc(runtime: string): Promise<void> {
    globalStore.set(vaultHarnessDocAtom, null);
    if (runtime === SHARED_TAB) return;
    try {
        const r = await RpcApi.AgentSyncHarnessReadCommand(TabRpcClient, { runtime }, { timeout: SYNC_RPC_TIMEOUT_MS });
        if (globalStore.get(vaultDocTabAtom) !== runtime) return; // the tab moved on
        globalStore.set(vaultHarnessDocAtom, r);
        globalStore.set(vaultOwnDraftAtom, r.own ?? "");
        globalStore.set(vaultOwnDirtyAtom, false);
    } catch (e) {
        globalStore.set(vaultSyncErrorAtom, errText(e));
    }
}

export function selectDocTab(tab: VaultDocTab): void {
    globalStore.set(vaultDocTabAtom, tab);
    globalStore.set(vaultMemoryOpenAtom, false);
    void loadHarnessDoc(tab);
}

// Saves the harness's own zone back to its real file. The managed regions are untouched by the
// backend write, so this cannot desync the shared block.
export async function saveHarnessOwn(): Promise<boolean> {
    const doc = globalStore.get(vaultHarnessDocAtom);
    if (!doc) return false;
    globalStore.set(vaultSyncBusyAtom, true);
    globalStore.set(vaultSyncErrorAtom, null);
    try {
        const res = await RpcApi.AgentSyncHarnessWriteCommand(TabRpcClient, {
            runtime: doc.runtime,
            own: globalStore.get(vaultOwnDraftAtom),
            basemtime: doc.mtime ?? 0,
        });
        if (res.conflict) {
            globalStore.set(
                vaultSyncErrorAtom,
                `${doc.path} changed on disk since you opened it. Reload the tab to pick up the new version before saving.`
            );
            return false;
        }
        globalStore.set(vaultOwnDirtyAtom, false);
        globalStore.set(vaultStatusAtom, `Saved ${doc.path}`);
        await Promise.all([loadSync(), loadHarnessDoc(doc.runtime)]);
        return true;
    } catch (e) {
        globalStore.set(vaultSyncErrorAtom, errText(e));
        return false;
    } finally {
        globalStore.set(vaultSyncBusyAtom, false);
    }
}

// Moves one harness's own rules into the shared doc. The backend projects before it clears, so the
// rules never leave the file they were serving.
export async function foldIntoShared(runtime: string): Promise<void> {
    globalStore.set(vaultSyncBusyAtom, true);
    globalStore.set(vaultSyncErrorAtom, null);
    try {
        const r = await RpcApi.AgentSyncFoldCommand(TabRpcClient, { runtime }, { timeout: SYNC_RPC_TIMEOUT_MS });
        const moved = (r.lines ?? []).length;
        globalStore.set(
            vaultStatusAtom,
            r.seeded
                ? `Shared doc seeded from ${runtime} — ${moved} line${moved === 1 ? "" : "s"}`
                : moved
                  ? `Moved ${moved} line${moved === 1 ? "" : "s"} into the shared doc`
                  : "Nothing to move — every rule was already shared"
        );
        await loadSync();
        if (globalStore.get(vaultDocTabAtom) === runtime) await loadHarnessDoc(runtime);
    } catch (e) {
        globalStore.set(vaultSyncErrorAtom, errText(e));
    } finally {
        globalStore.set(vaultSyncBusyAtom, false);
    }
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
                "The shared doc changed on disk since you opened it. Revert to pick up the new version before saving."
            );
            return false;
        }
        await RpcApi.AgentSyncApplyCommand(TabRpcClient, { dryrun: false });
        globalStore.set(vaultDirtyAtom, false);
        globalStore.set(vaultStatusAtom, "Shared doc saved and written into every installed harness");
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
        const written = (r.actions ?? []).filter((a) => a.kind !== "skill-unmanaged").length;
        globalStore.set(vaultPlanAtom, null);
        globalStore.set(
            vaultStatusAtom,
            written ? `Synced — ${written} change${written === 1 ? "" : "s"} written` : "Already in sync"
        );
        await Promise.all([loadSync(), loadSkills()]);
        const tab = globalStore.get(vaultDocTabAtom);
        if (tab !== SHARED_TAB) await loadHarnessDoc(tab);
    } catch (e) {
        globalStore.set(vaultSyncErrorAtom, errText(e));
    } finally {
        globalStore.set(vaultSyncBusyAtom, false);
    }
}

// Adoption folds harness-local skill directories into the vault. Whole-vault, not per-skill: the
// plan decides which copy seeds each name and which become deltas beside it, and applying half a
// plan is what leaves two sources of truth.
export async function adoptSkills(): Promise<CommandAgentSyncAdoptRtnData | null> {
    globalStore.set(vaultSyncBusyAtom, true);
    globalStore.set(vaultSyncErrorAtom, null);
    try {
        const r = await RpcApi.AgentSyncAdoptCommand(TabRpcClient, { apply: true });
        const moved = (r.moves ?? []).filter((m) => !m.bodydiff).length;
        globalStore.set(
            vaultStatusAtom,
            `Adopted ${moved} skill director${moved === 1 ? "y" : "ies"} into the vault` +
                ((r.unresolved ?? []).length ? ` · ${r.unresolved.length} left for you to reconcile` : "")
        );
        await Promise.all([loadSync(), loadSkills()]);
        return r;
    } catch (e) {
        globalStore.set(vaultSyncErrorAtom, errText(e));
        return null;
    } finally {
        globalStore.set(vaultSyncBusyAtom, false);
    }
}
