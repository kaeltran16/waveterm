// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Channels surface: a conversational agent-dispatch surface, in the handoff's 2-pane chat layout.
// Left: the channel rail. Right: an avatar'd message stream + a card composer. Type a message;
// @<runtime> spawns a worker, @<name> steers a live one, `ask @<runtime>` runs a one-shot consult,
// plain text posts a note. Dispatched workers become roster rows, so a dispatch row shows a live
// status pill and an asking worker reuses AnswerBar — Cockpit still owns monitoring; this surface
// carries the dialogue and links out (↗).

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { AnswerBar } from "./answerbar";
import { toggleSelection, type AgentVM } from "./agentsviewmodel";
import { sendChannelMessage } from "./channelactions";
import { avatarColor } from "./channelderive";
import type { RosterEntry } from "./channelmessages";
import { ChannelRail } from "./channelrail";
import {
    activeChannelAtom,
    activeChannelIdAtom,
    channelsAtom,
    consultStreamsAtom,
    createChannel,
    loadChannels,
    selectChannel,
    type ConsultStream,
} from "./channelsstore";
import { projectsAtom } from "./projectsstore";

const STATE_DOT: Record<string, string> = {
    working: "var(--color-success)",
    asking: "var(--color-asking)",
    idle: "var(--color-muted)",
};

// resolve a dispatch/directive RefORef ("tab:<id>") to the live roster row, if still present
function workerFor(agents: AgentVM[], refORef: string): AgentVM | undefined {
    if (!refORef.startsWith("tab:")) {
        return undefined;
    }
    const id = refORef.slice(4);
    return agents.find((a) => a.id === id);
}

function jumpToAgent(model: AgentsViewModel, id: string) {
    globalStore.set(model.focusIdAtom, id);
    globalStore.set(model.terminalTargetAtom, undefined);
    globalStore.set(model.surfaceAtom, "agent");
}

function consultIdOf(refORef?: string): string | undefined {
    return refORef?.startsWith("consult:") ? refORef.slice("consult:".length) : undefined;
}

function jarvisReqIdOf(refORef?: string): string | undefined {
    return refORef?.startsWith("jarvis:") ? refORef.slice("jarvis:".length) : undefined;
}

function timeLabel(ts: number, now: number): string {
    return now - ts < 60_000 ? "now" : new Date(ts).toLocaleTimeString();
}

// 32px rounded avatar with the author's initial, colored deterministically by name.
function Avatar({ name }: { name: string }) {
    return (
        <div
            className="flex h-8 w-8 flex-none items-center justify-center rounded-[9px] font-mono text-[13px] font-bold text-background"
            style={{ backgroundColor: avatarColor(name) }}
        >
            {(name.charAt(0) || "?").toUpperCase()}
        </div>
    );
}

function Tag({ label, tone }: { label: string; tone: "muted" | "asking" }) {
    if (tone === "asking") {
        return (
            <span className="rounded-[4px] bg-asking px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-[.08em] text-background">
                {label}
            </span>
        );
    }
    return (
        <span className="rounded-[4px] border border-edge-mid bg-surface-raised px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-[.08em] text-ink-mid">
            {label}
        </span>
    );
}

// An asking worker's answer row, reusing the cockpit's AnswerBar + model answer state.
function AskRow({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const answerSel = useAtomValue(model.answerSelAtom);
    const setAnswerSel = useSetAtom(model.answerSelAtom);
    const sentIds = useAtomValue(model.sentIdsAtom);
    const toggle = (qi: number, oi: number) => {
        const multi = agent.ask?.questions?.[qi]?.multiSelect ?? false;
        setAnswerSel((prev) => ({ ...prev, [agent.id]: toggleSelection(prev[agent.id] ?? {}, qi, oi, multi) }));
    };
    return (
        <div className="rounded-[9px] border border-asking/40 bg-lane-asking p-3">
            <AnswerBar
                agent={agent}
                selections={answerSel[agent.id] ?? {}}
                sent={sentIds.has(agent.id)}
                numbered
                onToggle={toggle}
                onSubmit={() => model.submitAnswer(agent.id)}
            />
        </div>
    );
}

// A consult question with its replies grouped underneath by consultId. Each runtime shows either its
// persisted consult-reply (preferred) or, until that arrives, the live streaming text.
function ConsultRow({
    msg,
    allMessages,
    streams,
    now,
}: {
    msg: ChannelMessage;
    allMessages: ChannelMessage[];
    streams: Record<string, ConsultStream>;
    now: number;
}) {
    const consultId = consultIdOf(msg.reforef);
    const replies = consultId
        ? allMessages.filter((m) => m.kind === "consult-reply" && consultIdOf(m.reforef) === consultId)
        : [];
    const repliedRuntimes = new Set(replies.map((r) => r.author));
    const liveKeys = consultId
        ? Object.keys(streams).filter((k) => k.startsWith(`${consultId}:`) && !repliedRuntimes.has(k.split(":")[1]))
        : [];
    return (
        <div className="flex items-start gap-3">
            <Avatar name={msg.author} />
            <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-2">
                    <span className="font-mono text-[13px] font-semibold text-primary">{msg.author}</span>
                    <Tag label="ask" tone="muted" />
                    <span className="font-mono text-[10.5px] text-muted">{timeLabel(msg.ts, now)}</span>
                </div>
                <p className="mb-2.5 text-[14px] leading-[1.6] text-secondary">{msg.text || "(empty)"}</p>
                <div className="flex flex-col gap-2">
                    {replies.map((r) => (
                        <div key={r.id} className="rounded-[9px] border border-edge-mid bg-surface-raised px-3 py-2.5">
                            <div className="mb-1 font-mono text-[11px] font-semibold text-accent-soft">{r.author}</div>
                            <div className="whitespace-pre-wrap text-[13px] leading-[1.55] text-secondary">{r.text}</div>
                        </div>
                    ))}
                    {liveKeys.map((k) => {
                        const runtime = k.split(":")[1];
                        const s = streams[k];
                        return (
                            <div key={k} className="rounded-[9px] border border-accent/40 bg-accentbg/30 px-3 py-2.5">
                                <div className="mb-1 font-mono text-[11px] font-semibold text-accent-soft">
                                    {runtime} {s.status === "streaming" ? "· consulting…" : ""}
                                </div>
                                <div className="whitespace-pre-wrap text-[13px] leading-[1.55] text-secondary">
                                    {s.text || "…"}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

// A @jarvis query + its single grouped reply: the persisted jarvis-reply if present, else the live
// streaming text (keyed `${reqId}:jarvis` in the shared consultStreamsAtom).
function JarvisRow({
    msg,
    allMessages,
    streams,
    now,
}: {
    msg: ChannelMessage;
    allMessages: ChannelMessage[];
    streams: Record<string, ConsultStream>;
    now: number;
}) {
    const reqId = jarvisReqIdOf(msg.reforef);
    const reply = reqId
        ? allMessages.find((m) => m.kind === "jarvis-reply" && jarvisReqIdOf(m.reforef) === reqId)
        : undefined;
    const live = reqId && !reply ? streams[`${reqId}:jarvis`] : undefined;
    return (
        <div className="flex items-start gap-3">
            <Avatar name={msg.author} />
            <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-2">
                    <span className="font-mono text-[13px] font-semibold text-primary">{msg.author}</span>
                    <Tag label="jarvis" tone="muted" />
                    <span className="font-mono text-[10.5px] text-muted">{timeLabel(msg.ts, now)}</span>
                </div>
                <p className="mb-2.5 text-[14px] leading-[1.6] text-secondary">{msg.text || "(empty)"}</p>
                {reply ? (
                    <div className="rounded-[9px] border border-edge-mid bg-surface-raised px-3 py-2.5">
                        <div className="mb-1 font-mono text-[11px] font-semibold text-accent-soft">jarvis</div>
                        <div className="whitespace-pre-wrap text-[13px] leading-[1.55] text-secondary">{reply.text}</div>
                    </div>
                ) : (
                    <div className="rounded-[9px] border border-accent/40 bg-accentbg/30 px-3 py-2.5">
                        <div className="mb-1 font-mono text-[11px] font-semibold text-accent-soft">
                            jarvis {!live || live.status === "streaming" ? "· thinking…" : ""}
                        </div>
                        <div className="whitespace-pre-wrap text-[13px] leading-[1.55] text-secondary">
                            {live?.text || "…"}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

// A dispatch / directive / human message row: avatar + author + optional tag + body, plus (for a
// dispatch) the live worker status pill, open link, and — when asking — the inline AnswerBar.
function MessageRow({
    model,
    agents,
    msg,
    now,
}: {
    model: AgentsViewModel;
    agents: AgentVM[];
    msg: ChannelMessage;
    now: number;
}) {
    const worker = msg.reforef ? workerFor(agents, msg.reforef) : undefined;
    const isDispatch = msg.kind === "dispatch";
    return (
        <div className="flex items-start gap-3">
            <Avatar name={msg.author} />
            <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-2">
                    <span className="font-mono text-[13px] font-semibold text-primary">{msg.author}</span>
                    {isDispatch ? <Tag label="dispatch" tone="muted" /> : null}
                    {isDispatch && worker?.state === "asking" ? <Tag label="asking" tone="asking" /> : null}
                    <span className="font-mono text-[10.5px] text-muted">{timeLabel(msg.ts, now)}</span>
                </div>
                <p className="text-[14px] leading-[1.6] text-secondary">{msg.text || "(empty)"}</p>
                {isDispatch && worker ? (
                    <div className="mt-2 flex items-center gap-2.5">
                        <span
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: STATE_DOT[worker.state] ?? "var(--color-muted)" }}
                        />
                        <span className="font-mono text-[10.5px] text-muted">{worker.state}</span>
                        <button
                            type="button"
                            onClick={() => jumpToAgent(model, worker.id)}
                            className="cursor-pointer font-mono text-[10.5px] text-accent-soft hover:text-accent"
                        >
                            open ↗
                        </button>
                    </div>
                ) : null}
                {isDispatch && worker && worker.state === "asking" ? (
                    <div className="mt-2">
                        <AskRow model={model} agent={worker} />
                    </div>
                ) : null}
            </div>
        </div>
    );
}

export function ChannelsSurface({ model }: { model: AgentsViewModel }) {
    const channels = useAtomValue(channelsAtom);
    const activeId = useAtomValue(activeChannelIdAtom);
    const active = useAtomValue(activeChannelAtom);
    const agents = useAtomValue(model.agentsAtom);
    const now = useAtomValue(model.nowAtom);
    const projects = useAtomValue(projectsAtom); // Record<string, { path?: string }>
    const consultStreams = useAtomValue(consultStreamsAtom);
    const [draft, setDraft] = useState("");
    const [picking, setPicking] = useState(false);
    const [installedRuntimes, setInstalledRuntimes] = useState<string[]>([]);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        fireAndForget(loadChannels);
    }, []);
    useEffect(() => {
        fireAndForget(async () => {
            const rtn = await RpcApi.ListConsultRuntimesCommand(TabRpcClient);
            setInstalledRuntimes((rtn.runtimes ?? []).filter((r) => r.installed).map((r) => r.runtime));
        });
    }, []);

    const roster: RosterEntry[] = agents.map((a) => ({ id: a.id, name: a.name, blockId: a.blockId }));
    const messages = active?.messages ?? [];
    const askHint = installedRuntimes.length > 0 ? ` · ask @${installedRuntimes.join(" / @")} for a one-shot review` : "";

    const send = () => {
        const text = draft.trim();
        if (!text || !activeId) {
            return;
        }
        setDraft("");
        fireAndForget(() =>
            sendChannelMessage({
                model,
                channelId: activeId,
                projectPath: active?.projectpath ?? "",
                projectName: active?.name ?? "agent",
                roster,
                agents,
                text,
            })
        );
    };

    const insertMention = () => {
        setDraft((d) => (d.length > 0 && !d.endsWith(" ") ? d + " @" : d + "@"));
        textareaRef.current?.focus();
    };

    // A channel is bound to a project at creation, so every dispatch has a valid cwd (no unbound state).
    const pickProject = (name: string, path: string) => {
        setPicking(false);
        fireAndForget(async () => {
            await createChannel(name, path);
        });
    };

    return (
        <div className="absolute inset-0 flex">
            <ChannelRail
                channels={channels}
                activeId={activeId}
                agents={agents}
                projects={projects}
                picking={picking}
                onSelect={(id) => fireAndForget(() => selectChannel(id))}
                onToggleNew={() => setPicking((p) => !p)}
                onPickProject={pickProject}
            />

            <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex flex-none items-center gap-2.5 border-b border-border bg-background px-[22px] py-3.5">
                    <span className="font-mono text-[17px] font-bold text-muted">#</span>
                    <div className="min-w-0">
                        <div className="truncate text-[15px] font-bold tracking-[-0.01em] text-primary">
                            {active?.name ?? "no channel"}
                        </div>
                        {active?.projectpath ? (
                            <div className="truncate font-mono text-[11.5px] text-muted">{active.projectpath}</div>
                        ) : null}
                    </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-3 pt-[22px]">
                    <div className="flex max-w-[760px] flex-col gap-5">
                        {channels == null ? (
                            <div className="mt-10 text-center text-[13px] text-muted">Loading…</div>
                        ) : !activeId ? (
                            <div className="mt-10 text-center text-[13px] text-muted">
                                No channel yet — click <span className="text-secondary">+ New channel</span> to create
                                one bound to a project.
                            </div>
                        ) : messages.length === 0 ? (
                            <div className="mt-10 text-center text-[13px] text-muted">
                                Empty channel. Try <span className="font-mono text-secondary">@claude do something</span>.
                            </div>
                        ) : (
                            messages
                                .filter((m) => m.kind !== "consult-reply" && m.kind !== "jarvis-reply")
                                .map((m) =>
                                    m.kind === "consult" ? (
                                        <ConsultRow
                                            key={m.id}
                                            msg={m}
                                            allMessages={messages}
                                            streams={consultStreams}
                                            now={now}
                                        />
                                    ) : m.kind === "jarvis" ? (
                                        <JarvisRow
                                            key={m.id}
                                            msg={m}
                                            allMessages={messages}
                                            streams={consultStreams}
                                            now={now}
                                        />
                                    ) : (
                                        <MessageRow key={m.id} model={model} agents={agents} msg={m} now={now} />
                                    )
                                )
                        )}
                    </div>
                </div>

                <div className="flex-none px-6 pb-[18px] pt-2">
                    <div className="max-w-[760px] rounded-[12px] border border-edge-mid bg-surface-raised px-[15px] py-3">
                        <textarea
                            ref={textareaRef}
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) {
                                    e.preventDefault();
                                    send();
                                }
                            }}
                            rows={1}
                            placeholder={`Message #${active?.name ?? "channel"}…${askHint} · @jarvis to summarize`}
                            disabled={!activeId}
                            className="min-h-[22px] w-full resize-none bg-transparent text-[14px] text-primary placeholder:text-muted focus:outline-none disabled:opacity-50"
                        />
                        <div className="mt-2.5 flex items-center gap-2.5">
                            <button
                                type="button"
                                onClick={insertMention}
                                disabled={!activeId}
                                className="cursor-pointer rounded-[7px] border border-edge-mid px-2.5 py-1 font-mono text-[11.5px] text-ink-mid hover:border-edge-strong disabled:opacity-50"
                            >
                                @ mention agent
                            </button>
                            <div className="flex-1" />
                            <button
                                type="button"
                                onClick={send}
                                disabled={!activeId}
                                className="shrink-0 cursor-pointer rounded-[8px] bg-accent px-[15px] py-1.5 text-[12.5px] font-semibold text-background hover:bg-accenthover disabled:opacity-50"
                            >
                                Send ⏎
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
