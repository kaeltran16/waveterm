// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useState } from "react";
import { formatAge, type AgentAskQuestion, type AgentEntry, type AgentVM } from "./agentsviewmodel";
import { NarrationTimeline } from "./narrationtimeline";

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
        <div className="mt-3.5 border-t border-[#2a2f3a] pt-3.5">
            {question.header ? (
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#6b7585]">{question.header}</div>
            ) : null}
            <div className="text-[14px] font-semibold text-[#e6edf3]">{question.question}</div>
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
                                    "cursor-pointer rounded-[7px] px-[18px] py-1.5 text-[12.5px]",
                                    isSelected
                                        ? "bg-[#238636] font-semibold text-white"
                                        : isRecommended
                                          ? "border border-[#238636] font-semibold text-[#3fb950]"
                                          : "border border-[#2c3340] text-[#c9d1d9]"
                                )}
                            >
                                {opt.label}
                                {opt.description ? (
                                    <span className="ml-1.5 text-[11px] font-normal text-[#6b7585]">{opt.description}</span>
                                ) : null}
                            </button>
                        );
                    })}
                </div>
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

    const questions = agent.ask?.questions ?? [];

    // MVP: the panel can drive the native picker only for a single single-select question.
    // Everything else (multi-select, multi-question) is answered in the terminal.
    const panelAnswerable = questions.length === 1 && !questions[0]?.multiSelect;
    const canSubmit = panelAnswerable && (selections[0]?.size ?? 0) === 1;

    const handleToggle = (qi: number, oi: number) => {
        setSelections((prev) => {
            const current = new Set(prev[qi] ?? []);
            const q = questions[qi];
            if (q?.multiSelect) {
                if (current.has(oi)) current.delete(oi);
                else current.add(oi);
            } else {
                // single-select: replace
                current.clear();
                current.add(oi);
            }
            return { ...prev, [qi]: current };
        });
    };

    const handleSubmit = () => {
        if (!canSubmit) return;
        const answers: AgentAnswerItem[] = [{ selectedindexes: Array.from(selections[0] ?? []) }];
        onAnswer?.(agent.ask?.oref, answers);
    };

    return (
        <div className="mb-3.5 rounded-[10px] border border-[#d29922] bg-[#d29922]/[0.05] px-[18px] py-4">
            <div className="flex items-center justify-between">
                <div className="flex cursor-pointer items-center gap-2.5 hover:[&_b]:underline" onClick={() => onOpen(agent.id)}>
                    <span className="h-2 w-2 shrink-0 rounded-full bg-[#d29922]" />
                    <b className="text-[14px] text-[#e6edf3]">{agent.name}</b>
                    {agent.task ? <span className="text-[12.5px] text-[#6b7585]">· {agent.task}</span> : null}
                </div>
                <span className="text-[11.5px] text-[#d29922]">asking · {formatAge(agent.blockedMs)}</span>
            </div>

            {agent.previousInfo?.length ? <PreviousInfo entries={agent.previousInfo} /> : null}

            {agent.ask && panelAnswerable ? (
                <>
                    {questions.map((q, qi) => (
                        <QuestionGroup
                            key={qi}
                            question={q}
                            qi={qi}
                            selections={selections[qi] ?? new Set()}
                            onToggle={handleToggle}
                        />
                    ))}
                    <div className="mt-3.5 flex justify-end">
                        <button
                            type="button"
                            disabled={!canSubmit}
                            onClick={handleSubmit}
                            className={cn(
                                "rounded-[7px] px-[18px] py-1.5 text-[12.5px] font-semibold",
                                canSubmit
                                    ? "cursor-pointer bg-[#238636] text-white"
                                    : "bg-[#238636]/40 text-white/50"
                            )}
                        >
                            Submit
                        </button>
                    </div>
                </>
            ) : (
                <div className="mt-3.5 border-t border-[#2a2f3a] pt-3.5">
                    <button
                        type="button"
                        onClick={() => onOpen(agent.id)}
                        className="cursor-pointer rounded-[7px] bg-[#238636] px-[18px] py-1.5 text-[12.5px] font-semibold text-white"
                    >
                        Open session to answer
                    </button>
                </div>
            )}
        </div>
    );
}
