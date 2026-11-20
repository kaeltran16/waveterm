// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Rendered transcript's question card: the talk question with its why, its numbered rows (the approaches while the
// judge weighs, else the options with the pick's badge, the judge's ranking and its dropped approaches), Guess for me,
// Skip and the picks hint. A pick sends what the pane sends, recorded as picked here. OptionRows also draws the
// builder's question (renderedbscheck.tsx).

import { ViewSwap } from "@/app/element/viewswap";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { Lightbulb, LoaderCircle, Scale } from "lucide-react";
import type { JSX, ReactNode } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { OPTION_KEYS, partTitle, type AnswerOption, type BrainstormAction, type JudgeWork } from "./brainstormmodel";
import { sendBrainstorm } from "./brainstormsend";
import { openBrainstormAt, type BrainstormState } from "./brainstormstore";
import { CHIP, ErrorLine, SMALL_DOT, useAction } from "./brainstormui";
import { CardFrame, useCardRow } from "./renderedbrainstorm";
import type { CardProps } from "./renderedbrainstormmodel";
import { useQuestionBoards } from "./renderedbsboards";
import {
    JUDGE_PICK,
    judgeStartMs,
    judgeStatus,
    picksHint,
    questionActions,
    questionRows,
    startedRow,
} from "./renderedbsquestionmodel";
import { fmtDuration } from "./runcompletion";

const SPIN = "flex-none animate-spin motion-reduce:animate-none";
const KEY_SIZE = "h-[22px] w-[22px]";

// the judge's time so far, on the 1s clock; only this re-renders each tick
function JudgeClock({ model, agent, s }: { model: AgentsViewModel; agent: AgentVM; s: BrainstormState }) {
    const now = useAtomValue(model.nowAtom);
    const start = judgeStartMs(agent.brainstormJudge, s.modifiedMs);
    if (start == null) {
        return null;
    }
    return (
        <span data-rendered-bs-judge-clock className="whitespace-nowrap font-mono text-[12px] text-muted">
            {fmtDuration(now - start)}
        </span>
    );
}

function StartedRow({ s, decisions, compact }: { s: BrainstormState; decisions: string; compact: boolean }) {
    return (
        <div
            data-rendered-bs-started
            className={cn(
                "flex items-center gap-x-[10px] gap-y-1 px-0.5 text-ink-mid",
                compact ? "flex-wrap text-[12.5px]" : "text-[13.5px]"
            )}
        >
            <Lightbulb size={14} strokeWidth={2} aria-hidden className="flex-none" />
            <span>Started a brainstorm</span>
            <span className="min-w-0 truncate font-mono text-[12px] text-primary">{s.topic}</span>
            <span className="whitespace-nowrap">· {decisions}</span>
        </div>
    );
}

// the body's meta line: the question's lead, then → the part it settles, which opens the pane at that part
export function MetaLine({
    agent,
    lead,
    part,
    title,
    compact,
}: {
    agent: AgentVM;
    lead: string;
    part: string | null;
    title: string;
    compact: boolean;
}) {
    return (
        <div data-rendered-bs-q-meta className={cn("text-muted", compact ? "text-[12px]" : "text-[12.5px]")}>
            {lead}
            {part ? (
                <>
                    {" "}
                    <span className="text-ink-faint">→</span>{" "}
                    <button
                        type="button"
                        data-rendered-bs-part-link
                        onClick={() => openBrainstormAt(agent.id, { part })}
                        className="cursor-pointer border-0 bg-transparent p-0 text-secondary hover:underline"
                    >
                        {title}
                    </button>
                </>
            ) : null}
        </div>
    );
}

function JudgeStatus({ text, clock, compact }: { text: string; clock: ReactNode; compact: boolean }) {
    return (
        <div
            data-rendered-bs-judge-status
            aria-live="polite"
            className={cn(
                "flex items-center gap-x-[10px] gap-y-1 rounded-[8px] border border-edge-faint bg-background px-3 py-[9px]",
                compact && "flex-wrap"
            )}
        >
            <LoaderCircle size={13} strokeWidth={2.4} aria-hidden className={cn(SPIN, "text-skill")} />
            <span className={cn("text-secondary", compact ? "text-[12.5px]" : "text-[13px]")}>{text}</span>
            {clock}
            <span className="flex-1" />
            <span className={cn("text-[12px] text-muted", compact && "basis-full pl-[23px]")}>
                its pick shows here; you can pick first
            </span>
        </div>
    );
}

// how the judge got to its options and what it dropped, struck with why; or why the read and pick are the agent's
function JudgeWorkLines({ work, compact }: { work: JudgeWork; compact: boolean }) {
    const lead = <span className="text-secondary">Judge’s work:</span>;
    const size = compact ? "text-[12px]" : "text-[12.5px]";
    if (!work.judged) {
        return (
            <div data-rendered-bs-judge-work className={cn("flex items-baseline gap-2 leading-[1.5] text-muted", size)}>
                <span className={cn(SMALL_DOT, "bg-error")} />
                <span>
                    {lead} {work.line}
                </span>
            </div>
        );
    }
    return (
        <div data-rendered-bs-judge-work className={cn("flex flex-col", compact ? "gap-1.5" : "gap-1")}>
            <span className={cn("leading-[1.5] text-muted", size)}>
                {lead} {work.line}
            </span>
            {work.dropped.map((d, i) => (
                <div
                    key={i}
                    data-rendered-bs-dropped
                    className={cn(
                        "flex gap-x-[10px] text-muted",
                        compact ? "flex-col text-[12px]" : "items-baseline text-[12.5px]"
                    )}
                >
                    <span data-rendered-bs-dropped-name className="whitespace-nowrap line-through">
                        {d.name}
                    </span>
                    <span>{d.reason}</span>
                </div>
            ))}
        </div>
    );
}

function PickBadge({ label }: { label: string }) {
    const judge = label === JUDGE_PICK;
    return (
        <span
            data-rendered-bs-pick-badge
            className={cn(
                "inline-flex flex-none items-center gap-[5px] whitespace-nowrap text-[12px] font-semibold",
                judge ? "text-skill" : "text-accent-soft"
            )}
        >
            {judge ? <Scale size={12} strokeWidth={2.2} aria-hidden /> : null}
            {label}
        </span>
    );
}

// numbered rows, each one answer sent by its label. locked is why the rows are disabled ("" for no reason shown), null
// while they answer; badge marks the pick, note stands in for a row's detail (the judge's ranking), chip draws beside
// the row (under its label when compact), outside its button so it never sends the answer
export function OptionRows({
    options,
    onPick,
    locked,
    badge,
    chip,
    note,
    compact,
}: {
    options: AnswerOption[];
    onPick: (label: string) => void;
    locked: string | null;
    badge?: (i: number) => string | null;
    chip?: (i: number) => ReactNode | null;
    note?: (i: number) => string | null;
    compact: boolean;
}): JSX.Element | null {
    if (options.length === 0) {
        return null;
    }
    return (
        <div role="group" aria-label="Answers" data-rendered-bs-options className="flex flex-col gap-2">
            {options.map((o, i) => {
                const b = badge?.(i) ?? null;
                const c = chip?.(i) ?? null;
                const n = note?.(i) ?? null;
                const detail = n ?? o.detail;
                return (
                    <div
                        key={i}
                        data-rendered-bs-option-row={i}
                        className={cn(
                            "flex rounded-[8px] border has-[>button:focus-visible]:ring-2 has-[>button:focus-visible]:ring-accent",
                            compact ? "flex-col" : "items-center",
                            b === JUDGE_PICK ? "border-accent/50 bg-accent/7" : "border-edge-mid bg-background",
                            locked == null && "has-[>button:hover]:border-edge-strong"
                        )}
                    >
                        <button
                            type="button"
                            data-rendered-bs-option={i}
                            disabled={locked != null}
                            title={locked || undefined}
                            onClick={() => onPick(o.label)}
                            className={cn(
                                "flex min-w-0 flex-1 cursor-pointer gap-3 border-0 bg-transparent text-left outline-none disabled:cursor-default disabled:opacity-50",
                                compact ? "items-start px-3 py-[9px]" : "items-center px-[14px] py-2.5"
                            )}
                        >
                            {i < OPTION_KEYS.length ? (
                                <span
                                    data-rendered-bs-key
                                    className={cn(
                                        "flex flex-none items-center justify-center rounded-[5px] border border-edge-strong font-mono text-[12px] text-secondary",
                                        KEY_SIZE
                                    )}
                                >
                                    {OPTION_KEYS[i]}
                                </span>
                            ) : (
                                // no key reaches this row: a blank keeps its label in line with the others
                                <span data-rendered-bs-no-key className={cn("flex-none", KEY_SIZE)} />
                            )}
                            <span
                                className={cn(
                                    "flex min-w-0 flex-1",
                                    compact ? "flex-col gap-0.5" : "items-baseline gap-3"
                                )}
                            >
                                <span
                                    data-rendered-bs-option-label
                                    className={cn(
                                        "font-semibold leading-[1.4] text-primary",
                                        compact ? "pt-0.5 text-[13px]" : "max-w-[50%] flex-none text-[13.5px]"
                                    )}
                                >
                                    {o.label}
                                </span>
                                {detail ? (
                                    <span
                                        data-rendered-bs-option-detail
                                        title={n != null && o.detail ? o.detail : undefined}
                                        className={cn(
                                            "min-w-0 leading-[1.45]",
                                            n != null ? "text-muted" : "text-ink-mid",
                                            compact ? "text-[12.5px]" : "text-[13px]"
                                        )}
                                    >
                                        {detail}
                                    </span>
                                ) : null}
                            </span>
                            {b != null ? <PickBadge label={b} /> : null}
                        </button>
                        {c != null ? (
                            <div
                                data-rendered-bs-option-chip
                                className={cn("flex-none", compact ? "pb-[9px] pl-[46px] pr-3" : "pr-[14px]")}
                            >
                                {c}
                            </div>
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
}

// the picks hint with its keys drawn as keys
export function PicksHint({ rows }: { rows: number }) {
    return (
        <span data-rendered-bs-picks-hint className="text-[12px] text-muted">
            {picksHint(rows)
                .split(/(\d+)/)
                .map((part, i) =>
                    i % 2 === 1 ? (
                        <kbd
                            key={i}
                            className="rounded-[4px] border border-b-2 border-edge-strong px-1 font-mono text-[11.5px] text-secondary"
                        >
                            {part}
                        </kbd>
                    ) : (
                        part
                    )
                )}
        </span>
    );
}

export function QuestionCard({
    model,
    agent,
    s,
    f,
    compact,
    judging,
}: CardProps & { judging: boolean }): JSX.Element | null {
    const act = useAction();
    const boards = useQuestionBoards(agent, s, f, judging);
    const row = useCardRow();
    const q = f.question;
    if (q == null) {
        return null;
    }
    const rows = questionRows(q, judging);
    const actions = questionActions(f, judging);
    const started = startedRow(f);
    const send = (a: BrainstormAction) =>
        void act.run(() => sendBrainstorm(agent, a, undefined, undefined, "transcript"));
    const clock = <JudgeClock model={model} agent={agent} s={s} />;
    return (
        <div className="flex flex-col gap-4">
            {started != null && !row ? <StartedRow s={s} decisions={started.decisions} compact={compact} /> : null}
            <CardFrame
                agent={agent}
                s={s}
                f={f}
                asking={true}
                title={q.text}
                compact={compact}
                attr="data-rendered-bs-question"
            >
                <MetaLine
                    agent={agent}
                    lead={`Question ${q.n}`}
                    part={q.part || null}
                    title={q.part ? partTitle(f, q.part) : ""}
                    compact={compact}
                />
                <span
                    data-rendered-bs-q-text
                    className={cn(
                        "whitespace-pre-line font-semibold leading-[1.35] text-primary",
                        compact ? "text-[15.5px]" : "text-[17px]"
                    )}
                >
                    {q.text}
                </span>
                {q.why ? (
                    <span
                        data-rendered-bs-q-why
                        className={cn("leading-[1.5] text-ink-mid", compact ? "text-[12.5px]" : "text-[13.5px]")}
                    >
                        {q.why}
                    </span>
                ) : null}
                {judging ? <JudgeStatus text={judgeStatus(q)} clock={clock} compact={compact} /> : null}
                {rows.options.length > 0 || rows.work != null ? (
                    <ViewSwap swapKey={rows.state} className="flex flex-col gap-[14px]">
                        <OptionRows
                            options={rows.options}
                            onPick={(text) => send({ kind: "answer", text })}
                            locked={act.busy ? "" : null}
                            badge={rows.badge}
                            note={rows.note}
                            chip={boards.chip}
                            compact={compact}
                        />
                        {rows.work != null ? <JudgeWorkLines work={rows.work} compact={compact} /> : null}
                    </ViewSwap>
                ) : null}
                <div
                    data-rendered-bs-q-actions
                    className={cn("flex gap-2", compact ? "flex-col items-start" : "items-center")}
                >
                    {actions.guess || actions.skip ? (
                        <div className="flex flex-wrap items-center gap-2">
                            {actions.guess ? (
                                <button
                                    type="button"
                                    disabled={act.busy}
                                    onClick={() => send({ kind: "guess" })}
                                    className={CHIP}
                                >
                                    Guess for me
                                </button>
                            ) : null}
                            {actions.skip ? (
                                <button
                                    type="button"
                                    disabled={act.busy}
                                    onClick={() => send({ kind: "skip" })}
                                    className={CHIP}
                                >
                                    Skip the questions
                                </button>
                            ) : null}
                        </div>
                    ) : null}
                    {compact ? null : <span className="flex-1" />}
                    <PicksHint rows={rows.options.length} />
                </div>
                <ErrorLine error={act.error} attrs={{ "data-rendered-bs-error": "" }} />
            </CardFrame>
        </div>
    );
}
