// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { type AgentAskQuestion, type AgentVM } from "./agentsviewmodel";

function QuestionGroup({
    question,
    numbered,
    selections,
    onClickOption,
}: {
    question: AgentAskQuestion;
    numbered?: boolean;
    selections: Set<number>;
    onClickOption: (oi: number) => void;
}) {
    const options = question.options ?? [];
    // rich asks (any option has a description) read better as stacked rows; bare label-only asks
    // stay as compact wrapping chips. Number badges (1-9) map to the keyboard shortcut; the parent
    // renders only the keyboard-target question, so badges always belong to the rendered group.
    const stacked = options.some((o) => o.description);
    // Claude Code's AskUserQuestion payload has no separate "recommended" flag — by convention it
    // appends the literal "(Recommended)" marker to the option label, so this substring is the only signal.
    const isRec = (label: string) => label.toLowerCase().includes("(recommended)");
    return (
        <div className="mt-3">
            {question.header ? (
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{question.header}</div>
            ) : null}
            <div className="text-[14px] font-semibold text-primary">{question.question}</div>
            {options.length === 0 ? null : stacked ? (
                <div className="mt-2.5 flex flex-col gap-1.5">
                    {options.map((opt, oi) => {
                        const isSelected = selections.has(oi);
                        const isRecommended = isRec(opt.label);
                        const showNum = numbered && oi < 9;
                        return (
                            <button
                                key={oi}
                                type="button"
                                onClick={() => onClickOption(oi)}
                                className={cn(
                                    "flex w-full cursor-pointer items-start gap-2.5 rounded-[8px] border px-3 py-2 text-left transition-colors",
                                    isSelected
                                        ? "border-accent bg-accent/15"
                                        : isRecommended
                                          ? "border-accent/60 hover:bg-accent/10"
                                          : "border-border hover:bg-white/[0.04]"
                                )}
                            >
                                {showNum ? (
                                    <span className="mt-px inline-flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-[4px] bg-black/30 font-mono text-[10px] text-secondary">
                                        {oi + 1}
                                    </span>
                                ) : null}
                                <span className="min-w-0">
                                    <span
                                        className={cn(
                                            "text-[13px] font-semibold",
                                            isSelected ? "text-primary" : isRecommended ? "text-accent" : "text-secondary"
                                        )}
                                    >
                                        {opt.label}
                                    </span>
                                    {opt.description ? (
                                        <span className={cn("mt-0.5 block text-[12px] leading-[1.5]", isSelected ? "text-primary/75" : "text-muted")}>
                                            {opt.description}
                                        </span>
                                    ) : null}
                                </span>
                            </button>
                        );
                    })}
                </div>
            ) : (
                <div className="mt-2.5 flex flex-wrap gap-2">
                    {options.map((opt, oi) => {
                        const isSelected = selections.has(oi);
                        const isRecommended = isRec(opt.label);
                        const showNum = numbered && oi < 9;
                        return (
                            <button
                                key={oi}
                                type="button"
                                onClick={() => onClickOption(oi)}
                                className={cn(
                                    "flex cursor-pointer items-center gap-2 rounded-[6px] px-3 py-1 text-[12px] transition-colors",
                                    isSelected
                                        ? "bg-accent/80 font-semibold text-primary hover:bg-accent"
                                        : isRecommended
                                          ? "border border-accent font-semibold text-accent hover:bg-accent/10"
                                          : "border border-border text-secondary hover:bg-white/[0.04]"
                                )}
                            >
                                {showNum ? (
                                    <span className="inline-flex h-[16px] w-[16px] items-center justify-center rounded-[4px] bg-black/30 font-mono text-[10px] text-secondary">
                                        {oi + 1}
                                    </span>
                                ) : null}
                                <span>{opt.label}</span>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// Amber answer surface for an asking agent. Selection state is owned by the parent (so the keyboard
// triage keymap and mouse clicks write the same place). Mouse: single-select submits on click,
// multi-select waits for the parent's submit (Enter). When `sent`, shows a confirmation in place.
export function AnswerBar({
    agent,
    selections,
    sent,
    numbered,
    activeQuestion,
    onToggle,
    onSubmit,
    onSelectQuestion,
    className,
}: {
    agent: AgentVM;
    selections: Record<number, Set<number>>;
    sent?: boolean;
    numbered?: boolean;
    activeQuestion?: number;
    onToggle: (qi: number, oi: number) => void;
    onSubmit: () => void;
    onSelectQuestion?: (qi: number) => void;
    className?: string;
}) {
    const questions = agent.ask?.questions ?? [];
    if (questions.length === 0) {
        return null;
    }
    if (sent) {
        const chosen = questions
            .flatMap((q, qi) => Array.from(selections[qi] ?? []).map((oi) => q.options?.[oi]?.label ?? ""))
            .filter(Boolean);
        return (
            <div className={cn("text-[12px] text-secondary", className)}>
                <span className="text-accent">✓</span> Answered{chosen.length ? `: ${chosen.join(", ")}` : ""}
            </div>
        );
    }
    const needsConfirm = questions.some((q) => q.multiSelect);
    const renderGroup = (qi: number) => (
        <QuestionGroup
            question={questions[qi]}
            numbered={numbered}
            selections={selections[qi] ?? new Set()}
            onClickOption={(oi) => {
                onToggle(qi, oi);
                if (questions[qi].multiSelect) {
                    return;
                }
                // single-select: jump to the next still-unanswered question, else submit
                const next = questions.findIndex((_, j) => j !== qi && (selections[j]?.size ?? 0) === 0);
                if (next === -1) {
                    onSubmit();
                } else {
                    onSelectQuestion?.(next);
                }
            }}
        />
    );

    // one ask renders inline; multiple asks become tabs so they don't stack into a tall wall
    if (questions.length === 1) {
        return (
            <div className={className}>
                {renderGroup(0)}
                {needsConfirm ? <div className="mt-2 text-[11px] text-muted">press Enter to submit</div> : null}
            </div>
        );
    }

    const idx = Math.max(0, Math.min(activeQuestion ?? 0, questions.length - 1));
    const answeredCount = questions.filter((_, qi) => (selections[qi]?.size ?? 0) > 0).length;
    return (
        <div className={className}>
            <div className="flex flex-wrap gap-1.5">
                {questions.map((q, qi) => {
                    const answered = (selections[qi]?.size ?? 0) > 0;
                    const active = qi === idx;
                    return (
                        <button
                            key={qi}
                            type="button"
                            onClick={() => onSelectQuestion?.(qi)}
                            className={cn(
                                "flex cursor-pointer items-center gap-1.5 rounded-[6px] border px-2.5 py-1 text-[12px] transition-colors",
                                active
                                    ? "border-accent bg-accent/15 text-primary"
                                    : "border-border text-secondary hover:bg-white/[0.04]"
                            )}
                        >
                            <span className={cn("h-1.5 w-1.5 rounded-full", answered ? "bg-accent" : "bg-muted/40")} />
                            {q.header || `Q${qi + 1}`}
                        </button>
                    );
                })}
            </div>
            {renderGroup(idx)}
            <div className="mt-2 text-[11px] text-muted">
                {answeredCount}/{questions.length} answered · {needsConfirm ? "press Enter to submit" : "answer all to submit"}
            </div>
        </div>
    );
}
