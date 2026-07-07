// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Channels surface: a conversational agent-dispatch surface, in the handoff's 2-pane chat layout.
// Left: the channel rail. Right: an avatar'd message stream + a card composer. Type a message;
// @<runtime> spawns a worker, @<name> steers a live one, `ask @<runtime>` runs a one-shot consult,
// plain text posts a note. Dispatched workers become roster rows, so a dispatch row shows a live
// status pill and an asking worker reuses AnswerBar — Cockpit still owns monitoring; this surface
// carries the dialogue and links out (↗).

import { CollapsibleRail, type RailExtraIcon, type RailSection } from "@/app/element/collapsiblerail";
import { cardVariants } from "@/app/element/motiontokens";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue, useSetAtom } from "jotai";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AgentsViewModel } from "./agents";
import { type AgentVM } from "./agentsviewmodel";
import { sendChannelMessage, steerWorker } from "./channelactions";
import {
    activeMentionQuery,
    highlightSegments,
    mentionCandidates,
    type MentionCandidate,
} from "./channelderive";
import { AskRow, Avatar, jumpToAgent, STATE_DOT, Tag, timeLabel, WorkerRow, workerFor } from "./channelsprimitives";
import {
    describePlan,
    planMessage,
    tierFromMeta,
    type DispatchMode,
    type PlanChip,
    type RosterEntry,
} from "./channelmessages";
import { ChannelRail } from "./channelrail";
import { computeEntrances, initialEntranceState } from "./channelsmotion";
import {
    activeChannelAtom,
    activeChannelIdAtom,
    channelsAtom,
    consultStreamsAtom,
    createChannel,
    deleteChannel,
    loadChannels,
    selectChannel,
    type ConsultStream,
} from "./channelsstore";
import { autonomyExplainer, escalationPending, fleetCounts, parseCardData } from "./jarviscards";
import { buildFleetSnapshot } from "./jarvisderive";
import { MarkdownMessage } from "./markdownmessage";
import { projectsAtom } from "./projectsstore";
import { RAIL_ICON } from "./railicons";
import { channelRailOpenAtom } from "./railstore";
import { profileRailOpenAtom } from "./profilepanel";
import { getJarvisProfile, setChannelProfile } from "./runactions";
import { defaultView } from "./runmodel";
import { RunsView } from "./runssurface";

function consultIdOf(refORef?: string): string | undefined {
    return refORef?.startsWith("consult:") ? refORef.slice("consult:".length) : undefined;
}

function jarvisReqIdOf(refORef?: string): string | undefined {
    return refORef?.startsWith("jarvis:") ? refORef.slice("jarvis:".length) : undefined;
}

// one-shot completion settle (moment 4): plays @keyframes settle once when a streaming reply resolves
// (streaming -> done). Mirrors agentrow.tsx's justFinished pattern (520ms matches settle's .5s).
function useSettle(done: boolean): boolean {
    const [settling, setSettling] = useState(false);
    const prevDone = useRef(done);
    useEffect(() => {
        if (done && !prevDone.current) {
            setSettling(true);
            const t = setTimeout(() => setSettling(false), 520);
            prevDone.current = done;
            return () => clearTimeout(t);
        }
        prevDone.current = done;
    }, [done]);
    return settling;
}

// A radio-style option list used by the escalation card (deliver an answer) and Override (steer). When
// `chosen` is set, that option is marked; clicking any option calls onPick with its index.
function OptionList({
    options,
    chosen,
    onPick,
    disabled,
}: {
    options: { label: string; sub?: string }[];
    chosen?: number;
    onPick: (idx: number) => void;
    disabled?: boolean;
}) {
    return (
        <div className="flex flex-col gap-2">
            {options.map((o, i) => (
                <button
                    key={i}
                    type="button"
                    disabled={disabled}
                    onClick={() => onPick(i)}
                    className="flex items-start gap-2.5 rounded-[10px] border border-edge-mid bg-surface-raised px-3 py-2.5 text-left hover:border-edge-strong disabled:opacity-50"
                >
                    <span
                        className={
                            "mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full border " +
                            (i === chosen ? "border-accent" : "border-edge-strong")
                        }
                    >
                        {i === chosen ? <span className="h-1.5 w-1.5 rounded-full bg-accent" /> : null}
                    </span>
                    <span className="min-w-0">
                        <span className="block text-[13px] font-semibold text-primary">{o.label}</span>
                        {o.sub ? <span className="mt-0.5 block text-[11.5px] text-muted">{o.sub}</span> : null}
                    </span>
                </button>
            ))}
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
    // the consult is "done" once every live stream has resolved into a persisted reply
    const settling = useSettle(liveKeys.length === 0 && replies.length > 0);
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
                <div
                    className={cn(
                        "flex flex-col gap-2",
                        settling && "animate-[settle_0.5s_ease-out] motion-reduce:animate-none"
                    )}
                >
                    {replies.map((r) => (
                        <div key={r.id} className="rounded-[9px] border border-edge-mid bg-surface-raised px-3 py-2.5">
                            <div className="mb-1 font-mono text-[11px] font-semibold text-accent-soft">{r.author}</div>
                            <div className="whitespace-pre-wrap text-[13px] leading-[1.55] text-secondary">
                                {r.text}
                            </div>
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
    const settling = useSettle(!!reply);
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
                    <div
                        className={cn(
                            "rounded-[9px] border border-edge-mid bg-surface-raised px-3 py-2.5",
                            settling && "animate-[settle_0.5s_ease-out] motion-reduce:animate-none"
                        )}
                    >
                        <div className="mb-1 font-mono text-[11px] font-semibold text-accent-soft">jarvis</div>
                        <MarkdownMessage text={reply.text} className="text-[13px] leading-[1.55] text-secondary" />
                    </div>
                ) : (
                    <div className="rounded-[9px] border border-accent/40 bg-accentbg/30 px-3 py-2.5">
                        <div className="mb-1 font-mono text-[11px] font-semibold text-accent-soft">
                            jarvis {!live || live.status === "streaming" ? "· thinking…" : ""}
                        </div>
                        <MarkdownMessage
                            text={live?.text || "…"}
                            className="text-[13px] leading-[1.55] text-secondary"
                        />
                    </div>
                )}
            </div>
        </div>
    );
}

// The Gatekeeper "answered for you" card: shows the worker's question, the option Jarvis chose, and its
// reasoning, with an Override that reveals the options so you can steer the worker to a different one.
// Legacy messages (no structured data) fall back to the flat muted text card.
function GatekeeperRow({
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
    const card = parseCardData(msg);
    const [overriding, setOverriding] = useState(false);
    const [steered, setSteered] = useState<number | null>(null);
    const worker = card ? workerFor(agents, card.workerORef) : undefined;
    const workerName = worker?.name ?? "worker";
    // the override is persisted to the message (card.humanPick) so the "steered → X" footer survives a
    // surface remount; `steered` is only the optimistic local echo before the write round-trips.
    const steeredIdx = steered != null ? steered : (card?.humanPick ?? null);
    const doOverride = (idx: number) => {
        if (!card) {
            return;
        }
        setSteered(idx);
        setOverriding(false);
        const channelId = globalStore.get(activeChannelIdAtom);
        fireAndForget(async () => {
            await steerWorker({
                channelId: msg.reforef ? msg.reforef : (channelId ?? ""),
                workerORef: card.workerORef,
                agents,
                text: `reconsider — use ${card.options[idx]?.label}`,
            });
            if (channelId) {
                await RpcApi.SetChannelMessagePickCommand(TabRpcClient, {
                    channelid: channelId,
                    messageid: msg.id,
                    pick: idx,
                });
            }
        });
    };
    return (
        <div className="flex items-start gap-3">
            <Avatar name="jarvis" />
            <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-2">
                    <span className="font-mono text-[13px] font-semibold text-primary">jarvis</span>
                    <Tag label="answered" tone="muted" />
                    <span className="font-mono text-[10.5px] text-muted">{timeLabel(msg.ts, now)}</span>
                </div>
                <div className="rounded-[9px] border border-edge-mid bg-surface-raised px-3.5 py-3">
                    {card && card.choice != null ? (
                        <>
                            <div className="mb-2.5 rounded-[8px] border border-edge-faint bg-background/40 px-3 py-2">
                                <div className="mb-0.5 font-mono text-[11px] font-semibold text-ink-mid">
                                    {workerName} asked
                                </div>
                                <div className="text-[13px] text-secondary">{card.question}</div>
                            </div>
                            <div className="mb-1 flex items-baseline gap-2">
                                <span className="text-[12px] text-muted">Jarvis chose</span>
                                <span className="text-[14px] font-semibold text-primary">
                                    {card.options[card.choice]?.label}
                                </span>
                            </div>
                            {card.reason ? (
                                <p className="text-[13px] leading-[1.55] text-secondary">{card.reason}</p>
                            ) : null}
                            <div className="mt-3 flex items-center gap-2.5 border-t border-edge-faint pt-2.5">
                                <span className="h-1.5 w-1.5 rounded-full bg-success" />
                                <span className="flex-1 text-[11.5px] text-muted">
                                    {steeredIdx != null
                                        ? `steered ${workerName} → ${card.options[steeredIdx]?.label}`
                                        : `${workerName} resumed on its own`}
                                </span>
                                {steeredIdx == null && worker ? (
                                    <button
                                        type="button"
                                        onClick={() => setOverriding((v) => !v)}
                                        className="cursor-pointer rounded-[6px] border border-edge-mid px-2.5 py-1 font-mono text-[11px] text-ink-mid hover:border-edge-strong"
                                    >
                                        Override
                                    </button>
                                ) : null}
                            </div>
                            {overriding ? (
                                <div className="mt-2.5">
                                    <div className="mb-1.5 text-[11px] text-muted">Steer {workerName} to:</div>
                                    <OptionList options={card.options} chosen={card.choice} onPick={doOverride} />
                                </div>
                            ) : null}
                        </>
                    ) : (
                        <div className="whitespace-pre-wrap text-[13px] leading-[1.55] text-secondary">{msg.text}</div>
                    )}
                </div>
            </div>
        </div>
    );
}

// The escalation card: an amber attention card whose options are clickable. Selecting one delivers the
// answer to the still-blocked worker via AnswerAgentCommand (the same path AnswerBar uses), then shows a
// resolved footer. Falls back to the flat text for legacy messages with no structured data.
function EscalationRow({ msg, agents, now }: { msg: ChannelMessage; agents: AgentVM[]; now: number }) {
    const card = parseCardData(msg);
    const [picked, setPicked] = useState<number | null>(null);
    const worker = card ? workerFor(agents, card.workerORef) : undefined;
    const workerName = worker?.name ?? "worker";
    // resolution is derived from live worker state (not local `picked`), so an answered escalation stays
    // resolved after the surface unmounts on a tab switch. The chosen option is persisted to the message
    // (card.humanPick) so "You chose X" also survives the remount; `picked` is just optimistic feedback.
    const pending = card ? escalationPending(card, worker) : false;
    const chosen = picked != null ? picked : (card?.humanPick ?? null);
    const deliver = (idx: number) => {
        if (!card) {
            return;
        }
        setPicked(idx);
        const channelId = globalStore.get(activeChannelIdAtom);
        fireAndForget(async () => {
            await RpcApi.AnswerAgentCommand(TabRpcClient, {
                oref: card.askORef,
                answers: [{ selectedindexes: [idx] }],
            });
            if (channelId) {
                await RpcApi.SetChannelMessagePickCommand(TabRpcClient, {
                    channelid: channelId,
                    messageid: msg.id,
                    pick: idx,
                });
            }
        });
    };
    return (
        <div className="flex items-start gap-3">
            <Avatar name="jarvis" />
            <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-2">
                    <span className="font-mono text-[13px] font-semibold text-primary">jarvis</span>
                    <Tag label="escalation" tone="asking" />
                    <span className="font-mono text-[10.5px] text-muted">{timeLabel(msg.ts, now)}</span>
                </div>
                <div
                    className={cn(
                        "rounded-[9px] border border-asking/40 bg-lane-asking px-3.5 py-3",
                        pending &&
                            chosen == null &&
                            "animate-[breatheGlow_2.4s_ease-in-out_infinite] motion-reduce:animate-none"
                    )}
                >
                    {card ? (
                        <>
                            {card.reason ? (
                                <p className="mb-2 text-[12.5px] leading-[1.55] text-ink-mid">
                                    <span className="text-muted">Why I'm not deciding this: </span>
                                    {card.reason}
                                </p>
                            ) : null}
                            <p className="mb-3 text-[14px] font-semibold leading-[1.5] text-primary">{card.question}</p>
                            {pending && chosen == null ? (
                                <OptionList options={card.options} onPick={deliver} />
                            ) : chosen != null ? (
                                <div className="flex items-center gap-2 text-[12px] text-secondary">
                                    <span className="h-1.5 w-1.5 rounded-full bg-success" />
                                    You chose <b className="text-primary">{card.options[chosen]?.label}</b> — sent to{" "}
                                    {workerName}, resuming.
                                </div>
                            ) : (
                                <div className="flex items-center gap-2 text-[12px] text-secondary">
                                    <span className="h-1.5 w-1.5 rounded-full bg-success" />
                                    {worker ? `Answered — ${workerName} resumed.` : `${workerName} has exited.`}
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="whitespace-pre-wrap text-[13px] leading-[1.55] text-secondary">{msg.text}</div>
                    )}
                </div>
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

// The message composer: a plain-text draft with a scroll-synced backdrop that highlights @mentions and a
// caret-aware suggestion dropdown. Highlight + suggestions are driven by the pure channelderive helpers;
// the draft itself stays plain text, so sendChannelMessage/planMessage are unchanged.
// Always-visible legend of the channel commands, so dispatch/consult/jarvis/steer are discoverable
// (mirrors planMessage's routing). Static/informational — complements the live pre-send PlanChip.
function CommandHint() {
    const items: { cmd: string; label: string }[] = [
        { cmd: "@agent", label: "dispatch" },
        { cmd: "ask @agent", label: "consult" },
        { cmd: "@jarvis", label: "summarize" },
        { cmd: "@name", label: "steer" },
    ];
    return (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 px-1 font-mono text-[10.5px] text-muted">
            {items.map((it) => (
                <span key={it.cmd} className="whitespace-nowrap">
                    <span className="text-accent-soft">{it.cmd}</span> {it.label}
                </span>
            ))}
        </div>
    );
}

function Composer({
    value,
    onChange,
    onSend,
    chip,
    disabled,
    placeholder,
    candidates,
}: {
    value: string;
    onChange: (next: string) => void;
    onSend: () => void;
    chip?: PlanChip | null;
    disabled: boolean;
    placeholder: string;
    candidates: MentionCandidate[];
}) {
    const taRef = useRef<HTMLTextAreaElement>(null);
    const pendingCaret = useRef<number | null>(null);
    const [sugg, setSugg] = useState<{ query: string; start: number } | null>(null);
    const [sel, setSel] = useState(0);

    const known = new Set(candidates.map((c) => c.name.toLowerCase()));
    const runtimes = new Set(candidates.filter((c) => c.kind === "runtime").map((c) => c.name.toLowerCase()));
    const segments = highlightSegments(value, known, runtimes);
    const q = sugg?.query.toLowerCase() ?? "";
    const matches = sugg ? candidates.filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, 6) : [];
    const open = matches.length > 0;

    // reset the highlighted row whenever the active query changes
    useEffect(() => setSel(0), [sugg?.query, sugg?.start]);

    // apply a caret position requested by accept()/insertAt() after the controlled value has committed
    useLayoutEffect(() => {
        if (pendingCaret.current != null && taRef.current) {
            const p = pendingCaret.current;
            pendingCaret.current = null;
            taRef.current.setSelectionRange(p, p);
        }
    }, [value]);

    const syncSuggest = () => {
        const ta = taRef.current;
        if (ta) {
            setSugg(activeMentionQuery(ta.value, ta.selectionStart ?? ta.value.length));
        }
    };

    const accept = (cand: MentionCandidate) => {
        const ta = taRef.current;
        if (!ta || !sugg) {
            return;
        }
        const caret = ta.selectionStart ?? value.length;
        const before = value.slice(0, sugg.start);
        const insert = `@${cand.name} `;
        pendingCaret.current = before.length + insert.length;
        setSugg(null);
        onChange(before + insert + value.slice(caret));
    };

    const insertAt = () => {
        const ta = taRef.current;
        const caret = ta?.selectionStart ?? value.length;
        pendingCaret.current = caret + 1;
        setSugg({ query: "", start: caret });
        onChange(value.slice(0, caret) + "@" + value.slice(caret));
        ta?.focus();
    };

    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (open) {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => (s + 1) % matches.length);
                return;
            }
            if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => (s - 1 + matches.length) % matches.length);
                return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                accept(matches[Math.min(sel, matches.length - 1)]);
                return;
            }
            if (e.key === "Escape") {
                e.preventDefault();
                setSugg(null);
                return;
            }
        }
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
        }
    };

    return (
        <div className="flex-none px-6 pb-[18px] pt-2">
            <div className="relative">
                {open ? (
                    <div className="absolute bottom-full left-0 mb-1.5 w-[240px] overflow-hidden rounded-[9px] border border-edge-strong bg-surface-raised shadow-lg">
                        {matches.map((c, i) => (
                            <button
                                key={c.name}
                                type="button"
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    accept(c);
                                }}
                                onMouseEnter={() => setSel(i)}
                                className={`flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left ${
                                    i === sel ? "bg-accentbg" : ""
                                }`}
                            >
                                <span className="font-mono text-[12.5px] text-primary">@{c.name}</span>
                                <span className="ml-auto font-mono text-[9px] uppercase tracking-[.06em] text-muted">
                                    {c.kind}
                                </span>
                            </button>
                        ))}
                    </div>
                ) : null}
                <div className="rounded-[12px] border border-edge-mid bg-surface-raised px-[15px] py-3">
                    <div className="relative">
                        <div
                            aria-hidden
                            className="pointer-events-none min-h-[22px] whitespace-pre-wrap break-words text-[14px] leading-[1.5] text-primary"
                        >
                            {segments.map((s, i) =>
                                s.kind === "mention" ? (
                                    <span key={i} className="rounded-[3px] bg-accentbg text-accent-soft">
                                        {s.text}
                                    </span>
                                ) : s.kind === "command" ? (
                                    <span key={i} className="font-semibold text-accent">
                                        {s.text}
                                    </span>
                                ) : (
                                    <span key={i}>{s.text}</span>
                                )
                            )}
                            {"​"}
                        </div>
                        <textarea
                            ref={taRef}
                            value={value}
                            onChange={(e) => {
                                onChange(e.target.value);
                                syncSuggest();
                            }}
                            onKeyDown={onKeyDown}
                            onKeyUp={syncSuggest}
                            onClick={syncSuggest}
                            onBlur={() => setSugg(null)}
                            rows={1}
                            placeholder={placeholder}
                            disabled={disabled}
                            className="absolute inset-0 h-full w-full resize-none overflow-hidden whitespace-pre-wrap break-words bg-transparent text-[14px] leading-[1.5] text-transparent placeholder:text-muted focus:outline-none disabled:opacity-50"
                            style={{ caretColor: "var(--color-primary)" }}
                        />
                    </div>
                    <div className="mt-2.5 flex items-center gap-2.5">
                        <button
                            type="button"
                            onMouseDown={(e) => {
                                e.preventDefault();
                                insertAt();
                            }}
                            disabled={disabled}
                            className="cursor-pointer rounded-[7px] border border-edge-mid px-2.5 py-1 font-mono text-[11.5px] text-ink-mid hover:border-edge-strong disabled:opacity-50"
                        >
                            @ mention agent
                        </button>
                        <div className="flex-1" />
                        {chip ? (
                            <span
                                className={cn(
                                    "shrink-0 truncate font-mono text-[11px]",
                                    chip.tone === "warn" ? "text-asking" : "text-muted"
                                )}
                            >
                                {chip.label}
                            </span>
                        ) : null}
                        <button
                            type="button"
                            onClick={onSend}
                            disabled={disabled}
                            className="shrink-0 cursor-pointer rounded-[8px] bg-accent px-[15px] py-1.5 text-[12.5px] font-semibold text-background hover:bg-accenthover disabled:opacity-50"
                        >
                            Send ⏎
                        </button>
                    </div>
                </div>
            </div>
            <CommandHint />
        </div>
    );
}

// The right context panel: a Jarvis "fleet manager" header, the per-channel autonomy explainer keyed to
// the active tier, and the fleet dispatched here with working/waiting counts, the ones blocked on you,
// and the bound project. Auto-hides below ~1320px pane width so the full-width message column keeps room.
function ContextPanel({
    model,
    channel,
    agents,
    extraIcons,
}: {
    model: AgentsViewModel;
    channel: Channel | null;
    agents: AgentVM[];
    extraIcons?: RailExtraIcon[];
}) {
    const snapshot = channel ? buildFleetSnapshot(channel, agents) : [];
    const asking = snapshot.filter((w) => w.state === "asking");
    const counts = fleetCounts(snapshot);
    const tier = tierFromMeta(channel?.meta as Record<string, unknown> | undefined);
    const explainer = autonomyExplainer(tier);
    const label = "mb-2 font-mono text-[9px] uppercase tracking-[.09em] text-muted";
    const sections: RailSection[] = [
        {
            id: "jarvis",
            label: `Autonomy in #${channel?.name ?? "channel"}`,
            icon: RAIL_ICON.autonomy,
            content: (
                <div>
                    <div className="mb-4 flex items-center gap-2.5">
                        <Avatar name="jarvis" />
                        <div className="min-w-0 flex-1">
                            <div className="text-[13px] font-bold text-primary">Jarvis</div>
                            <div className="font-mono text-[10.5px] text-muted">Fleet manager</div>
                        </div>
                        <span className="flex items-center gap-1 font-mono text-[10px] text-success">
                            <span className="h-1.5 w-1.5 rounded-full bg-success" /> live
                        </span>
                    </div>

                    <div className={label}>Autonomy in #{channel?.name ?? "channel"}</div>
                    <div className="rounded-[9px] border border-accent/25 bg-accentbg/20 px-3 py-2.5">
                        <p className="mb-2.5 text-[11.5px] leading-[1.5] text-secondary">{explainer.blurb}</p>
                        <div className="flex flex-col gap-1.5">
                            {explainer.checklist.map((c) => (
                                <div key={c.label} className="flex items-center gap-2">
                                    <span className={c.active ? "text-success" : "text-edge-strong"}>
                                        {c.active ? "✓" : "–"}
                                    </span>
                                    <span
                                        className={
                                            c.active ? "text-[11.5px] text-secondary" : "text-[11.5px] text-muted"
                                        }
                                    >
                                        {c.label}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            ),
        },
        {
            id: "fleet",
            label: "Fleet here",
            icon: RAIL_ICON.fleet,
            content: (
                <div>
                    <div className={label}>
                        Fleet here · {counts.working} working · {counts.waiting} waiting
                    </div>
                    {snapshot.length === 0 ? (
                        <p className="text-[11.5px] text-muted">No workers dispatched here yet.</p>
                    ) : (
                        snapshot.map((w) => <WorkerRow key={w.oref} model={model} w={w} />)
                    )}
                </div>
            ),
        },
        ...(asking.length > 0
            ? [
                  {
                      id: "needs-you",
                      label: `Needs you · ${asking.length}`,
                      icon: RAIL_ICON.bell,
                      content: (
                          <div>
                              <div className={label}>Needs you · {asking.length}</div>
                              <div className="flex flex-col gap-2">
                                  {asking.map((w) => (
                                      <div
                                          key={w.oref}
                                          className="rounded-[7px] border border-asking/40 bg-lane-asking px-2.5 py-2 text-[11px] leading-[1.45] text-secondary"
                                      >
                                          <span className="font-mono text-accent-soft">{w.name}</span>
                                          {w.askText ? ` — ${w.askText}` : ""}
                                      </div>
                                  ))}
                              </div>
                          </div>
                      ),
                  } as RailSection,
              ]
            : []),
        {
            id: "project",
            label: "Project",
            icon: RAIL_ICON.folder,
            content: (
                <div>
                    <div className={label}>Project</div>
                    <div className="break-all font-mono text-[11px] text-muted">{channel?.projectpath || "—"}</div>
                </div>
            ),
        },
    ];

    return (
        <CollapsibleRail
            openAtom={channelRailOpenAtom}
            ariaLabel="Channel context"
            sections={sections}
            extraIcons={extraIcons}
        />
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
    const tier = tierFromMeta(active?.meta as Record<string, unknown> | undefined);
    const [draft, setDraft] = useState("");
    const [picking, setPicking] = useState(false);
    const [installedRuntimes, setInstalledRuntimes] = useState<string[]>([]);
    const [view, setView] = useState<"chat" | "runs">(() => defaultView(active));
    const [runMode, setRunMode] = useState<string>("pipeline");
    const [planGate, setPlanGate] = useState<boolean>(true);
    const [runOverride, setRunOverride] = useState<ProfileOverride | null>(null);
    const setProfileOpen = useSetAtom(profileRailOpenAtom);
    // in the Runs view the profile drawer's ⚙ trigger is stacked under the context rail's own icon, so
    // both live in one collapsed strip (the profile stays a separate drawer — see ProfilePanel).
    const contextExtraIcons: RailExtraIcon[] | undefined =
        view === "runs" && active
            ? [
                  {
                      key: "profile",
                      ariaLabel: "Jarvis profile",
                      icon: RAIL_ICON.gear,
                      onClick: () => setProfileOpen((o) => !o),
                  },
              ]
            : undefined;
    useEffect(() => {
        setView(defaultView(active));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeId]);

    useEffect(() => {
        if (!activeId) {
            return;
        }
        fireAndForget(async () => {
            const p = await getJarvisProfile(activeId);
            setRunMode(p.resolved.defaultmode || "pipeline");
            setPlanGate(p.resolved.defaultplangate ?? true);
            setRunOverride(p.override ?? null);
        });
    }, [activeId]);

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
    // replies are folded into their parent rows, so they never appear as standalone stream items
    const shownMessages = messages.filter((m) => m.kind !== "consult-reply" && m.kind !== "jarvis-reply");
    const messageIds = shownMessages.map((m) => m.id);
    // no-cascade guard: switch/mount is silent, only true arrivals animate (see channelsmotion.ts)
    const entranceRef = useRef(initialEntranceState());
    const { animate: entranceIds } = computeEntrances(entranceRef.current, activeId, messageIds);
    const idsKey = messageIds.join(",");
    useLayoutEffect(() => {
        entranceRef.current = computeEntrances(entranceRef.current, activeId, messageIds).state;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeId, idsKey]);
    // pre-send chip: render what Send will do (spawn a worker, consult, steer, …) before it happens.
    // projectName mirrors send()'s choice so the "spawns a worker in <x>" preview matches the dispatch.
    const chip: PlanChip | null =
        draft.trim() && activeId
            ? describePlan(planMessage(draft, roster), {
                  tier,
                  projectName: active?.name ?? "agent",
                  roster,
                  delegatorMode:
                      ((active?.meta as Record<string, unknown> | undefined)?.["delegator:mode"] as DispatchMode) ??
                      "report",
              })
            : null;
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

    // A channel is bound to a project at creation, so every dispatch has a valid cwd (no unbound state).
    const pickProject = (name: string, path: string) => {
        setPicking(false);
        fireAndForget(async () => {
            await createChannel(name, path);
        });
    };

    return (
        <MotionConfig reducedMotion="user">
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
                    onDeleteChannel={(id) => fireAndForget(() => deleteChannel(id))}
                    onSetTier={(id, t) =>
                        fireAndForget(() =>
                            RpcApi.SetChannelTierCommand(TabRpcClient, {
                                channelid: id,
                                tier: t,
                                mode:
                                    ((channels?.find((c) => c.oid === id)?.meta as Record<string, unknown> | undefined)?.[
                                        "delegator:mode"
                                    ] as string) ?? "report",
                            })
                        )
                    }
                />

                <div className="@container flex min-w-0 flex-1">
                    <div className="flex min-w-0 flex-1 flex-col">
                        <div className="flex flex-none items-center gap-2.5 border-b border-border bg-background px-[22px] py-3.5">
                            <span className="font-mono text-[17px] font-bold text-muted">#</span>
                            <div className="min-w-0">
                                <div className="truncate text-[15px] font-bold tracking-[-0.01em] text-primary">
                                    {active?.name ?? "no channel"}
                                </div>
                                {active?.projectpath ? (
                                    <div className="truncate font-mono text-[11.5px] text-muted">
                                        {active.projectpath}
                                    </div>
                                ) : null}
                            </div>
                            {active ? (
                                <div className="ml-1.5 flex items-center gap-0.5 rounded-[9px] border border-edge-mid p-0.5">
                                    {(["chat", "runs"] as const).map((v) => (
                                        <button
                                            key={v}
                                            type="button"
                                            onClick={() => setView(v)}
                                            className={
                                                view === v
                                                    ? "rounded-[6px] bg-accentbg/40 px-3 py-1 text-[11.5px] font-bold text-accent-soft"
                                                    : "rounded-[6px] px-3 py-1 text-[11.5px] font-bold text-muted hover:text-secondary"
                                            }
                                        >
                                            {v === "chat" ? "Chat" : "Runs"}
                                        </button>
                                    ))}
                                </div>
                            ) : null}
                            <div className="flex-1" />
                            {active && view === "chat" ? (
                                <div
                                    className="flex flex-none items-center gap-0.5 rounded-[7px] border border-edge-mid p-0.5"
                                    title="Jarvis autonomy for this channel: Concierge observes; Gatekeeper auto-answers routine asks; Delegator spawns and runs workers toward a goal"
                                >
                                    {(["concierge", "gatekeeper", "delegator"] as const).map((t) => (
                                        <button
                                            key={t}
                                            type="button"
                                            onClick={() =>
                                                fireAndForget(() =>
                                                    RpcApi.SetChannelTierCommand(TabRpcClient, {
                                                        channelid: active.oid,
                                                        tier: t,
                                                        mode:
                                                            ((active.meta as Record<string, unknown> | undefined)?.[
                                                                "delegator:mode"
                                                            ] as string) ?? "report",
                                                    })
                                                )
                                            }
                                            className={
                                                tier === t
                                                    ? "rounded-[5px] border border-accent/50 bg-accentbg/40 px-2 py-0.5 font-mono text-[11px] text-accent-soft"
                                                    : "rounded-[5px] px-2 py-0.5 font-mono text-[11px] text-muted hover:text-secondary"
                                            }
                                        >
                                            {t}
                                        </button>
                                    ))}
                                </div>
                            ) : null}
                            {active && view === "runs" ? (
                                <div className="flex flex-none items-center gap-1.5">
                                    <div
                                        className="flex items-center gap-0.5 rounded-[7px] border border-edge-mid p-0.5"
                                        title="How Jarvis runs a goal: Pipeline uses fixed phases with a review gate; Orchestrator runs one adaptive lead that spawns its own subagents"
                                    >
                                        {(["pipeline", "orchestrator"] as const).map((mVal) => (
                                            <button
                                                key={mVal}
                                                type="button"
                                                onClick={() => {
                                                    setRunMode(mVal);
                                                    const next = { ...(runOverride ?? {}), defaultmode: mVal };
                                                    setRunOverride(next);
                                                    fireAndForget(() => setChannelProfile(active.oid, next));
                                                }}
                                                className={
                                                    runMode === mVal
                                                        ? "rounded-[5px] border border-accent/50 bg-accentbg/40 px-2 py-0.5 font-mono text-[11px] text-accent-soft"
                                                        : "rounded-[5px] px-2 py-0.5 font-mono text-[11px] text-muted hover:text-secondary"
                                                }
                                            >
                                                {mVal}
                                            </button>
                                        ))}
                                    </div>
                                    {runMode === "orchestrator" ? (
                                        <label className="flex cursor-pointer items-center gap-1 font-mono text-[11px] text-muted">
                                            <input
                                                type="checkbox"
                                                checked={planGate}
                                                onChange={(e) => setPlanGate(e.target.checked)}
                                            />
                                            plan gate
                                        </label>
                                    ) : null}
                                </div>
                            ) : null}
                        </div>

                        {view === "runs" && active ? (
                            <RunsView model={model} channel={active} agents={agents} runMode={runMode} planGate={planGate} />
                        ) : (
                            <>
                        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-3 pt-[22px]">
                            <div className="flex flex-col gap-5">
                                {channels == null ? (
                                    <div className="mt-10 text-center text-[13px] text-muted">Loading…</div>
                                ) : !activeId ? (
                                    <div className="mt-10 text-center text-[13px] text-muted">
                                        No channel yet — click <span className="text-secondary">+ New channel</span> to
                                        create one bound to a project.
                                    </div>
                                ) : messages.length === 0 ? (
                                    <div className="mt-10 text-center text-[13px] text-muted">
                                        Empty channel. Try{" "}
                                        <span className="font-mono text-secondary">@claude do something</span>.
                                    </div>
                                ) : (
                                    <AnimatePresence mode="popLayout" initial={false}>
                                        {shownMessages.map((m) => (
                                            <motion.div
                                                key={m.id}
                                                layout
                                                variants={cardVariants}
                                                initial={entranceIds.has(m.id) ? "initial" : false}
                                                animate="animate"
                                            >
                                                {m.kind === "consult" ? (
                                                    <ConsultRow
                                                        msg={m}
                                                        allMessages={messages}
                                                        streams={consultStreams}
                                                        now={now}
                                                    />
                                                ) : m.kind === "jarvis" ? (
                                                    <JarvisRow
                                                        msg={m}
                                                        allMessages={messages}
                                                        streams={consultStreams}
                                                        now={now}
                                                    />
                                                ) : m.kind === "jarvis-answered" ? (
                                                    <GatekeeperRow model={model} agents={agents} msg={m} now={now} />
                                                ) : m.kind === "jarvis-escalation" ? (
                                                    <EscalationRow agents={agents} msg={m} now={now} />
                                                ) : (
                                                    <MessageRow model={model} agents={agents} msg={m} now={now} />
                                                )}
                                            </motion.div>
                                        ))}
                                    </AnimatePresence>
                                )}
                            </div>
                        </div>

                        <Composer
                            value={draft}
                            onChange={setDraft}
                            onSend={send}
                            chip={chip}
                            disabled={!activeId}
                            placeholder={
                                tier === "gatekeeper"
                                    ? `Message #${active?.name ?? "channel"} — Jarvis is auto-answering routine asks`
                                    : tier === "delegator"
                                      ? `Message #${active?.name ?? "channel"} — Jarvis is managing this channel`
                                      : `Message #${active?.name ?? "channel"}`
                            }
                            candidates={mentionCandidates(installedRuntimes, roster)}
                        />
                            </>
                        )}
                    </div>
                    <ContextPanel model={model} channel={active} agents={agents} extraIcons={contextExtraIcons} />
                </div>
            </div>
        </MotionConfig>
    );
}
