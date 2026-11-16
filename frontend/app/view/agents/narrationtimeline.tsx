// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ContextMenuModel } from "@/app/store/contextmenu";
import { modalsModel } from "@/app/store/modalmodel";
import { MONO_FAINT } from "@/app/view/jarvis/briefstyle";
import { cn } from "@/util/util";
import { ArrowUpRight, Ban, Check, ChevronDown, ChevronRight, ChevronUp, Copy, Ellipsis, LoaderCircle, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { MOTION, composerReveal, shouldFadeEntry } from "@/app/element/motiontokens";
import useResizeObserver from "@react-hook/resize-observer";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
    conversationText,
    detailExceedsInline,
    formatTokens,
    type ActionDetail,
    type AgentActionEntry,
    type AgentEntry,
} from "./agentsviewmodel";
import { ArcMessageRow } from "./arcmessagerow";
import { MarkdownMessage } from "./markdownmessage";
import { placeMarks, type TimelineMark } from "./permissionmodel";
import { highlightLine } from "./highlight";
import { toolRendererKey } from "./renderregistry";
import { fmtDuration } from "./runcompletion";
import { TIMELINE_RENDER_CAP } from "./sessionstranscript";
import { formatDuration } from "./tooldetail";
import type { TranscriptContext } from "./transcriptcontext";
import { layoutTranscript, stepTitle, type FoldSummary, type Step } from "./transcriptlayout";
import { ToolOutputRenderer } from "./toolrenderers";
import { isCardKey } from "./wshcall";
import { WshChangeRow } from "./wshchangerow";
import { wshRendererFor, type WshRendererProps } from "./wshrenderers";

// The transcript feed. layoutTranscript (transcriptlayout.ts) decides the items: prose, user bubbles, events, Arc's own
// messages, wsh change cards, and stretches of tool steps, a finished turn's long stretch folded into "Worked for N".
// While `active`, the live turn's stretches stay open.

// a host that passes no ctx: cards still render, with no links
const NO_CTX: TranscriptContext = {};

// inline panels wrap long lines so a narrow card never scrolls sideways; the modal has room, so it keeps them unwrapped
function lineWrap(variant: "inline" | "modal"): string {
    return variant === "inline" ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre";
}

function ExitChip({ exit }: { exit: number }) {
    return (
        <span
            className={cn(
                "rounded-[4px] px-[7px] py-px font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em]",
                exit ? "bg-error/15 text-error" : "bg-success/15 text-success"
            )}
        >
            exit {exit}
        </span>
    );
}

// pending: the call has no result yet (running, or waiting on a permission prompt), so it claims neither outcome
export function StatusSquare({ ok, pending }: { ok: boolean; pending?: boolean }) {
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

function Affordance({ toModal, open }: { toModal: boolean; open: boolean }) {
    const Icon = toModal ? ArrowUpRight : open ? ChevronDown : ChevronRight;
    return (
        <span className="flex shrink-0 text-muted">
            <Icon size={12} strokeWidth={2.2} aria-hidden />
        </span>
    );
}

const TOOL_ROW = "flex items-center gap-2 rounded-[6px] px-1.5 py-[3px]";
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

// Shared per-kind detail renderer. Used inline (capped by max-height) and by the modal (uncapped).
// Tokens only — no raw hex. See Wave-transcript-feed.dc.html.
export function ToolDetailBody({ detail, variant }: { detail: ActionDetail; variant: "inline" | "modal" }) {
    const modal = variant === "modal";
    const pad = modal ? "px-4 py-3" : "px-[11px] py-[9px]";
    const wrap = lineWrap(variant);
    if (detail.kind === "grep") {
        return (
            <div className={pad}>
                {detail.matches.map((g, i) => (
                    <div key={i} className="flex gap-2.5 whitespace-pre font-mono text-[11.5px] leading-[1.65]">
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
                            {highlightLine(ln).map((tk, k) => (
                                <span key={k} className={tk.cls}>
                                    {tk.t}
                                </span>
                            ))}
                        </div>
                    ))}
                </div>
            </div>
        );
    }
    if (detail.kind === "bash") {
        return (
            <div>
                {detail.command ? (
                    <div
                        className={cn(
                            "flex gap-2 whitespace-pre-wrap font-mono text-[11.5px] leading-[1.6] text-secondary [overflow-wrap:anywhere]",
                            pad
                        )}
                    >
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
                            detail.command && "border-t border-edge-faint",
                            pad,
                            detail.exit ? "text-error" : "text-ink-mid"
                        )}
                    >
                        {detail.output}
                    </pre>
                ) : null}
                {/* inline, the exit chip sits in the panel footer (ToolLine) so it never scrolls away */}
                {modal ? (
                    <div className="flex items-center gap-2 px-[13px] pb-[9px]">
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
    // edit
    return (
        <div className="flex flex-col">
            {detail.files.map((f, i) => (
                <div key={i} className="border-b border-lane last:border-b-0">
                    <div className="flex items-center gap-2.5 bg-surface px-[11px] py-[7px]">
                        <span
                            className={cn(
                                "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] font-mono text-[10.5px] font-bold",
                                f.badge === "A" ? "bg-success/15 text-success" : "bg-warning/15 text-warning"
                            )}
                        >
                            {f.badge}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-hi">{f.path}</span>
                        <span className={cn("font-mono text-[10.5px]", f.adds > 0 ? "font-bold text-diff-added" : "text-muted")}>
                            +{f.adds}
                        </span>
                        <span className={cn("font-mono text-[10.5px]", f.dels > 0 ? "font-bold text-diff-removed" : "text-muted")}>
                            −{f.dels}
                        </span>
                    </div>
                    <div className={cn("bg-surface-code py-1", modal && "overflow-x-auto")}>
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
                                <div
                                    key={k}
                                    className={cn(
                                        "flex font-mono text-[11.5px] leading-[1.7]",
                                        wrap,
                                        l.sign === "+"
                                            ? "bg-diff-added/[0.09]"
                                            : l.sign === "-"
                                              ? "bg-diff-removed/[0.09]"
                                              : ""
                                    )}
                                >
                                    {/* the sign column stays put, so a wrapped line hangs under its own text */}
                                    <span
                                        className={cn(
                                            "w-[13px] shrink-0 text-center",
                                            l.sign === "+"
                                                ? "text-diff-added"
                                                : l.sign === "-"
                                                  ? "text-diff-removed"
                                                  : "text-ink-faint"
                                        )}
                                    >
                                        {l.sign}
                                    </span>
                                    <span
                                        className={cn(
                                            "min-w-0 pr-3.5",
                                            l.sign === "+"
                                                ? "text-diff-added"
                                                : l.sign === "-"
                                                  ? "text-diff-removed"
                                                  : "text-secondary"
                                        )}
                                    >
                                        {l.text}
                                    </span>
                                </div>
                                )
                            )}
                        </div>
                    </div>
                </div>
            ))}
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
            {mono ? <span className={cn("min-w-0 truncate font-mono text-ink-faint", monoSize)}>{mono}</span> : null}
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
            ) : status === "stopped" ? (
                <span className={cn("shrink-0 text-muted", compact ? "text-[11px]" : "text-[12px]")}>stopped</span>
            ) : action.durationMs ? (
                <span className={time}>{formatDuration(action.durationMs)}</span>
            ) : null}
        </>
    );
}

// a step's opened body: a wsh read call's structured view, else the tool detail as today
function StepBody({ step, View, ctx, compact }: { step: Step; View?: ComponentType<WshRendererProps>; ctx: TranscriptContext; compact: boolean }) {
    const { action } = step;
    const openFull = (
        <button
            type="button"
            aria-label="Open full view"
            onClick={() => modalsModel.pushModal("AgentToolDetailModal", { action })}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-[5px] px-1.5 py-[3px] font-mono text-[10.5px] text-ink-mid hover:bg-lane hover:text-primary"
        >
            <ArrowUpRight size={12} strokeWidth={2.2} aria-hidden />
            Open full view
        </button>
    );
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
            <div className="max-h-[200px] overflow-auto">
                <ToolDetailBody detail={detail} variant="inline" />
            </div>
            <div className="flex items-center gap-2 border-t border-edge-faint px-1.5 py-[3px]">
                {detail.kind === "bash" ? <ExitChip exit={detail.exit} /> : null}
                <div className="flex-1" />
                {openFull}
            </div>
        </div>
    );
}

// One step: its title, command in mono, exit chip, time and chevron. Opens to its body inline, or to the modal when
// the detail is past its inline budget; a step with neither a body nor a wsh view is a plain row.
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
    const [open, setOpen] = useState(false);
    const { action, status, wsh } = step;
    const View = wsh && !isCardKey(wsh.key) ? wshRendererFor(wsh.key) : undefined;
    const detail = action.detail;
    const toModal = !View && detail != null && detailExceedsInline(detail);
    const clickable = View != null || detail != null;
    const onClick = () => {
        if (toModal) {
            modalsModel.pushModal("AgentToolDetailModal", { action });
        } else {
            setOpen((v) => !v);
        }
    };
    const head = cn(
        "flex w-full items-center text-left font-sans",
        compact ? "gap-2 text-[12.5px]" : "gap-2.5 text-[13.5px]",
        status === "running" ? "text-secondary" : "text-ink-mid",
        askAnswer(action) != null && "items-start"
    );
    const content = (
        <>
            {status === "running" ? (
                <LoaderCircle
                    size={compact ? 13 : 14}
                    strokeWidth={2.2}
                    role="img"
                    aria-label="Running"
                    className="shrink-0 animate-spin text-ink-mid"
                />
            ) : null}
            <StepTitle step={step} compact={compact} />
            <span className="min-w-[6px] flex-1" />
            <StepFacts step={step} compact={compact} />
            {clickable && !compact ? <Affordance toModal={toModal} open={open} /> : null}
        </>
    );
    const rendererKey = renderers ? toolRendererKey(action) : null;
    return (
        <div
            data-step
            data-step-status={status}
            className={cn("border-t border-edge-faint first:border-t-0", compact ? "px-2.5 py-[7px]" : "px-3.5 py-2.5")}
        >
            {clickable ? (
                <button type="button" aria-expanded={toModal ? undefined : open} onClick={onClick} className={cn(head, "cursor-pointer")}>
                    {content}
                </button>
            ) : (
                <div className={head}>{content}</div>
            )}
            <AnimatePresence initial={false}>
                {open && !toModal ? (
                    <motion.div key="body" variants={composerReveal} initial="initial" animate="animate" exit="exit" className="overflow-hidden">
                        <StepBody step={step} View={View} ctx={ctx} compact={compact} />
                    </motion.div>
                ) : null}
            </AnimatePresence>
            {rendererKey ? (
                <div className="mt-2">
                    <ToolOutputRenderer action={action} />
                </div>
            ) : null}
        </div>
    );
}

function StepBox({ steps, renderers, ctx, compact }: { steps: Step[]; renderers?: boolean; ctx: TranscriptContext; compact: boolean }) {
    return (
        <div data-steps className={cn("overflow-hidden border border-edge-mid", compact ? "my-2 rounded-[8px]" : "my-2.5 rounded-[10px]")}>
            {steps.map((step) => (
                <StepRow key={step.index} step={step} renderers={renderers} ctx={ctx} compact={compact} />
            ))}
        </div>
    );
}

// "Worked for N · phrase +a −d ✗ k failed": a finished turn's folded stretch
function FoldLine({ fold, open, onClick, compact }: { fold: FoldSummary; open: boolean; onClick: () => void; compact: boolean }) {
    return (
        <button
            type="button"
            data-fold
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
                {open ? <ChevronDown size={14} strokeWidth={2} aria-hidden /> : <ChevronRight size={14} strokeWidth={2} aria-hidden />}
            </span>
        </button>
    );
}

// A stretch: a box of steps, or, folded, its Worked-for line that opens to the box. A stretch holding a tool output
// card (rendered view only) starts open, since a fold would hide the card.
function StepsBlock({
    steps,
    fold,
    renderers,
    ctx,
    compact,
}: {
    steps: Step[];
    fold: FoldSummary | null;
    renderers?: boolean;
    ctx: TranscriptContext;
    compact: boolean;
}) {
    const [toggled, setToggled] = useState(false);
    if (fold == null) {
        return <StepBox steps={steps} renderers={renderers} ctx={ctx} compact={compact} />;
    }
    const hasCard = !!renderers && steps.some((s) => toolRendererKey(s.action) != null);
    const open = hasCard ? !toggled : toggled;
    return (
        <div>
            <FoldLine fold={fold} open={open} onClick={() => setToggled((v) => !v)} compact={compact} />
            <AnimatePresence initial={false}>
                {open ? (
                    <motion.div key="box" variants={composerReveal} initial="initial" animate="animate" exit="exit" className="overflow-hidden">
                        <StepBox steps={steps} renderers={renderers} ctx={ctx} compact={compact} />
                    </motion.div>
                ) : null}
            </AnimatePresence>
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

function CommandChip({ name, args, isSkill }: { name: string; args?: string; isSkill?: boolean }) {
    return (
        <div className="mt-2 flex justify-end">
            <span
                className={cn(
                    "inline-flex max-w-[88%] flex-wrap items-baseline rounded-lg border px-[11px] py-[5px] font-mono",
                    isSkill ? "border-skill/35 bg-skill/[0.08]" : "border-accent/35 bg-accent/[0.07]"
                )}
            >
                {isSkill ? <span className="mr-[7px] self-center text-[11px] text-skill">✦</span> : null}
                <span className={cn("text-[12px] font-semibold", isSkill ? "text-skill-soft" : "text-accent-soft")}>{name}</span>
                {args ? (
                    <span className={cn("ml-2 border-l pl-2 text-[11.5px] text-feed-summary", isSkill ? "border-skill/25" : "border-accent/25")}>
                        {args}
                    </span>
                ) : null}
            </span>
        </div>
    );
}

function CompactionDivider({
    trigger,
    preTokens,
    postTokens,
    summary,
}: {
    trigger?: string;
    preTokens?: number;
    postTokens?: number;
    summary?: string;
}) {
    const [open, setOpen] = useState(false);
    const stat = preTokens != null && postTokens != null ? `${formatTokens(preTokens)} → ${formatTokens(postTokens)} tokens` : null;
    const canExpand = !!summary;
    return (
        <div className="mt-3.5">
            <button type="button" disabled={!canExpand} onClick={() => setOpen((v) => !v)} className={cn("flex w-full items-center gap-2.5", canExpand ? "cursor-pointer" : "cursor-default")}>
                <span className="h-px flex-1 bg-edge-mid" />
                <span className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-accent/30 bg-accent/[0.07] px-2.5 py-0.5 font-mono text-[10.5px] leading-[1.6]">
                    <span className="font-semibold uppercase tracking-[0.1em] text-accent-soft">Compacted</span>
                    {stat ? (
                        <>
                            <span className="text-ink-faint">·</span>
                            <span className="text-ink-mid">{stat}</span>
                        </>
                    ) : null}
                    {trigger ? (
                        <>
                            <span className="text-ink-faint">·</span>
                            <span className="text-muted">{trigger}</span>
                        </>
                    ) : null}
                    {canExpand ? (
                        <span className="flex text-muted">
                            {open ? (
                                <ChevronUp size={10} strokeWidth={2.4} aria-hidden />
                            ) : (
                                <ChevronDown size={10} strokeWidth={2.4} aria-hidden />
                            )}
                        </span>
                    ) : null}
                </span>
                <span className="h-px flex-1 bg-edge-mid" />
            </button>
            <AnimatePresence initial={false}>
                {open && summary ? (
                    <motion.div
                        key="sum"
                        variants={composerReveal}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className="my-2 overflow-hidden rounded-[8px] border border-edge-mid bg-surface-code px-3.5 py-3"
                    >
                        <div className="mb-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted">
                            Summary — kept context
                        </div>
                        <MarkdownMessage text={summary} />
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </div>
    );
}
// The human interrupted the agent mid-turn. A thin centered marker, not a You bubble.
function InterruptedDivider() {
    return (
        <div className="mt-3 flex items-center gap-2.5">
            <span className="h-px flex-1 bg-edge-mid" />
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-edge-strong bg-surface px-2.5 py-0.5 font-mono text-[10.5px] font-semibold uppercase leading-[1.6] tracking-[0.1em] text-ink-mid">
                <Ban size={10} strokeWidth={2.4} aria-hidden />
                Interrupted
            </span>
            <span className="h-px flex-1 bg-edge-mid" />
        </div>
    );
}

// A finished background Task/subagent (<task-notification>). Collapsed: a "Task" chip + summary +
// status pill; expands to the child's full result via MarkdownMessage (result can be large).
function TaskNotificationRow({ summary, status, result }: { summary: string; status?: string; result?: string }) {
    const [open, setOpen] = useState(false);
    const canExpand = !!result;
    const ok = status == null || status === "completed";
    return (
        <div className="mt-2 flex gap-2.5">
            <span
                className={cn(
                    "mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border font-mono text-[12px]",
                    ok ? "border-success/30 bg-success/[0.12] text-success" : "border-warning/30 bg-warning/[0.12] text-warning"
                )}
            >
                ⑃
            </span>
            <div className="min-w-0 flex-1">
                <button
                    type="button"
                    disabled={!canExpand}
                    onClick={() => setOpen((v) => !v)}
                    className={cn(
                        "flex w-full items-center gap-2 rounded-[8px] border border-edge-mid bg-surface px-2.5 py-1.5 text-left",
                        canExpand ? "cursor-pointer hover:border-edge-strong" : "cursor-default"
                    )}
                >
                    <span className="shrink-0 font-mono text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-mid">
                        Task
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-secondary">{summary || "Subagent finished"}</span>
                    {status ? (
                        <span
                            className={cn(
                                "shrink-0 rounded-[4px] px-1.5 py-px font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em]",
                                ok ? "bg-success/15 text-success" : "bg-warning/15 text-warning"
                            )}
                        >
                            {status}
                        </span>
                    ) : null}
                    {canExpand ? (
                        <span className="flex shrink-0 text-muted">
                            {open ? (
                                <ChevronDown size={12} strokeWidth={2.2} aria-hidden />
                            ) : (
                                <ChevronRight size={12} strokeWidth={2.2} aria-hidden />
                            )}
                        </span>
                    ) : null}
                </button>
                <AnimatePresence initial={false}>
                    {open && result ? (
                        <motion.div
                            key="res"
                            variants={composerReveal}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            className="mt-1.5 overflow-hidden rounded-[8px] border border-edge-mid bg-surface-code px-3.5 py-3"
                        >
                            <MarkdownMessage text={result} />
                        </motion.div>
                    ) : null}
                </AnimatePresence>
            </div>
        </div>
    );
}

// A You bubble keeps the prompt's line breaks; a long one (a run's goal, a pasted spec) is clamped behind Show more.
// The clamp is measured, not estimated, so the toggle only shows when text is really hidden. A find over the
// transcript passes clamp=false, since a match must never sit in hidden text.
function UserBubbleText({ text, clamp }: { text: string; clamp: boolean }) {
    const ref = useRef<HTMLParagraphElement>(null);
    const [open, setOpen] = useState(false);
    const [overflows, setOverflows] = useState(false);
    const clamped = clamp && !open;
    const measure = () => {
        const el = ref.current;
        if (el != null && clamped) {
            setOverflows(el.scrollHeight > el.clientHeight + 1);
        }
    };
    useLayoutEffect(measure, [text, clamped]);
    useResizeObserver(ref, measure);
    return (
        <>
            <p
                ref={ref}
                data-find-turn
                className={cn(
                    "whitespace-pre-wrap text-[13px] leading-[1.5] text-primary [overflow-wrap:anywhere]",
                    clamped && "line-clamp-[8]"
                )}
            >
                {text.trim()}
            </p>
            {clamp && (overflows || open) ? (
                <button
                    type="button"
                    data-bubble-more
                    aria-expanded={open}
                    onClick={() => setOpen((v) => !v)}
                    className="mt-1 cursor-pointer font-mono text-[10.5px] text-accent-soft hover:text-primary"
                >
                    {open ? "Show less" : "Show more"}
                </button>
            ) : null}
        </>
    );
}

function PermissionMarkRow({ text }: { text: string }) {
    return (
        <div data-permission-mark className={cn(TOOL_ROW, MONO_FAINT)}>
            <StatusSquare ok />
            <span className="min-w-0 truncate">{text}</span>
        </div>
    );
}

// memo: every agent:status rebuilds each AgentVM and re-renders every card, while a card's entries change only on its
// own transcript chunk, so an unchanged timeline (up to TIMELINE_RENDER_CAP items) skips the re-render
export const NarrationTimeline = memo(function NarrationTimeline({
    entries,
    accentLatest,
    active,
    renderAll,
    renderers,
    marks,
    className,
    tail,
    ctx,
    compact,
}: {
    entries: AgentEntry[];
    accentLatest?: boolean;
    active?: boolean;
    // a find over the transcript must reach its earliest turns, so it lifts the cap
    renderAll?: boolean;
    // draws the registered tool output cards open under their rows; only the rendered view sets it,
    // since always-open cards would bloat the cockpit's narrow cards
    renderers?: boolean;
    // session-local rows the rendered view records after answering a permission prompt, each drawn after the item
    // holding entry afterEntry - 1
    marks?: TimelineMark[];
    className?: string;
    // what the host knows about the agent, for wsh cards' links and Arc's messages
    ctx?: TranscriptContext;
    // a card-width host (agent row, lead card, subagent interior)
    compact?: boolean;
    // drawn after the last item, inside the column
    tail?: React.ReactNode;
}) {
    // ctx feeds the layout only through its role (a run brief), so a host's fresh ctx object does not relayout
    const role = ctx?.role;
    const items = useMemo(() => layoutTranscript(entries, { active: !!active, ctx: { role } }), [entries, active, role]);
    const cardCtx = ctx ?? NO_CTX;
    const isCompact = !!compact;
    const visibleItems =
        !renderAll && items.length > TIMELINE_RENDER_CAP ? items.slice(items.length - TIMELINE_RENDER_CAP) : items;
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
        (list ?? []).map((m, k) => <PermissionMarkRow key={`pm${m.afterEntry}-${k}`} text={m.text} />);
    const withMarks = (rows: React.ReactNode[]) => [
        ...markRows(placed.lead),
        ...rows.flatMap((row, idx) => [row, ...markRows(placed.after.get(idx))]),
    ];

    return (
        <div className={cn("leading-relaxed", className)}>
            <AnimatePresence initial={false}>
            {withMarks(visibleItems.map((item) => {
                if (item.kind === "message") {
                    return (
                        <motion.div
                            key={item.index}
                            className="mt-2 flex gap-2.5"
                            onContextMenu={copyMenu(item.text)}
                            initial={shouldFadeEntry("message") ? { opacity: 0 } : false}
                            animate={{ opacity: 1 }}
                            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                        >
                            <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border border-accent/30 bg-accent/[0.13]">
                                <span className="h-[7px] w-[7px] rounded-full bg-accent-soft" />
                            </span>
                            <div
                                data-find-turn
                                className={cn(
                                    "min-w-0 flex-1 text-[13px] leading-[1.55]",
                                    accentLatest && item.latest ? "text-primary" : "text-secondary"
                                )}
                            >
                                <MarkdownMessage text={item.text} />
                            </div>
                        </motion.div>
                    );
                }
                if (item.kind === "user") {
                    return (
                        <motion.div
                            key={item.index}
                            data-user-bubble
                            className="mt-2 flex justify-end pl-[30px]"
                            onContextMenu={copyMenu(item.text)}
                            initial={shouldFadeEntry("user") ? { opacity: 0 } : false}
                            animate={{ opacity: 1 }}
                            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                        >
                            <div className="max-w-[90%] rounded-[11px_11px_4px_11px] border border-accent/25 bg-accent/10 px-2.5 py-1.5">
                                <div className="mb-0.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.1em] text-accent-soft">
                                    You
                                </div>
                                <UserBubbleText text={item.text} clamp={!renderAll} />
                            </div>
                        </motion.div>
                    );
                }
                if (item.kind === "command") {
                    return (
                        <motion.div
                            key={item.index}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                        >
                            <CommandChip name={item.name} args={item.args} isSkill={item.isSkill} />
                        </motion.div>
                    );
                }
                if (item.kind === "compaction") {
                    return (
                        <motion.div
                            key={item.index}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                        >
                            <CompactionDivider trigger={item.trigger} preTokens={item.preTokens} postTokens={item.postTokens} summary={item.summary} />
                        </motion.div>
                    );
                }
                if (item.kind === "notification") {
                    return (
                        <motion.div
                            key={item.index}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                        >
                            <TaskNotificationRow summary={item.summary} status={item.status} result={item.result} />
                        </motion.div>
                    );
                }
                if (item.kind === "interrupted") {
                    return (
                        <motion.div
                            key={item.index}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                        >
                            <InterruptedDivider />
                        </motion.div>
                    );
                }
                if (item.kind === "arc") {
                    return (
                        <div key={"a" + item.index}>
                            <ArcMessageRow message={item.message} ts={item.ts} idleMs={item.idleMs} ctx={cardCtx} compact={isCompact} />
                        </div>
                    );
                }
                if (item.kind === "card") {
                    return (
                        <div key={"c" + item.index} className={isCompact ? "my-2" : "my-2.5"}>
                            <WshCardItem step={item.step} ctx={cardCtx} compact={isCompact} />
                        </div>
                    );
                }
                return (
                    <StepsBlock
                        key={"s" + item.startIndex}
                        steps={item.steps}
                        fold={item.fold}
                        renderers={renderers}
                        ctx={cardCtx}
                        compact={isCompact}
                    />
                );
            }))}
            </AnimatePresence>
            {tail}
        </div>
    );
});

