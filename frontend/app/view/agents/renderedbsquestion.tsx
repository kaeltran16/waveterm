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
import { ArrowUpRight, Lightbulb, LoaderCircle, Scale } from "lucide-react";
import type { JSX, ReactNode } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { partTitle, type AnswerOption, type BrainstormAction, type JudgeWork } from "./brainstormmodel";
import { sendBrainstorm } from "./brainstormsend";
import { openBrainstormAt, type BrainstormState } from "./brainstormstore";
import { CHIP, ErrorLine, SMALL_DOT, useAction } from "./brainstormui";
import { CardFrame } from "./renderedbrainstorm";
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

const OPEN_LINK =
    "inline-flex cursor-pointer items-center gap-1 whitespace-nowrap border-0 bg-transparent p-0 text-[12px] text-accent-soft hover:underline";
const SPIN = "flex-none animate-spin motion-reduce:animate-none";

// the judge's time so far, on the 1s clock; only this re-renders each tick
function JudgeClock({ model, agent, s }: { model: AgentsViewModel; agent: AgentVM; s: BrainstormState }) {
    const now = useAtomValue(model.nowAtom);
    const start = judgeStartMs(agent.brainstormJudge, s.modifiedMs);
    if (start == null) {
        return null;
    }
    return (
        <span data-rendered-bs-judge-clock className="whitespace-nowrap text-[12px] text-muted">
            {fmtDuration(now - start)}
        </span>
    );
}

function StartedRow({
    agent,
    s,
    decisions,
    compact,
}: {
    agent: AgentVM;
    s: BrainstormState;
    decisions: string;
    compact: boolean;
}) {
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
            <span className="flex-1" />
            <button type="button" onClick={() => openBrainstormAt(agent.id, {})} className={OPEN_LINK}>
                Open brainstorm
                <ArrowUpRight size={11} strokeWidth={2.2} aria-hidden />
            </button>
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
    if (!work.judged) {
        return (
            <div data-rendered-bs-judge-work className="flex items-baseline gap-2 text-[12px] leading-[1.5] text-muted">
                <span className={cn(SMALL_DOT, "bg-error")} />
                <span>
                    {lead} {work.line}
                </span>
            </div>
        );
    }
    return (
        <div data-rendered-bs-judge-work className="flex flex-col gap-1">
            <span className="text-[12px] leading-[1.5] text-muted">
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
                "inline-flex flex-none items-center gap-[5px] whitespace-nowrap text-[11.5px] font-semibold",
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
                            "flex rounded-[10px] border has-[>button:focus-visible]:ring-2 has-[>button:focus-visible]:ring-accent",
                            compact ? "flex-col" : "items-center",
                            b === JUDGE_PICK ? "border-accent/55 bg-accent/8" : "border-edge-mid bg-background",
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
                                compact ? "items-start px-[10px] py-2" : "items-center px-3 py-2.5"
                            )}
                        >
                            <span
                                className={cn(
                                    "flex flex-none items-center justify-center rounded-[6px] border border-edge-strong font-mono font-semibold text-secondary",
                                    compact ? "h-[20px] w-[20px] text-[10.5px]" : "h-[22px] w-[22px] text-[11px]"
                                )}
                            >
                                {i + 1}
                            </span>
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
                                        compact ? "text-[12.5px]" : "max-w-[50%] flex-none text-[13.5px]"
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
                                            compact ? "text-[12px]" : "text-[12.5px]"
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
                                className={cn("flex-none", compact ? "pb-2 pl-[42px] pr-[10px]" : "pr-[10px]")}
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

export function QuestionCard({
    model,
    agent,
    s,
    f,
    compact,
    judging,
}: CardProps & { judging: boolean }): JSX.Element | null {
    const act = useAction();
    const boards = useQuestionBoards(agent, s, f, judging, compact);
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
    const head = q.part ? (
        <>
            <span className="whitespace-nowrap font-mono font-semibold">{q.n} →</span>
            <button
                type="button"
                data-rendered-bs-part-link
                onClick={() => openBrainstormAt(agent.id, { part: q.part })}
                className="min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-warning hover:underline"
            >
                {partTitle(f, q.part)}
            </button>
        </>
    ) : (
        <span className="whitespace-nowrap font-mono font-semibold">Question {q.n}</span>
    );
    return (
        <div className="flex flex-col gap-4">
            {started != null ? (
                <StartedRow agent={agent} s={s} decisions={started.decisions} compact={compact} />
            ) : null}
            <CardFrame
                agent={agent}
                s={s}
                f={f}
                asking={true}
                head={head}
                compact={compact}
                attr="data-rendered-bs-question"
            >
                <div className="flex flex-col gap-1.5">
                    <span
                        data-rendered-bs-q-text
                        className={cn(
                            "whitespace-pre-line font-semibold leading-[1.4] text-primary",
                            compact ? "text-[15px]" : "text-[17px]"
                        )}
                    >
                        {q.text}
                    </span>
                    {q.why ? (
                        <span
                            data-rendered-bs-q-why
                            className={cn("leading-[1.55] text-ink-mid", compact ? "text-[12.5px]" : "text-[13.5px]")}
                        >
                            {q.why}
                        </span>
                    ) : null}
                </div>
                {judging ? <JudgeStatus text={judgeStatus(q)} clock={clock} compact={compact} /> : null}
                {boards.block}
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
                    className={cn("flex gap-[10px]", compact ? "flex-col items-start" : "items-center")}
                >
                    {actions.guess || actions.skip ? (
                        <div className="flex flex-wrap items-center gap-[10px]">
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
                    <span data-rendered-bs-picks-hint className="text-[12px] text-muted">
                        {picksHint(rows.options.length)}
                    </span>
                </div>
                <ErrorLine error={act.error} attrs={{ "data-rendered-bs-error": "" }} />
            </CardFrame>
            {judging ? (
                <div
                    data-rendered-bs-judge-wait
                    className={cn("flex items-center gap-[10px] text-muted", compact ? "text-[12.5px]" : "text-[13px]")}
                >
                    <LoaderCircle size={13} strokeWidth={2.4} aria-hidden className={cn(SPIN, "text-success")} />
                    <span>Waiting for the judge</span>
                    {clock}
                </div>
            ) : null}
        </div>
    );
}
