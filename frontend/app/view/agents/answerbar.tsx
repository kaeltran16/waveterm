// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { answerHint, type AgentAskQuestion, type AgentVM } from "./agentsviewmodel";

// The answer surface tracks the agent's status, mirroring the handoff (Wave-answer.dc.html: the
// cockpit passes accent = stateColor — asking → amber, else → periwinkle). So an asking agent's
// options/tabs/check read in the same "needs you" amber as its card, not a generic blue prompt.
type Accent = {
    selected: string; // selected option/chip: border + soft fill
    rec: string; // recommended option: dim border only (label stays neutral)
    pill: string; // recommended badge
    numSel: string; // selected number badge fill
    check: string; // selected checkmark
    tab: string; // active multi-question tab
    dot: string; // answered tab dot
};
const ACCENT_ASKING: Accent = {
    selected: "border-warning bg-warning/15",
    rec: "border-warning/50",
    pill: "border border-warning/40 bg-warning/10 text-warning",
    numSel: "bg-warning text-background",
    check: "text-warning",
    tab: "border-warning bg-warning/15 text-primary",
    dot: "bg-warning",
};
const ACCENT_DEFAULT: Accent = {
    selected: "border-accent bg-accent/15",
    rec: "border-accent/50",
    pill: "border border-accent/40 bg-accent/10 text-accent",
    numSel: "bg-accent text-background",
    check: "text-accent",
    tab: "border-accent bg-accent/15 text-primary",
    dot: "bg-accent",
};

// Claude Code's AskUserQuestion payload has no separate "recommended" flag — by convention it appends
// the literal "(Recommended)" marker to the option label, so this substring is the only signal. The
// handoff shows it as a separate pill, so strip the marker from the label and badge it instead.
const isRec = (label: string) => /\(recommended\)/i.test(label);
const cleanLabel = (label: string) => label.replace(/\s*\(recommended\)\s*/i, " ").trim();

function QuestionGroup({
    question,
    accent,
    numbered,
    hideQuestion,
    selections,
    onClickOption,
}: {
    question: AgentAskQuestion;
    accent: Accent;
    numbered?: boolean;
    hideQuestion?: boolean;
    selections: Set<number>;
    onClickOption: (oi: number) => void;
}) {
    const options = question.options ?? [];
    // rich asks (any option has a description) read better as stacked rows; bare label-only asks
    // stay as compact wrapping chips. Number badges (1-9) map to the keyboard shortcut; the parent
    // renders only the keyboard-target question, so badges always belong to the rendered group.
    const stacked = options.some((o) => o.description);
    return (
        <div className={hideQuestion ? "" : "mt-3"}>
            {!hideQuestion && question.header ? (
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
                    {question.header}
                </div>
            ) : null}
            {!hideQuestion ? (
                <div className="text-[13px] font-semibold text-primary">{question.question}</div>
            ) : null}
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
                                    "flex w-full cursor-pointer items-start gap-2.5 rounded-[8px] border px-3 py-2 text-left",
                                    isSelected
                                        ? accent.selected
                                        : isRecommended
                                          ? accent.rec
                                          : "border-border hover:bg-white/[0.04]"
                                )}
                            >
                                {showNum ? (
                                    <span
                                        className={cn(
                                            "mt-px inline-flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-[4px] font-mono text-[10px]",
                                            isSelected ? accent.numSel : "bg-black/30 text-secondary"
                                        )}
                                    >
                                        {oi + 1}
                                    </span>
                                ) : null}
                                <span className="min-w-0 flex-1">
                                    <span className="flex items-center gap-2">
                                        <span className="text-[12.5px] font-semibold text-primary">
                                            {cleanLabel(opt.label)}
                                        </span>
                                        {isRecommended ? (
                                            <span
                                                className={cn(
                                                    "shrink-0 rounded-[5px] px-1.5 py-px font-mono text-[8.5px] font-semibold uppercase tracking-wide",
                                                    accent.pill
                                                )}
                                            >
                                                recommended
                                            </span>
                                        ) : null}
                                    </span>
                                    {opt.description ? (
                                        <span
                                            className={cn(
                                                "mt-0.5 block text-[11px] leading-[1.45]",
                                                isSelected ? "text-primary/75" : "text-secondary"
                                            )}
                                        >
                                            {opt.description}
                                        </span>
                                    ) : null}
                                </span>
                                {isSelected ? (
                                    <span className={cn("mt-0.5 shrink-0 text-[13px]", accent.check)}>
                                        {question.multiSelect ? "✓" : "●"}
                                    </span>
                                ) : null}
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
                                    "flex cursor-pointer items-center gap-2 rounded-[6px] border px-3 py-1 text-[12px]",
                                    isSelected
                                        ? cn(accent.selected, "font-semibold text-primary")
                                        : isRecommended
                                          ? cn(accent.rec, "font-semibold text-primary")
                                          : "border-border text-primary hover:bg-white/[0.04]"
                                )}
                            >
                                {showNum ? (
                                    <span
                                        className={cn(
                                            "inline-flex h-[16px] w-[16px] items-center justify-center rounded-[4px] font-mono text-[10px]",
                                            isSelected ? accent.numSel : "bg-black/30 text-secondary"
                                        )}
                                    >
                                        {oi + 1}
                                    </span>
                                ) : null}
                                <span>{cleanLabel(opt.label)}</span>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// Answer surface for an asking agent. Selection state is owned by the parent (so the keyboard triage
// keymap and mouse clicks write the same place). Mouse: single-select submits on click, multi-select
// waits for the parent's submit (Enter). When `sent`, shows a confirmation in place.
export function AnswerBar({
    agent,
    selections,
    sent,
    numbered,
    hideQuestion,
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
    hideQuestion?: boolean;
    activeQuestion?: number;
    onToggle: (qi: number, oi: number) => void;
    onSubmit: () => void;
    onSelectQuestion?: (qi: number) => void;
    className?: string;
}) {
    const questions = agent.ask?.questions ?? [];
    const accent = agent.state === "asking" ? ACCENT_ASKING : ACCENT_DEFAULT;
    if (questions.length === 0) {
        return null;
    }
    if (sent) {
        const chosen = questions
            .flatMap((q, qi) => Array.from(selections[qi] ?? []).map((oi) => cleanLabel(q.options?.[oi]?.label ?? "")))
            .filter(Boolean);
        return (
            <div className={cn("text-[12px] text-secondary", className)}>
                <span className={accent.check}>✓</span> Answered{chosen.length ? `: ${chosen.join(", ")}` : ""}
            </div>
        );
    }
    const renderGroup = (qi: number) => (
        <QuestionGroup
            question={questions[qi]}
            accent={accent}
            numbered={numbered}
            hideQuestion={hideQuestion}
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
        const hint = answerHint(questions, selections, !!numbered);
        return (
            <div className={className}>
                {renderGroup(0)}
                {hint ? <div className="mt-2 text-[11px] text-secondary">{hint}</div> : null}
            </div>
        );
    }

    const idx = Math.max(0, Math.min(activeQuestion ?? 0, questions.length - 1));
    const hint = answerHint(questions, selections, !!numbered);
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
                                "flex cursor-pointer items-center gap-1.5 rounded-[6px] border px-2.5 py-1 text-[12px]",
                                active ? accent.tab : "border-border text-secondary hover:bg-white/[0.04]"
                            )}
                        >
                            <span className={cn("h-1.5 w-1.5 rounded-full", answered ? accent.dot : "bg-muted/40")} />
                            {q.header || `Q${qi + 1}`}
                        </button>
                    );
                })}
            </div>
            {renderGroup(idx)}
            {hint ? <div className="mt-2 text-[11px] text-secondary">{hint}</div> : null}
        </div>
    );
}
