// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The sheet's shell and its run-settings dock. B5 moved "which subject is drawn" out to briefsheet.tsx,
// because the sheet draws the active subject rather than a run id; what stays here is everything that is
// specific to a run's configuration.
//
// Two rules decide what is a control and what is a fact. Shape, machine and the lead route are immutable
// after launch, so they are printed, not offered. Parallelism and the worker route are genuinely mutable, so
// they carry real controls — but only once asked for: until then the configuration is one printed line, and
// a run with nothing to reconfigure states its reason in the slot where the dials would be.
//
// A third rule decides *when* any of it is offered. A run that links a DAG has mutable settings, but never
// from the launch snapshot: until the linked TaskGroup is here the sheet cannot know what the scheduler is
// running at, and a save sent from the snapshot would overwrite it. So the dock reads the group through
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
    parallelismInvalid,
    runSettingsDraft,
    runSettingsPanelState,
    settingsPayload,
    type LinkedGroupRead,
    type RunSettingsDraft,
} from "./runsettings";
import { configLine, configNote } from "./runsheetmodel";

const LABEL = "font-mono text-[9.5px] font-bold uppercase tracking-[.13em] text-feed-label";
const FIELD = "rounded-[7px] border border-border bg-background px-2 py-1 text-[11.5px] text-ink-hi";
export const SHEET_BTN =
    "cursor-pointer rounded-[7px] border border-border bg-surface-raised px-2.5 py-1 text-[11px] font-semibold text-secondary hover:border-edge-strong hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:opacity-40";

// The one panel both faces use. `face` is what the sheet is drawing, and it is on the element rather than
// inferred from the subject so a check can tell a sheet that never opened from one that opened empty.
export function SheetShell({
    face,
    label,
    title,
    meta,
    actions,
    onClose,
    children,
}: {
    face: string;
    label: string;
    title: string;
    // the run the header is showing, printed beside the project it belongs to
    meta?: string;
    actions?: ReactNode;
    onClose: () => void;
    children: ReactNode;
}) {
    return (
        <aside
            data-jarvis-brief-sheet={face}
            aria-label="Detail sheet"
            // positioning, width, scrim and edge now belong to ModalShell variant="sheet"
            className="flex h-full min-h-0 flex-col"
        >
            <header className="flex flex-none items-center gap-2.5 border-b border-edge-faint px-4 py-3">
                <span className={cn(LABEL, "text-accent-soft")}>{label}</span>
                <span className="min-w-0 truncate text-[13.5px] font-semibold text-ink-hi">{title}</span>
                {meta ? <span className="min-w-0 truncate font-mono text-[10px] text-ink-faint">{meta}</span> : null}
                <span className="flex-1" />
                {actions}
                <button type="button" aria-label="Close detail sheet" onClick={onClose} className={SHEET_BTN}>
                    Close
                </button>
            </header>
            {children}
        </aside>
    );
}

// "Save as project defaults" copies the whole effective configuration of a run — the run's launched facts
// with the given dials — into the channel's profile. Shared by the live dials and a finished run's dock.
export async function saveRunAsDefaults(run: Run, draft: RunSettingsDraft): Promise<void> {
    const channelId = run.channeloid ?? "";
    const current = await getJarvisProfile(channelId);
    await setChannelProfile(channelId, engineDefaultsPatch(current.override ?? {}, effectiveRunConfig(run, draft)));
    // refresh only after the write landed, so a refused save never leaves a cache describing a profile
    // that does not exist.
    await refreshResolvedProfile(channelId);
}

function LoadedConfig({ run, group, groupRead }: { run: Run; group: TaskGroup | null; groupRead: LinkedGroupRead }) {
    const [open, setOpen] = useState(false);
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
        if (state.kind !== "editable") {
            setDraft(null);
            setBaseline(null);
            return;
        }
        const next = runSettingsDraft(run, group);
        setDraft(next);
        setBaseline(next);
    }, [run.oid, group?.oid, seed, state.kind]);

    const note = configNote(run, state);
    if (note != null) {
        return (
            <div
                data-jarvis-brief-sheet-state={
                    state.kind === "loading" || state.kind === "unavailable" ? state.kind : undefined
                }
                className="flex items-start gap-[9px] px-4 py-[11px]"
            >
                <span
                    className={cn(
                        "mt-1 h-1.5 w-1.5 flex-none rounded-full",
                        note.tone === "error" ? "bg-error" : note.tone === "muted" ? "bg-muted" : "bg-edge-strong",
                        note.pulse && "animate-pulse motion-reduce:animate-none"
                    )}
                />
                <div className="flex min-w-0 flex-col gap-[3px]">
                    <span className="text-[11.5px] font-semibold text-secondary">{note.title}</span>
                    {note.body ? <span className="text-[11px] leading-[1.5] text-muted">{note.body}</span> : null}
                </div>
            </div>
        );
    }
    if (draft == null || baseline == null) {
        return null;
    }

    const busy = saving != null;
    const dirty = draftIsDirty(draft, baseline);
    const invalid = parallelismInvalid(draft.parallelism);
    // the scheduler runs at the baseline until a save lands, so a draft it refused (or never received) is
    // printed as not saved rather than as the configuration in force
    const notSaved = dirty && (invalid || error != null);

    const submit = (label: string, work: () => Promise<void>, onDone: () => void) => {
        setSaving(label);
        setError(null);
        setNotice(null);
        fireAndForget(async () => {
            try {
                await work();
                onDone();
            } catch (e) {
                setError(String(e));
            } finally {
                setSaving(null);
            }
        });
    };
    const save = () =>
        submit(
            "settings",
            () => RpcApi.SetRunSettingsCommand(TabRpcClient, settingsPayload(channelId, run.id, draft)),
            () => {
                // only a successful write re-seeds: a refused save must leave the user's draft alone.
                setBaseline(draft);
                setNotice("Saved. Applies to future dispatches.");
            }
        );
    const saveDefaults = () =>
        submit(
            "defaults",
            () => saveRunAsDefaults(run, draft),
            () => setNotice("Saved as this project's future-run defaults.")
        );

    return (
        <div data-jarvis-brief-sheet-config="editable">
            <div className="flex items-center gap-2.5 px-4 py-[11px]">
                <span
                    title={configLine(run, notSaved ? draft : baseline, notSaved)}
                    className={cn(
                        "min-w-0 flex-1 truncate font-mono text-[10.5px]",
                        notSaved ? "text-error" : "text-muted"
                    )}
                >
                    {configLine(run, notSaved ? draft : baseline, notSaved)}
                </span>
                <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setOpen((o) => !o)}
                    className={cn(SHEET_BTN, "flex-none rounded-[6px] px-[9px] py-[3px] text-[10.5px]")}
                >
                    {open ? "Done" : "Adjust"}
                </button>
            </div>
            {open ? (
                <div className="flex flex-col gap-3 border-t border-edge-faint px-4 pb-3.5">
                    <p className="mt-[11px] text-[11.5px] leading-[1.5] text-muted">
                        Shape, machine and the lead route are fixed after launch. These two apply to workers dispatched
                        from now on — nothing already running changes.
                    </p>
                    <div className="flex items-start gap-4">
                        <label className="flex flex-col gap-[5px]">
                            <span className="text-[11.5px] font-semibold text-secondary">Worker parallelism</span>
                            <input
                                type="number"
                                min={1}
                                max={MAX_PARALLELISM}
                                value={draft.parallelism}
                                disabled={busy}
                                onChange={(e) => setDraft({ ...draft, parallelism: Number(e.target.value) })}
                                className={cn(FIELD, "w-[72px] font-mono text-[12px]")}
                            />
                            <span className="text-[10.5px] text-muted">1 through {MAX_PARALLELISM}</span>
                        </label>
                        <div className="flex min-w-0 flex-1 flex-col gap-[5px]">
                            <span className="text-[11.5px] font-semibold text-secondary">Worker route</span>
                            <RoutePicker
                                value={draft.workerRoute}
                                canInherit
                                inheritedLabel="Inherit the lead"
                                disabled={busy}
                                onChange={(route) => setDraft({ ...draft, workerRoute: route })}
                            />
                        </div>
                    </div>
                    {invalid ? (
                        <p data-jarvis-brief-sheet-state="error" className="text-[11.5px] text-error">
                            Enter a whole number from 1 through {MAX_PARALLELISM}. The scheduler is still running at{" "}
                            {baseline.parallelism}.
                        </p>
                    ) : null}
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
                            disabled={busy || !dirty || invalid || channelId === ""}
                            className={cn(SHEET_BTN, "border-accent/40 px-[11px] py-[5px] text-accent-soft")}
                        >
                            {saving === "settings" ? "Saving…" : "Save settings"}
                        </button>
                        <button
                            type="button"
                            onClick={saveDefaults}
                            disabled={busy || invalid || channelId === ""}
                            className={cn(SHEET_BTN, "px-[11px] py-[5px]")}
                        >
                            {saving === "defaults" ? "Saving…" : "Save as project defaults"}
                        </button>
                    </div>
                </div>
            ) : null}
        </div>
    );
}

// Mounted only when the run actually links a dag, so the WOS subscription below always names a real object.
// The read state is carried whole — loading, arrived, failed, gone — because a failed or deleted group is not
// a group that is still loading.
function LinkedRunConfig({ run, dagId }: { run: Run; dagId: string }) {
    const oref = WOS.makeORef("dag", dagId);
    const [group, loading] = useDagGroup(oref);
    const errored = useAtomValue(WOS.getWaveObjectErrorAtom(oref));
    const groupRead: LinkedGroupRead = loading ? "loading" : group != null ? "ready" : errored ? "error" : "missing";
    return <LoadedConfig run={run} group={group ?? null} groupRead={groupRead} />;
}

// The run's configuration dock for whichever run the sheet is showing. The linked/unlinked split is a
// component boundary rather than a hook inside a branch: useDagGroup has to be called unconditionally.
export function RunSettingsPanel({ run }: { run: Run }) {
    if ((run.dagoref ?? "") !== "") {
        return <LinkedRunConfig run={run} dagId={run.dagoref} />;
    }
    return <LoadedConfig run={run} group={null} groupRead="ready" />;
}
