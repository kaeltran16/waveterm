// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The builder check card in the Rendered transcript: the builder reading (its clock against how long checks here
// usually take), the agent taking in its questions, a check that did not finish, the questions back with the one for
// the user, and the approve card once they are settled. Each state is the pane's own view of it: checkClock (in the
// boards' words), handoffView, checkAsk and approveBlocker.

import { openFileInCode } from "@/app/cockpit/openfilestore";
import { barFillClass, composerReveal } from "@/app/element/motiontokens";
import { PaneReveal } from "@/app/element/panereveal";
import { TickNumber } from "@/app/element/ticknumber";
import { ViewSwap } from "@/app/element/viewswap";
import * as WOS from "@/app/store/wos";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { ArrowUpRight, FileCheck, FileX, LoaderCircle } from "lucide-react";
import type { JSX } from "react";
import type { AgentsViewModel } from "./agents";
import { projectOf, type AgentVM } from "./agentsviewmodel";
import {
    approveBlocker,
    builderCheckView,
    checkAsk,
    checkSpan,
    handoffView,
    runPrefill,
    type BrainstormAction,
    type BrainstormFile,
    type BuilderCheckView,
} from "./brainstormmodel";
import { NO_RUN, useCheckTimes } from "./brainstormpane";
import { approveAndOpenRun, sendBrainstorm } from "./brainstormsend";
import { openBrainstormAt, type BrainstormState } from "./brainstormstore";
import { CHIP, ErrorLine, SMALL_DOT, useAction } from "./brainstormui";
import { CANVAS_BTN, CANVAS_PRIMARY_BTN } from "./canvaspane";
import { CardFrame, headIconSize, useCardRow } from "./renderedbrainstorm";
import type { CardProps } from "./renderedbrainstormmodel";
import {
    builderHead,
    cardClock,
    CHECK_FAILED_LINE,
    CHECK_SETTLED_LINE,
    checkCardState,
    checkRowTitle,
    clockBar,
    noteLead,
    settledLine,
} from "./renderedbscheckmodel";
import { OptionRows, PicksHint } from "./renderedbsquestion";

const OPEN_LINK =
    "inline-flex flex-none cursor-pointer items-center gap-1 whitespace-nowrap border-0 bg-transparent p-0 text-[12px] text-accent-soft hover:underline";
const SPIN = "flex-none animate-spin motion-reduce:animate-none";
// the boards draw the spinner a size under the other header icons
const SPIN_PX = 14;
const CHECK_KIND = "Builder check";

type Pending = Extract<BuilderCheckView, { kind: "pending" }>;

// the builder's time against how long checks here usually take; only this re-renders each tick
function ClockBox({
    model,
    agent,
    s,
    f,
    check,
    compact,
}: {
    model: AgentsViewModel;
    agent: AgentVM;
    s: BrainstormState;
    f: BrainstormFile;
    check: Pending;
    compact: boolean;
}) {
    const record = agent.builderCheck;
    const run = useAtomValue(record?.runId ? WOS.getWaveObjectAtom<Run>(WOS.makeORef("run", record.runId)) : NO_RUN);
    const now = useAtomValue(model.nowAtom);
    const times = useCheckTimes(record?.runId);
    const clock = cardClock(check, checkSpan(record, run ?? null), times, now);
    const bar = clockBar(clock.bar, clock.over);
    const note = noteLead(clock.note);
    const icon = clock.running ? (
        <LoaderCircle
            size={SPIN_PX}
            strokeWidth={2.4}
            aria-hidden
            className={cn(SPIN, clock.over ? "text-warning" : "text-success")}
        />
    ) : (
        <span className={cn(SMALL_DOT, "mx-1 bg-success")} />
    );
    return (
        <div data-rendered-bs-check-pending={check.stage} aria-live="polite">
            <CardFrame
                agent={agent}
                s={s}
                f={f}
                asking={false}
                icon={icon}
                kind={CHECK_KIND}
                subject={clock.line}
                status={clock.times != null ? <span data-rendered-bs-check-times>{clock.times}</span> : ""}
                link={
                    clock.running && clock.elapsed != null ? (
                        <span
                            data-rendered-bs-check-clock="running"
                            className={cn(
                                "whitespace-nowrap font-mono text-[12px]",
                                clock.over ? "text-warning" : "text-secondary"
                            )}
                        >
                            {clock.elapsed}
                        </span>
                    ) : null
                }
                title={clock.line}
                compact={compact}
                attr="data-rendered-bs-check-clockcard"
            >
                <div className="flex flex-col gap-[10px]">
                    {bar != null ? (
                        <div data-rendered-bs-check-bar className="relative h-1 rounded-[2px] bg-edge-mid">
                            <span
                                data-rendered-bs-check-fill={bar.over ? "over" : "within"}
                                className={cn(
                                    "absolute inset-y-0 left-0 rounded-[2px]",
                                    bar.over ? "bg-warning" : "bg-success",
                                    barFillClass
                                )}
                                style={{ width: bar.fill }}
                            />
                            <span
                                data-rendered-bs-check-usual
                                className="absolute top-[-3px] h-[10px] w-[2px] rounded-[1px] bg-ink-mid"
                                style={{ left: bar.usual }}
                            />
                        </div>
                    ) : null}
                    <span
                        data-rendered-bs-check-note
                        className={cn("leading-[1.5] text-muted", compact ? "text-[12px]" : "text-[12.5px]")}
                    >
                        {note.lead ? (
                            <span data-rendered-bs-check-note-lead className="text-warning">
                                {note.lead}
                            </span>
                        ) : null}
                        {note.rest}
                    </span>
                </div>
            </CardFrame>
        </div>
    );
}

function FailedBox({
    agent,
    s,
    f,
    reason,
    compact,
}: {
    agent: AgentVM;
    s: BrainstormState;
    f: BrainstormFile;
    reason: string;
    compact: boolean;
}) {
    const act = useAction();
    return (
        <CardFrame
            agent={agent}
            s={s}
            f={f}
            asking={false}
            tone="error"
            icon={<FileX size={headIconSize(compact)} strokeWidth={2} aria-hidden className="flex-none text-error" />}
            kind={CHECK_KIND}
            subject={CHECK_FAILED_LINE}
            status=""
            link={
                <button
                    type="button"
                    data-rendered-bs-check-retry
                    disabled={act.busy}
                    onClick={() =>
                        void act.run(() => sendBrainstorm(agent, { kind: "check" }, undefined, undefined, "transcript"))
                    }
                    className={cn(
                        CANVAS_BTN,
                        "flex-none px-[10px] py-1 text-[12px] disabled:cursor-default disabled:opacity-50"
                    )}
                >
                    Try again
                </button>
            }
            title={CHECK_FAILED_LINE}
            compact={compact}
            attr="data-rendered-bs-check-failed"
        >
            {reason || act.error != null ? (
                <>
                    {reason ? (
                        <span
                            data-rendered-bs-check-reason
                            className={cn("leading-[1.5] text-ink-mid", compact ? "text-[12px]" : "text-[12.5px]")}
                        >
                            {reason}
                        </span>
                    ) : null}
                    <ErrorLine error={act.error} attrs={{ "data-rendered-bs-error": "" }} />
                </>
            ) : undefined}
        </CardFrame>
    );
}

// how many questions came back and how they split: already in the design, the agent's calls, and the user's
function SummaryBox({
    model,
    agent,
    s,
    f,
    compact,
}: {
    model: AgentsViewModel;
    agent: AgentVM;
    s: BrainstormState;
    f: BrainstormFile;
    compact: boolean;
}) {
    const hv = handoffView(f);
    const spec = f.spec ? runPrefill(f, { projectName: projectOf(agent), cwd: s.cwd }).spec : undefined;
    return (
        <CardFrame
            agent={agent}
            s={s}
            f={f}
            asking={false}
            icon={<FileCheck size={headIconSize(compact)} strokeWidth={2} aria-hidden className="flex-none" />}
            kind={CHECK_KIND}
            subject={
                <span data-rendered-bs-check-back>
                    <TickNumber value={hv.questions} /> {hv.questions === 1 ? "question" : "questions"} back
                </span>
            }
            status=""
            link={
                spec != null ? (
                    <button
                        type="button"
                        data-rendered-bs-check-spec
                        onClick={() => fireAndForget(() => openFileInCode(model, spec))}
                        className={OPEN_LINK}
                    >
                        Spec
                        <ArrowUpRight size={11} strokeWidth={2.2} aria-hidden />
                    </button>
                ) : null
            }
            title={CHECK_KIND}
            compact={compact}
            attr="data-rendered-bs-check-summary"
        >
            <div className="flex flex-col gap-2">
                {f.spec ? (
                    <span
                        data-rendered-bs-check-spec-path
                        className={cn(
                            "font-mono text-secondary [overflow-wrap:anywhere]",
                            compact ? "text-[12px]" : "text-[12.5px]"
                        )}
                    >
                        {f.spec}
                    </span>
                ) : null}
                <div
                    data-rendered-bs-check-counts
                    className="flex flex-wrap gap-x-[18px] gap-y-1 text-[12.5px] text-muted"
                >
                    <span>
                        <span className="font-semibold text-secondary">
                            <TickNumber value={hv.already} />
                        </span>{" "}
                        already in the design
                    </span>
                    <span>
                        <span className="font-semibold text-secondary">
                            <TickNumber value={hv.calls.length} />
                        </span>{" "}
                        the agent decided
                    </span>
                    <span>
                        <span className="font-semibold text-warning">
                            <TickNumber value={hv.forYou} />
                        </span>{" "}
                        for you
                    </span>
                </div>
            </div>
        </CardFrame>
    );
}

// the builder's open question, asked as the talk question is: its answers, the agent decides, or a line in the box
function BuilderQuestion({
    agent,
    s,
    f,
    compact,
}: {
    agent: AgentVM;
    s: BrainstormState;
    f: BrainstormFile;
    compact: boolean;
}) {
    const act = useAction();
    const open = checkAsk(f).open!;
    const head = builderHead(f);
    const options = open.options ?? [];
    const send = (a: BrainstormAction) =>
        void act.run(() => sendBrainstorm(agent, a, undefined, undefined, "transcript"));
    return (
        <CardFrame
            agent={agent}
            s={s}
            f={f}
            asking={true}
            icon={<FileCheck size={headIconSize(compact)} strokeWidth={2} aria-hidden className="flex-none" />}
            kind="Builder question"
            subject={`${head.index} of ${head.total}`}
            status=""
            title={head.lead}
            compact={compact}
            attr="data-rendered-bs-builder-question"
        >
            <div className="flex flex-col gap-1.5">
                <span data-rendered-bs-q-meta className="min-w-0 truncate text-[12.5px] text-muted">
                    Builder question {head.index}
                    {head.part != null ? (
                        <>
                            {" "}
                            <span className="text-ink-faint">→</span>{" "}
                            <button
                                type="button"
                                data-rendered-bs-part-link
                                onClick={() => openBrainstormAt(agent.id, { part: head.part!.id })}
                                className="cursor-pointer border-0 bg-transparent p-0 text-secondary hover:underline"
                            >
                                {head.part.title}
                            </button>
                        </>
                    ) : null}
                </span>
                <span
                    data-rendered-bs-q-text
                    className={cn(
                        "whitespace-pre-line font-semibold leading-[1.4] text-primary",
                        compact ? "text-[15px]" : "text-[17px]"
                    )}
                >
                    {open.q}
                </span>
                {open.why ? (
                    <span
                        data-rendered-bs-q-why
                        className={cn("leading-[1.55] text-ink-mid", compact ? "text-[12.5px]" : "text-[13.5px]")}
                    >
                        {open.why}
                    </span>
                ) : null}
            </div>
            <OptionRows
                options={options}
                onPick={(text) => send({ kind: "builder-answer", text })}
                locked={act.busy ? "" : null}
                compact={compact}
            />
            <div
                data-rendered-bs-q-actions
                className={cn("flex gap-[10px]", compact ? "flex-col items-start" : "items-center")}
            >
                <button
                    type="button"
                    data-rendered-bs-builder-decide
                    disabled={act.busy}
                    onClick={() => send({ kind: "builder-decide" })}
                    className={CHIP}
                >
                    Let the agent decide
                </button>
                {compact ? null : <span className="flex-1" />}
                <PicksHint rows={options.length} />
            </div>
            <ErrorLine error={act.error} attrs={{ "data-rendered-bs-error": "" }} />
        </CardFrame>
    );
}

// every builder question answered: approving starts the run from the spec, keeping talking goes back to the agent
function ApproveCard({
    model,
    agent,
    s,
    f,
    compact,
}: {
    model: AgentsViewModel;
    agent: AgentVM;
    s: BrainstormState;
    f: BrainstormFile;
    compact: boolean;
}) {
    const act = useAction();
    const blocker = approveBlocker(f);
    const buttons = compact ? "w-full justify-center" : "flex-none";
    return (
        <CardFrame
            agent={agent}
            s={s}
            f={f}
            asking={true}
            chip="Ready to approve"
            status={CHECK_KIND}
            title={CHECK_SETTLED_LINE}
            compact={compact}
            attr="data-rendered-bs-approve"
        >
            <div className={cn("flex gap-4", compact ? "flex-col" : "items-center")}>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className={cn("font-semibold text-primary", compact ? "text-[14px]" : "text-[15px]")}>
                        {CHECK_SETTLED_LINE}
                    </span>
                    <span className={cn("leading-[1.5] text-ink-mid", compact ? "text-[12.5px]" : "text-[13.5px]")}>
                        {settledLine(handoffView(f).questions)}
                    </span>
                    <PaneReveal open={blocker != null} variants={composerReveal}>
                        <span data-rendered-bs-approve-reason className="block text-[12px] leading-[1.45] text-warning">
                            {blocker}
                        </span>
                    </PaneReveal>
                    <ErrorLine error={act.error} attrs={{ "data-rendered-bs-error": "" }} />
                </div>
                <div className={cn("flex gap-[10px]", compact ? "flex-col" : "flex-none items-center")}>
                    <button
                        type="button"
                        data-rendered-bs-keep-talking
                        disabled={act.busy}
                        onClick={() =>
                            void act.run(() =>
                                sendBrainstorm(agent, { kind: "keep-talking" }, undefined, undefined, "transcript")
                            )
                        }
                        className={cn(CANVAS_BTN, buttons, "disabled:cursor-default disabled:opacity-50")}
                    >
                        Keep talking
                    </button>
                    <button
                        type="button"
                        data-rendered-bs-approve-btn
                        disabled={blocker != null || act.busy}
                        title={blocker ?? undefined}
                        onClick={() => void act.run(() => approveAndOpenRun(model, agent, s))}
                        className={cn(CANVAS_PRIMARY_BTN, buttons)}
                    >
                        Approve and start run
                    </button>
                </div>
            </div>
        </CardFrame>
    );
}

export function CheckCard({ model, agent, s, f, compact }: CardProps): JSX.Element | null {
    const check = builderCheckView(
        agent.builderCheck,
        s.sentCheckAt,
        s.file,
        s.modifiedMs,
        agent,
        s.turnStartMs,
        s.checkTakenTs
    );
    const row = useCardRow();
    const state = checkCardState(f, check, s.sent != null);
    if (row) {
        return (
            <CardFrame
                agent={agent}
                s={s}
                f={f}
                asking={state === "asking"}
                title={checkRowTitle(f, check, s.sent != null)}
                compact={compact}
                attr="data-rendered-bs-check-row"
            />
        );
    }
    // each builder question is a new card, as each talk question is
    const swapKey = state === "asking" ? `asking:${checkAsk(f).index}` : state;
    return (
        <ViewSwap swapKey={swapKey} className="flex flex-col gap-4">
            {check.kind === "pending" ? (
                <ClockBox model={model} agent={agent} s={s} f={f} check={check} compact={compact} />
            ) : check.kind === "failed" ? (
                <FailedBox agent={agent} s={s} f={f} reason={check.reason} compact={compact} />
            ) : (
                <>
                    <SummaryBox model={model} agent={agent} s={s} f={f} compact={compact} />
                    {state === "asking" ? (
                        <BuilderQuestion agent={agent} s={s} f={f} compact={compact} />
                    ) : (
                        <ApproveCard model={model} agent={agent} s={s} f={f} compact={compact} />
                    )}
                </>
            )}
        </ViewSwap>
    );
}
