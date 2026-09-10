// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Vault's collection bar (Wave-vault-tab.dc.html): where the vault lives on disk, the three
// collections, and a status cluster that follows whichever collection is showing. Folding the
// projection/harvest controls in here is what keeps them from costing a row of chrome of their own —
// they are status about the memory collection, so they belong on the line that names it.

import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { taskListAtom } from "../jarvis/tasksstore";
import { harvestMemory, memNotesAtom, memPendingAtom } from "./memstore";
import { projectLabel } from "./projectlabel";
import { RollingCount } from "./rollingcount";
import { recordStatusCounts } from "./vaultrecordsmodel";
import {
    previewSync,
    selectDocTab,
    SHARED_TAB,
    vaultDraftAtom,
    vaultHarnessesAtom,
    vaultSkillsAtom,
    vaultStatusAtom,
    vaultSteeringPathAtom,
    vaultSyncBusyAtom,
    vaultTabAtom,
    type VaultTab,
} from "./vaultstore";

// Codex rewrites its MEMORY.md only on session summarization, so a low-frequency sweep behind the
// backend's mtime guard means most ticks are no-ops. Frontend-hosted so it can scope to focusedCwd.
const HARVEST_CADENCE_MS = 3 * 60 * 1000;

const RUNTIME_LABEL: Record<string, string> = { codex: "Codex" };

function CollectionTab({ tab, label, count }: { tab: VaultTab; label: string; count: string | number }) {
    const active = useAtomValue(vaultTabAtom) === tab;
    return (
        <button
            onClick={() => globalStore.set(vaultTabAtom, tab)}
            data-vault-tab={tab}
            aria-pressed={active}
            className={cn(
                "flex items-center gap-[7px] rounded-[8px] border px-[12px] py-[4px] text-[12px] font-semibold",
                active
                    ? "border-accent/40 bg-accent/15 text-accent-soft"
                    : "border-border text-ink-mid hover:text-primary"
            )}
        >
            {label}
            <span className="font-mono text-[10.5px] text-ink-faint">
                {typeof count === "number" ? <RollingCount value={count} /> : count}
            </span>
        </button>
    );
}

// Memory's cluster: which project each harness's steering file currently reflects, what the last
// harvest pulled in, and the two on-demand controls for both directions.
function MemoryStatus({ focusedCwd }: { focusedCwd: string | null }) {
    const config = useAtomValue(atoms.fullConfigAtom);
    const [projected, setProjected] = useState<Record<string, string>>({});
    const [harvest, setHarvest] = useState<{ ingested: number; skipped: number } | null>(null);
    const [pulling, setPulling] = useState(false);
    const [projecting, setProjecting] = useState(false);

    const refresh = useCallback(() => {
        void RpcApi.MemoryProjectionStatusCommand(TabRpcClient)
            .then((r) => setProjected(r.runtimes ?? {}))
            .catch(() => setProjected({}));
    }, []);
    useEffect(refresh, [refresh]);

    const pull = useCallback(
        (manual: boolean) => {
            if (!focusedCwd) return;
            if (manual) setPulling(true);
            fireAndForget(async () => {
                try {
                    setHarvest(await harvestMemory(focusedCwd));
                } finally {
                    if (manual) setPulling(false);
                }
            });
        },
        [focusedCwd]
    );

    useEffect(() => {
        if (!focusedCwd) return;
        pull(false);
        const id = setInterval(() => pull(false), HARVEST_CADENCE_MS);
        return () => clearInterval(id);
    }, [focusedCwd, pull]);

    const label = projectLabel(focusedCwd ?? "", config?.projects ?? {});
    return (
        <>
            {Object.keys(RUNTIME_LABEL).map((rt) => (
                <span key={rt} className="flex items-center gap-[7px] text-[11.5px] text-ink-mid">
                    <span
                        className={cn(
                            "h-[6px] w-[6px] rounded-full",
                            projected[rt] ? "bg-mem-project" : "bg-ink-faint"
                        )}
                    />
                    {RUNTIME_LABEL[rt]}
                    <span className={projected[rt] ? "text-accent-soft" : "text-ink-faint"}>
                        · {projected[rt] || "none"}
                    </span>
                </span>
            ))}
            {harvest && (
                <>
                    <span className="mx-[6px] h-[14px] w-px bg-edge-mid" />
                    <span className="text-[11.5px] text-ink-mid">
                        harvest +{harvest.ingested} new · {harvest.skipped} known
                    </span>
                </>
            )}
            <button
                onClick={() => pull(true)}
                disabled={!focusedCwd || pulling}
                title={focusedCwd ? "Pull this project's agent facts into memory" : "Focus an agent to pull its facts"}
                className="ml-[8px] rounded-[7px] border border-border px-[11px] py-[4px] text-[11px] font-semibold text-ink-mid hover:border-edge-strong hover:text-primary disabled:opacity-40"
            >
                {pulling ? "Pulling…" : "Pull from agents"}
            </button>
            <button
                onClick={() => {
                    if (!focusedCwd) return;
                    setProjecting(true);
                    fireAndForget(async () => {
                        try {
                            await RpcApi.MemoryProjectCommand(TabRpcClient, { cwd: focusedCwd });
                            globalStore.set(vaultStatusAtom, `Projected ${label} into the harness steering files`);
                            refresh();
                        } finally {
                            setProjecting(false);
                        }
                    });
                }}
                disabled={!focusedCwd || projecting}
                title={focusedCwd ? `Project ${label} into the harness steering files` : "Focus an agent to project it"}
                className="rounded-[7px] border border-border px-[11px] py-[4px] text-[11px] font-semibold text-ink-mid hover:border-edge-strong hover:text-primary disabled:opacity-40"
            >
                {projecting ? "Projecting…" : "Project now"}
            </button>
        </>
    );
}

// Steering and skills share one cluster: both are projections of the same vault into the same
// harnesses, so drift is one number and the fix is one button. On a vault with no shared doc yet the
// button would dry-run to nothing, so it says so rather than offering an empty sync.
// Records' cluster: the same states the index groups by, counted, so the collection line answers "what is in
// here" before the tab is opened. Text, not dots — the index already carries a per-row dot, and a second
// copy of the same status-to-tone map here would be a second place to keep the vocabulary in step.
function RecordStatus() {
    const records = useAtomValue(taskListAtom);
    const counts = recordStatusCounts(records ?? []);
    if (records == null) {
        return <span className="text-[11.5px] text-ink-faint">loading records…</span>;
    }
    if (counts.length === 0) {
        return <span className="text-[11.5px] text-ink-faint">no records yet</span>;
    }
    return (
        <span className="flex items-center gap-[12px] text-[11.5px] text-ink-mid">
            {counts.map((c) => (
                <span key={c.status}>
                    {c.count} {c.status}
                </span>
            ))}
        </span>
    );
}

function SyncStatus() {
    const harnesses = useAtomValue(vaultHarnessesAtom);
    const skills = useAtomValue(vaultSkillsAtom);
    const busy = useAtomValue(vaultSyncBusyAtom);
    const sharedEmpty = useAtomValue(vaultDraftAtom).trim() === "";
    const present = harnesses.filter((h) => h.present);
    const stale = present.filter((h) => h.steering === "stale").length;
    const withOwn = present.filter((h) => h.own).length;
    const unmanaged = harnesses.reduce((n, h) => n + h.skillsunmanaged, 0);
    const pending = skills.filter((s) => Object.values(s.states ?? {}).includes("differs")).length;
    const clean = stale + withOwn + unmanaged + pending === 0 && !sharedEmpty;
    const parts = [
        sharedEmpty && "no shared doc yet",
        stale > 0 && `${stale} out of date`,
        withOwn > 0 && `${withOwn} holding own rules`,
        pending > 0 && `${pending} to write`,
        unmanaged > 0 && `${unmanaged} unmanaged`,
    ].filter(Boolean);
    return (
        <>
            <span className={cn("flex items-center gap-[7px] text-[11.5px]", clean ? "text-success" : "text-warning")}>
                <span className={cn("h-[6px] w-[6px] rounded-full", clean ? "bg-success" : "bg-warning")} />
                {clean ? "every harness current" : parts.join(" · ")}
            </span>
            <button
                onClick={() => {
                    if (sharedEmpty) {
                        globalStore.set(vaultTabAtom, "steering");
                        selectDocTab(SHARED_TAB);
                        return;
                    }
                    fireAndForget(previewSync);
                }}
                disabled={busy}
                className="ml-[8px] rounded-[7px] border border-border px-[11px] py-[4px] text-[11px] font-semibold text-ink-mid hover:border-edge-strong hover:text-primary disabled:opacity-40"
            >
                {busy ? "Working…" : sharedEmpty ? "Start the shared doc" : "Sync harnesses"}
            </button>
        </>
    );
}

export function VaultLine({ focusedCwd }: { focusedCwd: string | null }) {
    const tab = useAtomValue(vaultTabAtom);
    const notes = useAtomValue(memNotesAtom);
    const pending = useAtomValue(memPendingAtom);
    const skills = useAtomValue(vaultSkillsAtom);
    const records = useAtomValue(taskListAtom);
    const steeringPath = useAtomValue(vaultSteeringPathAtom);
    // the vault root is the steering doc's grandparent (vault/steering/AGENTS.md)
    const root = steeringPath ? steeringPath.replace(/[\\/]steering[\\/][^\\/]+$/, "") : "";
    return (
        <div className="flex flex-none items-center gap-[6px] border-y border-edge-faint px-[24px] py-[7px]">
            <span
                title={root}
                className="mr-[8px] max-w-[280px] truncate font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint"
            >
                {root || "vault"}
            </span>
            <CollectionTab tab="memory" label="memory" count={notes.length + pending.length} />
            <CollectionTab tab="steering" label="steering" count="AGENTS.md" />
            <CollectionTab tab="skills" label="skills" count={skills.length} />
            <CollectionTab tab="records" label="records" count={records?.length ?? 0} />
            <div className="flex-1" />
            {tab === "memory" ? (
                <MemoryStatus focusedCwd={focusedCwd} />
            ) : tab === "records" ? (
                <RecordStatus />
            ) : (
                <SyncStatus />
            )}
        </div>
    );
}
