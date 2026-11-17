// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { pushToast } from "@/app/cockpit/notificationstore";
import { writeClipboard } from "@/app/element/copyfeedback";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { modalsModel } from "@/app/store/modalmodel";
import { MONO_FAINT } from "@/app/view/jarvis/briefstyle";
import { localFileUrl } from "@/app/view/jarvis/localimage";
import { getWebServerEndpoint } from "@/util/endpoints";
import { fetch } from "@/util/fetchutil";
import { cn, fireAndForget } from "@/util/util";
import {
    ArrowUpRight,
    Ban,
    Check,
    ChevronDown,
    ChevronRight,
    Copy,
    Ellipsis,
    File as FileIcon,
    GitBranch,
    Info,
    LoaderCircle,
    X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
    MOTION,
    cardVariants,
    composerReveal,
    microFade,
    shouldFadeEntry,
    turnTransition,
    viewFade,
} from "@/app/element/motiontokens";
import { PaneReveal } from "@/app/element/panereveal";
import { atoms } from "@/app/store/global";
import { useAtomValue } from "jotai";
import useResizeObserver from "@react-hook/resize-observer";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
    conversationText,
    formatTokens,
    type ActionDetail,
    type AgentActionEntry,
    type AgentEntry,
    type DiffLine,
} from "./agentsviewmodel";
import { ArcMessageRow } from "./arcmessagerow";
import { MarkdownMessage } from "./markdownmessage";
import { placeMarks, type TimelineMark } from "./permissionmodel";
import { highlightLine } from "./highlight";
import { ImageThumbs } from "./imagethumbs";
import { toolRendererKey } from "./renderregistry";
import { fmtDuration } from "./runcompletion";
import { TIMELINE_RENDER_CAP } from "./sessionstranscript";
import { ShellRunRow } from "./shellrunrow";
import { formatDuration } from "./tooldetail";
import type { TranscriptContext } from "./transcriptcontext";
import {
    layoutTranscript,
    stepRows,
    stepTitle,
    type FoldSummary,
    type LayoutItem,
    type Step,
    type Thought,
} from "./transcriptlayout";
import { ToolOutputRenderer } from "./toolrenderers";
import { isCardKey } from "./wshcall";
import { WshChangeRow } from "./wshchangerow";
import { WSH_STEP_SUMMARIES, wshRendererFor, type WshRendererProps, type WshStepSummary } from "./wshrenderers";

// The transcript feed. layoutTranscript (transcriptlayout.ts) decides the items: prose, user bubbles, events, Arc's own
// messages, wsh change cards, stretches of tool steps, and a finished turn's work folded into one "Worked for N" line.
// While `active`, the live turn stays unfolded.

// a host that passes no ctx: cards still render, with no links
const NO_CTX: TranscriptContext = {};

// inline panels wrap long lines so a narrow card never scrolls sideways; the modal has room, so it keeps them unwrapped
function lineWrap(variant: "inline" | "modal"): string {
    return variant === "inline" ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre";
}

// a failure's code only: exit 0 is the normal case, and null means the command never ran
function ExitChip({ exit }: { exit: number | null }) {
    if (!exit) {
        return null;
    }
    return <span className="rounded-[4px] bg-error/15 px-1.5 py-px font-mono text-[11px] text-error">exit {exit}</span>;
}

// pending: the call has no result yet (running, or waiting on a permission prompt), so it claims neither outcome
export function StatusSquare({ ok, blocked, pending }: { ok: boolean; blocked?: boolean; pending?: boolean }) {
    // refused before it ran: grey, passed over rather than failed
    if (blocked) {
        return (
            <span
                role="img"
                aria-label="Blocked"
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] bg-surface-hover text-muted"
            >
                <Ban size={10} strokeWidth={2.6} aria-hidden />
            </span>
        );
    }
    if (pending) {
        return (
            <span
                role="img"
                aria-label="No result yet"
                data-status-pending
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] bg-surface-raised text-muted"
            >
                <Ellipsis size={10} strokeWidth={3} aria-hidden />
            </span>
        );
    }
    return (
        <span
            role="img"
            aria-label={ok ? "Succeeded" : "Failed"}
            className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px]",
                ok ? "bg-success/15 text-success" : "bg-error/15 text-error"
            )}
        >
            {ok ? <Check size={10} strokeWidth={3} aria-hidden /> : <X size={10} strokeWidth={3} aria-hidden />}
        </span>
    );
}

// a disclosure chevron that turns as its pane opens: right to down, or with `flip` down to up
function TurnChevron({ open, size, strokeWidth, flip }: { open: boolean; size: number; strokeWidth: number; flip?: boolean }) {
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

export const VERB = "min-w-[50px] shrink-0 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted";

// One option of an asked question. The check and the weight mark a picked one, so colour is not the only signal.
function AskOptionLine({
    label,
    description,
    picked,
    note,
}: {
    label: string;
    description?: string;
    picked: boolean;
    note?: string;
}) {
    return (
        <div className="flex items-start gap-2">
            <span
                className={cn(
                    "mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px]",
                    picked && "bg-accent/[0.12] text-accent-soft"
                )}
            >
                {picked ? <Check size={10} strokeWidth={3} aria-hidden /> : null}
            </span>
            <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                <div className={cn("text-[12.5px]", picked ? "font-semibold text-primary" : "text-ink-mid")}>{label}</div>
                {description ? (
                    <div className={cn("text-[12px] leading-[1.5]", picked ? "text-ink-mid" : "text-muted")}>
                        {description}
                    </div>
                ) : null}
            </div>
            {note ? <span className={cn("shrink-0", MONO_FAINT)}>{note}</span> : null}
        </div>
    );
}

function HighlightedCode({ text }: { text: string }) {
    return (
        <>
            {highlightLine(text).map((tk, k) => (
                <span key={k} className={tk.cls}>
                    {tk.t}
                </span>
            ))}
        </>
    );
}

// one diff line: a 3px edge and a tint mark the side, the gutter holds the line's number (the new side's, a removed
// line's old one), or its sign when the diff carries no numbers
function DiffRow({ line, numbered, wrap }: { line: DiffLine; numbered: boolean; wrap: string }) {
    const tint =
        line.sign === "+"
            ? "border-l-diff-added bg-diff-added/10"
            : line.sign === "-"
              ? "border-l-diff-removed bg-diff-removed/10"
              : "border-l-transparent";
    const gutter = numbered ? (line.sign === "-" ? line.oldNo : (line.newNo ?? line.oldNo)) : line.sign;
    return (
        <div data-diff-line={line.sign} className={cn("flex border-l-[3px] font-mono text-[12px] leading-[1.6]", tint)}>
            <span
                data-diff-no
                className={cn("shrink-0 select-none text-right text-ink-faint", numbered ? "w-[42px] pr-3.5" : "w-[22px] pr-2")}
            >
                {gutter}
            </span>
            {/* the gutter stays put, so a wrapped line hangs under its own text */}
            <span className={cn("min-w-0 pr-3.5", wrap)}>
                <HighlightedCode text={line.text} />
            </span>
        </div>
    );
}

// Shared per-kind detail renderer. Used inline (capped by max-height) and by the modal (uncapped).
// Tokens only — no raw hex. See StepsOpen.dc.html and Main.dc.html.
export function ToolDetailBody({ detail, variant }: { detail: ActionDetail; variant: "inline" | "modal" }) {
    const modal = variant === "modal";
    const pad = modal ? "px-4 py-3" : "px-3 py-2";
    const wrap = lineWrap(variant);
    if (detail.kind === "grep") {
        return (
            <div className={pad}>
                {detail.matches.map((g, i) => (
                    <div key={i} className="flex gap-3 whitespace-pre font-mono text-[11.5px] leading-[1.7]">
                        <span className="shrink-0 text-muted">{g.loc}</span>
                        <span className="min-w-0 flex-1 truncate text-secondary">{g.code}</span>
                    </div>
                ))}
                {detail.more ? <div className={cn("pt-1.5", MONO_FAINT)}>{detail.more}</div> : null}
            </div>
        );
    }
    if (detail.kind === "read") {
        // syntax-highlight the file body with the feed's lightweight tokenizer (same one CodeBlock uses).
        // Kept off shiki deliberately — the feed is on the cockpit boot path.
        return (
            <div className={cn(pad, modal && "overflow-x-auto")}>
                <div className={cn("font-mono text-[11.5px] leading-[1.7]", modal && "min-w-min")}>
                    {detail.snippet.split("\n").map((ln, i) => (
                        <div key={i} className={wrap}>
                            <HighlightedCode text={ln} />
                        </div>
                    ))}
                </div>
            </div>
        );
    }
    if (detail.kind === "bash") {
        // "$ cmd" and its output read as one terminal block
        return (
            <div className={pad}>
                {detail.command ? (
                    <div className="flex gap-2 whitespace-pre-wrap font-mono text-[11.5px] leading-[1.7] text-foreground [overflow-wrap:anywhere]">
                        <span className="shrink-0 select-none text-accent">$</span>
                        <span>{detail.command}</span>
                    </div>
                ) : null}
                {detail.output ? (
                    <pre
                        className={cn(
                            "m-0 font-mono text-[11.5px] leading-[1.7]",
                            wrap,
                            modal && "overflow-x-auto",
                            detail.exit ? "text-error" : "text-ink-mid"
                        )}
                    >
                        {detail.output}
                    </pre>
                ) : null}
                {/* inline, the step row's own exit chip already names a failure */}
                {modal && detail.exit ? (
                    <div className="mt-2 flex items-center gap-2">
                        <ExitChip exit={detail.exit} />
                    </div>
                ) : null}
            </div>
        );
    }
    if (detail.kind === "skill") {
        return (
            <div className={pad}>
                <div className="flex items-center gap-2 font-mono text-[11.5px]">
                    <span className="text-syntax-keyword">skill</span>
                    <span className="text-primary">{detail.name}</span>
                </div>
                {detail.args ? (
                    <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[1.6] text-secondary">
                        {detail.args}
                    </pre>
                ) : null}
            </div>
        );
    }
    if (detail.kind === "ask") {
        return (
            <div className="flex flex-col">
                {detail.questions.map((q, i) => (
                    <div key={i} className={cn("flex flex-col gap-[5px] border-b border-edge-faint last:border-b-0", pad)}>
                        {q.header ? <span className={MONO_FAINT}>{q.header}</span> : null}
                        <div className="text-[12.5px] leading-[1.5] text-secondary">{q.question}</div>
                        {q.options.map((o, k) => (
                            <AskOptionLine
                                key={k}
                                label={o.label}
                                description={o.description}
                                picked={q.picked.includes(o.label)}
                            />
                        ))}
                        {q.typed ? <AskOptionLine label={q.typed} picked note="typed" /> : null}
                    </div>
                ))}
            </div>
        );
    }
    // edit: per file, a header (path, "new" for an added file, +a −d) over its lines
    return (
        <div className="flex flex-col">
            {detail.files.map((f, i) => {
                const numbered = f.lines.some((l) => l.oldNo != null || l.newNo != null);
                return (
                    <div key={i} data-diff-file className="border-b border-edge-faint last:border-b-0">
                        <div className="flex items-center gap-2 border-b border-edge-faint px-3 py-1.5 font-mono text-[11.5px]">
                            <span className="min-w-0 flex-1 truncate text-ink-mid">{f.path}</span>
                            {f.badge === "A" ? <span className="shrink-0 text-success">new</span> : null}
                            <span className={cn("shrink-0", f.adds > 0 ? "text-diff-added" : "text-muted")}>+{f.adds}</span>
                            <span className={cn("shrink-0", f.dels > 0 ? "text-diff-removed" : "text-muted")}>−{f.dels}</span>
                        </div>
                        <div className={cn("py-2", modal && "overflow-x-auto")}>
                            <div className={modal ? "min-w-min" : undefined}>
                                {f.lines.map((l, k) =>
                                    l.hunk ? (
                                        <div
                                            key={k}
                                            data-diff-hunk
                                            className={cn(
                                                "bg-accent/[0.06] pl-[13px] pr-3.5 font-mono text-[11.5px] leading-[1.7] text-muted",
                                                wrap,
                                                k > 0 && "mt-1"
                                            )}
                                        >
                                            {l.text}
                                        </div>
                                    ) : (
                                        <DiffRow key={k} line={l} numbered={numbered} wrap={wrap} />
                                    )
                                )}
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
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

function AddsDels({ adds, dels, compact }: { adds: number; dels: number; compact: boolean }) {
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

// the row's right side: a failed call's exit chip, then its time (a running one's live elapsed, a stopped one's word)
function StepFacts({ step, compact }: { step: Step; compact: boolean }) {
    const { action, status } = step;
    const chip = compact ? "px-[5px] text-[10.5px]" : "px-1.5 py-px text-[11px]";
    const time = cn("shrink-0 font-mono text-ink-faint", compact ? "text-[10.5px]" : "text-[11px]");
    return (
        <>
            {status === "fail" ? (
                <span className={cn("shrink-0 rounded-[4px] bg-error/15 font-mono text-error", chip)}>
                    {action.detail?.kind === "bash" && action.detail.exit !== 0 ? `exit ${action.detail.exit}` : "failed"}
                </span>
            ) : null}
            {status === "running" ? (
                <span className={time}>
                    <Elapsed since={action.startedTs ?? action.ts} />
                </span>
            ) : status === "stopped" || status === "blocked" ? (
                <span className={cn("shrink-0 text-muted", compact ? "text-[11px]" : "text-[12px]")}>{status}</span>
            ) : action.durationMs ? (
                <span className={time}>{formatDuration(action.durationMs)}</span>
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

function outputLines(action: AgentActionEntry): number {
    return action.detail?.kind === "bash" ? action.detail.output.replace(/\n+$/, "").split("\n").length : 0;
}

// a step's opened body: a wsh read call's structured view, a test or diff card, else the tool detail
function StepBody({
    step,
    View,
    ctx,
    compact,
}: {
    step: Step;
    View?: ComponentType<WshRendererProps>;
    ctx: TranscriptContext;
    compact: boolean;
}) {
    const { action } = step;
    const openFull = (
        <button
            type="button"
            aria-label="Open full view"
            onClick={() => modalsModel.pushModal("AgentToolDetailModal", { action })}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-[5px] px-1.5 py-[3px] font-sans text-[12px] text-ink-mid hover:bg-lane hover:text-primary"
        >
            <ArrowUpRight size={12} strokeWidth={2.2} aria-hidden />
            Open full view
        </button>
    );
    if (hasBodyCard(action)) {
        return (
            <div data-step-card className="mt-2.5">
                <ToolOutputRenderer action={action} />
                <div className="mt-2 flex items-center gap-2.5">
                    <span className="text-[12px] text-muted">Raw output, {outputLines(action)} lines</span>
                    <div className="flex-1" />
                    {openFull}
                </div>
            </div>
        );
    }
    if (View && step.wsh) {
        return (
            <div data-wsh-view={step.wsh.key} className="mt-2.5">
                <View call={step.wsh.call} wshKey={step.wsh.key} action={action} ctx={ctx} compact={compact} />
                <div className="mt-2 flex items-center gap-2">
                    <span className="text-[12px] text-muted">Raw output</span>
                    <div className="flex-1" />
                    {openFull}
                </div>
            </div>
        );
    }
    const detail = action.detail!;
    return (
        <div data-tool-panel className="mt-2.5 overflow-hidden rounded-[8px] border border-edge-mid bg-surface-code">
            <div className="max-h-[400px] overflow-auto">
                <ToolDetailBody detail={detail} variant="inline" />
            </div>
            <div className="flex items-center justify-end border-t border-edge-faint px-2 py-1">
                {openFull}
            </div>
        </div>
    );
}

// a step row's gap-2 / gap-2.5, in px, for the spinner's collapse to take back
const HEAD_GAP_PX = { compact: 8, full: 10 };

// One step: its title, command in mono, exit chip, time and chevron. Opens to its body inline, however long (the
// panel scrolls, and "Open full view" holds the modal); a step with neither a body nor a wsh view is a plain row.
function StepRow({
    step,
    renderers,
    ctx,
    compact,
}: {
    step: Step;
    renderers?: boolean;
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
    const clickable = View != null || action.detail != null;
    const align = askAnswer(action) != null ? "items-start" : "items-center";
    const gap = compact ? "gap-2" : "gap-2.5";
    const head = cn(
        "flex min-w-0 flex-1 text-left font-sans",
        align,
        gap,
        compact ? "text-[12.5px]" : "text-[13.5px]",
        status === "running" ? "text-secondary" : "text-ink-mid"
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
                    <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={cn(head, "cursor-pointer")}>
                        {content}
                    </button>
                ) : (
                    <div className={head}>{content}</div>
                )}
            </div>
            <PaneReveal open={open}>
                <StepBody step={step} View={View} ctx={ctx} compact={compact} />
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
    ctx,
    compact,
}: {
    steps: Step[];
    renderers?: boolean;
    ctx: TranscriptContext;
    compact: boolean;
}) {
    const [open, setOpen] = useState(false);
    return (
        <div data-step data-step-group="images" data-step-status="ok">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className={cn(
                    "flex w-full cursor-pointer items-center text-left font-sans text-ink-mid",
                    compact ? "gap-2 px-2.5 py-[7px] text-[12.5px]" : "gap-2.5 px-3.5 py-2.5 text-[13.5px]"
                )}
            >
                <span className="min-w-0 truncate">Read {steps.length} images</span>
                <span className="min-w-[6px] flex-1" />
                {compact ? null : <Affordance open={open} />}
            </button>
            <PaneReveal open={open}>
                <div className={cn("border-t border-edge-faint", compact ? "pl-2.5" : "pl-3.5")}>
                    {steps.map((step) => (
                        <StepRow key={step.index} step={step} renderers={renderers} ctx={ctx} compact={compact} />
                    ))}
                </div>
            </PaneReveal>
        </div>
    );
}

// what the agent thought between steps (a thinking-only message, consecutive ones merged): muted prose clamped to a few
// lines, never a step
function ThoughtText({ text, clamp, compact }: { text: string; clamp: boolean; compact: boolean }) {
    return (
        <ClampedText lines="thought" clamp={clamp}>
            <MarkdownMessage text={text} className={cn("text-ink-mid", compact ? "text-[12.5px]" : "text-[13px] leading-[1.55]")} />
        </ClampedText>
    );
}

function StepBox({
    steps,
    thoughts,
    renderers,
    clamp,
    ctx,
    compact,
}: {
    steps: Step[];
    thoughts?: Thought[];
    renderers?: boolean;
    // clamps a long thought behind Show more
    clamp: boolean;
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
                                <ThoughtText text={row.text} clamp={clamp} compact={compact} />
                            </div>
                        ) : row.kind === "images" ? (
                            <ImageReadsRow steps={row.steps} renderers={renderers} ctx={ctx} compact={compact} />
                        ) : (
                            <StepRow step={row.step} renderers={renderers} ctx={ctx} compact={compact} />
                        )}
                    </motion.div>
                ))}
            </AnimatePresence>
        </div>
    );
}

// "Worked for N · phrase +a −d ✗ k failed": a finished turn's folded work. Fades in when a turn folds after mount.
function FoldLine({ fold, open, onClick, compact }: { fold: FoldSummary; open: boolean; onClick: () => void; compact: boolean }) {
    return (
        <motion.button
            type="button"
            data-fold
            variants={viewFade}
            initial="initial"
            animate="animate"
            aria-expanded={open}
            onClick={onClick}
            className={cn(
                "mt-2 flex max-w-full cursor-pointer items-center gap-1.5 text-left font-sans text-muted hover:text-ink-mid",
                compact ? "text-[12.5px]" : "text-[14px]"
            )}
        >
            <span className="shrink-0 text-secondary">
                {fold.durationMs != null ? `Worked for ${fmtDuration(fold.durationMs)}` : "Worked"}
            </span>
            {fold.phrase ? <span className="min-w-0 truncate">· {fold.phrase}</span> : null}
            {fold.adds > 0 || fold.dels > 0 ? <AddsDels adds={fold.adds} dels={fold.dels} compact={compact} /> : null}
            {/* the word carries the outcome, so colour is never the only signal */}
            {fold.failed > 0 ? (
                <span className="ml-1 inline-flex shrink-0 items-center gap-1 text-error">
                    <X size={11} strokeWidth={3} aria-hidden />
                    {fold.failed} failed
                </span>
            ) : null}
            <span className="flex shrink-0">
                <TurnChevron open={open} size={14} strokeWidth={2} />
            </span>
        </motion.button>
    );
}

// A finished turn's work behind its Worked-for line, which opens to the items in order. startsOpen: it holds a tool
// output card (rendered view), which a fold would hide. live: the working turn, drawn open with no line and unclipped,
// so its rows sit as they would flat; when it finishes the same rows fold. finishing: the turn just finished under a
// mounted feed, so it mounts open and folds its work away under the new line. unfold: drawn open with no reveal, so a
// find over the transcript sees every row where it will stay.
function TurnFold({
    fold,
    live,
    startsOpen,
    finishing,
    unfold,
    compact,
    children,
}: {
    fold: FoldSummary;
    live: boolean;
    startsOpen: boolean;
    finishing: boolean;
    unfold: boolean;
    compact: boolean;
    children: React.ReactNode;
}) {
    const [toggled, setToggled] = useState(false);
    // open for one render after the turn is done, which clips the pane before it collapses: an exiting pane keeps the
    // props it last rendered with
    const [settled, setSettled] = useState(!finishing && !live);
    useEffect(() => {
        if (!live) {
            setSettled(true);
        }
    }, [live]);
    const open = unfold || !settled || (startsOpen ? !toggled : toggled);
    // a turn that mounts live gains rows as they arrive, and those enter as the feed's own do
    const body = <AnimatePresence initial={live}>{children}</AnimatePresence>;
    return (
        <div data-turn-fold={live ? undefined : ""} data-turn-live={live ? "" : undefined}>
            {live ? null : <FoldLine fold={fold} open={open} onClick={() => setToggled((v) => !v)} compact={compact} />}
            {unfold ? (
                <div>{body}</div>
            ) : (
                <PaneReveal open={open} className={live ? "overflow-visible" : undefined}>
                    {body}
                </PaneReveal>
            )}
        </div>
    );
}

// a wsh change call that succeeded: its family's card, or the generic change row
function WshCardItem({ step, ctx, compact }: { step: Step; ctx: TranscriptContext; compact: boolean }) {
    const { call, key } = step.wsh!;
    const Card = key === "other-change" ? undefined : wshRendererFor(key);
    if (Card == null) {
        return <WshChangeRow call={call} action={step.action} compact={compact} />;
    }
    return (
        <div data-wsh-card={key}>
            <Card call={call} wshKey={key} action={step.action} ctx={ctx} compact={compact} />
        </div>
    );
}

// a typed slash command, or a skill (✦), as a right-aligned chip; the Rendered view's queued foot draws one too
export function CommandChip({
    name,
    args,
    isSkill,
    output,
    compact,
}: {
    name: string;
    args?: string;
    isSkill?: boolean;
    output?: string;
    compact: boolean;
}) {
    return (
        <div data-command-chip={isSkill ? "skill" : "command"} className="my-2.5 flex justify-end">
            <div className="flex min-w-0 max-w-[88%] flex-col items-end gap-1">
                <span
                    className={cn(
                        "inline-flex max-w-full flex-wrap items-baseline gap-x-2 rounded-[12px] bg-surface-hover px-3 py-1.5 font-mono",
                        compact ? "text-[12px]" : "text-[12.5px]"
                    )}
                >
                    {isSkill ? <span className="text-[11.5px] text-skill">✦</span> : null}
                    <span className={cn("font-semibold", isSkill ? "text-skill-soft" : "text-accent-soft")}>{name}</span>
                    {args ? <span className="min-w-0 text-ink-mid [overflow-wrap:anywhere]">{args}</span> : null}
                </span>
                {output ? (
                    <div
                        data-command-output
                        className={cn(
                            "whitespace-pre-wrap px-3 text-right font-mono text-ink-mid [overflow-wrap:anywhere]",
                            compact ? "text-[11.5px]" : "text-[12px]"
                        )}
                    >
                        {output}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

// a centred event on a rule: compaction, an interrupt
const EVENT_RULE = "h-px flex-1 bg-edge-mid";
// an event's opened markdown panel; set here, or it inherits the page's 16px foreground
const EVENT_PANEL_TEXT = "text-[13px] leading-[1.55] text-secondary";

function CompactionDivider({
    trigger,
    preTokens,
    postTokens,
    summary,
    compact,
}: {
    trigger?: string;
    preTokens?: number;
    postTokens?: number;
    summary?: string;
    compact: boolean;
}) {
    const [open, setOpen] = useState(false);
    const stat = preTokens != null && postTokens != null ? `${formatTokens(preTokens)} → ${formatTokens(postTokens)} tokens` : null;
    const canExpand = !!summary;
    return (
        <div data-compaction className={compact ? "my-4" : "my-6"}>
            <button
                type="button"
                disabled={!canExpand}
                aria-expanded={canExpand ? open : undefined}
                onClick={() => setOpen((v) => !v)}
                className={cn("flex w-full items-center gap-3", canExpand ? "cursor-pointer" : "cursor-default")}
            >
                <span className={EVENT_RULE} />
                <span
                    className={cn(
                        "inline-flex min-w-0 items-center gap-[7px] text-muted",
                        compact ? "text-[12px]" : "text-[12.5px]"
                    )}
                >
                    <span className="shrink-0 text-secondary">Context compacted</span>
                    {stat ? <span className="truncate">· {stat}</span> : null}
                    {trigger ? <span className="shrink-0">· {trigger}</span> : null}
                    {canExpand ? (
                        <span className="flex shrink-0">
                            <TurnChevron open={open} size={12} strokeWidth={2.2} flip />
                        </span>
                    ) : null}
                </span>
                <span className={EVENT_RULE} />
            </button>
            <PaneReveal open={open && !!summary}>
                <div className="my-2 rounded-[8px] border border-edge-mid bg-surface-code px-3.5 py-3">
                    <div className="mb-1.5 text-[12px] text-muted">Summary, kept context</div>
                    <MarkdownMessage text={summary ?? ""} className={EVENT_PANEL_TEXT} />
                </div>
            </PaneReveal>
        </div>
    );
}
// The human interrupted the agent mid-turn: a divider, not a bubble.
function InterruptedDivider({ compact }: { compact: boolean }) {
    return (
        <div data-interrupted className={cn("flex items-center gap-3", compact ? "my-3.5" : "my-5")}>
            <span className={EVENT_RULE} />
            <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-ink-mid", compact ? "text-[12px]" : "text-[12.5px]")}>
                <Ban size={12} strokeWidth={2.2} aria-hidden />
                You interrupted
            </span>
            <span className={EVENT_RULE} />
        </div>
    );
}

// A finished background Task/subagent (<task-notification>): "Subagent finished · summary · status", opening to the
// child's full result (which can be large) through MarkdownMessage.
function TaskNotificationRow({
    summary,
    status,
    result,
    compact,
}: {
    summary: string;
    status?: string;
    result?: string;
    compact: boolean;
}) {
    const [open, setOpen] = useState(false);
    const canExpand = !!result;
    const ok = status == null || status === "completed";
    const tone = ok ? "text-success" : "text-warning";
    return (
        <div data-subagent-finished className={compact ? "my-3" : "my-5"}>
            <button
                type="button"
                disabled={!canExpand}
                aria-expanded={canExpand ? open : undefined}
                onClick={() => setOpen((v) => !v)}
                className={cn(
                    "flex w-full items-center border border-edge-mid text-left text-ink-mid",
                    compact ? "gap-2 rounded-[8px] px-2.5 py-[7px] text-[12.5px]" : "gap-2.5 rounded-[10px] px-3.5 py-2.5 text-[13.5px]",
                    canExpand ? "cursor-pointer hover:border-edge-strong" : "cursor-default"
                )}
            >
                <GitBranch size={14} strokeWidth={2.2} className={cn("shrink-0", tone)} aria-hidden />
                <span className="shrink-0 text-secondary">Subagent finished</span>
                {summary ? <span className="min-w-0 truncate">{summary}</span> : null}
                <span className="min-w-[6px] flex-1" />
                {status ? <span className={cn("shrink-0 text-[12px]", tone)}>{status}</span> : null}
                {canExpand ? (
                    <span className="flex shrink-0 text-muted">
                        <TurnChevron open={open} size={13} strokeWidth={2} />
                    </span>
                ) : null}
            </button>
            <PaneReveal open={open && !!result}>
                <div className="mt-1.5 rounded-[8px] border border-edge-mid bg-surface-code px-3.5 py-3">
                    <MarkdownMessage text={result ?? ""} className={EVENT_PANEL_TEXT} />
                </div>
            </PaneReveal>
        </div>
    );
}

// the line clamp per kind of clamped text, spelled out so tailwind sees each class
const CLAMP_LINES = { bubble: "line-clamp-[8]", thought: "line-clamp-3" } as const;

// Long text clamped behind Show more. The clamp is measured, not estimated, so the toggle only shows when text is
// really hidden. A find over the transcript (unfold) passes clamp=false, since a match must never sit in hidden text.
function ClampedText({
    lines,
    clamp,
    findTurn,
    className,
    children,
}: {
    lines: keyof typeof CLAMP_LINES;
    clamp: boolean;
    findTurn?: boolean;
    className?: string;
    children: React.ReactNode;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [overflows, setOverflows] = useState(false);
    const clamped = clamp && !open;
    const measure = () => {
        const el = ref.current;
        if (el != null && clamped) {
            setOverflows(el.scrollHeight > el.clientHeight + 1);
        }
    };
    useLayoutEffect(measure, [children, clamped]);
    useResizeObserver(ref, measure);
    return (
        <>
            <div ref={ref} data-find-turn={findTurn || undefined} className={cn(className, clamped && CLAMP_LINES[lines])}>
                {children}
            </div>
            {clamp && (overflows || open) ? (
                <button
                    type="button"
                    data-clamp-more
                    aria-expanded={open}
                    onClick={() => setOpen((v) => !v)}
                    className="mt-1 cursor-pointer text-[12px] text-accent-soft hover:text-primary"
                >
                    {open ? "Show less" : "Show more"}
                </button>
            ) : null}
        </>
    );
}

// A background-task notice (a shell finished, a hook skipped): one muted line, not the subagent box. A structured one
// (with a status) reads "Background task", a free-text one "Notice"; it opens to the whole text when the line hides some.
function NoticeRow({
    summary,
    status,
    result,
    compact,
}: {
    summary: string;
    status?: string;
    result?: string;
    compact: boolean;
}) {
    const [open, setOpen] = useState(false);
    const canExpand = summary.includes("\n") || !!result;
    const size = compact ? "text-[12.5px]" : "text-[13.5px]";
    return (
        <div data-notice className={compact ? "my-2" : "my-3"}>
            <button
                type="button"
                disabled={!canExpand}
                aria-expanded={canExpand ? open : undefined}
                onClick={() => setOpen((v) => !v)}
                className={cn(
                    "flex w-full min-w-0 items-center gap-2 text-left text-muted",
                    size,
                    canExpand ? "cursor-pointer hover:text-ink-mid" : "cursor-default"
                )}
            >
                <Info size={13} strokeWidth={2.2} className="shrink-0" aria-hidden />
                <span className="shrink-0 text-ink-mid">{status ? "Background task" : "Notice"}</span>
                <span className="min-w-0 truncate">{summary.split("\n")[0]}</span>
                {status ? (
                    <span className={cn("shrink-0", status !== "completed" && "text-warning")}>· {status}</span>
                ) : null}
                {canExpand ? (
                    <span className="flex shrink-0">
                        <TurnChevron open={open} size={12} strokeWidth={2.2} />
                    </span>
                ) : null}
            </button>
            <PaneReveal open={open && canExpand}>
                <div data-notice-body className={cn("mt-1 ml-[21px] text-muted", size)}>
                    <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{summary}</div>
                    {result ? <MarkdownMessage text={result} className="mt-1.5" /> : null}
                </div>
            </PaneReveal>
        </div>
    );
}

// A You bubble keeps the prompt's line breaks; a long one (a run's goal, a pasted spec) is clamped behind Show more.
function UserBubbleText({ text, clamp, compact }: { text: string; clamp: boolean; compact: boolean }) {
    return (
        <ClampedText
            lines="bubble"
            clamp={clamp}
            findTurn
            className={cn(
                "whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]",
                compact ? "text-[13px] leading-[1.5]" : "text-[14px] leading-[1.55]"
            )}
        >
            {text.trim()}
        </ClampedText>
    );
}

// the person's bubble; the Rendered view's queued foot draws one too
export function PersonBubble({
    text,
    clamp,
    compact,
    children,
}: {
    text: string;
    clamp: boolean;
    compact: boolean;
    children?: React.ReactNode;
}) {
    return (
        <div
            className={cn(
                "max-w-[82%] bg-surface-hover",
                compact ? "rounded-[10px] px-[11px] py-2" : "rounded-[12px] px-[15px] py-[11px]"
            )}
        >
            {text ? <UserBubbleText text={text} clamp={clamp} compact={compact} /> : null}
            {children}
        </div>
    );
}

// path -> a blob url, or null once it failed; a path still loading is absent
type LocalImages = Record<string, string | null>;

// An <img src> cannot carry the auth header wavesrv needs under tauri (fetchutil.ts), so each attached image path is
// fetched and drawn from a blob url. A failed fetch, or an image that fails to decode (fail), falls back to a file chip.
function useLocalImages(paths: string[]): [LocalImages, (path: string) => void] {
    const key = paths.join("\n");
    const [loaded, setLoaded] = useState<LocalImages>({});
    useEffect(() => {
        setLoaded({});
        if (key === "") {
            return;
        }
        let cancelled = false;
        const urls: string[] = [];
        for (const path of key.split("\n")) {
            fireAndForget(async () => {
                let url: string | null = null;
                try {
                    const resp = await fetch(localFileUrl(getWebServerEndpoint(), path));
                    if (resp.ok && !cancelled) {
                        const blob = await resp.blob();
                        // the blob can land after cleanup revoked the list; a url made then would never be revoked
                        if (!cancelled) {
                            url = URL.createObjectURL(blob);
                            urls.push(url);
                        }
                    }
                } catch (e) {
                    console.warn("bubble attachment: cannot load", path, e);
                }
                if (!cancelled) {
                    setLoaded((cur) => ({ ...cur, [path]: url }));
                }
            });
        }
        return () => {
            cancelled = true;
            urls.forEach((u) => URL.revokeObjectURL(u));
        };
    }, [key]);
    const fail = (path: string) => setLoaded((cur) => ({ ...cur, [path]: null }));
    return [loaded, fail];
}

function FileChip({ path }: { path: string }) {
    return (
        <span
            data-file-chip
            title={path}
            className="flex h-[26px] min-w-0 items-center gap-1.5 rounded-[7px] border border-edge-mid bg-surface px-2 text-[12px] text-secondary"
        >
            <FileIcon size={13} className="shrink-0 text-muted" aria-hidden />
            <span className="max-w-[200px] truncate font-mono">{path.split(/[\\/]/).pop() || path}</span>
        </span>
    );
}

// a bubble's pasted images and attached paths, under its text: thumbnails that open the zoom view, then file chips
function BubbleAttachments({ item, compact }: { item: Extract<LayoutItem, { kind: "user" }>; compact: boolean }) {
    const imagePaths = item.imagePaths ?? [];
    const [loaded, fail] = useLocalImages(imagePaths);
    const pasted = (item.images ?? []).map((img, i) => ({
        src: `data:${img.mediaType};base64,${img.data}`,
        alt: `Pasted image ${i + 1}`,
    }));
    const local = imagePaths.filter((p) => loaded[p] != null);
    const thumbs = [...pasted, ...local.map((p) => ({ src: loaded[p], alt: p.split(/[\\/]/).pop() || p }))];
    const chips = [...imagePaths.filter((p) => loaded[p] === null), ...(item.filePaths ?? [])];
    if (thumbs.length === 0 && chips.length === 0) {
        return null;
    }
    return (
        <div data-bubble-attachments className="mt-2 flex flex-col gap-2 first:mt-0">
            {thumbs.length > 0 ? (
                <ImageThumbs
                    images={thumbs}
                    compact={compact}
                    onError={(i) => {
                        if (i >= pasted.length) fail(local[i - pasted.length]);
                    }}
                />
            ) : null}
            {chips.length > 0 ? (
                <div className="flex min-w-0 flex-wrap gap-1.5">
                    {chips.map((p, i) => (
                        <FileChip key={i} path={p} />
                    ))}
                </div>
            ) : null}
        </div>
    );
}

// A mark's text is "<choice>: <subject>" (permissionLogText). A yes reads "You allowed <subject>"; any other answer
// reads "You answered <choice>", so a refusal never claims an allow. The whole text stays in the row.
const MARK_SEP = ": ";

function PermissionMarkRow({ text, compact }: { text: string; compact: boolean }) {
    const at = text.indexOf(MARK_SEP);
    const choice = at < 0 ? text : text.slice(0, at);
    const subject = at < 0 ? "" : text.slice(at + MARK_SEP.length);
    const allowed = /^yes\b/i.test(choice);
    return (
        <div
            data-permission-mark
            className={cn("flex min-w-0 items-center gap-2 text-muted", compact ? "my-3 text-[12.5px]" : "my-[18px] text-[13.5px]")}
        >
            <Check size={13} strokeWidth={2.6} className="shrink-0 text-ink-mid" aria-hidden />
            <span className="shrink-0">{allowed ? "You allowed" : `You answered ${choice}`}</span>
            {subject ? (
                <span className={cn("min-w-0 truncate font-mono text-ink-mid", compact ? "text-[11.5px]" : "text-[12px]")}>{subject}</span>
            ) : null}
            {/* a bare "Yes" adds nothing to "You allowed"; a scoped one ("…this session") does */}
            {allowed && choice.toLowerCase() !== "yes" ? <span className="min-w-0 truncate">· {choice}</span> : null}
        </div>
    );
}

// memo: every agent:status rebuilds each AgentVM and re-renders every card, while a card's entries change only on its
// own transcript chunk, so an unchanged timeline (up to TIMELINE_RENDER_CAP items) skips the re-render
// copy on select, as in the claude code TUI. the mouseup listener is on window so a drag released outside the
// transcript still copies; the flag keeps a nested timeline (a subagent's) and its host from copying twice.
let selectionCopyArmed = false;
function armSelectionCopy(e: React.MouseEvent<HTMLElement>) {
    if (e.button !== 0 || selectionCopyArmed) return;
    selectionCopyArmed = true;
    const root = e.currentTarget;
    window.addEventListener(
        "mouseup",
        () => {
            selectionCopyArmed = false;
            const sel = window.getSelection();
            if (sel == null || sel.isCollapsed || !root.contains(sel.anchorNode)) return;
            const text = sel.toString();
            if (text.trim() === "") return;
            void writeClipboard(text).then((state) =>
                pushToast(
                    state === "copied"
                        ? { title: `Copied ${text.length} chars to clipboard`, message: "", level: "info" }
                        : { title: "Copy to clipboard failed", message: "", level: "error" }
                )
            );
        },
        { once: true }
    );
}

export const NarrationTimeline = memo(function NarrationTimeline({
    entries,
    accentLatest,
    active,
    renderAll,
    renderers,
    marks,
    thoughts,
    className,
    tail,
    ctx,
    compact,
    unfold,
    entryRow,
}: {
    entries: AgentEntry[];
    accentLatest?: boolean;
    active?: boolean;
    // lifts the item cap, for a whole session loaded or read in full; the clamp stays, since only a find needs it gone
    renderAll?: boolean;
    // draws the registered tool output cards open under their rows; only the rendered view sets it,
    // since always-open cards would bloat the cockpit's narrow cards
    renderers?: boolean;
    // session-local rows the rendered view records after answering a permission prompt, each drawn after the item
    // holding entry afterEntry - 1
    marks?: TimelineMark[];
    // draws a thinking-only message as a muted line between steps; only the rendered view sets it
    thoughts?: boolean;
    className?: string;
    // what the host knows about the agent, for wsh cards' links and Arc's messages
    ctx?: TranscriptContext;
    // a card-width host (agent row, lead card, subagent interior)
    compact?: boolean;
    // drawn after the last item, inside the column
    tail?: React.ReactNode;
    // a find is active: every finished turn's fold draws open and no bubble or thought is clamped, so a match never
    // sits in hidden text
    unfold?: boolean;
    // consulted for each user prompt and Arc message: a row returned replaces the one the timeline would draw
    entryRow?: (entry: AgentEntry, index: number) => React.ReactNode | null;
}) {
    // ctx feeds the layout only through its role (a run brief), so a host's fresh ctx object does not relayout; a host's
    // fresh marks array relayouts only when a mark moves
    const role = ctx?.role;
    const marksKey = (marks ?? []).map((m) => m.afterEntry).join(",");
    const items = useMemo(
        () => layoutTranscript(entries, { active: !!active, ctx: { role }, thoughts, renderers, marks }),
        [entries, active, role, thoughts, renderers, marksKey]
    );
    // a turn folding after the first render is one that just finished
    const mounted = useRef(false);
    useEffect(() => {
        mounted.current = true;
    }, []);
    // a row enters with its fade once: one a turn takes in (its first step, or the live turn's start) is redrawn
    // inside it, and must not fade in again. Recorded after commit, so a render React discards records nothing
    const drawn = useRef(new Set<string>());
    const rendered: string[] = [];
    const entering = (id: string) => {
        rendered.push(id);
        return mounted.current && !drawn.current.has(id);
    };
    useEffect(() => {
        rendered.forEach((id) => drawn.current.add(id));
    });
    const cardCtx = ctx ?? NO_CTX;
    const isCompact = !!compact;
    const visibleItems =
        !renderAll && items.length > TIMELINE_RENDER_CAP ? items.slice(items.length - TIMELINE_RENDER_CAP) : items;
    const lastTurn = items.filter((i) => i.kind === "turn").pop();
    const copyMenu = (text: string) => (e: React.MouseEvent) =>
        ContextMenuModel.getInstance().showContextMenu(
            [
                { label: "Copy text", icon: <Copy size={15} />, click: () => void navigator.clipboard.writeText(text) },
                { label: "Copy conversation", icon: <Copy size={15} />, click: () => void navigator.clipboard.writeText(conversationText(entries)) },
            ],
            e
        );

    const placed = placeMarks(visibleItems, marks ?? []);
    const markRows = (list: TimelineMark[] | undefined) =>
        (list ?? []).map((m, k) => <PermissionMarkRow key={`pm${m.afterEntry}-${k}`} text={m.text} compact={isCompact} />);
    const withMarks = (rows: React.ReactNode[]) => [
        ...markRows(placed.lead),
        ...rows.flatMap((row, idx) => [row, ...markRows(placed.after.get(idx))]),
    ];

    const renderItem = (item: LayoutItem): React.ReactNode => {
        if (item.kind === "turn") {
            return (
                <TurnFold
                    key={"f" + item.startIndex}
                    fold={item.fold}
                    live={!!item.live}
                    startsOpen={item.open}
                    finishing={mounted.current && item === lastTurn}
                    unfold={!!unfold}
                    compact={isCompact}
                >
                    {item.items.map(renderItem)}
                </TurnFold>
            );
        }
        if (item.kind === "message") {
            return (
                <motion.div
                    key={item.index}
                    data-find-turn
                    className={cn(
                        "min-w-0",
                        isCompact ? "my-3 text-[13px] leading-[1.55]" : "my-[18px] text-[14px] leading-[1.6]",
                        accentLatest && item.latest ? "text-foreground" : "text-secondary"
                    )}
                    onContextMenu={copyMenu(item.text)}
                    variants={viewFade}
                    initial={entering("m" + item.index) && shouldFadeEntry("message") ? "initial" : false}
                    animate="animate"
                >
                    <MarkdownMessage text={item.text} />
                </motion.div>
            );
        }
        if (item.kind === "thought") {
            return (
                <motion.div
                    key={"t" + item.index}
                    data-thought
                    className={cn("min-w-0", isCompact ? "my-2" : "my-2.5")}
                    variants={viewFade}
                    initial={entering("t" + item.index) && shouldFadeEntry("thought") ? "initial" : false}
                    animate="animate"
                >
                    <ThoughtText text={item.text} clamp={!unfold} compact={isCompact} />
                </motion.div>
            );
        }
        // a host's own row for a prompt or an Arc message (the Rendered view's brainstorm answers) stands in its place
        const at = item.kind === "user" || item.kind === "arc" ? item.index : null;
        const own = at != null ? (entryRow?.(entries[at], at) ?? null) : null;
        if (own != null) {
            return (
                <motion.div
                    key={(item.kind === "arc" ? "a" : "") + at}
                    data-entry-row
                    data-entry-index={at}
                    variants={viewFade}
                    initial={shouldFadeEntry("user") ? "initial" : false}
                    animate="animate"
                >
                    {own}
                </motion.div>
            );
        }
        if (item.kind === "user") {
            return (
                <motion.div
                    key={item.index}
                    data-user-bubble
                    data-entry-index={item.index}
                    className={cn("flex justify-end", isCompact ? "my-3.5 ml-7" : "my-6")}
                    onContextMenu={copyMenu(item.text)}
                    variants={viewFade}
                    initial={shouldFadeEntry("user") ? "initial" : false}
                    animate="animate"
                >
                    <PersonBubble text={item.text} clamp={!unfold} compact={isCompact}>
                        {item.images || item.imagePaths || item.filePaths ? (
                            <BubbleAttachments item={item} compact={isCompact} />
                        ) : null}
                    </PersonBubble>
                </motion.div>
            );
        }
        if (item.kind === "command") {
            return (
                <motion.div
                    key={item.index}
                    variants={viewFade}
                    initial="initial"
                    animate="animate"
                >
                    <CommandChip name={item.name} args={item.args} isSkill={item.isSkill} output={item.output} compact={isCompact} />
                </motion.div>
            );
        }
        if (item.kind === "compaction") {
            return (
                <motion.div
                    key={item.index}
                    variants={viewFade}
                    initial="initial"
                    animate="animate"
                >
                    <CompactionDivider trigger={item.trigger} preTokens={item.preTokens} postTokens={item.postTokens} summary={item.summary} compact={isCompact} />
                </motion.div>
            );
        }
        if (item.kind === "notification") {
            return (
                <motion.div
                    key={item.index}
                    variants={viewFade}
                    initial={entering("n" + item.index) ? "initial" : false}
                    animate="animate"
                >
                    {item.notice ? (
                        <NoticeRow summary={item.summary} status={item.status} result={item.result} compact={isCompact} />
                    ) : (
                        <TaskNotificationRow summary={item.summary} status={item.status} result={item.result} compact={isCompact} />
                    )}
                </motion.div>
            );
        }
        if (item.kind === "interrupted") {
            return (
                <motion.div
                    key={item.index}
                    variants={viewFade}
                    initial="initial"
                    animate="animate"
                >
                    <InterruptedDivider compact={isCompact} />
                </motion.div>
            );
        }
        if (item.kind === "arc") {
            return (
                <motion.div key={"a" + item.index} variants={cardVariants} initial="initial" animate="animate">
                    <ArcMessageRow
                        message={item.message}
                        ts={item.ts}
                        idleMs={item.idleMs}
                        latest={item.latest}
                        ctx={cardCtx}
                        compact={isCompact}
                    />
                </motion.div>
            );
        }
        if (item.kind === "card") {
            return (
                <motion.div
                    key={"c" + item.index}
                    className={isCompact ? "my-2" : "my-2.5"}
                    variants={cardVariants}
                    initial={entering("c" + item.index) ? "initial" : false}
                    animate="animate"
                >
                    <WshCardItem step={item.step} ctx={cardCtx} compact={isCompact} />
                </motion.div>
            );
        }
        if (item.kind === "shell") {
            return (
                <motion.div key={"sh" + item.index} variants={cardVariants} initial="initial" animate="animate">
                    <ShellRunRow command={item.command} stdout={item.stdout} stderr={item.stderr} compact={isCompact} />
                </motion.div>
            );
        }
        // a new stretch arrives as one box, so its fade is one entrance, never a burst of tool lines
        return (
            <motion.div
                key={"s" + item.startIndex}
                variants={viewFade}
                initial={entering("s" + item.startIndex) ? "initial" : false}
                animate="animate"
            >
                <StepBox
                    steps={item.steps}
                    thoughts={item.thoughts}
                    renderers={renderers}
                    clamp={!unfold}
                    ctx={cardCtx}
                    compact={isCompact}
                />
            </motion.div>
        );
    };

    return (
        <div className={cn("leading-relaxed", className)} onMouseDown={armSelectionCopy}>
            <AnimatePresence initial={false}>{withMarks(visibleItems.map(renderItem))}</AnimatePresence>
            {tail}
        </div>
    );
});

