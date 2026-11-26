// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Rendered transcript's question card: the talk question with its why, its numbered rows (the approaches while the
// judge weighs, else the read, the options with the pick's badge, the judge's ranking and pros and cons, and the
// judge's work with its dropped approaches, drawn as the pane draws them), Guess for me, Skip and the picks hint. A
// pick sends what the pane sends, recorded as picked here. OptionRows also draws the builder's question
// (renderedbscheck.tsx).

import { PaneReveal } from "@/app/element/panereveal";
import { ViewSwap } from "@/app/element/viewswap";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { Lightbulb, LoaderCircle, Scale } from "lucide-react";
import { useState, type JSX, type ReactNode } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { hasProsCons, OPTION_KEYS, partTitle, type AnswerOption, type BrainstormAction } from "./brainstormmodel";
import { sendBrainstorm } from "./brainstormsend";
import { openBrainstormAt, type BrainstormState } from "./brainstormstore";
import { CHIP, ErrorLine, JudgeWorkLine, ProsConsToggle, ReasonList, useAction } from "./brainstormui";
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
const KEY_SIZE = "h-[24px] w-[24px]";
const LINE_READ = "text-[14px] leading-[1.55]";
const LINE_WORK = "text-[13.5px] leading-[1.5]";
const LINE_COMPACT = "text-[12.5px] leading-[1.5]";

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

// a row's pros and cons, indented to its label: two columns, one when compact
function ProsCons({ o, compact }: { o: AnswerOption; compact: boolean }) {
    return (
        <div
            data-rendered-bs-proscons
            className={cn(
                "grid",
                compact
                    ? "grid-cols-1 gap-1.5 pb-[9px] pl-[48px] pr-3"
                    : "grid-cols-2 gap-5 pb-[14px] pl-[50px] pr-[14px]"
            )}
        >
            <ReasonList label={`${o.label}: for`} mark="+" tone="text-success" items={o.pros} compact={compact} />
            <ReasonList label={`${o.label}: against`} mark="−" tone="text-error" items={o.cons} compact={compact} />
        </div>
    );
}

// numbered rows, each one answer sent by its label, with its detail full width under the label. locked is why the rows
// are disabled ("" for no reason shown), null while they answer; badge marks the pick and note tags a row (the judge's
// ranking), both beside the label; reasons shows each row's pros and cons under it; chip draws beside the row (under
// it when compact), outside its button so it never sends the answer
export function OptionRows({
    options,
    onPick,
    locked,
    badge,
    chip,
    note,
    reasons = false,
    compact,
}: {
    options: AnswerOption[];
    onPick: (label: string) => void;
    locked: string | null;
    badge?: (i: number) => string | null;
    chip?: (i: number) => ReactNode | null;
    note?: (i: number) => string | null;
    reasons?: boolean;
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
                const beside = c != null && !compact;
                return (
                    <div
                        key={i}
                        data-rendered-bs-option-row={i}
                        className={cn(
                            "rounded-[8px] border has-[>button:focus-visible]:ring-2 has-[>button:focus-visible]:ring-accent",
                            beside ? "grid grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_1fr]" : "flex flex-col",
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
                                "flex min-w-0 cursor-pointer items-start gap-3 border-0 bg-transparent text-left outline-none disabled:cursor-default disabled:opacity-50",
                                compact ? "px-3 py-[9px]" : "px-[14px] py-3"
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
                            <span className={cn("flex min-w-0 flex-1 flex-col", compact ? "gap-0.5" : "gap-1")}>
                                <span className="flex flex-wrap items-baseline gap-x-[10px] gap-y-0.5">
                                    <span
                                        data-rendered-bs-option-label
                                        className={cn(
                                            "font-semibold leading-[1.4] text-primary",
                                            compact ? "pt-0.5 text-[13px]" : "text-[14.5px]"
                                        )}
                                    >
                                        {o.label}
                                    </span>
                                    {b != null ? <PickBadge label={b} /> : null}
                                    {n != null ? (
                                        <span
                                            data-rendered-bs-option-note
                                            className="whitespace-nowrap text-[12px] text-muted"
                                        >
                                            {n}
                                        </span>
                                    ) : null}
                                </span>
                                {o.detail ? (
                                    <span
                                        data-rendered-bs-option-detail
                                        className={cn(
                                            "min-w-0 text-ink-mid",
                                            compact ? "text-[12.5px] leading-[1.45]" : "text-[13.5px] leading-[1.5]"
                                        )}
                                    >
                                        {o.detail}
                                    </span>
                                ) : null}
                            </span>
                        </button>
                        {c != null ? (
                            <div
                                data-rendered-bs-option-chip
                                className={
                                    beside
                                        ? "col-start-2 row-span-2 row-start-1 py-3 pr-[14px]"
                                        : "pb-[9px] pl-[48px] pr-3"
                                }
                            >
                                {c}
                            </div>
                        ) : null}
                        {o.pros != null || o.cons != null ? (
                            <PaneReveal open={reasons}>
                                <ProsCons o={o} compact={compact} />
                            </PaneReveal>
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
    // hidden until asked for: the card sits in a transcript, where the pane starts them shown
    const [reasonsShown, setReasonsShown] = useState(false);
    const q = f.question;
    if (q == null) {
        return null;
    }
    const rows = questionRows(q, judging);
    // the read and the pros and cons are left out while the judge weighs, as the pane does
    const prosCons = !judging && hasProsCons(q);
    const readLine = !judging && (!!q.read || prosCons);
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
                {rows.options.length > 0 || rows.work != null || readLine ? (
                    <ViewSwap swapKey={rows.state} className="flex flex-col">
                        {readLine ? (
                            <div className={cn("flex items-baseline gap-3", compact ? "mb-2" : "mb-3")}>
                                <span
                                    data-rendered-bs-read
                                    className={cn("min-w-0 flex-1 text-secondary", compact ? LINE_COMPACT : LINE_READ)}
                                >
                                    {q.read ? (
                                        <>
                                            <span className="font-semibold text-accent-soft">
                                                {rows.work?.judged ? "Judge’s" : "Agent’s"} read:{" "}
                                            </span>
                                            {q.read}
                                        </>
                                    ) : null}
                                </span>
                                {prosCons ? (
                                    <ProsConsToggle
                                        shown={reasonsShown}
                                        onToggle={() => setReasonsShown(!reasonsShown)}
                                    />
                                ) : null}
                            </div>
                        ) : null}
                        <OptionRows
                            options={rows.options}
                            onPick={(text) => send({ kind: "answer", text })}
                            locked={act.busy ? "" : null}
                            badge={rows.badge}
                            note={rows.note}
                            chip={boards.chip}
                            reasons={prosCons && reasonsShown}
                            compact={compact}
                        />
                        {rows.work != null ? (
                            <JudgeWorkLine
                                work={rows.work}
                                compact={compact}
                                lineText={compact ? LINE_COMPACT : LINE_WORK}
                            />
                        ) : null}
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
