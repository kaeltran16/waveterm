// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useState } from "react";
import { buildAskAnswers, canSubmitAsk, type AgentAskQuestion, type AgentVM } from "./agentsviewmodel";

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
        <div className={cn("mt-3", qi > 0 && "border-t border-border pt-3")}>
            {question.header ? (
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{question.header}</div>
            ) : null}
            <div className="text-[13px] font-semibold text-primary">{question.question}</div>
            {options.length > 0 ? (
                <div className="mt-2.5 flex flex-wrap gap-2">
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
                                    "cursor-pointer rounded-[6px] px-3 py-1 text-[12px] transition-colors",
                                    isSelected
                                        ? "bg-accent/80 font-semibold text-primary hover:bg-accent"
                                        : isRecommended
                                          ? "border border-accent font-semibold text-accent hover:bg-accent/10"
                                          : "border border-border text-secondary hover:bg-white/[0.04]"
                                )}
                            >
                                {opt.label}
                                {opt.description ? (
                                    <span className={cn("ml-1.5 text-[11px] font-normal", isSelected ? "text-primary/75" : "text-muted")}>
                                        {opt.description}
                                    </span>
                                ) : null}
                            </button>
                        );
                    })}
                </div>
            ) : null}
            {question.multiSelect && selections.size > 0 ? (
                <div className="mt-2 text-[11px] text-muted">press Enter to submit</div>
            ) : null}
        </div>
    );
}

// Pinned amber answer surface for an asking agent. Single-select submits the moment every question is
// answered; multi-select submits on Enter (it can't know when you're done). The freeform reply lives in
// the panel's AgentComposer, not here.
export function AnswerBar({ agent, onAnswer }: { agent: AgentVM; onAnswer?: (oref: string, answers: AgentAnswerItem[]) => void }) {
    const [selections, setSelections] = useState<Record<number, Set<number>>>({});
    const [sent, setSent] = useState(false);
    const questions = agent.ask?.questions ?? [];
    const needsConfirm = questions.some((q) => q.multiSelect);

    const submit = (sel: Record<number, Set<number>>) => {
        if (sent || !canSubmitAsk(questions, sel)) return;
        setSent(true);
        onAnswer?.(agent.ask?.oref, buildAskAnswers(questions, sel));
    };

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

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key !== "Enter" || !needsConfirm) return;
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        submit(selections);
    };

    if (questions.length === 0) {
        return null;
    }
    return (
        <div className="shrink-0 border-t border-warning bg-warning/5 px-[14px] py-2.5" tabIndex={-1} onKeyDown={onKeyDown}>
            {questions.map((q, qi) => (
                <QuestionGroup key={qi} question={q} qi={qi} selections={selections[qi] ?? new Set()} onToggle={handleSelect} />
            ))}
        </div>
    );
}
