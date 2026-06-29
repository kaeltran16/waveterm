// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { AgentComposer } from "./agentcomposer";
import type { AgentsViewModel } from "./agents";
import { formatAge, projectOf, toggleSelection, usageLevel, type AgentVM } from "./agentsviewmodel";
import { AnswerBar } from "./answerbar";
import { FocusTranscript } from "./focustranscript";
import { liveEntriesByIdAtom } from "./livetranscript";
import { railVisibleAtom } from "./railstore";
import { StatusDot } from "./statusdot";

const STATE_COLOR: Record<AgentVM["state"], string> = {
    asking: "var(--color-warning)",
    working: "var(--color-accent)",
    idle: "var(--color-muted)",
};
const STATE_LABEL: Record<AgentVM["state"], string> = { asking: "asking", working: "working", idle: "idle" };

// header Context % chip color by occupancy band (mirrors the rail gauge, as text not fill)
const CTX_TEXT: Record<"ok" | "warn" | "hot", string> = {
    ok: "text-accent",
    warn: "text-warning",
    hot: "text-error",
};

export function AgentTranscript({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const liveEntries = useAtomValue(liveEntriesByIdAtom);
    const answerSel = useAtomValue(model.answerSelAtom);
    const answerTab = useAtomValue(model.answerTabAtom);
    const sentIds = useAtomValue(model.sentIdsAtom);
    const focusReply = useAtomValue(model.focusReplyAtom);
    const railVisible = useAtomValue(railVisibleAtom);
    const entries = liveEntries[agent.id] ?? agent.previousInfo ?? [];
    const project = projectOf(agent);
    const asking = agent.state === "asking";

    const scrollRef = useRef<HTMLDivElement>(null);
    const stickRef = useRef(true);
    const prevLenRef = useRef(entries.length);
    const [newCount, setNewCount] = useState(0);
    const composerWrapRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const added = entries.length - prevLenRef.current;
        prevLenRef.current = entries.length;
        const el = scrollRef.current;
        if (el && stickRef.current) {
            el.scrollTop = el.scrollHeight;
            setNewCount(0);
        } else if (added > 0) {
            setNewCount((n) => n + added);
        }
    }, [entries]);

    useEffect(() => {
        if (focusReply) {
            composerWrapRef.current?.querySelector("textarea")?.focus();
        }
    }, [focusReply, agent.id]);

    const onScroll = () => {
        const el = scrollRef.current;
        if (!el) {
            return;
        }
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        if (stickRef.current) {
            setNewCount(0);
        }
    };

    const jumpToLatest = () => {
        const el = scrollRef.current;
        if (!el) {
            return;
        }
        el.scrollTop = el.scrollHeight;
        stickRef.current = true;
        setNewCount(0);
    };

    return (
        <div className="flex min-w-0 flex-1 flex-col">
            {/* header */}
            <div className="flex shrink-0 items-center gap-[13px] border-b border-[#1a1f26] bg-background px-[22px] py-[14px]">
                <StatusDot state={agent.state} className="!h-[9px] !w-[9px]" />
                <div className="min-w-0">
                    <div className="flex items-center gap-[9px]">
                        <span className="whitespace-nowrap font-mono text-[15px] font-semibold text-[#eef1f4]">
                            {agent.name}
                        </span>
                        <span
                            className="rounded-[5px] border px-[7px] py-[1px] font-mono text-[10.5px] font-medium opacity-85"
                            style={{ color: STATE_COLOR[agent.state], borderColor: STATE_COLOR[agent.state] }}
                        >
                            {STATE_LABEL[agent.state]}
                        </span>
                        {agent.model ? (
                            <span className="rounded-[5px] border border-edge-mid px-[7px] py-[1px] font-mono text-[10.5px] font-medium text-muted">
                                {agent.model}
                            </span>
                        ) : null}
                        {agent.usage?.contextpct != null ? (
                            <span
                                className={cn(
                                    "font-mono text-[10.5px] font-semibold",
                                    CTX_TEXT[usageLevel(agent.usage.contextpct)]
                                )}
                            >
                                {Math.round(agent.usage.contextpct)}%
                            </span>
                        ) : null}
                    </div>
                    <div className="mt-[2px] font-mono text-[11px] font-medium text-muted">{project || "—"}</div>
                </div>
                <div className="flex-1" />
                <button
                    type="button"
                    onClick={() => model.openTerminal(agent.id)}
                    className="rounded-[7px] border border-edge-mid bg-surface-raised px-[11px] py-[6px] text-[12px] font-medium text-[#aeb6bf] hover:border-edge-strong"
                >
                    Open terminal
                </button>
                <button
                    type="button"
                    onClick={() => globalStore.set(railVisibleAtom, !railVisible)}
                    title={railVisible ? "Hide details (d)" : "Show details (d)"}
                    aria-pressed={railVisible}
                    className={cn(
                        "rounded-[7px] border px-[9px] py-[6px]",
                        railVisible
                            ? "border-accent bg-accentbg text-accent"
                            : "border-edge-mid bg-surface-raised text-[#aeb6bf] hover:border-edge-strong"
                    )}
                >
                    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
                        <rect x="3" y="4" width="14" height="12" rx="2" />
                        <line x1="13" y1="4" x2="13" y2="16" />
                    </svg>
                </button>
            </div>

            {/* transcript */}
            <div
                ref={scrollRef}
                onScroll={onScroll}
                className="relative min-h-0 flex-1 overflow-y-auto bg-background px-[22px] pb-[16px] pt-[24px]"
            >
                <div className="mx-auto flex max-w-[720px] flex-col gap-[18px]">
                    <FocusTranscript key={agent.id} entries={entries} agentName={agent.name} />
                    {/* handoff (dc.html:456-461): an asking agent's reply sits inline at the end of the
                        transcript — warm-dark fill + amber left bar + "Awaiting your reply", indented under
                        the avatar gutter (ml-38) so it lines up with the message turns */}
                    {asking ? (
                        <div className="relative ml-[38px] overflow-hidden rounded-[12px] border border-warning/35 bg-lane-asking px-[17px] py-[14px]">
                            <span className="absolute inset-y-0 left-0 w-[3px] bg-warning" />
                            <div className="flex items-center gap-2">
                                <span className="h-[7px] w-[7px] rounded-full bg-warning" />
                                <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[.08em] text-warning">
                                    Awaiting your reply
                                    {agent.blockedMs != null ? ` · ${formatAge(agent.blockedMs)}` : ""}
                                </span>
                            </div>
                            <AnswerBar
                                agent={agent}
                                selections={answerSel[agent.id] ?? {}}
                                sent={sentIds.has(agent.id)}
                                numbered
                                activeQuestion={answerTab[agent.id] ?? 0}
                                onToggle={(qi, oi) => {
                                    const multi = agent.ask?.questions?.[qi]?.multiSelect ?? false;
                                    globalStore.set(model.answerSelAtom, {
                                        ...answerSel,
                                        [agent.id]: toggleSelection(answerSel[agent.id] ?? {}, qi, oi, multi),
                                    });
                                }}
                                onSubmit={() => model.submitAnswer(agent.id)}
                                onSelectQuestion={(qi) =>
                                    globalStore.set(model.answerTabAtom, { ...answerTab, [agent.id]: qi })
                                }
                            />
                        </div>
                    ) : null}
                </div>
                {newCount > 0 ? (
                    <button
                        type="button"
                        onClick={jumpToLatest}
                        className="sticky bottom-3 left-1/2 ml-[-40px] cursor-pointer rounded-full bg-accent px-3 py-1 text-[11px] font-semibold text-white shadow-lg"
                    >
                        ↓ {newCount} new
                    </button>
                ) : null}
            </div>

            {/* footer: composer */}
            <div className="shrink-0 border-t border-[#1a1f26] bg-background px-[22px] pb-[16px] pt-[14px]">
                <div className="mx-auto max-w-[720px]">
                    <div ref={composerWrapRef}>
                        <AgentComposer blockId={agent.blockId} placeholder={`message ${agent.name}…`} />
                    </div>
                </div>
            </div>
        </div>
    );
}
