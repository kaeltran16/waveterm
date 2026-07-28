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
import { type RosterEntry } from "@/app/view/agents/channelmessages";
import { LAUNCH_COMMANDS, composerFace, parseComposerCommand } from "@/app/view/agents/composercommand";
import { appendAttachments, useComposerAttachments } from "@/app/view/agents/composerattachments";
import { createRun, pendingRunDraftAtom } from "@/app/view/agents/runactions";
import { currentPhaseIndex } from "@/app/view/agents/runmodel";
import { cn, fireAndForget } from "@/util/util";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useState } from "react";
import { resolveComposerTarget } from "./composertarget";
import { activeConversationIdAtom, jarvisDraftAtom, submitJarvisQuery } from "./jarvisstore";
import { askAboutRecord, setActiveRunId } from "./jarvissubjectstore";
import type { StageComposition } from "./stagecompose";

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
// off a channel there is no run strategy footer to state.
function JarvisAsk({
    draft,
    onChange,
    onSubmit,
    placeholder,
}: {
    draft: string;
    onChange: (next: string) => void;
    onSubmit: () => void;
    placeholder: string;
}) {
    return (
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
    );
}

export function StageComposer({
    model,
    comp,
    channel,
    channels,
    agents,
    run,
    recordId,
    recordObjective,
    profile,
}: {
    model: AgentsViewModel;
    comp: StageComposition;
    channel: Channel | null;
    channels: Channel[];
    agents: AgentVM[];
    run: Run | undefined;
    recordId: string | null;
    recordObjective: string;
    profile: JarvisProfile | undefined;
}) {
    const [draft, setDraft] = useAtom(jarvisDraftAtom);
    const [channelDraft, setChannelDraft] = useState("");
    const [picking, setPicking] = useState(false);
    const activeConvId = useAtomValue(activeConversationIdAtom);
    const radarDraft = useAtomValue(pendingRunDraftAtom);
    const setRadarDraft = useSetAtom(pendingRunDraftAtom);
    const attach = useComposerAttachments();

    const onChannel = comp.composerTarget === "worker-or-jarvis";
    // a pending Radar draft forces the Launch face and owns the field: it is an investigation awaiting
    // review, so nothing dispatches until the user presses Start.
    const value = onChannel ? (radarDraft != null ? radarDraft.goal : channelDraft) : draft;
    const face = onChannel && channel != null && radarDraft == null ? composerFace(run, agents) : { face: "launch" as const };
    const target = resolveComposerTarget({
        composerTarget: comp.composerTarget,
        draft: value,
        workerName: face.face === "talk" ? face.worker.name : undefined,
        runLabel: run != null ? `run ${run.id.slice(0, 4)}` : undefined,
    });

    const roster: RosterEntry[] = agents.map((a) => ({ id: a.id, name: a.name, blockId: a.blockId }));
    const phaseLabel = run ? run.phases?.[currentPhaseIndex(run)]?.kind : undefined;

    // every @run / dispatch shares the channel profile's mode + plan gate, exactly as the Channels
    // launch composer did — the strategy is the channel's setting, never chosen per dispatch.
    const launchInto = (channelId: string, goal: string, mode?: string) =>
        fireAndForget(async () => {
            const created = await createRun(channelId, goal, {
                mode: mode ?? profile?.defaultmode,
                planGate: profile?.defaultplangate,
            });
            setActiveRunId(channelId, created.id);
        });

    const sendOnChannel = () => {
        if (channel == null || attach.uploading) {
            return;
        }
        // the Radar path keeps radarOrigin on the created run — that origin is what lets the finding's
        // outcome be written back when the run finishes.
        if (radarDraft != null) {
            const goal = appendAttachments(radarDraft.goal.trim(), attach.attachments);
            if (!goal) {
                return;
            }
            attach.clear();
            setRadarDraft(null);
            fireAndForget(async () => {
                const created = await createRun(channel.oid, goal, {
                    mode: profile?.defaultmode,
                    planGate: profile?.defaultplangate,
                    radarOrigin: radarDraft.radarOrigin,
                });
                setActiveRunId(channel.oid, created.id);
            });
            return;
        }
        if (face.face === "talk") {
            const text = appendAttachments(channelDraft.trim(), attach.attachments);
            if (!text.trim()) {
                return;
            }
            setChannelDraft("");
            attach.clear();
            fireAndForget(() =>
                steerWorker({ channelId: channel.oid, workerORef: `tab:${face.worker.id}`, agents, text })
            );
            return;
        }
        const text = appendAttachments(channelDraft.trim(), attach.attachments);
        if (!text.trim()) {
            return;
        }
        setChannelDraft("");
        attach.clear();
        const cmd = parseComposerCommand(text);
        if (cmd.mode === "run") {
            launchInto(channel.oid, cmd.body);
            return;
        }
        if (cmd.mode === "quick") {
            launchInto(channel.oid, cmd.body, "quick");
            return;
        }
        // @ask -> one-shot consult (no worker), via sendChannelMessage's ask transport.
        fireAndForget(() =>
            sendChannelMessage({
                model,
                channelId: channel.oid,
                projectPath: channel.projectpath ?? "",
                projectName: channel.name ?? "agent",
                roster,
                text: `ask @${cmd.runtime ?? "claude"} ${cmd.body}`,
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
        if (comp.composerTarget === "jarvis-record" && recordId != null) {
            askAboutRecord(recordId, recordObjective, text);
            return;
        }
        if (activeConvId != null) {
            submitJarvisQuery(activeConvId, text);
        }
    };

    const dispatchFromPicker = (channelId: string) => {
        const cmd = parseComposerCommand(draft.trim());
        setPicking(false);
        setDraft("");
        launchInto(channelId, cmd.body, cmd.mode === "quick" ? "quick" : undefined);
    };

    return (
        <div className="flex-none border-t border-border bg-background px-5 pb-4 pt-2.5">
            <TalkingTo label={target.label} audience={target.audience} />
            {picking ? (
                <ChannelPicker channels={channels} onPick={dispatchFromPicker} onCancel={() => setPicking(false)} />
            ) : null}
            {onChannel && channel != null ? (
                face.face === "talk" ? (
                    <TalkComposer
                        worker={face.worker}
                        phaseLabel={phaseLabel}
                        value={channelDraft}
                        onChange={setChannelDraft}
                        onSubmit={sendOnChannel}
                        onNewRun={() => setActiveRunId(channel.oid, undefined)}
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
                                    Review the goal, then start it — nothing dispatches until you do.
                                </span>
                                <button
                                    type="button"
                                    onClick={() => setRadarDraft(null)}
                                    className="cursor-pointer font-mono text-[10px] text-muted hover:text-secondary"
                                >
                                    Discard
                                </button>
                            </div>
                        ) : null}
                        <LaunchComposer
                            value={value}
                            onChange={
                                radarDraft != null
                                    ? (next) => setRadarDraft({ ...radarDraft, goal: next })
                                    : setChannelDraft
                            }
                            onSubmit={sendOnChannel}
                            profile={profile}
                            channelName={channel.name ?? "channel"}
                            pending={radarDraft != null}
                            attach={attach}
                        />
                    </>
                )
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
                />
            )}
        </div>
    );
}
