// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Channels surface: a single runs-native surface where "a channel *is* its runs." No Chat｜Runs toggle
// and no message stream — the surface owns the chrome (header + autonomy toggle + ⚙, a collapsible
// overview strip, a single run strip, RunBody, and one two-face composer) and a right rail (Needs you /
// Consults / Fleet here). The composer's Launch face takes typed @quick/@run/@ask commands; its Talk face
// messages the selected run's live worker (the old "Steer"). RunBody (runbody.tsx) renders the selected
// run; all cross-process behavior reuses existing RPCs (SetChannelTier, CreateRun, Consult, Jarvis, …).

import { buildChannelsAskBindings } from "@/app/store/keybindings/bindings";
import { useKeybindings } from "@/app/store/keybindings/store";
import { fireAndForget } from "@/util/util";
import { useAtomValue, useSetAtom } from "jotai";
import { MotionConfig } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { type AgentVM } from "./agentsviewmodel";
import { sendChannelMessage, steerWorker } from "./channelactions";
import { ChannelHeader, OverviewStrip, RunStrip } from "./channelchrome";
import { LaunchComposer, TalkComposer } from "./channelcomposers";
import { appendAttachments, useComposerAttachments } from "./composerattachments";
import { ContextPanel } from "./channelcontextpanel";
import { resolveTargetChannel } from "./channelderive";
import { composerFace, parseComposerCommand } from "./composercommand";
import { type RosterEntry } from "./channelmessages";
import { CHANNEL_COL } from "./channelsprimitives";
import { ChannelRail } from "./channelrail";
import { filterChannelsBySpace, spaceBannerText } from "./spacescope";
import { activeSpaceAtom, spaceRevealAtom, spaceScopeAtom } from "./spacestore";
import { SpaceBanner } from "./spacebanner";
import {
    activeChannelAtom,
    activeChannelIdAtom,
    activeChannelMessagesAtom,
    activeChannelRunsAtom,
    archiveChannel,
    channelDismissedRunsAtom,
    channelDraftAtom,
    channelsAtom,
    channelsErrorAtom,
    consultStreamsAtom,
    createChannel,
    deleteChannel,
    loadChannels,
    renameChannel,
    selectChannel,
    setChannelNotes,
    setChannelTier,
} from "./channelsstore";
import { projectsAtom } from "./projectsstore";
import { createRun, getJarvisProfile, pendingRunDraftAtom, pendingRunFocusAtom } from "./runactions";
import { currentPhaseIndex, defaultRunId, liveWorkers, resolveActiveRunId } from "./runmodel";
import { RunBody } from "./runbody";
import { SkeletonLine } from "@/app/element/skeleton";
import { SurfaceEmptyState, SurfaceError } from "./surfacescaffold";

// ── The surface ──────────────────────────────────────────────────────────────────────────────────────

export function ChannelsSurface({ model }: { model: AgentsViewModel }) {
    const channels = useAtomValue(channelsAtom);
    const spaceScope = useAtomValue(spaceScopeAtom);
    const activeSpace = useAtomValue(activeSpaceAtom);
    const channelsRevealed = useAtomValue(spaceRevealAtom).has("channels");
    const scopedChannels = filterChannelsBySpace(channels, spaceScope, channelsRevealed);
    const channelsHidden = (channels?.length ?? 0) - (scopedChannels?.length ?? 0);
    const channelsError = useAtomValue(channelsErrorAtom);
    const activeId = useAtomValue(activeChannelIdAtom);
    const active = useAtomValue(activeChannelAtom);
    const agents = useAtomValue(model.agentsAtom);
    const projects = useAtomValue(projectsAtom);
    const consultStreams = useAtomValue(consultStreamsAtom);
    const pendingDraft = useAtomValue(pendingRunDraftAtom);
    const setPendingDraft = useSetAtom(pendingRunDraftAtom);
    const pendingFocus = useAtomValue(pendingRunFocusAtom);
    const setPendingFocus = useSetAtom(pendingRunFocusAtom);

    // draft + dismissals live in per-channel atoms (keyed by activeId), not surface-local state, so they
    // survive the surface unmount on nav-rail switch and the channel switch (see channelsstore).
    const draftMap = useAtomValue(channelDraftAtom);
    const setDraftMap = useSetAtom(channelDraftAtom);
    const draft = activeId ? (draftMap[activeId] ?? "") : "";
    const setDraft = (value: string) => {
        if (activeId) {
            setDraftMap((m) => ({ ...m, [activeId]: value }));
        }
    };
    const setDismissedMap = useSetAtom(channelDismissedRunsAtom);
    const dismissedMap = useAtomValue(channelDismissedRunsAtom);
    const dismissed = useMemo(
        () => new Set(activeId ? (dismissedMap[activeId] ?? []) : []),
        [dismissedMap, activeId]
    );
    const attach = useComposerAttachments();
    const [picking, setPicking] = useState(false);
    const [overviewOpen, setOverviewOpen] = useState(false);
    const [profile, setProfile] = useState<JarvisProfile | undefined>(undefined);

    // Phase 2: the active channel's runs/messages come from the row-backed atoms (seeded on select,
    // refetched on channel: bump), not the embedded Channel.runs/messages arrays. `activeForDerive` splices
    // them onto the pinned channel so downstream consumers (ContextPanel, the @jarvis summary) that read
    // channel.messages/runs pick up the row data without changing their signatures.
    const allRuns = useAtomValue(activeChannelRunsAtom);
    const messages = useAtomValue(activeChannelMessagesAtom);
    const activeForDerive = active ? { ...active, runs: allRuns, messages } : null;
    const runs = allRuns.filter((r) => !dismissed.has(r.id));
    const [activeRunId, setActiveRunId] = useState<string | undefined>(() => defaultRunId(runs));

    const [notesDraft, setNotesDraft] = useState("");
    useEffect(() => {
        const stored = (active?.meta as Record<string, unknown> | undefined)?.["channel:notes"];
        setNotesDraft(typeof stored === "string" ? stored : "");
        // re-seed only when the active channel changes, not on every meta update (avoids clobbering typing)
    }, [active?.oid]);
    const notesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const onNotesChange = (value: string) => {
        setNotesDraft(value);
        if (!active) {
            return;
        }
        const oid = active.oid;
        if (notesTimer.current) {
            clearTimeout(notesTimer.current);
        }
        notesTimer.current = setTimeout(() => {
            fireAndForget(() => setChannelNotes(oid, value));
        }, 600);
    };

    // keep a valid run selection as the channel / visible runs change
    useEffect(() => {
        setActiveRunId((cur) => resolveActiveRunId(runs, cur));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active?.oid, runs.length]);
    useEffect(() => {
        attach.clear();
        setOverviewOpen(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeId]);

    // the channel's resolved Jarvis profile drives the composer's run footer + createRun defaults (the ⚙
    // drawer edits it). Refetched on channel change.
    useEffect(() => {
        if (!activeId) {
            setProfile(undefined);
            return;
        }
        let live = true;
        getJarvisProfile(activeId)
            .then((r) => {
                if (live) {
                    setProfile(r.resolved);
                }
            })
            .catch(() => {});
        return () => {
            live = false;
        };
    }, [activeId]);

    useEffect(() => {
        fireAndForget(loadChannels);
    }, []);

    // land a Radar handoff exactly once: resolve its project to a channel and select it. The guard lives
    // on the atom (not a ref) so it survives ChannelsSurface unmounting on navigation.
    useEffect(() => {
        if (!pendingDraft || pendingDraft.landed) {
            return;
        }
        const target = resolveTargetChannel(channels ?? [], pendingDraft.projectPath);
        if (target) {
            fireAndForget(() => selectChannel(target.oid));
            setPendingDraft({ ...pendingDraft, landed: true });
        } else {
            setPicking(true); // no channel for this project yet — stays unlanded so it retries once one exists
        }
    }, [pendingDraft, channels]);

    // land an "Open run" focus request: select the channel, then (once its runs are loaded) select the run.
    useEffect(() => {
        if (!pendingFocus) {
            return;
        }
        if (activeId !== pendingFocus.channelId) {
            fireAndForget(() => selectChannel(pendingFocus.channelId));
            return; // re-runs when activeId flips to the target channel
        }
        if (runs.some((r) => r.id === pendingFocus.runId)) {
            setActiveRunId(pendingFocus.runId);
            setPendingFocus(null);
        }
    }, [pendingFocus, activeId, runs]);

    const roster: RosterEntry[] = agents.map((a) => ({ id: a.id, name: a.name, blockId: a.blockId }));

    const dismissTab = (id: string) => {
        if (!activeId) {
            return;
        }
        setDismissedMap((m) => ({ ...m, [activeId]: [...(m[activeId] ?? []), id] }));
        const visible = allRuns.filter((r) => r.id !== id && !dismissed.has(r.id));
        setActiveRunId((cur) => (cur === id ? defaultRunId(visible) : cur));
    };

    const run = runs.find((r) => r.id === activeRunId);

    // Make the ask card's numbered (1-9) badges + Enter functional on Channels, targeting the selected
    // run's asking worker. A ref keeps the binding array stable while reading the live worker each render
    // (mirrors the Agent surface's live-atom bindings). Registered only while ChannelsSurface is mounted.
    const askAgentRef = useRef<AgentVM | undefined>(undefined);
    askAgentRef.current = run ? liveWorkers(run, agents).find((w) => w.state === "asking") : undefined;
    const askBindings = useMemo(() => buildChannelsAskBindings(model, askAgentRef), [model]);
    useKeybindings(askBindings);

    const faceRun = pendingDraft ? undefined : run; // a pending Radar draft forces the Launch (investigation) face
    const face = active ? composerFace(faceRun, agents) : { face: "launch" as const };

    const selectNewRun = () => {
        setPendingDraft(null);
        setDraft("");
        setActiveRunId(undefined);
    };
    const goToRun = (id: string) => {
        setPendingDraft(null);
        setActiveRunId(id);
    };

    const launchValue = pendingDraft ? pendingDraft.goal : draft;
    const onLaunchChange = pendingDraft ? (v: string) => setPendingDraft((d) => (d ? { ...d, goal: v } : d)) : setDraft;

    // every @run / dispatch / radar-draft create-run shares the channel profile's mode + plan gate
    const launchRun = (goal: string, extra?: Parameters<typeof createRun>[2]) =>
        createRun(active!.oid, goal, { mode: profile?.defaultmode, planGate: profile?.defaultplangate, ...extra });

    const dispatchToRun = (goal: string) => {
        if (!active || !goal.trim()) {
            return;
        }
        fireAndForget(async () => {
            const created = await launchRun(goal);
            goToRun(created.id);
        });
    };

    const send = () => {
        if (!active) {
            return;
        }
        if (attach.uploading) {
            return; // Enter bypasses the disabled Send button; block until every attachment resolves
        }
        if (face.face === "talk") {
            const text = appendAttachments(draft.trim(), attach.attachments);
            if (!text.trim()) {
                return;
            }
            setDraft("");
            attach.clear();
            fireAndForget(() => steerWorker({ channelId: active.oid, workerORef: `tab:${face.worker.id}`, agents, text }));
            return;
        }
        // Launch face
        if (pendingDraft) {
            const goal = appendAttachments(pendingDraft.goal.trim(), attach.attachments);
            if (!goal.trim()) {
                return;
            }
            const radarOrigin = pendingDraft.radarOrigin;
            setPendingDraft(null);
            attach.clear();
            fireAndForget(async () => {
                const created = await launchRun(goal, { radarOrigin });
                setActiveRunId(created.id);
            });
            return;
        }
        const text = appendAttachments(draft.trim(), attach.attachments);
        if (!text.trim()) {
            return;
        }
        setDraft("");
        attach.clear();
        const cmd = parseComposerCommand(text);
        if (cmd.mode === "run") {
            fireAndForget(async () => {
                const created = await launchRun(cmd.body);
                setActiveRunId(created.id);
            });
            return;
        }
        if (cmd.mode === "quick") {
            fireAndForget(async () => {
                const created = await launchRun(cmd.body, { mode: "quick" });
                setActiveRunId(created.id);
            });
            return;
        }
        // @ask → one-shot consult (no worker), via sendChannelMessage's ask transport.
        const transport = `ask @${cmd.runtime ?? "claude"} ${cmd.body}`;
        fireAndForget(() =>
            sendChannelMessage({
                model,
                channelId: active.oid,
                projectPath: active.projectpath ?? "",
                projectName: active.name ?? "agent",
                roster,
                text: transport,
            })
        );
    };

    // A channel is bound to a project at creation, so every dispatch has a valid cwd (no unbound state).
    const pickProject = (name: string, path: string) => {
        setPicking(false);
        fireAndForget(async () => {
            await createChannel(name, path);
        });
    };

    const phaseLabel = run ? run.phases?.[currentPhaseIndex(run)]?.kind : undefined;

    return (
        <MotionConfig reducedMotion="user">
            <div className="absolute inset-0 flex bg-background">
                <ChannelRail
                    channels={scopedChannels}
                    activeId={activeId}
                    agents={agents}
                    projects={projects}
                    picking={picking}
                    spaceBanner={
                        activeSpace != null ? (
                            <SpaceBanner
                                surface="channels"
                                text={spaceBannerText(activeSpace.objective, channelsHidden, channelsRevealed)}
                                revealed={channelsRevealed}
                            />
                        ) : null
                    }
                    onSelect={(id) => fireAndForget(() => selectChannel(id))}
                    onToggleNew={() => setPicking((p) => !p)}
                    onPickProject={pickProject}
                    onDeleteChannel={(id) => fireAndForget(() => deleteChannel(id))}
                    onSetTier={(id, t) =>
                        fireAndForget(() =>
                            setChannelTier(
                                id,
                                t,
                                ((channels?.find((c) => c.oid === id)?.meta as Record<string, unknown> | undefined)?.[
                                    "delegator:mode"
                                ] as string) ?? "report"
                            )
                        )
                    }
                    onRenameChannel={(id, name) => fireAndForget(() => renameChannel(id, name))}
                    onArchiveChannel={(id, archived) => fireAndForget(() => archiveChannel(id, archived))}
                />

                <div className="@container flex min-w-0 flex-1">
                    <div className="flex min-w-0 flex-1 flex-col">
                        <ChannelHeader channel={active} />

                        {active ? (
                            <>
                                <OverviewStrip
                                    open={overviewOpen}
                                    onToggle={() => setOverviewOpen((o) => !o)}
                                    runCount={runs.length}
                                    notes={notesDraft}
                                    onNotesChange={onNotesChange}
                                />

                                <RunStrip
                                    runs={runs}
                                    agents={agents}
                                    activeRunId={activeRunId}
                                    pendingDraft={!!pendingDraft}
                                    onGoToRun={goToRun}
                                    onDismiss={dismissTab}
                                    onNewRun={selectNewRun}
                                    hasSelectedRun={!!run}
                                />

                                {/* run body */}
                                {pendingDraft ? (
                                    <div className="sc min-h-0 flex-1 overflow-y-auto px-6 pb-3 pt-5">
                                        <div className={CHANNEL_COL}>
                                            <div className="mb-1 text-center text-[17px] font-bold text-primary">Start investigation</div>
                                            <div className="mb-5 text-center text-[13px] text-muted">Review the draft goal below, then start it.</div>
                                            <div className="rounded-[10px] border border-accent/30 bg-accentbg/15 px-3.5 py-3">
                                                <div className="mb-2 flex items-center gap-2">
                                                    <span className="font-mono text-[9px] font-semibold uppercase tracking-[.1em] text-accent-soft">From Radar finding</span>
                                                    <span className="flex-1" />
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            setPendingDraft(null);
                                                            setDraft("");
                                                        }}
                                                        className="rounded-sm border border-edge-mid px-2 py-0.5 font-mono text-[10px] text-muted hover:border-edge-strong hover:text-secondary"
                                                    >
                                                        Discard
                                                    </button>
                                                </div>
                                                {pendingDraft.files.length > 0 ? (
                                                    <div className="mb-1.5 flex flex-wrap gap-1.5">
                                                        {pendingDraft.files.map((f) => (
                                                            <span key={f} className="rounded-full border border-edge-mid px-2 py-0.5 font-mono text-[10.5px] text-muted">
                                                                {f}
                                                            </span>
                                                        ))}
                                                    </div>
                                                ) : null}
                                                {pendingDraft.evidenceRefs.length > 0 ? (
                                                    <div className="font-mono text-[10.5px] text-muted">
                                                        {pendingDraft.evidenceRefs.length} evidence signal{pendingDraft.evidenceRefs.length === 1 ? "" : "s"}
                                                    </div>
                                                ) : null}
                                            </div>
                                        </div>
                                    </div>
                                ) : run ? (
                                    <RunBody model={model} channel={active} agents={agents} run={run} />
                                ) : (
                                    <div className="sc min-h-0 flex-1 overflow-y-auto px-6 pb-3 pt-5">
                                        <div className={CHANNEL_COL + " flex flex-col items-center gap-3.5 pt-16 text-center"}>
                                            <div className="text-[20px] font-bold tracking-[-0.01em] text-primary">Start a run in #{active.name}</div>
                                            <p className="max-w-[460px] text-[13.5px] leading-[1.6] text-muted">
                                                Give Jarvis a goal below. <b className="text-secondary">@quick</b> spawns one worker,{" "}
                                                <b className="text-secondary">@run</b> kicks off the channel's full strategy — pipeline or adaptive lead, set in{" "}
                                                <b className="text-secondary">⚙</b> — and <b className="text-secondary">@ask</b> is a one-shot consult.
                                            </p>
                                        </div>
                                    </div>
                                )}

                                {/* composer (two faces) */}
                                <div className="flex-none px-6 pb-[18px] pt-2">
                                    <div className={CHANNEL_COL}>
                                        {face.face === "talk" ? (
                                            <TalkComposer
                                                worker={face.worker}
                                                phaseLabel={phaseLabel}
                                                value={draft}
                                                onChange={setDraft}
                                                onSubmit={send}
                                                onNewRun={selectNewRun}
                                                attach={attach}
                                            />
                                        ) : (
                                            <LaunchComposer
                                                value={launchValue}
                                                onChange={onLaunchChange}
                                                onSubmit={send}
                                                profile={profile}
                                                channelName={active.name ?? "channel"}
                                                pending={!!pendingDraft}
                                                attach={attach}
                                            />
                                        )}
                                    </div>
                                </div>
                            </>
                        ) : channelsError ? (
                            <div className="min-h-0 flex-1">
                                <SurfaceError message="Couldn’t load channels." onRetry={() => fireAndForget(loadChannels)} />
                            </div>
                        ) : channels == null ? (
                            <div className="min-h-0 flex-1 px-6 pt-16">
                                <div className="mx-auto flex w-full max-w-[520px] flex-col gap-2.5">
                                    {Array.from({ length: 5 }).map((_, i) => (
                                        <SkeletonLine key={i} className="h-[52px] rounded-[11px]" />
                                    ))}
                                </div>
                            </div>
                        ) : (
                            <div className="min-h-0 flex-1">
                                <SurfaceEmptyState
                                    title="No channel yet"
                                    body="Create a channel bound to a project to start dispatching runs."
                                    action={{ label: "＋ New channel", onClick: () => setPicking(true) }}
                                />
                            </div>
                        )}
                    </div>
                    <ContextPanel
                        model={model}
                        channel={activeForDerive}
                        agents={agents}
                        runs={runs}
                        consultStreams={consultStreams}
                        onSelectRun={goToRun}
                        onDispatchConsult={dispatchToRun}
                    />
                </div>
            </div>
        </MotionConfig>
    );
}
