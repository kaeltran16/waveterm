// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The builder check card in the Rendered transcript: the builder reading (its clock against how long checks here
// usually take), the agent taking in its questions, a check that did not finish, the questions back with the one for
// the user, and the approve bar once they are settled. Each state is the pane's own view of it: checkClock (in the
// boards' words), handoffView, checkAsk and approveBlocker.

import { openFileInCode } from "@/app/cockpit/openfilestore";
import { barFillClass, composerReveal } from "@/app/element/motiontokens";
import { PaneReveal } from "@/app/element/panereveal";
import { TickNumber } from "@/app/element/ticknumber";
import { ViewSwap } from "@/app/element/viewswap";
import * as WOS from "@/app/store/wos";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { ArrowUpRight, FileCheck, LoaderCircle } from "lucide-react";
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
import { CardFrame } from "./renderedbrainstorm";
import type { CardProps } from "./renderedbrainstormmodel";
import { builderHead, cardClock, checkCardState, clockBar, settledLine } from "./renderedbscheckmodel";
import { OptionRows } from "./renderedbsquestion";
import { picksHint } from "./renderedbsquestionmodel";

const OPEN_LINK =
    "inline-flex cursor-pointer items-center gap-1 whitespace-nowrap border-0 bg-transparent p-0 text-[12px] text-accent-soft hover:underline";
const SPIN = "flex-none animate-spin motion-reduce:animate-none";
const BOX = "flex flex-col rounded-[10px] border border-edge-mid bg-surface";

type Pending = Extract<BuilderCheckView, { kind: "pending" }>;

// the builder's time against how long checks here usually take; only this re-renders each tick
function ClockBox({
    model,
    agent,
    check,
    compact,
}: {
    model: AgentsViewModel;
    agent: AgentVM;
    check: Pending;
    compact: boolean;
}) {
    const record = agent.builderCheck;
    const run = useAtomValue(record?.runId ? WOS.getWaveObjectAtom<Run>(WOS.makeORef("run", record.runId)) : NO_RUN);
    const now = useAtomValue(model.nowAtom);
    const times = useCheckTimes(record?.runId);
    const clock = cardClock(check, checkSpan(record, run ?? null), times, now);
    const bar = clockBar(clock.bar, clock.over);
    return (
        <div
            data-rendered-bs-check-pending={check.stage}
            aria-live="polite"
            className={cn(BOX, compact ? "gap-2 px-[12px] py-[10px]" : "gap-[10px] px-[14px] py-3")}
        >
            <div className="flex items-center gap-x-[10px] gap-y-1 flex-wrap">
                {clock.running ? (
                    <LoaderCircle size={13} strokeWidth={2.4} aria-hidden className={cn(SPIN, "text-success")} />
                ) : (
                    <span className={cn(SMALL_DOT, "bg-success")} />
                )}
                <span className={cn("text-ink-mid", compact ? "text-[12.5px]" : "text-[13.5px]")}>Builder check</span>
                <span className={cn("font-semibold text-primary", compact ? "text-[12.5px]" : "text-[13.5px]")}>
                    {clock.line}
                </span>
                <span className="flex-1" />
                {clock.times != null ? (
                    <span
                        data-rendered-bs-check-times
                        className={cn("whitespace-nowrap text-[12px] text-muted", compact && "basis-full")}
                    >
                        {clock.times}
                    </span>
                ) : null}
                {clock.elapsed != null ? (
                    <span
                        data-rendered-bs-check-clock={clock.running ? "running" : "stopped"}
                        className="font-mono text-[12px] text-secondary"
                    >
                        {clock.elapsed}
                    </span>
                ) : null}
            </div>
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
                className={cn(
                    "leading-[1.5]",
                    compact ? "text-[12px]" : "text-[12.5px]",
                    clock.over ? "text-warning" : "text-muted"
                )}
            >
                {clock.note}
            </span>
        </div>
    );
}

function FailedBox({ agent, reason, compact }: { agent: AgentVM; reason: string; compact: boolean }) {
    const act = useAction();
    return (
        <div className="flex flex-col gap-2">
            <div
                data-rendered-bs-check-failed
                className={cn(
                    "flex gap-[14px] rounded-[10px] border border-error/40 bg-error/10 px-[14px] py-3",
                    compact ? "flex-col items-start" : "items-center"
                )}
            >
                <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                    <span
                        className={cn(
                            "flex items-center gap-2 font-semibold text-primary",
                            compact ? "text-[12.5px]" : "text-[13.5px]"
                        )}
                    >
                        <span className={cn(SMALL_DOT, "bg-error")} />
                        The builder check did not finish
                    </span>
                    {reason ? (
                        <span
                            data-rendered-bs-check-reason
                            className={cn("leading-[1.5] text-ink-mid", compact ? "text-[12.5px]" : "text-[13px]")}
                        >
                            {reason}
                        </span>
                    ) : null}
                </div>
                <button
                    type="button"
                    data-rendered-bs-check-retry
                    disabled={act.busy}
                    onClick={() =>
                        void act.run(() => sendBrainstorm(agent, { kind: "check" }, undefined, undefined, "transcript"))
                    }
                    className={cn(CANVAS_BTN, "flex-none disabled:cursor-default disabled:opacity-50")}
                >
                    Try again
                </button>
            </div>
            <ErrorLine error={act.error} attrs={{ "data-rendered-bs-error": "" }} />
        </div>
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
    const pad = compact ? "px-[12px]" : "px-[14px]";
    const spec = f.spec ? runPrefill(f, { projectName: projectOf(agent), cwd: s.cwd }).spec : undefined;
    return (
        <div data-rendered-bs-check-summary className={cn(BOX, "overflow-hidden")}>
            <div className={cn("flex items-center gap-[10px]", pad, compact ? "py-[10px]" : "py-3")}>
                <FileCheck size={15} strokeWidth={2} aria-hidden className="flex-none text-ink-mid" />
                <span className={cn("text-ink-mid", compact ? "text-[12.5px]" : "text-[13.5px]")}>Builder check</span>
                <span
                    data-rendered-bs-check-back
                    className={cn("font-semibold text-primary", compact ? "text-[12.5px]" : "text-[13.5px]")}
                >
                    <TickNumber value={hv.questions} /> {hv.questions === 1 ? "question" : "questions"} back
                </span>
                <span className="flex-1" />
                {spec != null ? (
                    <button
                        type="button"
                        data-rendered-bs-check-spec
                        onClick={() => fireAndForget(() => openFileInCode(model, spec))}
                        className={OPEN_LINK}
                    >
                        Spec
                        <ArrowUpRight size={11} strokeWidth={2.2} aria-hidden />
                    </button>
                ) : null}
            </div>
            {f.spec ? (
                <div
                    data-rendered-bs-check-spec-path
                    className={cn(
                        "border-t border-edge-faint pb-1 pt-[9px] font-mono text-[12px] text-ink-mid [overflow-wrap:anywhere]",
                        pad
                    )}
                >
                    {f.spec}
                </div>
            ) : null}
            <div
                data-rendered-bs-check-counts
                className={cn("flex flex-wrap gap-x-4 gap-y-1 pb-[11px] pt-1.5 text-[12.5px] text-muted", pad)}
            >
                <span>
                    <span className="text-secondary">
                        <TickNumber value={hv.already} />
                    </span>{" "}
                    already in the design
                </span>
                <span>
                    <span className="text-secondary">
                        <TickNumber value={hv.calls.length} />
                    </span>{" "}
                    the agent decided
                </span>
                <span>
                    <span className="text-warning">
                        <TickNumber value={hv.forYou} />
                    </span>{" "}
                    for you
                </span>
            </div>
        </div>
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
            lead={false}
            status=""
            compact={compact}
            attr="data-rendered-bs-builder-question"
            head={
                <>
                    <span className="whitespace-nowrap font-mono font-semibold">
                        {head.lead}
                        {head.part != null ? " →" : ""}
                    </span>
                    {head.part != null ? (
                        <button
                            type="button"
                            data-rendered-bs-part-link
                            onClick={() => openBrainstormAt(agent.id, { part: head.part!.id })}
                            className="min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-warning hover:underline"
                        >
                            {head.part.title}
                        </button>
                    ) : null}
                </>
            }
        >
            <div className="flex flex-col gap-1.5">
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
                <span data-rendered-bs-picks-hint className="text-[12px] text-muted">
                    {picksHint(options.length)}
                </span>
            </div>
            <ErrorLine error={act.error} attrs={{ "data-rendered-bs-error": "" }} />
        </CardFrame>
    );
}

// every builder question answered: approving starts the run from the spec, keeping talking goes back to the agent
function ApproveBar({
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
        <div
            data-rendered-bs-approve
            className={cn(
                BOX,
                "gap-[14px]",
                compact ? "px-[12px] py-[10px]" : "flex-row items-center px-[18px] py-[14px]"
            )}
        >
            <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span className={cn("font-semibold text-primary", compact ? "text-[14px]" : "text-[15px]")}>
                    A builder read the design
                </span>
                <span className={cn("leading-[1.5] text-ink-mid", compact ? "text-[12.5px]" : "text-[13px]")}>
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
    const state = checkCardState(f, check, s.sent != null);
    // each builder question is a new card, as each talk question is
    const swapKey = state === "asking" ? `asking:${checkAsk(f).index}` : state;
    return (
        <ViewSwap swapKey={swapKey} className="flex flex-col gap-4">
            {check.kind === "pending" ? (
                <ClockBox model={model} agent={agent} check={check} compact={compact} />
            ) : check.kind === "failed" ? (
                <FailedBox agent={agent} reason={check.reason} compact={compact} />
            ) : (
                <>
                    <SummaryBox model={model} agent={agent} s={s} f={f} compact={compact} />
                    {state === "asking" ? (
                        <BuilderQuestion agent={agent} s={s} f={f} compact={compact} />
                    ) : (
                        <ApproveBar model={model} agent={agent} s={s} f={f} compact={compact} />
                    )}
                </>
            )}
        </ViewSwap>
    );
}
