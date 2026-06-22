// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useRef, useState } from "react";
import { liveEntriesByIdAtom } from "./livetranscript";
import { AgentComposer } from "./agentcomposer";
import { buildAskAnswers, canSubmitAsk, formatAge, type AgentAskQuestion, type AgentEntry, type AgentVM } from "./agentsviewmodel";
import { NarrationTimeline } from "./narrationtimeline";
import { StatusDot } from "./statusdot";

const AskMinH = 160; // keeps the pinned header + composer (and a sliver of body) always visible

function PreviousInfo({ entries }: { entries: AgentEntry[] }) {
    return <NarrationTimeline entries={entries} className="mt-2.5" />;
}

function QuestionGroup({
    question,
    qi,
    selections,
    onToggle,
}: {
    question: AgentAskQuestion;
    qi: number;
    selections: Set<number>;
    onToggle: (qi: number, oi: number) => void;
}) {
    const options = question.options ?? [];
    return (
        <div className="mt-3.5 border-t border-border pt-3.5">
            {question.header ? (
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{question.header}</div>
            ) : null}
            <div className="text-[14px] font-semibold text-primary">{question.question}</div>
            {options.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2.5">
                    {options.map((opt, oi) => {
                        const isSelected = selections.has(oi);
                        // Claude Code's AskUserQuestion payload has no separate "recommended" flag — by convention it
                        // appends the literal "(Recommended)" marker to the option label, so this substring is the only signal.
                        const isRecommended = opt.label.toLowerCase().includes("(recommended)");
                        return (
                            <button
                                key={oi}
                                type="button"
                                onClick={() => onToggle(qi, oi)}
                                className={cn(
                                    "cursor-pointer rounded-[7px] px-[18px] py-1.5 text-[12.5px] transition-colors",
                                    isSelected
                                        ? "bg-accent/80 font-semibold text-primary hover:bg-accent"
                                        : isRecommended
                                          ? "border border-accent font-semibold text-accent hover:bg-accent/10"
                                          : "border border-border text-secondary hover:bg-white/[0.04]"
                                )}
                            >
                                {opt.label}
                                {opt.description ? (
                                    <span
                                        className={cn(
                                            "ml-1.5 text-[11px] font-normal",
                                            isSelected ? "text-primary/75" : "text-muted"
                                        )}
                                    >
                                        {opt.description}
                                    </span>
                                ) : null}
                            </button>
                        );
                    })}
                </div>
            ) : null}
            {question.multiSelect && selections.size > 0 ? (
                <div className="mt-2.5 text-[11px] text-muted">press Enter to submit</div>
            ) : null}
        </div>
    );
}

export function AskCard({
    agent,
    onAnswer,
    onOpen,
}: {
    agent: AgentVM;
    onAnswer?: (oref: string, answers: AgentAnswerItem[]) => void;
    onOpen: (id: string) => void;
}) {
    const [selections, setSelections] = useState<Record<number, Set<number>>>({});
    const [sent, setSent] = useState(false);
    // null = auto (content-driven, unchanged default); a number means the user dragged it to a fixed height
    const [height, setHeight] = useState<number>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ y: number; h: number }>(null);
    const liveEntries = useAtomValue(liveEntriesByIdAtom);
    const entries = liveEntries[agent.id] ?? agent.previousInfo ?? [];

    const questions = agent.ask?.questions ?? [];
    const needsConfirm = questions.some((q) => q.multiSelect);

    const submit = (sel: Record<number, Set<number>>) => {
        if (sent || !canSubmitAsk(questions, sel)) return;
        setSent(true);
        onAnswer?.(agent.ask?.oref, buildAskAnswers(questions, sel));
    };

    // Single-select asks submit the moment every question is answered. Multi-select can't know when
    // you're done (one pick already satisfies canSubmit), so those submit on Enter instead — no button.
    const handleSelect = (qi: number, oi: number) => {
        if (sent) return;
        const q = questions[qi];
        const current = new Set(selections[qi] ?? []);
        if (q?.multiSelect) {
            if (current.has(oi)) current.delete(oi);
            else current.add(oi);
        } else {
            current.clear();
            current.add(oi);
        }
        const next = { ...selections, [qi]: current };
        setSelections(next);
        if (!needsConfirm) {
            submit(next);
        }
    };

    // Enter submits a multi-select ask. Ignored when focus is in the composer (it owns its own Enter).
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key !== "Enter" || !needsConfirm) return;
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        submit(selections);
    };

    const onResizeDown = (e: React.PointerEvent) => {
        const el = cardRef.current;
        if (!el) {
            return;
        }
        e.preventDefault();
        dragRef.current = { y: e.clientY, h: el.getBoundingClientRect().height };
        e.currentTarget.setPointerCapture(e.pointerId);
    };
    const onResizeMove = (e: React.PointerEvent) => {
        const d = dragRef.current;
        if (!d) {
            return;
        }
        setHeight(Math.max(AskMinH, d.h + (e.clientY - d.y)));
    };
    const onResizeUp = (e: React.PointerEvent) => {
        if (!dragRef.current) {
            return;
        }
        dragRef.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
    };

    return (
        <div
            ref={cardRef}
            style={height != null ? { height } : undefined}
            className="relative mb-3.5 flex flex-col rounded-[10px] border border-warning bg-warning/5 px-[18px] py-4"
            tabIndex={-1}
            onKeyDown={onKeyDown}
        >
            <div className="flex shrink-0 items-center gap-2.5">
                <div className="flex min-w-0 cursor-pointer items-center gap-2.5 hover:[&_b]:underline" onClick={() => onOpen(agent.id)}>
                    <StatusDot state="asking" />
                    <b className="shrink-0 text-[14px] text-primary">{agent.name}</b>
                    {agent.task ? <span className="truncate text-[12.5px] text-muted">· {agent.task}</span> : null}
                </div>
                <span className="ml-auto shrink-0 text-[11px] text-warning">asking · {formatAge(agent.blockedMs)}</span>
                <button
                    type="button"
                    onClick={() => onOpen(agent.id)}
                    className="shrink-0 cursor-pointer rounded-[5px] border border-border px-2.5 py-0.5 text-[10.5px] text-secondary hover:bg-white/[0.04]"
                >
                    Open terminal
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
                {entries.length ? <PreviousInfo entries={entries} /> : null}

                {questions.map((q, qi) => (
                    <QuestionGroup
                        key={qi}
                        question={q}
                        qi={qi}
                        selections={selections[qi] ?? new Set()}
                        onToggle={handleSelect}
                    />
                ))}
            </div>

            <AgentComposer blockId={agent.blockId} placeholder={`reply to ${agent.name}…`} className="mt-3.5 shrink-0 px-0" />

            <div
                onPointerDown={onResizeDown}
                onPointerMove={onResizeMove}
                onPointerUp={onResizeUp}
                title="Drag to resize"
                className="absolute bottom-0 left-0 right-0 z-20 flex h-2 cursor-ns-resize items-end justify-center"
            >
                <div className="mb-0.5 h-0.5 w-8 rounded-full bg-muted/40 hover:bg-muted" />
            </div>
        </div>
    );
}
