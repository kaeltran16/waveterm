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
import { harvestMemory, memNotesAtom, memPendingAtom } from "./memstore";
import { projectLabel } from "./projectlabel";
import { RollingCount } from "./rollingcount";
import {
    previewSync,
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
// harnesses, so drift is one number and the fix is one button.
function SyncStatus() {
    const harnesses = useAtomValue(vaultHarnessesAtom);
    const skills = useAtomValue(vaultSkillsAtom);
    const busy = useAtomValue(vaultSyncBusyAtom);
    // "stale" and "never projected" are different problems and read as different sentences: on a vault
    // that has never synced, calling four untouched harnesses stale suggests something decayed.
    const stale = harnesses.filter((h) => h.present && h.steering === "stale").length;
    const unprojected = harnesses.filter((h) => h.present && h.steering === "absent").length;
    const conflicts = harnesses.reduce((n, h) => n + h.skillsconflict, 0);
    const pending = skills.filter((s) => Object.values(s.states ?? {}).includes("pending")).length;
    const clean = stale + unprojected + conflicts + pending === 0;
    const parts = [
        stale > 0 && `${stale} stale`,
        unprojected > 0 && `${unprojected} not projected`,
        pending > 0 && `${pending} to link`,
        conflicts > 0 && `${conflicts} conflict`,
    ].filter(Boolean);
    return (
        <>
            <span className={cn("flex items-center gap-[7px] text-[11.5px]", clean ? "text-success" : "text-warning")}>
                <span className={cn("h-[6px] w-[6px] rounded-full", clean ? "bg-success" : "bg-warning")} />
                {clean ? "all harnesses current" : parts.join(" · ")}
            </span>
            <button
                onClick={() => fireAndForget(previewSync)}
                disabled={busy}
                className="ml-[8px] rounded-[7px] border border-border px-[11px] py-[4px] text-[11px] font-semibold text-ink-mid hover:border-edge-strong hover:text-primary disabled:opacity-40"
            >
                {busy ? "Working…" : "Sync harnesses"}
            </button>
        </>
    );
}

export function VaultLine({ focusedCwd }: { focusedCwd: string | null }) {
    const tab = useAtomValue(vaultTabAtom);
    const notes = useAtomValue(memNotesAtom);
    const pending = useAtomValue(memPendingAtom);
    const skills = useAtomValue(vaultSkillsAtom);
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
            <div className="flex-1" />
            {tab === "memory" ? <MemoryStatus focusedCwd={focusedCwd} /> : <SyncStatus />}
        </div>
    );
}
