// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Agent surface's middle pane while the final stage's own row is focused: the stage has no session yet, so
// where a transcript would be it draws the stage in the transcript's look. One box of step rows, each opening in
// place to its body (the running command's live tail, a Tests card, or the output a step kept), then what an ended
// stage came to.

import { AutoHeight } from "@/app/element/autoheight";
import { CrossFade } from "@/app/element/crossfade";
import { errorNudge, viewFade } from "@/app/element/motiontokens";
import { PaneReveal } from "@/app/element/panereveal";
import { ViewSwap } from "@/app/element/viewswap";
import { globalStore } from "@/app/store/jotaiStore";
import { FinalShotsViewer } from "@/app/view/jarvis/finalshotsviewer";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { LoaderCircle } from "lucide-react";
import { motion, MotionConfig, type Variants } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { dockButtonClass } from "./endfinalform";
import {
    finalDetailAbove,
    finalFailedNote,
    finalStepBody,
    finalStepExit,
    finalStepOpens,
    finalStepOpensByDefault,
    STEP_WORDS,
    type FinalRoundLine,
    type FinalStageView,
    type FinalStep,
    type FinalStepKey,
    type FinalStepState,
    type FinalTone,
} from "./finalstage";
import {
    EndFinalStage,
    FinalUnverified,
    RerunFinalStage,
    StepMemory,
    useFinalStageView,
    useKeptOutput,
} from "./finalstageviews";
import { TRANSCRIPT_COLUMN } from "./renderedview";
import { fmtDuration } from "./runcompletion";
import { leadAgentOf, stageLabel, verifierStepTarget, type RunInfo } from "./runlineage";
import { FINAL_FILL } from "./runstrip";
import { ToolPanel } from "./steprows";
import { StatusSquare, ToolDetailBody, TurnChevron } from "./tooldetailbody";
import { TestCard } from "./toolrenderers";

// the states a stage ends in without failing: a rerun the human asked for is answered by one of these or by failed
const ENDED_CLEAN = new Set(["passed", "unverified"]);
// the states whose row shows a time on its right; the others say their state
const TIMED = new Set<FinalStepState>(["passed", "failed", "running"]);
// a step that has not run reads quieter: its label ink-mid
const QUIET = new Set<FinalStepState>(["waiting", "notrun"]);
// the transcript's statusWordTone: a step a human stopped, or one that could not verify, warns; other words are muted
const WARN = new Set<FinalStepState>(["stopped", "unverified"]);
const TAIL_NOTE = "output tail · the engine publishes it every 10s";

// a step's mark: the transcript's status square, or its spinner while the step runs
function StepMark({ state }: { state: FinalStepState }) {
    const kind = state === "passed" || state === "failed" || state === "running" ? state : "pending";
    return (
        <span data-final-step-mark={kind} className="flex size-4 flex-none items-center justify-center">
            <CrossFade swapKey={kind}>
                {kind === "running" ? (
                    <LoaderCircle
                        size={14}
                        strokeWidth={2.2}
                        role="img"
                        aria-label="Running"
                        className="shrink-0 animate-spin text-ink-mid"
                    />
                ) : (
                    <StatusSquare ok={kind === "passed"} pending={kind === "pending"} />
                )}
            </CrossFade>
        </span>
    );
}

// the row's right side: a failed step's exit chip, then its time, or the state word of a step with none to show. A
// failed step with no time says nothing more than its chip.
function StepFacts({ view, step }: { view: FinalStageView; step: FinalStep }) {
    const timed = TIMED.has(step.state) && step.ms != null;
    const word = !timed && step.state !== "failed";
    return (
        <>
            {step.state === "failed" ? (
                <span
                    data-final-step-exit
                    className="flex-none rounded-[4px] bg-error/15 px-1.5 py-px font-mono text-[11px] text-error"
                >
                    {finalStepExit(view, step)}
                </span>
            ) : null}
            {timed ? (
                <span data-final-step-fact className="flex-none font-mono text-[11px] text-muted">
                    {fmtDuration(step.ms)}
                </span>
            ) : word ? (
                <span
                    data-final-step-fact
                    className={cn("flex-none text-[12px]", WARN.has(step.state) ? "text-warning" : "text-muted")}
                >
                    {STEP_WORDS[step.state]}
                </span>
            ) : null}
        </>
    );
}

// a running command's live output, read from its end: each publish keeps the newest lines in view
function StepTail({ command, output }: { command: string; output: string }) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        ref.current?.scrollTo({ top: ref.current.scrollHeight });
    }, [output]);
    return (
        <>
            <ToolPanel>
                <div ref={ref} className="sc max-h-[360px] overflow-y-auto">
                    <ToolDetailBody
                        detail={{ kind: "bash", command, output: output.trimEnd(), exit: null }}
                        variant="inline"
                    />
                </div>
            </ToolPanel>
            <div className="mt-1.5 font-mono text-[10.5px] text-muted">{TAIL_NOTE}</div>
        </>
    );
}

// an opened step's body, as finalStepBody decides it; an ended step's trades its tail for what it kept
function StepBody({ view, step }: { view: FinalStageView; step: FinalStep }) {
    const kept = useKeptOutput(step.kept);
    const body = finalStepBody(view, step, kept);
    const swapKey = body.kind === "tail" ? "tail" : kept.status === "loading" ? "loading" : "kept";
    return (
        <div data-final-step-body={step.key} className="mt-2.5">
            <ViewSwap swapKey={swapKey}>
                {body.kind === "tail" ? (
                    <StepTail command={body.command} output={body.output} />
                ) : body.kind === "card" ? (
                    <TestCard summary={body.summary} output={body.output} />
                ) : (
                    <ToolPanel error={body.error}>
                        <ToolDetailBody
                            detail={{ kind: "bash", command: body.command, output: body.output.trimEnd(), exit: null }}
                            variant="inline"
                            capped
                        />
                        {body.note ? <div className="-mt-0.5 px-3 pb-2 text-[12px] text-muted">{body.note}</div> : null}
                    </ToolPanel>
                )}
            </ViewSwap>
        </div>
    );
}

// One step in StepRow's look: mark, label, its command (or the memory gate's hold), the facts and a chevron when it
// opens. The Verifier's row opens the verifier's session instead, when there is one.
function FinalStepRow({
    view,
    step,
    open,
    onToggle,
    onOpenSession,
}: {
    view: FinalStageView;
    step: FinalStep;
    open: boolean;
    onToggle: () => void;
    onOpenSession?: () => void;
}) {
    const opens = finalStepOpens(view, step);
    const onClick = opens ? onToggle : onOpenSession;
    const head = cn(
        "flex w-full min-w-0 items-center gap-2.5 text-left font-sans text-[13.5px]",
        QUIET.has(step.state) ? "text-ink-mid" : "text-secondary"
    );
    const content = (
        <>
            <StepMark state={step.state} />
            <span className="flex-none">{step.label}</span>
            {step.memory ? (
                <StepMemory memory={step.memory} className="min-w-0 shrink-[100] text-[12px]" />
            ) : step.key !== "verifier" ? (
                <span
                    data-final-step-command
                    title={step.command}
                    className="min-w-0 shrink-[100] truncate font-mono text-[12px] text-muted"
                >
                    {step.command}
                </span>
            ) : null}
            <span className="min-w-[6px] flex-1" />
            <StepFacts view={view} step={step} />
            {opens ? (
                <span className="flex flex-none text-muted">
                    <TurnChevron open={open} size={12} strokeWidth={2.2} />
                </span>
            ) : null}
        </>
    );
    return (
        <div data-final-step={step.key} data-final-step-state={step.state} className="px-3.5 py-2.5">
            {onClick ? (
                <button
                    type="button"
                    data-final-step-head
                    aria-expanded={opens ? open : undefined}
                    title={opens ? undefined : "Open the verifier's session"}
                    onClick={onClick}
                    className={cn(head, "cursor-pointer")}
                >
                    {content}
                </button>
            ) : (
                <div data-final-step-head className={head}>
                    {content}
                </div>
            )}
            <PaneReveal open={opens && open}>
                <StepBody view={view} step={step} />
            </PaneReveal>
        </div>
    );
}

const PAST_MARK: Record<FinalTone, { ok: boolean; pending?: boolean }> = {
    pass: { ok: true },
    fail: { ok: false },
    wait: { ok: false, pending: true },
    run: { ok: false, pending: true },
    warn: { ok: false, pending: true },
};

// An earlier round: its outcome, its screenshots, and a click that opens its failure detail beneath.
function PastRound({ line, group }: { line: FinalRoundLine; group: TaskGroup }) {
    const [open, setOpen] = useState(false);
    const [viewing, setViewing] = useState(false);
    const opens = line.detail !== "";
    return (
        <div className="flex flex-col">
            <div
                data-final-past-round={line.round}
                role={opens ? "button" : undefined}
                aria-expanded={opens ? open : undefined}
                onClick={opens ? () => setOpen(!open) : undefined}
                className={cn("flex items-center gap-2.5 py-1.5 text-[13px] text-secondary", opens && "cursor-pointer")}
            >
                <StatusSquare {...PAST_MARK[line.tone]} />
                <span className="flex-none">Round {line.round}</span>
                <span className="min-w-0 truncate font-mono text-[12px] text-muted">{line.outcome}</span>
                <span className="flex-1" />
                {line.hasShots ? (
                    <button
                        type="button"
                        data-final-past-round-shots
                        onClick={(e) => {
                            e.stopPropagation();
                            setViewing(true);
                        }}
                        className="flex-none cursor-pointer text-[12px] text-accent-soft hover:text-accent"
                    >
                        screenshots
                    </button>
                ) : null}
                {opens ? (
                    <span className="flex flex-none text-muted">
                        <TurnChevron open={open} size={12} strokeWidth={2.2} />
                    </span>
                ) : null}
            </div>
            <PaneReveal open={open}>
                <div data-final-past-round-detail className="pb-1.5">
                    <ToolPanel error={line.detail} />
                </div>
            </PaneReveal>
            {/* outside the line: the portaled viewer's clicks still bubble through the React tree */}
            {viewing ? (
                <FinalShotsViewer group={group} initial={{ round: line.round }} onClose={() => setViewing(false)} />
            ) : null}
        </div>
    );
}

export function FinalStagePane({ model, run }: { model: AgentsViewModel; run: RunInfo }) {
    const now = useAtomValue(model.nowAtom);
    const view = useFinalStageView(run.dag, run.runId, run.channelId, now);
    const agents = useAtomValue(model.agentsAtom);
    const lead = leadAgentOf(useAtomValue(model.lineageAtom), agents, run.runId);
    // the verifier's transcript is its output, so its step opens that session
    const verifierTarget = verifierStepTarget(run, agents);
    // a row's open state is the human's click when there is one, else its default; a new round starts clean
    const [chosen, setChosen] = useState<{ round: number; open: Partial<Record<FinalStepKey, boolean>> }>({
        round: view.round,
        open: {},
    });
    const choices = chosen.round === view.round ? chosen.open : {};
    const isOpen = (step: FinalStep) => choices[step.key] ?? finalStepOpensByDefault(view, step);
    const toggle = (step: FinalStep) =>
        setChosen({ round: view.round, open: { ...choices, [step.key]: !isOpen(step) } });
    // the failed note's moment, picked on the render the stage turns failed: a nudge when it answers the human's
    // own rerun ("your action failed, here"), else a fade. Cleared once played, so a remount never replays it.
    const [rerunAsked, setRerunAsked] = useState(false);
    const [stage, setStage] = useState<{ state: string; note: Variants | null }>({ state: view.state, note: null });
    if (stage.state !== view.state) {
        const failedNow = view.state === "failed";
        setStage({ state: view.state, note: failedNow ? (rerunAsked ? errorNudge : viewFade) : null });
        if (failedNow || ENDED_CLEAN.has(view.state)) {
            setRerunAsked(false);
        }
    }
    const detailAbove = finalDetailAbove(view);

    return (
        <div data-final-pane className="flex min-h-0 flex-1 flex-col bg-background">
            {/* not clipped: the end form opens under its button */}
            {/* wraps rather than truncate: the headline's end is the outcome ("failed at Final"). Its basis keeps it from
                shrinking under its words beside the buttons in a narrow center; short of it, it takes its own line */}
            <div className="flex flex-none flex-wrap items-center gap-x-[10px] gap-y-[6px] border-b border-border px-[22px] py-[12px]">
                <span
                    aria-hidden
                    className={cn(
                        "h-[7px] w-[7px] flex-none rounded-full",
                        view.tone === "wait" ? "border border-muted" : FINAL_FILL[view.tone]
                    )}
                />
                <span className="flex-none text-[13px] font-semibold text-foreground">{stageLabel("verifier")}</span>
                <span data-final-headline className="min-w-0 flex-[1_1_12rem] font-mono text-[10.5px] text-ink-mid">
                    {view.headline}
                </span>
                <EndFinalStage group={run.dag} channelId={run.channelId} runId={run.runId} />
                <RerunFinalStage
                    group={run.dag}
                    channelId={run.channelId}
                    runId={run.runId}
                    className={dockButtonClass()}
                    onRerun={() => setRerunAsked(true)}
                />
            </div>
            <div className="sc min-h-0 flex-1 overflow-y-auto px-6 py-[18px]">
                <div className={TRANSCRIPT_COLUMN}>
                    {/* a failure no command step's panel holds (the verifier's, the end review's, a human's end) */}
                    {detailAbove !== "" ? (
                        <div data-final-detail className="mt-2.5">
                            <ToolPanel error={detailAbove} />
                        </div>
                    ) : null}
                    {view.steps.length > 0 ? (
                        <div
                            data-final-steps
                            className="my-2.5 divide-y divide-edge-faint overflow-hidden rounded-[10px] border border-edge-mid"
                        >
                            {view.steps.map((step) => (
                                <FinalStepRow
                                    key={step.key}
                                    view={view}
                                    step={step}
                                    open={isOpen(step)}
                                    onToggle={() => toggle(step)}
                                    onOpenSession={
                                        step.key === "verifier" && verifierTarget != null
                                            ? () => globalStore.set(model.focusIdAtom, verifierTarget)
                                            : undefined
                                    }
                                />
                            ))}
                        </div>
                    ) : null}
                    {run.dag && view.past.length > 0 ? (
                        <AutoHeight className="mt-1.5">
                            <div className="flex flex-col">
                                {view.past.map((line) => (
                                    <PastRound key={line.round} line={line} group={run.dag} />
                                ))}
                            </div>
                        </AutoHeight>
                    ) : null}
                    <FinalUnverified reasons={view.unverified} className="mt-1.5" />
                    {view.state === "failed" ? (
                        <MotionConfig reducedMotion="user">
                            <motion.span
                                data-final-note
                                variants={stage.note ?? viewFade}
                                initial={stage.note ? "initial" : false}
                                animate="animate"
                                onAnimationComplete={() => setStage((s) => (s.note ? { ...s, note: null } : s))}
                                className="mt-1 text-[12px] text-muted"
                            >
                                {finalFailedNote(lead ? { asking: lead.state === "asking" } : undefined)}
                            </motion.span>
                        </MotionConfig>
                    ) : null}
                </div>
            </div>
        </div>
    );
}
