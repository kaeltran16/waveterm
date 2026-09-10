// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Vault surface (Wave-vault-tab.dc.html): one tab over the three things the vault is the single
// write target for — memory, steering, and skills. Harness copies of all three are projections and
// are never harvested back, so everything here edits the vault and pushes outward.
//
// This shell owns the chrome (header, collection line, rail, footer) and the loads; each collection
// is its own component and none of them knows about the others.

import { MOTION } from "@/app/element/motiontokens";
import { SkeletonLine } from "@/app/element/skeleton";
import { getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { buildVaultBindings } from "@/app/store/keybindings/bindings";
import { useKeybindings } from "@/app/store/keybindings/store";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { loadTaskList, taskListAtom } from "../jarvis/tasksstore";
import { resolveCwd } from "./agentcwdresolve";
import type { AgentsViewModel } from "./agents";
import {
    loadArchived,
    loadMemory,
    loadPrune,
    loadReview,
    memArchivedAtom,
    memErrorAtom,
    memLoadedAtom,
    memNotesAtom,
    memPendingAtom,
    memPruneAtom,
    memReflowAnimatedAtom,
    memSearchAtom,
} from "./memstore";
import { NewMemoryModal } from "./newmemorymodal";
import { SurfaceError, SurfaceHeader } from "./surfacescaffold";
import { VaultLine } from "./vaultline";
import { VaultMemory } from "./vaultmemory";
import { VaultRail } from "./vaultrail";
import { VaultReader } from "./vaultreader";
import { VaultRecords } from "./vaultrecords";
import { VaultSkills } from "./vaultskills";
import { VaultSteering } from "./vaultsteering";
import {
    loadSkills,
    loadSync,
    vaultHarnessesAtom,
    vaultReaderAtom,
    vaultSkillsAtom,
    vaultStatusAtom,
    vaultSteeringPathAtom,
    vaultSyncErrorAtom,
    vaultTabAtom,
} from "./vaultstore";

function VaultSkeleton() {
    return (
        <div className="absolute inset-0 p-[28px]">
            <SkeletonLine className="mb-[22px] h-[24px] w-[170px]" />
            <div className="space-y-[18px]">
                {Array.from({ length: 3 }).map((_, group) => (
                    <div key={group}>
                        <SkeletonLine className="mb-[9px] h-[11px] w-[86px]" />
                        <div className="space-y-[7px]">
                            {Array.from({ length: 3 }).map((_, row) => (
                                <SkeletonLine key={row} className="h-[26px] w-full rounded-[10px]" />
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function Footer() {
    const tab = useAtomValue(vaultTabAtom);
    const status = useAtomValue(vaultStatusAtom);
    const notes = useAtomValue(memNotesAtom);
    const prune = useAtomValue(memPruneAtom);
    const archived = useAtomValue(memArchivedAtom);
    const harnesses = useAtomValue(vaultHarnessesAtom);
    const skills = useAtomValue(vaultSkillsAtom);
    const records = useAtomValue(taskListAtom);
    const steeringPath = useAtomValue(vaultSteeringPathAtom);
    const present = harnesses.filter((h) => h.present).length;
    // one total, not the four states the collection line already breaks out — the footer is the line that
    // stays stable while the cluster's counts come and go
    const recordsLine = records == null ? "loading records…" : `${records.length} records`;
    const left =
        status ||
        (tab === "memory"
            ? `${notes.length} notes · ${prune.length} to clean up · ${archived.length} archived`
            : tab === "steering"
              ? `shared steering · ${present} harness${present === 1 ? "" : "es"} installed`
              : tab === "records"
                ? recordsLine
                : `${skills.length} skills · ${harnesses.reduce((n, h) => n + h.skillsunmanaged, 0)} unmanaged`);
    return (
        <div className="flex flex-none items-center gap-[12px] border-t border-edge-faint px-[24px] py-[7px] font-mono text-[10.5px] text-ink-faint">
            <span className="truncate">{left}</span>
            <div className="flex-1" />
            <span className="truncate">{steeringPath ? `vault at ${steeringPath}` : ""}</span>
        </div>
    );
}

export function VaultSurface({ model }: { model: AgentsViewModel }) {
    const tab = useAtomValue(vaultTabAtom);
    const notes = useAtomValue(memNotesAtom);
    const pending = useAtomValue(memPendingAtom);
    const skills = useAtomValue(vaultSkillsAtom);
    const loaded = useAtomValue(memLoadedAtom);
    const loadError = useAtomValue(memErrorAtom);
    const search = useAtomValue(memSearchAtom);
    const reflowAnimated = useAtomValue(memReflowAnimatedAtom);
    const reader = useAtomValue(vaultReaderAtom);
    const syncError = useAtomValue(vaultSyncErrorAtom);

    // modal-open lives on the model (not local state) so the keybinding dispatcher sees it as modalOpen.
    const newOpen = useAtomValue(model.memNewOpenAtom);
    // reset on unmount: this surface remounts on re-entry and the flag lives on the persistent model, so
    // a mouse-switch away with the modal open would otherwise leave global nav frozen.
    useEffect(() => () => globalStore.set(model.memNewOpenAtom, false), []);
    // a reader left open would reappear over a surface the user has since navigated away from
    useEffect(() => () => globalStore.set(vaultReaderAtom, null), []);

    const bindings = useMemo(() => buildVaultBindings(), []);
    useKeybindings(bindings);

    // Resolve the focused agent's cwd so new notes land in that project's hub and the projection
    // controls know what to project. Null when no agent is focused.
    const focusId = useAtomValue(model.focusIdAtom);
    const agents = useAtomValue(model.agentsAtom);
    const agent = agents.find((a) => a.id === focusId);
    const [focusedCwd, setFocusedCwd] = useState<string | null>(null);
    useEffect(() => {
        let live = true;
        void resolveCwd(agent?.transcriptPath, agent?.blockId).then((c) => {
            if (live) setFocusedCwd(c);
        });
        return () => {
            live = false;
        };
    }, [agent?.transcriptPath, agent?.blockId]);

    // Re-scan on mount and whenever the vault path changes (Settings > Memory). getSettingsKeyAtom is
    // cached per key, so this atom identity is stable and the effect fires only on a real path change.
    const vaultPath = useAtomValue(getSettingsKeyAtom("memory:vaultpath"));
    useEffect(() => {
        fireAndForget(() => loadMemory());
        fireAndForget(() => loadReview());
        fireAndForget(() => loadPrune());
        fireAndForget(() => loadArchived());
        // steering and skills load with the surface, not with their tab: the collection line reports
        // harness drift from the moment the Vault opens, whichever collection you land on
        fireAndForget(() => loadSync());
        fireAndForget(() => loadSkills());
        // same reason: the records tab count on the collection line is stale the moment a dossier is written
        // from the Brief peek, so the list loads with the surface rather than behind the tab
        loadTaskList();
    }, [vaultPath]);

    const subtitle =
        tab === "memory"
            ? `${notes.length} saved · ${pending.length} pending review`
            : tab === "steering"
              ? "one shared doc, plus what each harness holds of its own"
              : tab === "records"
                ? "every dossier, kept by status with its full decision history"
                : `${skills.length} skills, written into every harness`;

    return (
        <MotionConfig reducedMotion="user">
            <div className="absolute inset-0 flex bg-background">
                <div className="flex min-w-0 flex-1 flex-col">
                    <SurfaceHeader
                        border={false}
                        title="Vault"
                        subtitle={subtitle}
                        actions={
                            <>
                                <input
                                    value={search}
                                    onChange={(e) => {
                                        globalStore.set(memSearchAtom, e.target.value);
                                        globalStore.set(memReflowAnimatedAtom, false);
                                    }}
                                    placeholder={
                                        tab === "memory"
                                            ? "Search notes and the queue…"
                                            : tab === "records"
                                              ? "Search records…"
                                              : "Search the vault…"
                                    }
                                    className="w-[240px] rounded-[9px] border border-border bg-surface px-[12px] py-[7px] text-[12.5px] text-foreground outline-none placeholder:text-muted"
                                />
                                {tab === "memory" && (
                                    <button
                                        onClick={() => globalStore.set(model.memNewOpenAtom, true)}
                                        className={cn(
                                            "flex items-center gap-[6px] rounded-[6px] border border-edge-mid bg-surface-raised px-[13px] py-[7px]",
                                            "text-[12.5px] font-semibold text-ink-mid hover:border-edge-strong hover:text-primary"
                                        )}
                                    >
                                        <span className="-mt-px text-[15px] leading-none">+</span>New memory
                                    </button>
                                )}
                            </>
                        }
                    />
                    <VaultLine focusedCwd={focusedCwd} />
                    {loadError && tab === "memory" ? (
                        <SurfaceError
                            message="Couldn’t scan memory."
                            onRetry={() => fireAndForget(() => loadMemory())}
                        />
                    ) : null}
                    {/* steering and skills read through the same rpc domain, so one banner serves both. Records
                        read through the dossier domain and carry their own banner in the pane. */}
                    {syncError && (tab === "steering" || tab === "skills") ? (
                        <div className="flex-none border-b border-error/30 bg-error/10 px-[24px] py-[7px] text-[12px] text-error">
                            {syncError}
                        </div>
                    ) : null}
                    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
                        {/* the three collections are one surface, so switching them crossfades in place
                            rather than cutting — keyed on the tab, not on what the tab is showing */}
                        <AnimatePresence mode="wait" initial={false}>
                            <motion.div
                                key={tab}
                                initial={{ opacity: 0 }}
                                animate={{
                                    opacity: 1,
                                    transition: { duration: MOTION.durMicro, ease: MOTION.easeFluid },
                                }}
                                exit={{ opacity: 0, transition: { duration: MOTION.durMicro, ease: MOTION.easeFluid } }}
                                className="flex min-h-0 flex-1 flex-col"
                            >
                                {tab === "memory" ? (
                                    !loaded ? (
                                        <VaultSkeleton />
                                    ) : (
                                        <VaultMemory reflowAnimated={reflowAnimated} />
                                    )
                                ) : tab === "steering" ? (
                                    <VaultSteering />
                                ) : tab === "records" ? (
                                    <VaultRecords />
                                ) : (
                                    <VaultSkills />
                                )}
                            </motion.div>
                        </AnimatePresence>
                        <AnimatePresence>
                            {reader && <VaultReader key="reader" model={model} reader={reader} />}
                        </AnimatePresence>
                    </div>
                    <Footer />
                </div>
                {/* the record detail is already the right-hand pane of the split ledger, so the rail would be
                    a second one — and its memory/skill sections have nothing to say about a record */}
                {tab !== "records" && <VaultRail model={model} />}
                {newOpen && (
                    <NewMemoryModal
                        onClose={() => globalStore.set(model.memNewOpenAtom, false)}
                        cwd={focusedCwd ?? undefined}
                    />
                )}
            </div>
        </MotionConfig>
    );
}
