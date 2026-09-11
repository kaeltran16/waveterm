// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Brief's detail sheet: the Stage's successor. The Stage occupied the middle pane and drew whatever
// subject was active; the sheet draws the same subject on the right, so one renderer serves a channel (the
// live body of the run it is showing, or the launcher when it has no run yet) and an initiative (its chunk
// detail).
//
// It reads what the subject store already resolved — the run through stageRunAtom, the attribution through
// the ambient map — instead of re-deriving any of it, which is what stops one run having two live
// renderers. Note what is NOT here: a run id. B4 keyed the sheet by one, and that was fine while a run row
// was the only way in; the moment the sheet draws the active subject, a second key would be a second
// answer to the same question, and the two could name different runs.
//
// A channel with no run is not an empty sheet. The launcher is the only place a run starts from now, so the
// sheet carries its configuration AND the goal row that dispatches it: RunLauncher alone is the config half
// of a launch, and its own docblock says so — the goal and its Run live in the composer that used to sit
// directly below it on the Stage.

import { globalStore } from "@/app/store/jotaiStore";
import { buildChannelsAskBindings } from "@/app/store/keybindings/bindings";
import { useKeybindings } from "@/app/store/keybindings/store";
import * as WOS from "@/app/store/wos";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { ambientProviderAtom, ensureAmbient } from "@/app/view/agents/ambientstore";
import { resolveTargetChannel } from "@/app/view/agents/channelderive";
import { activeChannelAtom, channelsAtom } from "@/app/view/agents/channelsstore";
import { harnessPreferenceAtom } from "@/app/view/agents/harnessstore";
import { channelProjectLabel } from "@/app/view/agents/projectlabel";
import { projectsAtom } from "@/app/view/agents/projectsstore";
import {
    channelOverrideAtom,
    createRun,
    loadResolvedProfile,
    pendingRunDraftAtom,
    resolvedProfileAtom,
} from "@/app/view/agents/runactions";
import { RunBody } from "@/app/view/agents/runbody";
import {
    endRunConfigDraft,
    hydrateRunConfigFromProfile,
    orchestrationAtom,
    parallelismAtom,
    resetRunConfigForChannel,
    routeTouchedAtom,
    runRouteAtom,
    runShapeAtom,
    workerRouteAtom,
} from "@/app/view/agents/runconfigstore";
import { RunLauncher } from "@/app/view/agents/runlauncher";
import { liveWorkers } from "@/app/view/agents/runmodel";
import { fireAndForget } from "@/util/util";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { RunSettingsPanel, SheetShell } from "./briefrunsheet";
import { sheetFace } from "./briefsheetmodel";
import { EffortDetailView } from "./effortdetailview";
import { effortDetailAtom } from "./effortstore";
import { briefSheetOpenAtom } from "./jarvisstore";
import {
    activeSubjectAtom,
    clearSubject,
    loadRecordDetail,
    recordBandOpenAtom,
    recordDetailAtom,
    setActiveRunId,
    setComposingRun,
    stageRunAtom,
    toggleRecordBand,
} from "./jarvissubjectstore";
import { recordBandCase } from "./recordband";
import { RecordBand } from "./recordbandview";

const FIELD =
    "min-w-0 flex-1 rounded-[7px] border border-border bg-background px-2.5 py-1.5 text-[12.5px] text-ink-hi placeholder:text-ink-faint";

// The goal row the launcher needs to be a launch. It reads the same config atoms RunLauncher edits, so a
// control the user moved above is the control this dispatches with — a launch that ignored the launcher
// would be a control that does nothing.
function ChannelLaunch({ channel }: { channel: Channel }) {
    const shape = useAtomValue(runShapeAtom);
    const orchestration = useAtomValue(orchestrationAtom);
    const workerRoute = useAtomValue(workerRouteAtom);
    const parallelism = useAtomValue(parallelismAtom);
    const runRoute = useAtomValue(runRouteAtom);
    const routeTouched = useAtomValue(routeTouchedAtom);
    const pref = useAtomValue(harnessPreferenceAtom);
    const overrides = useAtomValue(channelOverrideAtom);
    const profiles = useAtomValue(resolvedProfileAtom);
    const pendingDraft = useAtomValue(pendingRunDraftAtom);
    const setPendingDraft = useSetAtom(pendingRunDraftAtom);
    const channels = useAtomValue(channelsAtom);
    const projects = useAtomValue(projectsAtom);
    const [goal, setGoal] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [launching, setLaunching] = useState(false);

    // A Radar "Start investigation" owns the field while it is pending: it is a reviewed draft, not a fresh
    // goal, and its origin has to ride on the run for the finding's outcome to be written back at the end.
    const target = pendingDraft != null ? resolveTargetChannel(channels ?? [], pendingDraft.projectPath) : undefined;
    const radarDraft = pendingDraft != null && target?.oid === channel.oid ? pendingDraft : null;
    const value = radarDraft != null ? radarDraft.goal : goal;

    const channelId = channel.oid;
    useEffect(() => {
        resetRunConfigForChannel(channelId);
    }, [channelId]);
    // the channel's saved profile is the launcher's starting point, and it re-applies whenever the resolved
    // profile changes (a save, a first load, a switch back) — never over a configuration the user edited.
    useEffect(() => {
        hydrateRunConfigFromProfile(profiles[channelId]);
    }, [channelId, profiles]);
    useEffect(() => {
        loadResolvedProfile(channelId);
    }, [channelId]);
    const profileRoute = overrides[channelId]?.route ?? pref.route ?? null;
    useEffect(() => {
        if (!routeTouched && profileRoute != null) {
            globalStore.set(runRouteAtom, profileRoute);
        }
    }, [channelId, profileRoute, routeTouched]);

    const launch = () => {
        const text = value.trim();
        if (text === "" || runRoute == null || launching) {
            return;
        }
        setLaunching(true);
        setError(null);
        fireAndForget(async () => {
            try {
                const mode = shape;
                const created = await createRun(channelId, text, runRoute, {
                    mode,
                    ...(radarDraft != null ? { radarOrigin: radarDraft.radarOrigin } : {}),
                    ...(mode === "orchestrator" ? { orchestration } : {}),
                    ...(mode === "orchestrator" && orchestration === "engine" && workerRoute ? { workerRoute } : {}),
                    ...(mode === "orchestrator" && orchestration === "engine" ? { parallelism } : {}),
                });
                // the launch consumed this draft, so the next one starts from the channel's saved defaults
                endRunConfigDraft(profiles[channelId]);
                setGoal("");
                setPendingDraft(null);
                setActiveRunId(channelId, created.id);
                setComposingRun(channelId, false);
            } catch (e) {
                setError(String(e));
            } finally {
                setLaunching(false);
            }
        });
    };

    return (
        <div className="flex flex-none flex-col gap-1.5 border-t border-edge-faint px-4 py-3">
            <span className="font-mono text-[9.5px] font-bold uppercase tracking-[.13em] text-feed-label">
                run this in {channelProjectLabel(channel, projects)}
            </span>
            <div className="flex items-center gap-2">
                <input
                    data-jarvis-launch-goal
                    value={value}
                    disabled={launching}
                    placeholder="What should it do?"
                    onChange={(e) => {
                        if (radarDraft != null) {
                            setPendingDraft({ ...radarDraft, goal: e.target.value });
                            return;
                        }
                        setGoal(e.target.value);
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            launch();
                        }
                    }}
                    className={FIELD}
                />
                <button
                    type="button"
                    onClick={launch}
                    // no route is a real block, not a slow state: nothing dispatches without one, so the
                    // control states that instead of accepting a goal it would have to refuse.
                    disabled={launching || value.trim() === "" || runRoute == null}
                    className="flex-none cursor-pointer rounded-[7px] border border-accent/40 bg-surface-raised px-2.5 py-1.5 text-[11.5px] font-semibold text-accent-soft hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:opacity-40"
                >
                    {launching ? "Starting…" : "Run ⏎"}
                </button>
            </div>
            <span className="text-[11px] text-muted">
                {runRoute == null
                    ? "Pick a lead route in the launcher above — nothing dispatches without one."
                    : radarDraft != null
                      ? "A Radar investigation, awaiting your review. Its finding's outcome is written back when this run ends."
                      : "The shape and machine above are what this dispatches with."}
            </span>
            {error != null ? (
                <p data-jarvis-brief-sheet-state="error" className="text-[11.5px] text-error">
                    {error}
                </p>
            ) : null}
        </div>
    );
}

function ChannelRun({ model, channel, run }: { model: AgentsViewModel; channel: Channel; run: Run }) {
    const agents = useAtomValue(model.agentsAtom);
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-none items-center gap-2 border-b border-edge-faint px-4 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] uppercase tracking-[.1em] text-ink-faint">
                    showing {run.mode || "quick"} run {run.id.slice(0, 4)}
                </span>
                {/* the Stage's + New run, which is the only way to start a SECOND run in a channel: without
                    it a channel that has any run could never compose another. */}
                <button
                    type="button"
                    onClick={() => setComposingRun(channel.oid, true)}
                    className="flex-none cursor-pointer rounded-[6px] border border-border px-2 py-[3px] font-mono text-[9.5px] font-bold uppercase tracking-[.06em] text-secondary hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                    New run
                </button>
            </div>
            <RunBody model={model} channel={channel} agents={agents} run={run} />
        </div>
    );
}

// The skeleton is only honest while the channel is still being read. A peek's attributed run can name a
// channel that no longer exists, and this sheet is the only place that run is shown — so a read that FAILED
// has to say so rather than sit under "Reading this project…", which is what the two states looked like
// when they shared one branch.
function SheetChannelPending({ channelId }: { channelId: string }) {
    const errored = useAtomValue(WOS.getWaveObjectErrorAtom(WOS.makeORef("channel", channelId)));
    const channels = useAtomValue(channelsAtom);
    // A channel that no longer exists does not fail its read — it never settles: no value, no error. The
    // one signal the client has is the list, which the Brief loads on boot, so "the list is here and this
    // id is not in it" is what says gone. Without it the skeleton below is the permanent state for a run
    // whose channel was deleted, which is most of what an old record's attribution points at.
    const gone = channels != null && !channels.some((c) => c.oid === channelId);
    if (errored || gone) {
        return (
            <div data-jarvis-brief-sheet-state="unavailable" className="flex min-h-0 flex-1 flex-col gap-2 p-4">
                <span className="text-[12px] text-secondary">This run's project is no longer available.</span>
            </div>
        );
    }
    return (
        <div data-jarvis-brief-sheet-state="loading" className="flex min-h-0 flex-1 flex-col gap-2 p-4">
            <span className="h-8 animate-pulse rounded-[8px] bg-surface-raised motion-reduce:animate-none" />
            <span className="text-[12px] text-secondary">Reading this project…</span>
        </div>
    );
}

export function BriefSheet({ model }: { model: AgentsViewModel }) {
    const subject = useAtomValue(activeSubjectAtom);
    const run = useAtomValue(stageRunAtom);
    const open = useAtomValue(briefSheetOpenAtom);
    const channel = useAtomValue(activeChannelAtom);
    const agents = useAtomValue(model.agentsAtom);
    const ambient = useAtomValue(ambientProviderAtom);
    const recordDetails = useAtomValue(recordDetailAtom);
    const bandsOpen = useAtomValue(recordBandOpenAtom);
    const effortCache = useAtomValue(effortDetailAtom);
    const projects = useAtomValue(projectsAtom);

    useEffect(() => ensureAmbient(), []);

    // the ask card's numbered (1-9) badges + Enter, targeting the shown run's asking worker. A ref keeps
    // the binding array stable while reading the live worker each render; it moved here with the run body.
    const askAgentRef = useRef<AgentVM | undefined>(undefined);
    const askBindings = useMemo(() => buildChannelsAskBindings(model, askAgentRef), [model]);
    useKeybindings(askBindings);
    askAgentRef.current = run != null ? liveWorkers(run, agents).find((w) => w.state === "asking") : undefined;

    const face = sheetFace(subject, run);
    const subjectId = subject?.id ?? null;
    const bandOpen = subjectId != null ? (bandsOpen[subjectId] ?? false) : false;
    const tags = run != null ? ambient.tagsFor({ oref: "run:" + run.id }) : [];
    const band = recordBandCase({ kind: subject?.kind ?? "channel", tags });
    const bandRecordId = band.case === "one" ? band.edge.taskId : band.case === "several" ? band.primary.taskId : null;
    // the band's record is loaded only once it is expanded — a collapsed band needs the edge, not the whole
    // dossier (the Stage's rule, moved with the band).
    useEffect(() => {
        if (bandOpen && bandRecordId != null) {
            loadRecordDetail(bandRecordId);
        }
    }, [bandOpen, bandRecordId]);

    if (!open || face.kind === "none") {
        return null;
    }

    const close = () => {
        globalStore.set(briefSheetOpenAtom, false);
        clearSubject();
    };
    const title =
        face.kind === "channel"
            ? channelProjectLabel(channel, projects)
            : (effortCache.get("effort:" + face.effortId)?.title ?? "Initiative");

    return (
        <div className="absolute inset-0 z-20">
            <button
                type="button"
                aria-label="Close detail sheet"
                onClick={close}
                className="absolute inset-0 cursor-default bg-background/40"
            />
            <SheetShell
                face={face.kind}
                label={face.kind === "effort" ? "initiative" : "project"}
                title={title}
                onClose={close}
            >
                {face.kind === "channel" && face.body === "run" && run != null ? (
                    <RecordBand
                        kind={subject?.kind ?? "channel"}
                        tags={tags}
                        detail={bandRecordId != null ? (recordDetails[bandRecordId] ?? null) : null}
                        runORef={"run:" + run.id}
                        open={bandOpen}
                        onToggle={() => subjectId != null && toggleRecordBand(subjectId)}
                    />
                ) : null}
                {face.kind === "channel" ? (
                    channel == null ? (
                        <SheetChannelPending channelId={face.channelId} />
                    ) : face.body === "run" && run != null ? (
                        <ChannelRun model={model} channel={channel} run={run} />
                    ) : (
                        <div className="flex min-h-0 flex-1 flex-col">
                            <RunLauncher projectName={channelProjectLabel(channel, projects)} />
                            <ChannelLaunch channel={channel} />
                        </div>
                    )
                ) : null}
                {face.kind === "effort" ? (
                    <div className="flex min-h-0 flex-1 flex-col">
                        <EffortDetailView model={model} />
                    </div>
                ) : null}
                {/* the settings face is a fixed-height band under the body: RunBody scrolls itself, and a
                    second scroller around it would put two scrollbars on one surface. */}
                {face.kind === "channel" && face.body === "run" && run != null ? (
                    <div
                        data-jarvis-brief-sheet-face="settings"
                        className="flex max-h-[55%] flex-none flex-col gap-4 overflow-y-auto border-t border-edge-faint px-4 py-4"
                    >
                        <RunSettingsPanel run={run} />
                    </div>
                ) : null}
            </SheetShell>
        </div>
    );
}
