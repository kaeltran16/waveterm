// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { CrossFade } from "@/app/element/crossfade";
import { DrawCheck } from "@/app/element/drawcheck";
import { MOTION, composerReveal, microFade } from "@/app/element/motiontokens";
import { PaneReveal } from "@/app/element/panereveal";
import { TickNumber } from "@/app/element/ticknumber";
import { atoms } from "@/app/store/global";
import { cn } from "@/util/util";
import { LoaderCircle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useAtomValue } from "jotai";
import { createContext, useContext, useEffect, useState, type ComponentType, type ReactNode } from "react";
import type { AgentActionEntry } from "./agentsviewmodel";
import { ImageThumbs, toolZoomImages } from "./imagethumbs";
import { MarkdownMessage } from "./markdownmessage";
import { toolCount } from "./nowline";
import { RecordedOutput } from "./recordedoutput";
import { toolRendererKey } from "./renderregistry";
import { fmtDuration } from "./runcompletion";
import type { SubagentVM } from "./session-models/sessionviewmodel";
import { subagentElapsedMs, subagentOutcome } from "./subagentmodel";
import { BODY_BUTTON, CODE_TEXT, PassedOverNote, ToolDetailBody, TurnChevron } from "./tooldetailbody";
import { formatDuration } from "./tooldetail";
import { ToolOutputRenderer } from "./toolrenderers";
import type { TranscriptContext } from "./transcriptcontext";
import { actionCommand, stepRows, stepTitle, subagentStepStatus, type Step, type Thought } from "./transcriptlayout";
import { isCardKey } from "./wshcall";
import { WSH_STEP_SUMMARIES, wshRendererFor, type WshRendererProps, type WshStepSummary } from "./wshrenderers";

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

// the host's subagents by the Agent call that spawned each, and how it opens one; only the Rendered view provides it, so
// every other host keeps plain Agent steps
export interface SubagentSteps {
    byToolUseId: ReadonlyMap<string, SubagentVM>;
    open: (sub: SubagentVM) => void;
}

export const SubagentStepsContext = createContext<SubagentSteps | null>(null);

// the subagent an Agent call spawned, and opening it
export function useSubagentOf(toolUseId: string | undefined): { sub: SubagentVM; open: () => void } | null {
    const steps = useContext(SubagentStepsContext);
    const sub = toolUseId != null ? steps?.byToolUseId.get(toolUseId) : undefined;
    return sub == null || steps == null ? null : { sub, open: () => steps.open(sub) };
}

export function OpenSubagentButton({ onOpen, compact }: { onOpen: () => void; compact: boolean }) {
    return (
        <button
            type="button"
            data-subagent-open
            title="Open the subagent's transcript"
            onClick={onOpen}
            className={cn(
                "shrink-0 cursor-pointer rounded-[6px] border border-edge-mid px-[7px] py-px font-mono text-accent-soft hover:border-edge-strong",
                compact ? "text-[10.5px]" : "text-[11px]"
            )}
        >
            Open
        </button>
    );
}

// a row's chevron as its own toggle, for a row whose Open sits between its facts and the chevron; the head stays the
// keyboard's way to toggle
export function ChevronToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
    return (
        <button
            type="button"
            tabIndex={-1}
            aria-hidden
            onClick={onToggle}
            className="flex shrink-0 cursor-pointer text-muted"
        >
            <TurnChevron open={open} size={12} strokeWidth={2.2} />
        </button>
    );
}

// an Agent step's second line: what its subagent is on (its running call, named as a step row names it) or how it
// ended, and its tool count
function SubagentLine({ sub, compact }: { sub: SubagentVM; compact: boolean }) {
    const outcome = subagentOutcome(sub);
    const call = outcome === "running" && sub.currentCall != null ? stepTitle(sub.currentCall) : null;
    const swapKey = call != null ? `call:${call.title}:${call.mono ?? ""}` : outcome;
    return (
        <div
            data-subagent-line={outcome}
            className={cn(
                "flex min-w-0 items-center gap-2 text-muted",
                compact ? "mt-1 ml-[21px] text-[11.5px]" : "mt-1.5 ml-6 text-[12.5px]"
            )}
        >
            <span className="shrink-0 text-ink-faint" aria-hidden>
                ↳
            </span>
            <CrossFade swapKey={swapKey} className="min-w-0 gap-2 overflow-hidden">
                {call != null ? (
                    <>
                        <span data-subagent-call className="shrink-0 text-ink-mid">
                            {call.title}
                        </span>
                        {call.mono ? (
                            <span
                                data-subagent-target
                                className={cn(
                                    "min-w-0 truncate font-mono text-ink-mid",
                                    compact ? "text-[10.5px]" : "text-[11.5px]"
                                )}
                            >
                                {call.mono}
                            </span>
                        ) : null}
                    </>
                ) : (
                    // failed in the error tone; stopped reads neutral, like done. Between calls a running one is working
                    <span data-subagent-outcome className={outcome === "failed" ? "text-error" : "text-ink-mid"}>
                        {outcome === "running" ? "working" : outcome}
                    </span>
                )}
            </CrossFade>
            <span className="min-w-[6px] flex-1" />
            {sub.toolCount != null ? (
                <span data-subagent-count className="shrink-0">
                    <TickNumber value={sub.toolCount} format={toolCount} />
                </span>
            ) : null}
        </div>
    );
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

function isAsk(action: AgentActionEntry): boolean {
    return action.detail?.kind === "ask";
}

// the picked option(s) or the typed answer of an asked question, shown under its title
function askAnswer(action: AgentActionEntry): string | undefined {
    if (action.detail?.kind !== "ask") {
        return undefined;
    }
    const q = action.detail.questions[0];
    return q == null ? undefined : q.picked.length > 0 ? q.picked.join(", ") : q.typed;
}

// a Bash step with no description: its command is the row's own text, so its opened body does not repeat it
function isBareCommand(action: AgentActionEntry): boolean {
    return action.detail?.kind === "bash" && !stepTitle(action).title;
}

// open: an opened bare command shows its whole command, wrapped, since its body leaves it out
// the projection's verb for an Agent or Task call
const SPAWN_VERB = "spawned";

// background: the step spawned a background subagent, tagged after its description
// subagentType: the linked subagent's type, which heads a spawn step in place of "Spawned", its description after it
// drawn mono
function StepTitle({
    step,
    compact,
    open,
    gap,
    background,
    subagentType,
}: {
    step: Step;
    compact: boolean;
    open: boolean;
    gap: string;
    background?: boolean;
    subagentType?: string;
}) {
    const named = stepTitle(step.action);
    const { title, mono, subject } =
        subagentType && step.action.verb === SPAWN_VERB ? { title: subagentType, mono: named.subject } : named;
    const head = subject != null && title.endsWith(subject) ? title.slice(0, title.length - subject.length) : title;
    const answer = askAnswer(step.action);
    const totals = editTotals(step.action);
    const whole = open && isBareCommand(step.action);
    // a bare command is the row's own text, so it is never smaller than the output it opens
    const monoSize = !title ? CODE_TEXT : compact ? "text-[11px]" : "text-[12px]";
    const line = (
        <>
            {title ? (
                // the title truncates rather than pushing the row's facts out; a command under it gives way first
                <span data-step-title className="min-w-0 truncate">
                    {head}
                    {subject != null && head !== title ? <span className="text-foreground">{subject}</span> : null}
                </span>
            ) : null}
            {mono ? (
                // a bare command is the row's text, so it takes the row's color; under a title it is subordinate
                <span
                    className={cn(
                        "min-w-0 font-mono",
                        whole ? "whitespace-pre-wrap break-words" : "shrink-[100] truncate",
                        title ? "text-muted" : undefined,
                        monoSize
                    )}
                >
                    {whole ? (actionCommand(step.action) ?? mono) : mono}
                </span>
            ) : null}
            {background ? (
                <span
                    data-step-background
                    className={cn(
                        "shrink-0 rounded-[4px] border border-edge-mid px-[5px] font-mono text-muted",
                        compact ? "text-[10.5px]" : "text-[11px]"
                    )}
                >
                    background
                </span>
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
    if (!isAsk(step.action)) {
        return line;
    }
    // the answer takes the row's width under the title line, not a share of it beside the facts. Its line is mounted
    // collapsed while the question waits, so an answer landing grows it open and draws its check
    return (
        <span className="flex min-w-0 flex-1 flex-col">
            <span className={cn("flex min-w-0 items-center", gap)}>{line}</span>
            <motion.span
                variants={composerReveal}
                initial={false}
                animate={answer != null ? "animate" : "initial"}
                className="block overflow-hidden"
            >
                <span data-step-answer className="mt-1 flex min-w-0 items-start gap-1.5 break-words text-foreground">
                    <DrawCheck done={answer != null} className="mt-[3px] shrink-0 text-accent-soft" />
                    <span className="min-w-0">{answer}</span>
                </span>
            </motion.span>
        </span>
    );
}

// a quicker step's time is noise on the row
const STEP_DURATION_MIN_MS = 1000;

// a call that did not finish, which the row names in one word
function isUnfinished(status: Step["status"]): boolean {
    return status === "stopped" || status === "blocked" || status === "declined";
}

// a status word's tone, the same in every step row: a stop warns, a call passed over (blocked, declined) is muted
function statusWordTone(status: Step["status"]): string {
    return status === "stopped" ? "text-warning" : "text-muted";
}

// the row's right side: a failed call's exit chip, then its time (a running one's live elapsed), or the one word for a
// call that did not finish (stopped, blocked, declined). A running step's elapsed cross-fades to its outcome, so a
// failure arriving reads as a change rather than a chip popping in
// sub: an Agent step's subagent, whose own start and end the step's time reads
function StepFacts({ step, compact, gap, sub }: { step: Step; compact: boolean; gap: string; sub?: SubagentVM }) {
    const facts = stepFacts(step, compact, sub);
    // a quick step that ends with nothing to show drops its slot, so the row keeps no empty gap
    if (facts == null) {
        return null;
    }
    return (
        <CrossFade swapKey={step.status} className={cn("shrink-0", gap)}>
            {facts}
        </CrossFade>
    );
}

function stepFacts(step: Step, compact: boolean, sub?: SubagentVM): ReactNode {
    const { action, status } = step;
    const chip = compact ? "px-[5px] text-[10.5px]" : "px-1.5 py-px text-[11px]";
    const time = cn("shrink-0 font-mono text-muted", compact ? "text-[10.5px]" : "text-[11px]");
    // a finished subagent's own run, not its spawn's call: a background spawn's call is only its launch ack
    const subDuration = sub != null && sub.state !== "working" ? subagentElapsedMs(sub, 0) : undefined;
    const duration = subDuration != null || (action.durationMs ?? 0) >= STEP_DURATION_MIN_MS;
    if (status !== "fail" && status !== "running" && !isUnfinished(status) && !duration) {
        return null;
    }
    return (
        <>
            {status === "fail" ? (
                <span data-step-word className={cn("shrink-0 rounded-[4px] bg-error/15 font-mono text-error", chip)}>
                    {/* a call that never ran has a null exit, so it reads failed rather than "exit null" */}
                    {action.detail?.kind === "bash" && action.detail.exit ? `exit ${action.detail.exit}` : "failed"}
                </span>
            ) : null}
            {status === "running" ? (
                <span className={time}>
                    <Elapsed since={sub?.startedAtMs ?? action.startedTs ?? action.ts} />
                </span>
            ) : isUnfinished(status) ? (
                <span
                    data-step-word
                    className={cn("shrink-0", statusWordTone(status), compact ? "text-[11px]" : "text-[12px]")}
                >
                    {status}
                </span>
            ) : duration ? (
                <span data-step-duration className={time}>
                    {subDuration != null ? fmtDuration(subDuration) : formatDuration(action.durationMs)}
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

// a hook blocked it or the user declined it: passed over, not failed, so its reason reads muted with the Ban square
function isPassedOver(status: Step["status"]): boolean {
    return status === "blocked" || status === "declined";
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
}: {
    step: Step;
    View: ComponentType<WshRendererProps>;
    ctx: TranscriptContext;
    compact: boolean;
}) {
    const [raw, setRaw] = useState(false);
    const { action, wsh } = step;
    const output = action.detail?.kind === "bash" ? action.detail.output : "";
    return (
        <div data-wsh-view={wsh!.key} className="mt-2.5">
            <View call={wsh!.call} wshKey={wsh!.key} action={action} ctx={ctx} compact={compact} />
            {output.trim() ? (
                <div className="mt-2 flex items-center">
                    <button type="button" aria-pressed={raw} onClick={() => setRaw((v) => !v)} className={BODY_BUTTON}>
                        <TurnChevron open={raw} size={12} strokeWidth={2.2} />
                        Raw output
                    </button>
                </div>
            ) : null}
            <PaneReveal open={raw}>
                <div data-step-raw className="mt-1.5 overflow-hidden rounded-[6px] border border-edge-faint bg-surface">
                    <RecordedOutput output={output} compact={compact} />
                </div>
            </PaneReveal>
        </div>
    );
}

// a step's opened body: a wsh read call's structured view, a test or diff card (cardCollapsed: its header only), else
// the tool detail, capped to whole lines. A failed call leads with its error. A call passed over leads with why, muted
// beside the Ban square; a refused command shows the command first, the reason under it
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
    const { action, status } = step;
    if (hasBodyCard(action)) {
        return (
            <div data-step-card className="mt-2.5">
                <ToolOutputRenderer action={action} collapsed={cardCollapsed} />
            </div>
        );
    }
    if (View && step.wsh) {
        return <WshViewBody step={step} View={View} ctx={ctx} compact={compact} />;
    }
    const { detail, error } = action;
    const bare = isBareCommand(action);
    const passedOver = isPassedOver(status);
    const refused = isRefusedCommand(action);
    // an opened bare command is whole on its own row, so with no output and no error nothing is left to draw
    if (!error && bare && detail?.kind === "bash" && !detail.output) {
        return null;
    }
    // a refused command's reason sits under its command; with no command drawn, it leads like any other
    const noteUnder = refused && !bare;
    const note = !error ? null : passedOver ? (
        <PassedOverNote
            text={error}
            declined={status === "declined"}
            className={noteUnder ? "-mt-1 px-3 pb-2" : cn("px-3 py-2", detail && "border-b border-edge-faint")}
        />
    ) : refused ? (
        <div
            data-tool-note
            className={cn(
                "text-[12px] leading-[1.5] text-error break-words",
                noteUnder ? "-mt-1 px-3 pb-2" : "px-3 py-2"
            )}
        >
            {error}
        </div>
    ) : null;
    return (
        <ToolPanel error={note == null ? error : undefined} className="mt-2.5">
            {noteUnder ? null : note}
            {detail ? <ToolDetailBody detail={detail} variant="inline" capped hideCommand={bare} /> : null}
            {noteUnder ? note : null}
        </ToolPanel>
    );
}

// a tool's opened panel: its error, when it has one, as the red block on top of what it drew
export function ToolPanel({
    error,
    className,
    children,
}: {
    error?: string;
    className?: string;
    children?: ReactNode;
}) {
    return (
        <div
            data-tool-panel
            className={cn("overflow-hidden rounded-[8px] border border-edge-mid bg-surface-code", className)}
        >
            {error ? (
                <div
                    data-tool-error
                    className={cn(
                        "whitespace-pre-wrap break-words border-b border-edge-faint px-3 py-2 font-mono leading-[1.6] text-error last:border-b-0",
                        CODE_TEXT
                    )}
                >
                    {error}
                </div>
            ) : null}
            {children}
        </div>
    );
}

// a step row's gap-2 / gap-2.5, in px, for the spinner's collapse to take back
const HEAD_GAP_PX = { compact: 8, full: 10 };

// One step: its title, command in mono, exit chip, time and chevron. Opens to its body inline, cut to whole lines that
// expand in place; a step with neither a body nor a wsh view is a plain row.
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
    const { action, wsh } = step;
    const link = useSubagentOf(action.toolUseId);
    const status = subagentStepStatus(step.status, link?.sub);
    const shown = status === step.status ? step : { ...step, status };
    const reduceMotion = useAtomValue(atoms.prefersReducedMotionAtom);
    const bodyCard = hasBodyCard(action);
    // the rendered view shows a test or diff card without a click, as it always has
    const [open, setOpen] = useState(!!renderers && bodyCard);
    const View = wsh && !isCardKey(wsh.key) ? wshRendererFor(wsh.key) : undefined;
    const summary = stepSummary(shown);
    // a failed call with no detail (a Grep, Read or Monitor) still opens, to its error
    const clickable = View != null || action.detail != null || !!action.error;
    const answered = askAnswer(action) != null;
    const align = answered || (open && isBareCommand(action)) ? "items-start" : "items-center";
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
            <StepTitle
                step={step}
                compact={compact}
                open={open}
                gap={gap}
                background={link?.sub.background}
                subagentType={link?.sub.type}
            />
            {/* an ask's title column fills the row itself */}
            {isAsk(action) ? null : <span className="min-w-[6px] flex-1" />}
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
            <StepFacts step={shown} compact={compact} gap={gap} sub={link?.sub} />
            {clickable && !compact && link == null ? <Affordance open={open} /> : null}
        </>
    );
    // an image card has no row body to live in, so the rendered view draws it under the row
    const imageCard = !!renderers && toolRendererKey(action) === "image";
    return (
        <div
            data-step
            data-step-status={status}
            data-subagent={link?.sub.id}
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
                {/* Open sits outside the head, so the row's own click still expands its body */}
                {link != null ? (
                    <>
                        <OpenSubagentButton onOpen={link.open} compact={compact} />
                        {clickable && !compact ? (
                            <ChevronToggle open={open} onToggle={() => setOpen((v) => !v)} />
                        ) : null}
                    </>
                ) : null}
            </div>
            {link != null ? <SubagentLine sub={link.sub} compact={compact} /> : null}
            <PaneReveal open={open}>
                {/* a card the rendered view opened on its own, in an older turn, shows its header until clicked; one
                    the reader opened by its row shows whole */}
                <StepBody step={shown} View={View} ctx={ctx} compact={compact} cardCollapsed={!!renderers && !latest} />
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
