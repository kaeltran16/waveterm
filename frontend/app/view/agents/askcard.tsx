// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { motion } from "motion/react";
import { liveEntriesByIdAtom } from "./livetranscript";
import { buildAskAnswers, canSubmitAsk, formatAge, type AgentAskQuestion, type AgentEntry, type AgentVM } from "./agentsviewmodel";
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
                            <motion.button
                                key={oi}
                                type="button"
                                onClick={() => onToggle(qi, oi)}
                                whileTap={{ scale: 0.95 }}
                                animate={{ scale: isSelected ? 1.04 : 1 }}
                                transition={{ type: "spring", stiffness: 500, damping: 22 }}
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
                                    <span
                                        className={cn(
                                            "ml-1.5 text-[11px] font-normal",
                                            isSelected ? "text-white/75" : "text-[#8b949e]"
                                        )}
                                    >
                                        {opt.description}
                                    </span>
                                ) : null}
                            </motion.button>
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
    const [sent, setSent] = useState(false);
    const liveEntries = useAtomValue(liveEntriesByIdAtom);
    const entries = liveEntries[agent.id] ?? agent.previousInfo ?? [];

    const questions = agent.ask?.questions ?? [];
    const canSubmit = canSubmitAsk(questions, selections);

    const handleToggle = (qi: number, oi: number) => {
        setSelections((prev) => {
            const current = new Set(prev[qi] ?? []);
            const q = questions[qi];
            if (q?.multiSelect) {
                if (current.has(oi)) current.delete(oi);
                else current.add(oi);
            } else {
                current.clear();
                current.add(oi);
            }
            return { ...prev, [qi]: current };
        });
    };

    const handleSubmit = () => {
        if (!canSubmit) return;
        setSent(true);
        onAnswer?.(agent.ask?.oref, buildAskAnswers(questions, selections));
    };

    return (
        <div className="mb-3.5 rounded-[10px] border border-[#d29922] bg-[#d29922]/[0.05] px-[18px] py-4">
            <div className="flex items-center gap-2.5">
                <div className="flex min-w-0 cursor-pointer items-center gap-2.5 hover:[&_b]:underline" onClick={() => onOpen(agent.id)}>
                    <span className="h-2 w-2 shrink-0 rounded-full bg-[#d29922]" />
                    <b className="shrink-0 text-[14px] text-[#e6edf3]">{agent.name}</b>
                    {agent.task ? <span className="truncate text-[12.5px] text-[#6b7585]">· {agent.task}</span> : null}
                </div>
                <span className="ml-auto shrink-0 text-[11px] text-[#d29922]">asking · {formatAge(agent.blockedMs)}</span>
                <button
                    type="button"
                    onClick={() => onOpen(agent.id)}
                    className="shrink-0 cursor-pointer rounded-[5px] border border-[#2c3340] px-2.5 py-0.5 text-[10.5px] text-[#c9d1d9] hover:bg-white/[0.04]"
                >
                    Open terminal
                </button>
            </div>

            {entries.length ? <PreviousInfo entries={entries} /> : null}

            {questions.map((q, qi) => (
                <QuestionGroup
                    key={qi}
                    question={q}
                    qi={qi}
                    selections={selections[qi] ?? new Set()}
                    onToggle={handleToggle}
                />
            ))}

            <div className="mt-3.5 flex items-center justify-end gap-2.5">
                <motion.button
                    type="button"
                    disabled={!canSubmit || sent}
                    onClick={handleSubmit}
                    whileTap={{ scale: 0.96 }}
                    animate={{ scale: sent ? 1.03 : 1 }}
                    transition={{ type: "spring", stiffness: 500, damping: 20 }}
                    className={cn(
                        "rounded-[7px] px-[18px] py-1.5 text-[12.5px] font-semibold",
                        sent
                            ? "bg-[#238636] text-white"
                            : canSubmit
                              ? "cursor-pointer bg-[#238636] text-white"
                              : "bg-[#238636]/40 text-white/50"
                    )}
                >
                    {sent ? "✓ Sent" : "Submit"}
                </motion.button>
            </div>
        </div>
    );
}
