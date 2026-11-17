// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { MOTION, composerReveal, microFade, turnTransition } from "@/app/element/motiontokens";
import { PaneReveal } from "@/app/element/panereveal";
import { atoms } from "@/app/store/global";
import { modalsModel } from "@/app/store/modalmodel";
import { cn } from "@/util/util";
import { ArrowUpRight, Check, ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useAtomValue } from "jotai";
import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import type { AgentActionEntry } from "./agentsviewmodel";
import { ImageThumbs, toolZoomImages } from "./imagethumbs";
import { MarkdownMessage } from "./markdownmessage";
import { RecordedOutput } from "./recordedoutput";
import { toolRendererKey } from "./renderregistry";
import { fmtDuration } from "./runcompletion";
import { ToolDetailBody } from "./tooldetailbody";
import { formatDuration } from "./tooldetail";
import { ToolOutputRenderer } from "./toolrenderers";
import type { TranscriptContext } from "./transcriptcontext";
import { stepRows, stepTitle, type Step, type Thought } from "./transcriptlayout";
import { isCardKey } from "./wshcall";
import { WSH_STEP_SUMMARIES, wshRendererFor, type WshRendererProps, type WshStepSummary } from "./wshrenderers";

// a disclosure chevron that turns as its pane opens: right to down, or with `flip` down to up
export function TurnChevron({ open, size, strokeWidth, flip }: { open: boolean; size: number; strokeWidth: number; flip?: boolean }) {
    const Icon = flip ? ChevronDown : ChevronRight;
    return (
        <Icon
            size={size}
            strokeWidth={strokeWidth}
            aria-hidden
            style={turnTransition}
            className={cn("transition-transform motion-reduce:transition-none", open && (flip ? "rotate-180" : "rotate-90"))}
        />
    );
}

function Affordance({ open }: { open: boolean }) {
    return (
        <span className="flex shrink-0 text-muted">
            <TurnChevron open={open} size={12} strokeWidth={2.2} />
        </span>
    );
}

// a running step's elapsed, ticking here so the memoised timeline does not re-render each second
function Elapsed({ since }: { since?: number }) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, []);
    return since == null ? null : <span data-step-elapsed>{fmtDuration(Math.max(0, now - since))}</span>;
}

function editTotals(action: AgentActionEntry): { adds: number; dels: number } | null {
    if (action.detail?.kind !== "edit") {
        return null;
    }
    return action.detail.files.reduce((t, f) => ({ adds: t.adds + f.adds, dels: t.dels + f.dels }), { adds: 0, dels: 0 });
}

export function AddsDels({ adds, dels, compact }: { adds: number; dels: number; compact: boolean }) {
    const size = compact ? "text-[11px]" : "text-[12px]";
    return (
        <>
            <span className={cn("shrink-0 font-mono text-diff-added", size)}>+{adds}</span>
            <span className={cn("shrink-0 font-mono text-diff-removed", size)}>−{dels}</span>
        </>
    );
}

// the picked option(s) or the typed answer of an asked question, shown under its title
function askAnswer(action: AgentActionEntry): string | undefined {
    if (action.detail?.kind !== "ask") {
        return undefined;
    }
    const q = action.detail.questions[0];
    return q == null ? undefined : q.picked.length > 0 ? q.picked.join(", ") : q.typed;
}

function StepTitle({ step, compact }: { step: Step; compact: boolean }) {
    const { title, mono, subject } = stepTitle(step.action);
    const head = subject != null && title.endsWith(subject) ? title.slice(0, title.length - subject.length) : title;
    const answer = askAnswer(step.action);
    const totals = editTotals(step.action);
    const monoSize = compact ? "text-[11px]" : "text-[12px]";
    const line = (
        <>
            {title ? (
                <span className={cn("min-w-0", answer == null && "shrink-0", mono == null && "truncate")}>
                    {head}
                    {subject != null && head !== title ? <span className="text-foreground">{subject}</span> : null}
                </span>
            ) : null}
            {mono ? (
                // a bare command is the row's text, so it takes the row's color; under a title it is subordinate
                <span className={cn("min-w-0 truncate font-mono", title ? "text-muted" : undefined, monoSize)}>{mono}</span>
            ) : null}
            {step.action.summary && (step.action.verb === "grep" || step.action.verb === "glob") ? (
                <span className={cn("shrink-0 text-muted", compact ? "text-[11.5px]" : "text-[12.5px]")}>
                    {step.action.summary}
                </span>
            ) : null}
            {totals ? <AddsDels adds={totals.adds} dels={totals.dels} compact={compact} /> : null}
            {step.edits ? (
                <span
                    data-step-edits
                    className={cn("shrink-0 text-muted", compact ? "text-[11.5px]" : "text-[12.5px]")}
                >
                    {step.edits} edits
                </span>
            ) : null}
        </>
    );
    if (answer == null) {
        return line;
    }
    return (
        <span className="min-w-0 flex-1">
            <span className="block [overflow-wrap:anywhere]">{line}</span>
            <span className="mt-1 flex items-center gap-1.5 text-foreground">
                <Check size={12} strokeWidth={3} className="shrink-0 text-accent-soft" aria-hidden />
                {answer}
            </span>
        </span>
    );
}

// a quicker step's time is noise on the row; the full view still shows it
const STEP_DURATION_MIN_MS = 1000;

// the row's right side: a failed call's exit chip, then its time (a running one's live elapsed, a stopped one's word)
function StepFacts({ step, compact }: { step: Step; compact: boolean }) {
    const { action, status } = step;
    const chip = compact ? "px-[5px] text-[10.5px]" : "px-1.5 py-px text-[11px]";
    const time = cn("shrink-0 font-mono text-muted", compact ? "text-[10.5px]" : "text-[11px]");
    return (
        <>
            {status === "fail" ? (
                <span className={cn("shrink-0 rounded-[4px] bg-error/15 font-mono text-error", chip)}>
                    {/* a call that never ran has a null exit, so it reads failed rather than "exit null" */}
                    {action.detail?.kind === "bash" && action.detail.exit ? `exit ${action.detail.exit}` : "failed"}
                </span>
            ) : null}
            {status === "running" ? (
                <span className={time}>
                    <Elapsed since={action.startedTs ?? action.ts} />
                </span>
            ) : status === "stopped" || status === "blocked" ? (
                <span className={cn("shrink-0 text-muted", compact ? "text-[11px]" : "text-[12px]")}>{status}</span>
            ) : (action.durationMs ?? 0) >= STEP_DURATION_MIN_MS ? (
                <span data-step-duration className={time}>
                    {formatDuration(action.durationMs)}
                </span>
            ) : null}
        </>
    );
}

// a Bash step whose output parses as a test run or a git diff opens to that card rather than its raw output
function hasBodyCard(action: AgentActionEntry): boolean {
    const key = toolRendererKey(action);
    return key === "test" || key === "git-diff";
}

// a wsh read call's collapsed-row summary and its tone, from its own output when it exited 0
function stepSummary(step: Step): { text: string; tone: WshStepSummary["tone"] } | undefined {
    const { wsh, action, status } = step;
    if (!wsh || isCardKey(wsh.key) || status !== "ok" || action.detail?.kind !== "bash" || action.detail.exit !== 0) {
        return undefined;
    }
    const entry = WSH_STEP_SUMMARIES[wsh.key];
    const text = entry?.summary(wsh.call, action.detail.output);
    return text ? { text, tone: entry.tone } : undefined;
}

const BODY_BUTTON =
    "inline-flex cursor-pointer items-center gap-1.5 rounded-[5px] px-1.5 py-[3px] font-sans text-[12px] text-ink-mid hover:bg-lane hover:text-primary";

// a refused call is passed over, not failed, so its reason reads muted as the full view draws it
function errorTone(status: Step["status"]): string {
    return status === "blocked" ? "text-muted" : "text-error";
}

// a Bash call that never ran: the projection leaves its output empty and puts the reason in error
function isRefusedCommand(action: AgentActionEntry): boolean {
    return action.detail?.kind === "bash" && action.detail.exit === null && !!action.error;
}

// a wsh read call's structured view, with the call's own recorded output behind a toggle
function WshViewBody({
    step,
    View,
    ctx,
    compact,
    openFull,
}: {
    step: Step;
    View: ComponentType<WshRendererProps>;
    ctx: TranscriptContext;
    compact: boolean;
    openFull: ReactNode;
}) {
    const [raw, setRaw] = useState(false);
    const { action, wsh } = step;
    const output = action.detail?.kind === "bash" ? action.detail.output : "";
    return (
        <div data-wsh-view={wsh!.key} className="mt-2.5">
            <View call={wsh!.call} wshKey={wsh!.key} action={action} ctx={ctx} compact={compact} />
            <div className="mt-2 flex items-center gap-2">
                {output.trim() ? (
                    <button type="button" aria-pressed={raw} onClick={() => setRaw((v) => !v)} className={BODY_BUTTON}>
                        <TurnChevron open={raw} size={12} strokeWidth={2.2} />
                        Raw output
                    </button>
                ) : null}
                <div className="flex-1" />
                {openFull}
            </div>
            <PaneReveal open={raw}>
                <div data-step-raw className="mt-1.5 overflow-hidden rounded-[6px] border border-edge-faint bg-surface">
                    <RecordedOutput output={output} compact={compact} />
                </div>
            </PaneReveal>
        </div>
    );
}

// a step's opened body: a wsh read call's structured view, a test or diff card (cardCollapsed: its header only), else
// the tool detail. A failed call leads with its error; a refused command shows the command, then why it was refused as
// a note under it
function StepBody({
    step,
    View,
    ctx,
    compact,
    cardCollapsed,
}: {
    step: Step;
    View?: ComponentType<WshRendererProps>;
    ctx: TranscriptContext;
    compact: boolean;
    cardCollapsed: boolean;
}) {
    const { action } = step;
    const openFull = (
        <button
            type="button"
            aria-label="Open full view"
            onClick={() => modalsModel.pushModal("AgentToolDetailModal", { action })}
            className={BODY_BUTTON}
        >
            <ArrowUpRight size={12} strokeWidth={2.2} aria-hidden />
            Open full view
        </button>
    );
    if (hasBodyCard(action)) {
        // the card header's own raw toggle offers the output, so the footer holds only the full view
        return (
            <div data-step-card className="mt-2.5">
                <ToolOutputRenderer action={action} collapsed={cardCollapsed} />
                <div className="mt-2 flex justify-end">{openFull}</div>
            </div>
        );
    }
    if (View && step.wsh) {
        return <WshViewBody step={step} View={View} ctx={ctx} compact={compact} openFull={openFull} />;
    }
    const { detail, error } = action;
    const refused = isRefusedCommand(action);
    const tone = errorTone(step.status);
    return (
        <div data-tool-panel className="mt-2.5 overflow-hidden rounded-[8px] border border-edge-mid bg-surface-code">
            <div className="max-h-[400px] overflow-auto">
                {error && !refused ? (
                    <div
                        data-tool-error
                        className={cn(
                            "whitespace-pre-wrap border-b border-edge-faint px-3 py-2 font-mono text-[11.5px] leading-[1.6] [overflow-wrap:anywhere] last:border-b-0",
                            tone
                        )}
                    >
                        {error}
                    </div>
                ) : null}
                {detail ? <ToolDetailBody detail={detail} variant="inline" /> : null}
                {refused ? (
                    <div
                        data-tool-note
                        className={cn("-mt-1 px-3 pb-2 text-[12px] leading-[1.5] [overflow-wrap:anywhere]", tone)}
                    >
                        {error}
                    </div>
                ) : null}
            </div>
            <div className="flex items-center justify-end border-t border-edge-faint px-2 py-1">{openFull}</div>
        </div>
    );
}

// a step row's gap-2 / gap-2.5, in px, for the spinner's collapse to take back
const HEAD_GAP_PX = { compact: 8, full: 10 };

// One step: its title, command in mono, exit chip, time and chevron. Opens to its body inline, however long (the
// panel scrolls, and "Open full view" holds the modal); a step with neither a body nor a wsh view is a plain row.
// latest: the step is in the live or latest turn (or outside any fold)
function StepRow({
    step,
    renderers,
    latest,
    ctx,
    compact,
}: {
    step: Step;
    renderers?: boolean;
    latest: boolean;
    ctx: TranscriptContext;
    compact: boolean;
}) {
    const { action, status, wsh } = step;
    const reduceMotion = useAtomValue(atoms.prefersReducedMotionAtom);
    const bodyCard = hasBodyCard(action);
    // the rendered view shows a test or diff card without a click, as it always has
    const [open, setOpen] = useState(!!renderers && bodyCard);
    const View = wsh && !isCardKey(wsh.key) ? wshRendererFor(wsh.key) : undefined;
    const summary = stepSummary(step);
    // a failed call with no detail (a Grep, Read or Monitor) still opens, to its error
    const clickable = View != null || action.detail != null || !!action.error;
    const align = askAnswer(action) != null ? "items-start" : "items-center";
    const gap = compact ? "gap-2" : "gap-2.5";
    // one title colour whatever the status: the spinner alone marks a running step
    const head = cn(
        "flex min-w-0 flex-1 text-left font-sans text-secondary",
        align,
        gap,
        compact ? "text-[12.5px]" : "text-[13.5px]"
    );
    // a finished step's spinner collapses, its trailing gap with it, so the title glides left rather than jumping
    const spinnerExit = {
        opacity: 0,
        width: 0,
        marginRight: -(compact ? HEAD_GAP_PX.compact : HEAD_GAP_PX.full),
        transition: reduceMotion ? { duration: 0 } : { duration: MOTION.durExit, ease: MOTION.easeFluid },
    };
    const content = (
        <>
            <StepTitle step={step} compact={compact} />
            <span className="min-w-[6px] flex-1" />
            <AnimatePresence initial={false}>
                {summary ? (
                    <motion.span
                        key="summary"
                        data-step-summary
                        variants={microFade}
                        initial="initial"
                        animate="animate"
                        className={cn(
                            "shrink-0",
                            summary.tone === "secondary" ? "text-secondary" : "text-muted",
                            compact ? "text-[11.5px]" : "text-[12.5px]"
                        )}
                    >
                        {summary.text}
                    </motion.span>
                ) : null}
            </AnimatePresence>
            <StepFacts step={step} compact={compact} />
            {clickable && !compact ? <Affordance open={open} /> : null}
        </>
    );
    // an image card has no row body to live in, so the rendered view draws it under the row
    const imageCard = !!renderers && toolRendererKey(action) === "image";
    return (
        <div
            data-step
            data-step-status={status}
            className={cn("border-t border-edge-faint first:border-t-0", compact ? "px-2.5 py-[7px]" : "px-3.5 py-2.5")}
        >
            {/* the spinner sits outside the head, which turns from div to button when the result lands: inside, the
                remount would drop it before its exit could play */}
            <div className={cn("flex", align, gap)}>
                <AnimatePresence initial={false}>
                    {status === "running" ? (
                        <motion.span key="spin" exit={spinnerExit} className="flex shrink-0 overflow-hidden">
                            <LoaderCircle
                                size={compact ? 13 : 14}
                                strokeWidth={2.2}
                                role="img"
                                aria-label="Running"
                                className="shrink-0 animate-spin text-ink-mid"
                            />
                        </motion.span>
                    ) : null}
                </AnimatePresence>
                {clickable ? (
                    <button
                        type="button"
                        data-step-head
                        aria-expanded={open}
                        onClick={() => setOpen((v) => !v)}
                        className={cn(head, "cursor-pointer")}
                    >
                        {content}
                    </button>
                ) : (
                    <div data-step-head className={head}>
                        {content}
                    </div>
                )}
            </div>
            <PaneReveal open={open}>
                {/* a card the rendered view opened on its own, in an older turn, shows its header until clicked; one
                    the reader opened by its row shows whole */}
                <StepBody step={step} View={View} ctx={ctx} compact={compact} cardCollapsed={!!renderers && !latest} />
            </PaneReveal>
            {imageCard ? (
                <div className="mt-2">
                    <ToolOutputRenderer action={action} />
                </div>
            ) : null}
        </div>
    );
}

// consecutive image reads as one closed "Read N images" row that opens to their own step rows
function ImageReadsRow({
    steps,
    renderers,
    latest,
    ctx,
    compact,
}: {
    steps: Step[];
    renderers?: boolean;
    latest: boolean;
    ctx: TranscriptContext;
    compact: boolean;
}) {
    const [open, setOpen] = useState(false);
    const strip = toolZoomImages(steps.flatMap((s) => s.action.images ?? []));
    return (
        <div data-step data-step-group="images" data-step-status="ok">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className={cn(
                    "flex w-full cursor-pointer items-center text-left font-sans text-secondary",
                    compact ? "gap-2 px-2.5 py-[7px] text-[12.5px]" : "gap-2.5 px-3.5 py-2.5 text-[13.5px]"
                )}
            >
                <span className="min-w-0 truncate">Read {steps.length} images</span>
                <span className="min-w-[6px] flex-1" />
                {compact ? null : <Affordance open={open} />}
            </button>
            {/* a sibling of the button, not inside it: a thumbnail is a button too. Once the row opens, each read's own
                card shows its images */}
            {renderers && strip.length > 0 ? (
                <PaneReveal open={!open}>
                    <div data-image-strip className={compact ? "px-2.5 pb-[7px]" : "px-3.5 pb-2.5"}>
                        <ImageThumbs images={strip} compact />
                    </div>
                </PaneReveal>
            ) : null}
            <PaneReveal open={open}>
                <div className={cn("border-t border-edge-faint", compact ? "pl-2.5" : "pl-3.5")}>
                    {steps.map((step) => (
                        <StepRow key={step.index} step={step} renderers={renderers} latest={latest} ctx={ctx} compact={compact} />
                    ))}
                </div>
            </PaneReveal>
        </div>
    );
}

// what the agent thought between steps (a thinking-only message, consecutive ones merged): muted prose drawn in full,
// never a step; the turn's fold is what keeps it short
export function ThoughtText({ text, compact }: { text: string; compact: boolean }) {
    return <MarkdownMessage text={text} className={cn("text-ink-mid", compact ? "text-[12.5px]" : "text-[13px] leading-[1.55]")} />;
}

export function StepBox({
    steps,
    thoughts,
    renderers,
    latest,
    ctx,
    compact,
}: {
    steps: Step[];
    thoughts?: Thought[];
    renderers?: boolean;
    // the box sits in the live or latest turn, or outside any fold: its cards draw open
    latest: boolean;
    ctx: TranscriptContext;
    compact: boolean;
}) {
    return (
        // a row arriving in the live box grows in as a strip, so the box gains it rather than jumping; the rows it
        // mounts with stay put. The wrapper carries the rule between rows, since each row is now its wrapper's first.
        <div
            data-steps
            className={cn(
                "divide-y divide-edge-faint overflow-hidden border border-edge-mid",
                compact ? "my-2 rounded-[8px]" : "my-2.5 rounded-[10px]"
            )}
        >
            <AnimatePresence initial={false}>
                {stepRows(steps, thoughts).map((row) => (
                    <motion.div
                        key={row.kind === "thought" ? "t" + row.index : row.kind === "images" ? row.steps[0].index : row.step.index}
                        variants={composerReveal}
                        initial="initial"
                        animate="animate"
                        className="overflow-hidden"
                    >
                        {row.kind === "thought" ? (
                            <div data-thought className={compact ? "px-2.5 py-[7px]" : "px-3.5 py-2.5"}>
                                <ThoughtText text={row.text} compact={compact} />
                            </div>
                        ) : row.kind === "images" ? (
                            <ImageReadsRow steps={row.steps} renderers={renderers} latest={latest} ctx={ctx} compact={compact} />
                        ) : (
                            <StepRow step={row.step} renderers={renderers} latest={latest} ctx={ctx} compact={compact} />
                        )}
                    </motion.div>
                ))}
            </AnimatePresence>
        </div>
    );
}
