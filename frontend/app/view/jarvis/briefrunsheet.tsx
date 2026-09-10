// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The session sheet: the right-side surface a run row opens. B4 owns its shell, the run summary, the
// unavailable/error states and the running-settings panel. It deliberately does not own the Stage body —
// B5 re-homes RunBody into this shell, and duplicating it here would give one run two live renderers.
//
// Two rules decide what is a control and what is a fact. Shape, machine and the lead route are immutable
// after launch, so they are printed, not offered. Parallelism, the worker route and an unreleased plan
// gate are genuinely mutable, so they carry real controls with the consequence of each stated next to it
// rather than left to be discovered.
//
// A third rule decides *when* any of it is offered. A run that links a DAG has mutable settings, but never
// from the launch snapshot: until the linked TaskGroup is here the sheet cannot know what the scheduler is
// running at, and a save sent from the snapshot would overwrite it. So the sheet reads the group through
// WOS (a scheduler tick has to show up here) and renders no controls until it has arrived.

import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { RoutePicker } from "@/app/view/agents/routepicker";
import { getJarvisProfile, refreshResolvedProfile, setChannelProfile } from "@/app/view/agents/runactions";
import { MAX_PARALLELISM } from "@/app/view/agents/runconfig";
import { useDagGroup } from "@/app/view/orchestrate/dagstore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState, type ReactNode } from "react";
import {
    draftIsDirty,
    draftSeedKey,
    effectiveRunConfig,
    engineDefaultsPatch,
    gateLockReason,
    parallelismInvalid,
    runSettingsDraft,
    runSettingsPanelState,
    settingsPayload,
    type LinkedGroupRead,
    type RunSettingsDraft,
} from "./runsettings";

const LABEL = "font-mono text-[9.5px] font-bold uppercase tracking-[.13em] text-feed-label";
const FIELD = "rounded-[7px] border border-border bg-background px-2 py-1 text-[11.5px] text-ink-hi";
const BTN =
    "rounded-[7px] border border-border bg-surface-raised px-2.5 py-1 text-[11px] font-semibold text-secondary hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:cursor-default";

function Fact({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-baseline gap-2">
            <span className="flex-none font-mono text-[9.5px] uppercase tracking-[.1em] text-ink-faint">{label}</span>
            <span className="min-w-0 truncate font-mono text-[11px] text-secondary">{value}</span>
        </div>
    );
}

function SheetShell({ goal, onClose, children }: { goal: string; onClose: () => void; children: ReactNode }) {
    return (
        <aside
            data-jarvis-brief-sheet="run"
            aria-label="Run session"
            className="absolute inset-y-0 right-0 flex w-[420px] max-w-[92vw] flex-col border-l border-edge-faint bg-surface shadow-xl"
        >
            <header className="flex flex-none items-center gap-2.5 border-b border-edge-faint px-4 py-3">
                <span className={cn(LABEL, "text-accent-soft")}>session</span>
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink-hi">{goal}</span>
                <button type="button" aria-label="Close session sheet" onClick={onClose} className={BTN}>
                    Close
                </button>
            </header>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">{children}</div>
        </aside>
    );
}

function SheetUnavailable() {
    return (
        <div
            data-jarvis-brief-sheet-state="unavailable"
            className="flex flex-col gap-1.5 rounded-[10px] border border-dashed border-edge-strong px-3.5 py-3"
        >
            <span className="text-[13px] font-semibold text-ink-hi">This run is no longer available.</span>
            <span className="text-[12px] text-secondary">
                It was deleted or cancelled since the Brief was loaded, so there are no settings to change.
            </span>
        </div>
    );
}

// The run's own route, printed as the fact it is: runtime and the model or tier it resolved to.
function runRuntimeView(run: Run): string {
    return [run.runtime || "claude", run.model || run.tier || "capable"].filter((p) => p !== "").join(" · ");
}

function LoadedSheet({
    runId,
    run,
    group,
    groupRead,
    onClose,
}: {
    runId: string;
    run: Run;
    group: TaskGroup | null;
    groupRead: LinkedGroupRead;
    onClose: () => void;
}) {
    const [draft, setDraft] = useState<RunSettingsDraft | null>(null);
    const [baseline, setBaseline] = useState<RunSettingsDraft | null>(null);
    const [saving, setSaving] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    const channelId = run.channeloid ?? "";
    const state = runSettingsPanelState(run, group, groupRead);
    // every effective mutable input, keyed: a status tick changes the object but not this, so it cannot
    // wipe whatever the user has typed into the panel.
    const seed = draftSeedKey(run, group);

    useEffect(() => {
        if (state.kind !== "editable" && state.kind !== "readonly") {
            setDraft(null);
            setBaseline(null);
            return;
        }
        const next = runSettingsDraft(run, group);
        setDraft(next);
        setBaseline(next);
    }, [run.oid, group?.oid, seed, state.kind]);

    const busy = saving != null;
    const dirty = draft != null && baseline != null && draftIsDirty(draft, baseline);
    const invalid = draft != null && parallelismInvalid(draft.parallelism);

    const save = () => {
        if (draft == null || state.kind !== "editable" || channelId === "") {
            return;
        }
        setSaving("settings");
        setError(null);
        setNotice(null);
        fireAndForget(async () => {
            try {
                await RpcApi.SetRunSettingsCommand(
                    TabRpcClient,
                    settingsPayload(channelId, runId, draft, { includeGate: state.gateEditable })
                );
                // only a successful write re-seeds: a refused save must leave the user's draft alone.
                setBaseline(draft);
                setNotice("Saved. Applies to future dispatches.");
            } catch (e) {
                setError(String(e));
            } finally {
                setSaving(null);
            }
        });
    };

    const saveAsDefaults = () => {
        if (draft == null || channelId === "" || state.kind !== "editable") {
            return;
        }
        setSaving("defaults");
        setError(null);
        setNotice(null);
        fireAndForget(async () => {
            try {
                const current = await getJarvisProfile(channelId);
                await setChannelProfile(
                    channelId,
                    engineDefaultsPatch(current.override ?? {}, effectiveRunConfig(run, draft))
                );
                // refresh only after the write landed, so a refused save never leaves a cache describing
                // a profile that does not exist.
                await refreshResolvedProfile(channelId);
                setNotice("Saved as this project's future-run defaults.");
            } catch (e) {
                setError(String(e));
            } finally {
                setSaving(null);
            }
        });
    };

    const machine = run.orchestration || (run.runtime === "pi" ? "engine" : "adaptive");

    return (
        <SheetShell goal={run.goal ?? "Run"} onClose={onClose}>
            <section className="flex flex-col gap-1.5">
                <span className={LABEL}>launched as</span>
                <Fact label="shape" value={run.mode || "quick"} />
                <Fact label="machine" value={machine} />
                <Fact label="lead route" value={runRuntimeView(run)} />
            </section>
            {state.kind === "loading" ? (
                <div
                    data-jarvis-brief-sheet-state="loading"
                    className="flex flex-col gap-1.5 rounded-[10px] border border-dashed border-edge-strong px-3.5 py-3"
                >
                    <span className="text-[13px] font-semibold text-ink-hi">Reading this run's plan…</span>
                    <span className="text-[12px] text-secondary">
                        The engine owns these settings once a plan exists, so they are read live rather than guessed
                        from what the run launched with.
                    </span>
                    <div className="mt-1 h-8 animate-pulse rounded-[8px] bg-surface-raised motion-reduce:animate-none" />
                </div>
            ) : null}
            {state.kind === "unavailable" ? (
                <div
                    data-jarvis-brief-sheet-state="unavailable"
                    className="flex flex-col gap-1.5 rounded-[10px] border border-dashed border-edge-strong px-3.5 py-3"
                >
                    <span className="text-[13px] font-semibold text-ink-hi">
                        {state.reason === "error"
                            ? "This run's plan could not be read."
                            : "This run's plan is no longer available."}
                    </span>
                    <span className="text-[12px] text-secondary">
                        The engine owns these settings once a plan exists, so nothing is shown rather than the run's
                        launch snapshot.
                    </span>
                </div>
            ) : null}
            {state.kind === "readonly" ? (
                <p className="rounded-[10px] border border-dashed border-edge-strong px-3.5 py-3 text-[12px] text-secondary">
                    These settings are fixed: {state.reason}.
                </p>
            ) : null}
            {state.kind === "editable" && draft != null ? (
                <section className="flex flex-col gap-3">
                    <span className={LABEL}>running settings</span>
                    <label className="flex flex-col gap-1">
                        <span className="text-[11.5px] font-semibold text-secondary">Worker parallelism</span>
                        <input
                            type="number"
                            min={1}
                            max={MAX_PARALLELISM}
                            value={draft.parallelism}
                            disabled={busy}
                            onChange={(e) => setDraft({ ...draft, parallelism: Number(e.target.value) })}
                            className={cn(FIELD, "w-24")}
                        />
                        <span className="text-[11px] text-muted">
                            {parallelismInvalid(draft.parallelism)
                                ? `Enter a whole number from 1 through ${MAX_PARALLELISM}.`
                                : "Lowering this does not stop the workers already running — the scheduler just waits before starting more."}
                        </span>
                    </label>
                    <div className="flex flex-col gap-1">
                        <span className="text-[11.5px] font-semibold text-secondary">Worker route</span>
                        <RoutePicker
                            value={draft.workerRoute}
                            canInherit
                            inheritedLabel="Inherit the lead"
                            disabled={busy}
                            onChange={(route) => setDraft({ ...draft, workerRoute: route })}
                        />
                        <span className="text-[11px] text-muted">
                            Applies to workers dispatched from now on. Nothing already running changes.
                        </span>
                    </div>
                    <label className="flex flex-col gap-1">
                        <span className="flex items-center gap-2 text-[11.5px] font-semibold text-secondary">
                            <input
                                type="checkbox"
                                checked={draft.planGate}
                                disabled={busy || !state.gateEditable}
                                onChange={(e) => setDraft({ ...draft, planGate: e.target.checked })}
                            />
                            Hold the plan for review
                        </span>
                        <span className="text-[11px] text-muted">
                            {state.gateEditable
                                ? "A gated plan waits for you before a single worker is dispatched."
                                : `This can no longer change — ${gateLockReason(group)}.`}
                        </span>
                    </label>
                    {error != null ? (
                        <p data-jarvis-brief-sheet-state="error" className="text-[11.5px] text-error">
                            {error}
                        </p>
                    ) : null}
                    {notice != null ? (
                        <p data-jarvis-brief-sheet-state="saved" className="text-[11.5px] text-success">
                            {notice}
                        </p>
                    ) : null}
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={save}
                            disabled={busy || !dirty || invalid}
                            className={cn(BTN, "border-accent/40 text-accent-soft")}
                        >
                            {saving === "settings" ? "Saving…" : "Save settings"}
                        </button>
                        <button type="button" onClick={saveAsDefaults} disabled={busy} className={BTN}>
                            {saving === "defaults" ? "Saving…" : "Save as project defaults"}
                        </button>
                    </div>
                </section>
            ) : null}
        </SheetShell>
    );
}

// Mounted only when the run actually links a dag, so the WOS subscription below always names a real object.
// The read state is carried whole — loading, arrived, failed, gone — because a failed or deleted group is not
// a group that is still loading.
function LinkedDagSheet({
    runId,
    run,
    dagId,
    onClose,
}: {
    runId: string;
    run: Run;
    dagId: string;
    onClose: () => void;
}) {
    const oref = WOS.makeORef("dag", dagId);
    const [group, loading] = useDagGroup(oref);
    const errored = useAtomValue(WOS.getWaveObjectErrorAtom(oref));
    const groupRead: LinkedGroupRead = loading ? "loading" : group != null ? "ready" : errored ? "error" : "missing";
    return <LoadedSheet runId={runId} run={run} group={group ?? null} groupRead={groupRead} onClose={onClose} />;
}

function BriefRunSheetBody({ runId, onClose }: { runId: string; onClose: () => void }) {
    const runOref = WOS.makeORef("run", runId);
    const run = useAtomValue(WOS.getWaveObjectAtom<Run>(runOref));
    const runLoading = useAtomValue(WOS.getWaveObjectLoadingAtom(runOref));
    if (run == null) {
        return (
            <SheetShell goal="Run" onClose={onClose}>
                {runLoading ? (
                    <div
                        data-jarvis-brief-sheet-state="loading"
                        className="h-16 animate-pulse rounded-[10px] bg-surface-raised motion-reduce:animate-none"
                    />
                ) : (
                    <SheetUnavailable />
                )}
            </SheetShell>
        );
    }
    if ((run.dagoref ?? "") !== "") {
        return <LinkedDagSheet runId={runId} run={run} dagId={run.dagoref} onClose={onClose} />;
    }
    return <LoadedSheet runId={runId} run={run} group={null} groupRead="ready" onClose={onClose} />;
}

export function BriefRunSheet({ runId, onClose }: { runId: string | null; onClose: () => void }) {
    if (runId == null) {
        return null;
    }
    return (
        <div className="absolute inset-0 z-20">
            <button
                type="button"
                aria-label="Close session sheet"
                onClick={onClose}
                className="absolute inset-0 cursor-default bg-background/40"
            />
            <BriefRunSheetBody key={runId} runId={runId} onClose={onClose} />
        </div>
    );
}
