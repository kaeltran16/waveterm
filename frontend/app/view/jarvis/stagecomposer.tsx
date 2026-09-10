// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// One composer for every subject. It retargets in place rather than being replaced: the "Talking to" line
// above the input is the only thing that tells the user whether a keystroke reaches a running worker or
// Jarvis, so its tone carries that distinction — success for a worker, accent for Jarvis.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { sendChannelMessage, steerWorker } from "@/app/view/agents/channelactions";
import { LaunchComposer, TalkComposer } from "@/app/view/agents/channelcomposers";
import { resolveTargetChannel } from "@/app/view/agents/channelderive";
import { type RosterEntry } from "@/app/view/agents/channelmessages";
import { appendAttachments, useComposerAttachments } from "@/app/view/agents/composerattachments";
import {
    LAUNCH_COMMANDS,
    composerFace,
    parseComposerCommand,
    resolveComposerDispatch,
    resolveRunCreationDecision,
} from "@/app/view/agents/composercommand";
import { harnessRuntimeIds } from "@/app/view/agents/harnesspicker";
import { harnessPreferenceAtom, harnessesAtom } from "@/app/view/agents/harnessstore";
import { resolveEffectiveRoute, routeForRuntime } from "@/app/view/agents/route";
import {
    createRun,
    pendingRunDraftAtom,
    resolveChannelLaunchRoute,
    resolvedProfileAtom,
} from "@/app/view/agents/runactions";
import {
    endRunConfigDraft,
    hydrateRunConfigFromProfile,
    orchestrationAtom,
    parallelismAtom,
    requestRouteOpen,
    resetRunConfigForChannel,
    routeTouchedAtom,
    runRouteAtom,
    runShapeAtom,
    workerRouteAtom,
} from "@/app/view/agents/runconfigstore";
import { currentPhaseIndex } from "@/app/view/agents/runmodel";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useState } from "react";
import { askAcrossWork, briefingAskStateAtom, briefingStateAtom } from "./briefingstore";
import { resolveComposerTarget } from "./composertarget";
import type { ScopeChip } from "./jarviscontract";
import { activeConversationAtom, activeConversationIdAtom, submitJarvisQuery } from "./jarvisstore";
import {
    askAboutRecord,
    channelPickingAtom,
    composingRunAtom,
    jarvisDraftAtom,
    setActiveRunId,
    setChannelPicking,
    setComposingRun,
    setJarvisDraft,
} from "./jarvissubjectstore";
import type { StageComposition } from "./stagecompose";
import { STAGE_BAND_INSET, STAGE_GUTTER } from "./stagemeasure";

function TalkingTo({ label, audience }: { label: string; audience: "worker" | "jarvis" }) {
    return (
        <div className="mb-1.5 flex items-center gap-2">
            <span className="font-mono text-[9px] font-semibold uppercase tracking-[.1em] text-muted">Talking to</span>
            <span
                className={cn(
                    "rounded-[6px] border px-2 py-[2px] text-[11px] font-semibold",
                    audience === "worker"
                        ? "border-success/40 bg-success/12 text-success"
                        : "border-accent/40 bg-accentbg text-accent-soft"
                )}
            >
                {label}
            </span>
        </div>
    );
}

// The dispatch a non-channel subject cannot serve on its own: an explicit @run/@quick needs a channel, so
// it asks for one instead of silently answering as a question.
function ChannelPicker({
    channels,
    onPick,
    onCancel,
}: {
    channels: Channel[];
    onPick: (channelId: string) => void;
    onCancel: () => void;
}) {
    return (
        <div className="mb-2 flex flex-col gap-1.5 rounded-[10px] border border-accent/30 bg-accentbg px-3 py-2.5">
            <div className="flex items-center gap-2">
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[.1em] text-accent-soft">
                    Dispatch into which channel?
                </span>
                <div className="flex-1" />
                <button
                    type="button"
                    onClick={onCancel}
                    className="cursor-pointer font-mono text-[10px] text-muted hover:text-secondary"
                >
                    Cancel
                </button>
            </div>
            {channels.length === 0 ? (
                <span className="text-[11.5px] text-muted">No channel yet — create one from the Subjects column.</span>
            ) : (
                <div className="flex flex-wrap gap-1.5">
                    {channels.map((c) => (
                        <button
                            key={c.oid}
                            type="button"
                            onClick={() => onPick(c.oid)}
                            className="cursor-pointer rounded-[7px] border border-border bg-surface px-2.5 py-1 text-[11.5px] font-semibold text-secondary hover:border-accent hover:text-primary"
                        >
                            #{c.name}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

// The Jarvis face: one plain ask box, used by a record and by a thread. Deliberately not the Launch face —
// off a channel there is no run strategy footer to state. The scope chips sit above the box: a contextual
// entry ("Ask Jarvis" on a memory note, a graph node, a record) attaches its source to the conversation, and
// this row is the only place that attachment is visible.
function JarvisAsk({
    draft,
    onChange,
    onSubmit,
    placeholder,
    chips,
}: {
    draft: string;
    onChange: (next: string) => void;
    onSubmit: () => void;
    placeholder: string;
    chips: ScopeChip[];
}) {
    return (
        <>
            {chips.length > 0 ? (
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                    {chips.map((chip) => (
                        <span
                            key={chip.label}
                            className={cn(
                                "rounded-full border px-2.5 py-0.5 text-[11.5px]",
                                chip.active
                                    ? "border-accent/40 bg-accentbg text-accent-soft"
                                    : "border-border text-ink-mid"
                            )}
                        >
                            {chip.label}
                        </span>
                    ))}
                </div>
            ) : null}
            <div className="flex items-center gap-2 rounded-[10px] border border-edge-mid bg-surface px-3.5 py-2.5">
                <input
                    value={draft}
                    onChange={(e) => onChange(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            onSubmit();
                        }
                    }}
                    placeholder={placeholder}
                    className="min-w-0 flex-1 bg-transparent text-[14px] text-secondary placeholder:text-muted focus:outline-none"
                />
                <span className="flex-none font-mono text-[10px] text-muted">
                    {LAUNCH_COMMANDS.map((c) => c.cmd).join(" · ")}
                </span>
            </div>
        </>
    );
}

// The Briefing face: one plain all-work ask. No dispatch legend — a dispatch needs a channel, and
// Briefing has none. Disabled while an ask is in flight or the work state is known-partial.
function BriefingAsk({
    draft,
    onChange,
    onSubmit,
    pending,
    disabled,
}: {
    draft: string;
    onChange: (next: string) => void;
    onSubmit: () => void;
    pending: boolean;
    disabled: boolean;
}) {
    return (
        <div className="flex items-center gap-2 rounded-[10px] border border-edge-mid bg-surface px-3.5 py-2.5">
            <input
                value={draft}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !disabled) {
                        e.preventDefault();
                        onSubmit();
                    }
                }}
                placeholder="ALL WORK · Ask across your work…"
                disabled={disabled}
                className="min-w-0 flex-1 bg-transparent text-[14px] text-secondary placeholder:text-muted focus:outline-none disabled:opacity-50"
            />
            {pending ? (
                <span className="flex-none rounded-[6px] border border-accent/40 bg-accentbg px-2 py-[3px] font-mono text-[10px] font-semibold text-accent-soft">
                    Answering…
                </span>
            ) : (
                // the answer renders up in the briefing body, not here — say so, because a composer
                // that swallows its own reply otherwise reads as having done nothing.
                <span className="flex-none font-mono text-[9.5px] text-muted">answers land on this page</span>
            )}
        </div>
    );
}

export function StageComposer({
    model,
    comp,
    subjectId,
    channel,
    channels,
    agents,
    run,
    recordId,
    recordObjective,
    route,
}: {
    model: AgentsViewModel;
    comp: StageComposition;
    subjectId: string;
    channel: Channel | null;
    channels: Channel[];
    agents: AgentVM[];
    run: Run | undefined;
    recordId: string | null;
    recordObjective: string;
    route?: RoutePin;
}) {
    // one draft store keyed by subject, serving all three faces: on a channel the key *is* the channel oid.
    // The box is the same box, but what is half-typed in it belongs to the subject it was typed on.
    const draft = useAtomValue(jarvisDraftAtom)[subjectId] ?? "";
    const setDraft = (next: string) => setJarvisDraft(subjectId, next);
    const picking = useAtomValue(channelPickingAtom)[subjectId] ?? false;
    const setPicking = (next: boolean) => setChannelPicking(subjectId, next);
    const activeConvId = useAtomValue(activeConversationIdAtom);
    const conversation = useAtomValue(activeConversationAtom);
    const pendingDraft = useAtomValue(pendingRunDraftAtom);
    const setRadarDraft = useSetAtom(pendingRunDraftAtom);
    const attach = useComposerAttachments();
    const pref = useAtomValue(harnessPreferenceAtom);
    const preferredRoute = route ?? pref.route;
    const harnesses = useAtomValue(harnessesAtom);
    const runtimeIds = harnessRuntimeIds(harnesses);
    const [harnessOpenRequest, setHarnessOpenRequest] = useState(0);
    const [launchError, setLaunchError] = useState("");
    // The run configuration is the launcher's (view/agents/runlauncher.tsx); this face reads it to dispatch.
    const shape = useAtomValue(runShapeAtom);
    const runRoute = useAtomValue(runRouteAtom);
    const workerRoute = useAtomValue(workerRouteAtom);
    const orchestration = useAtomValue(orchestrationAtom);
    const parallelism = useAtomValue(parallelismAtom);
    const routeTouched = useAtomValue(routeTouchedAtom);
    const channelIdentity = channel?.oid ?? null;
    const resolvedProfiles = useAtomValue(resolvedProfileAtom);

    useEffect(() => {
        resetRunConfigForChannel(channelIdentity);
    }, [channelIdentity]);

    // The channel's saved profile is the launcher's starting point: it decides the shape, the machine, the
    // width and the worker route a run would launch with, and it re-applies whenever the resolved profile
    // changes (a save, a first load, a switch back). It never touches a configuration the user has edited
    // by hand — see hydrateRunConfigFromProfile.
    useEffect(() => {
        if (channelIdentity == null) {
            return;
        }
        hydrateRunConfigFromProfile(resolvedProfiles[channelIdentity]);
    }, [channelIdentity, resolvedProfiles]);

    useEffect(() => {
        if (!routeTouched && (route != null || pref.route != null)) {
            globalStore.set(runRouteAtom, route ?? pref.route);
        }
    }, [channelIdentity, route, pref.route, routeTouched]);

    // A blocked launch opens the route picker, which lives in the launcher — so the launcher has to be on
    // the Stage for the request to be visible. Composing is what puts it there, and it is the truthful
    // state anyway: the launch did not happen, so the run is still being composed.
    const focusRoute = () => {
        if (channelIdentity != null) {
            setComposingRun(channelIdentity, true);
        }
        requestRouteOpen();
    };

    const briefingAskState = useAtomValue(briefingAskStateAtom);
    const briefingSnapshot = useAtomValue(briefingStateAtom).snapshot;
    const briefingPending = briefingAskState === "pending";
    // known-partial work state disables the composer until a complete refresh succeeds
    const briefingDisabled = briefingSnapshot != null && !briefingSnapshot.complete;

    // The Radar draft is one global value (one investigation at a time), but it belongs to the channel its
    // finding's project resolves to. Ungated it followed the user onto every other channel: the banner and
    // the goal showed there, `Run ⏎` dispatched the investigation into the wrong project carrying
    // radarOrigin — so the finding's outcome was written back against a run in a project it never touched —
    // and the Launch face hid whatever that channel's own draft or live worker held.
    const draftTarget = pendingDraft != null ? resolveTargetChannel(channels, pendingDraft.projectPath) : undefined;
    // no channel for the finding's project: there is nowhere correct to dispatch it. Rather than vanish
    // (Start investigation would look like a dead button) it stays visible and discardable wherever the
    // user is, with the send blocked and the banner saying why.
    const draftOrphaned = pendingDraft != null && draftTarget == null;
    const radarDraft =
        pendingDraft != null && (draftOrphaned || draftTarget?.oid === channel?.oid) ? pendingDraft : null;

    const composing = useAtomValue(composingRunAtom)[channel?.oid ?? ""] ?? false;

    const onChannel = comp.composerTarget === "worker-or-jarvis";
    // a pending Radar draft forces the Launch face and owns the field: it is an investigation awaiting
    // review, so nothing dispatches until the user presses Start. "＋ New run" forces it the same way —
    // only the Launch face can create a run, and the live worker that renders the button is also what
    // would drag the face straight back to Talk.
    const value = onChannel && radarDraft != null ? radarDraft.goal : draft;
    // the face the channel would show on its own, before either override.
    const naturalFace = onChannel && channel != null ? composerFace(run, agents) : { face: "launch" as const };
    const face = radarDraft == null && !composing ? naturalFace : { face: "launch" as const };
    const target = resolveComposerTarget({
        composerTarget: comp.composerTarget,
        draft: value,
        workerName: face.face === "talk" ? face.worker.name : undefined,
        runLabel: run != null ? `run ${run.id.slice(0, 4)}` : undefined,
    });

    const roster: RosterEntry[] = agents.map((a) => ({ id: a.id, name: a.name, blockId: a.blockId }));
    const phaseLabel = run ? run.phases?.[currentPhaseIndex(run)]?.kind : undefined;

    // The run shape is a per-dispatch choice. Every executable shape creates a run immediately.
    const launchInto = (channelId: string, goal: string, route: RoutePin, mode?: string) =>
        fireAndForget(async () => {
            const created = await createRun(channelId, goal, route, { mode });
            setActiveRunId(channelId, created.id);
        });
    const sendOnChannel = async () => {
        if (channel == null || attach.uploading) {
            return;
        }
        // the Radar path keeps radarOrigin on the created run — that origin is what lets the finding's
        // outcome be written back when the run finishes.
        if (radarDraft != null) {
            if (draftOrphaned) {
                return; // no channel for the finding's project — dispatching here is the wrong project
            }
            const goal = appendAttachments(radarDraft.goal.trim(), attach.attachments);
            if (!goal) {
                return;
            }
            // a Radar investigation needs a valid preferred harness; blocked keeps the draft visible.
            const dispatch = resolveComposerDispatch({
                command: { mode: "run", body: goal },
                preferredRuntime: preferredRoute?.runtime ?? "",
                preferenceSaving: pref.saving,
                harnesses,
            });
            if (dispatch.kind === "blocked") {
                setHarnessOpenRequest((n) => n + 1);
                return;
            }
            let route: RoutePin | undefined;
            try {
                route = await resolveChannelLaunchRoute(channel.oid);
            } catch {
                setHarnessOpenRequest((n) => n + 1);
                return;
            }
            attach.clear();
            setRadarDraft(null);
            endRunConfigDraft(resolvedProfiles[channel.oid]);
            // this dispatch also ends any draft run open on the channel — otherwise its row stays in the
            // Subjects column, selected, holding the Stage off the run this just created.
            setComposingRun(channel.oid, false);
            fireAndForget(async () => {
                const created = await createRun(channel.oid, goal, route, { radarOrigin: radarDraft.radarOrigin });
                setActiveRunId(channel.oid, created.id);
            });
            return;
        }
        if (face.face === "talk") {
            const text = appendAttachments(draft.trim(), attach.attachments);
            if (!text.trim()) {
                return;
            }
            setDraft("");
            attach.clear();
            fireAndForget(() =>
                steerWorker({ channelId: channel.oid, workerORef: `tab:${face.worker.id}`, agents, text })
            );
            return;
        }
        const text = appendAttachments(draft.trim(), attach.attachments);
        if (!text.trim()) {
            return;
        }
        // parse + resolve first: a blocked dispatch (missing/invalid harness or preference in flight)
        // preserves the draft and attachments and opens/focuses the picker instead of dispatching.
        const cmd = parseComposerCommand(text, runtimeIds);
        const dispatch = resolveComposerDispatch({
            command: cmd,
            preferredRuntime: preferredRoute?.runtime ?? "",
            preferenceSaving: pref.saving,
            harnesses,
        });
        if (dispatch.kind === "blocked") {
            setHarnessOpenRequest((n) => n + 1);
            return;
        }
        if (dispatch.kind === "run") {
            let selectedRoute = runRoute;
            if (selectedRoute == null) {
                try {
                    selectedRoute = await resolveChannelLaunchRoute(channel.oid);
                } catch {
                    focusRoute();
                    return;
                }
            }
            const effectiveRoute = resolveEffectiveRoute({ settings: selectedRoute, harnesses });
            const decision = resolveRunCreationDecision({
                channelId: channel.oid,
                goal: dispatch.body,
                shape: dispatch.mode === "quick" ? "quick" : shape,
                route: effectiveRoute,
            });
            if (decision.kind === "blocked") {
                if (decision.focusRoute) {
                    focusRoute();
                }
                return;
            }
            setLaunchError("");
            try {
                const created = await createRun(decision.channelId, decision.goal, decision.route, {
                    mode: decision.mode,
                    ...(decision.mode === "orchestrator" ? { orchestration } : {}),
                    ...(decision.mode === "orchestrator" && orchestration === "engine" && workerRoute ? { workerRoute } : {}),
                    ...(decision.mode === "orchestrator" && orchestration === "engine" ? { parallelism } : {}),
                });
                setActiveRunId(decision.channelId, created.id);
                // the launch consumed this draft: the next one starts from the channel's saved defaults
                endRunConfigDraft(resolvedProfiles[decision.channelId]);
                setDraft("");
                attach.clear();
                setComposingRun(decision.channelId, false);
            } catch (error) {
                setLaunchError(String(error));
            }
            return;
        }
        setDraft("");
        attach.clear();
        setComposingRun(channel.oid, false);
        // @ask -> one-shot consult (no worker), via sendChannelMessage's ask transport.
        fireAndForget(() =>
            sendChannelMessage({
                model,
                channelId: channel.oid,
                projectPath: channel.projectpath ?? "",
                projectName: channel.name ?? "agent",
                roster,
                text: `ask @${dispatch.runtime} ${dispatch.body}`,
            })
        );
    };

    const askJarvis = () => {
        const text = draft.trim();
        if (text === "") {
            return;
        }
        if (target.needsChannelPicker) {
            setPicking(true);
            return;
        }
        setDraft("");
        if (comp.composerTarget === "jarvis-briefing") {
            askAcrossWork(text);
            return;
        }
        if (comp.composerTarget === "jarvis-record" && recordId != null) {
            askAboutRecord(recordId, recordObjective, text);
            return;
        }
        if (activeConvId != null) {
            submitJarvisQuery(activeConvId, text);
        }
    };

    const dispatchFromPicker = async (channelId: string) => {
        const cmd = parseComposerCommand(draft.trim(), runtimeIds);
        try {
            const effective = await resolveChannelLaunchRoute(channelId);
            const route = cmd.runtime == null ? effective : routeForRuntime(cmd.runtime, effective, harnesses);
            if (route == null) {
                setHarnessOpenRequest((n) => n + 1);
                return;
            }
            setPicking(false);
            setDraft("");
            launchInto(channelId, cmd.body, route, cmd.mode === "quick" ? "quick" : undefined);
        } catch {
            setHarnessOpenRequest((n) => n + 1);
        }
    };

    // data-jarvis-composer is the handle `i` focuses and Escape leaves (buildJarvisBindings). One marker on
    // the wrapper serves all three faces, so neither the shared composers nor this file grow a per-face hook.
    return (
        <div data-jarvis-composer className={cn(STAGE_BAND_INSET, "flex-none border-t border-border bg-background")}>
            <div className={cn(STAGE_GUTTER, "pb-4 pt-2.5")}>
                <TalkingTo label={target.label} audience={target.audience} />
                {picking ? (
                    <ChannelPicker channels={channels} onPick={dispatchFromPicker} onCancel={() => setPicking(false)} />
                ) : null}
                {onChannel && channel != null ? (
                    face.face === "talk" ? (
                        <TalkComposer
                            worker={face.worker}
                            phaseLabel={phaseLabel}
                            value={draft}
                            onChange={setDraft}
                            onSubmit={sendOnChannel}
                            onNewRun={() => setComposingRun(channel.oid, true)}
                            attach={attach}
                        />
                    ) : (
                        <>
                            {radarDraft != null ? (
                                <div className="mb-2 flex items-center gap-2.5 rounded-[10px] border border-accent/30 bg-accentbg px-3 py-2">
                                    <span className="font-mono text-[9px] font-semibold uppercase tracking-[.1em] text-accent-soft">
                                        From Radar
                                    </span>
                                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-secondary">
                                        {draftOrphaned
                                            ? "No channel for this finding's project — create one to investigate it."
                                            : "Review the goal, then start it — nothing dispatches until you do."}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setRadarDraft(null);
                                            endRunConfigDraft(resolvedProfiles[channel.oid]);
                                        }}
                                        className="cursor-pointer font-mono text-[10px] text-muted hover:text-secondary"
                                    >
                                        Discard
                                    </button>
                                </div>
                            ) : null}
                            {composing && radarDraft == null && naturalFace.face === "talk" ? (
                                <div className="mb-2 flex items-center gap-2.5 rounded-[10px] border border-edge-mid bg-surface px-3 py-2">
                                    <span className="font-mono text-[9px] font-semibold uppercase tracking-[.1em] text-muted">
                                        New run
                                    </span>
                                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-secondary">
                                        The run already going keeps running — this starts a second one.
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setComposingRun(channel.oid, false);
                                            endRunConfigDraft(resolvedProfiles[channel.oid]);
                                        }}
                                        className="cursor-pointer font-mono text-[10px] text-muted hover:text-secondary"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            ) : null}
                            {launchError ? <div className="mb-1 text-[11px] text-error">{launchError}</div> : null}
                            <LaunchComposer
                                value={value}
                                onChange={
                                    radarDraft != null
                                        ? (next) => setRadarDraft({ ...radarDraft, goal: next })
                                        : setDraft
                                }
                                onSubmit={sendOnChannel}
                                channelName={channel.name ?? "channel"}
                                pending={radarDraft != null}
                                attach={attach}
                                harnessOpenRequest={harnessOpenRequest}
                            />
                        </>
                    )
                ) : comp.composerTarget === "jarvis-briefing" ? (
                    <BriefingAsk
                        draft={draft}
                        onChange={setDraft}
                        onSubmit={askJarvis}
                        pending={briefingPending}
                        disabled={briefingPending || briefingDisabled}
                    />
                ) : (
                    <JarvisAsk
                        draft={draft}
                        onChange={setDraft}
                        onSubmit={askJarvis}
                        placeholder={
                            comp.composerTarget === "jarvis-record"
                                ? "Ask Jarvis about this record…"
                                : "Ask Jarvis anything…"
                        }
                        chips={conversation.scope.chips}
                    />
                )}
            </div>
        </div>
    );
}
