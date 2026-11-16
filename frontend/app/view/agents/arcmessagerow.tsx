// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// One message Arc typed into an agent's transcript, drawn as an event: a wake (one row per line it holds, with the
// Waited fold and a passed plan review before it), a brief (folded, opening to its text), or a brainstorm line (the
// judge's result, the builder check, a pane action). arcmessagemodel.ts reads the text; this words and draws it.

import * as WOS from "@/app/store/wos";
import { openTarget } from "@/app/view/jarvis/openref";
import { cn, fireAndForget } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import {
    ArrowUpRight,
    Bell,
    Check,
    ChevronDown,
    ChevronRight,
    FileText,
    MousePointerClick,
    Scale,
    X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { ArcMessage } from "./arcmessage";
import {
    brainstormFileFor,
    brainstormLineView,
    briefView,
    builderCountsOf,
    finalRoundOf,
    fmtGap,
    judgeResultOf,
    landedCount,
    planPassedInGap,
    waitedSummary,
    wakeEvents,
    wakeParts,
    type BriefRun,
    type PaneAction,
    type WakeEvents,
    type WakePart,
} from "./arcmessagemodel";
import { parseBrainstorm, parseBrainstormPath, type BrainstormFile } from "./brainstormmodel";
import { tauriBrainstormIO } from "./brainstormpoller";
import { MarkdownMessage } from "./markdownmessage";
import { fmtDuration } from "./runcompletion";
import { ensureRunEvents, runEventsAtom } from "./runeventstore";
import { roleRunId, stageLabel } from "./runlineage";
import { eventText, tsLabel } from "./runtimeline";
import type { TranscriptContext } from "./transcriptcontext";
import { FinalVerdictCard } from "./wshcards-dag";
import { useWshData, type WshDataState } from "./wshdata";

export interface ArcMessageRowProps {
    message: ArcMessage;
    ts?: number;
    idleMs?: number; // the gap before it, for the Waited fold
    ctx: TranscriptContext;
    compact: boolean;
}

type Tone = "fail" | "warn" | "pass" | "plain";

const TONE_TEXT: Record<Tone, string> = {
    fail: "text-error",
    warn: "text-warning",
    pass: "text-success",
    plain: "text-foreground",
};

const NO_EVENTS = atom<RunEvent[]>([]);

// the run this agent belongs to, its events loaded once and kept live (seeded by the fixture seam)
function useRunEventsOf(ctx: TranscriptContext): RunEvent[] {
    const runId = ctx.role ? roleRunId(ctx.role) : undefined;
    const events = useAtomValue(runId ? runEventsAtom(runId) : NO_EVENTS);
    useEffect(() => {
        if (runId && ctx.channelId) ensureRunEvents(runId, ctx.channelId);
    }, [runId, ctx.channelId]);
    return events;
}

async function fetchBriefRun(runId: string): Promise<BriefRun> {
    const run = await WOS.reloadWaveObject<Run>(WOS.makeORef("run", runId));
    if (run == null) throw new Error(`run ${runId} not found`);
    const dag = run.dagoref ? await WOS.reloadWaveObject<TaskGroup>(run.dagoref) : null;
    return {
        goal: run.goal,
        planSkill: run.planskill,
        autonomous: dag?.autonomous ?? run.autonomous,
        tasks: (dag?.tasks ?? []).map((t) => ({ id: t.id, label: t.label, state: t.state })),
    };
}

// the run a brief and a run-finished wake read their goal and tasks from; keyed so the seam can seed it
function useBriefRun(ctx: TranscriptContext): WshDataState<BriefRun> {
    const runId = ctx.role ? roleRunId(ctx.role) : undefined;
    return useWshData(runId ? `arc-run:${runId}` : null, () => fetchBriefRun(runId!));
}

async function fetchBrainstorm(path: string): Promise<BrainstormFile> {
    const parsed = parseBrainstorm(await tauriBrainstormIO.read(path));
    if ("error" in parsed) throw new Error(parsed.error);
    return parsed.file;
}

function useBrainstormFile(path: string | undefined): WshDataState<BrainstormFile> {
    return useWshData(path ? `brainstorm:${path}` : null, () => fetchBrainstorm(path!));
}

// a load that failed still leaves the row drawn from its text, with why in muted text (decision 5)
function LoadError({ state, compact }: { state: WshDataState<unknown>; compact: boolean }) {
    return state.status === "error" ? (
        <div data-load-error className={cn("text-muted", compact ? "text-[11.5px]" : "text-[12px]")}>
            {state.error}
        </div>
    ) : null;
}

function Chevron({ open, compact }: { open: boolean; compact: boolean }) {
    const Icon = open ? ChevronDown : ChevronRight;
    return <Icon size={compact ? 12 : 13} strokeWidth={2} className="shrink-0 text-muted" aria-hidden />;
}

function LinkButton({ label, onClick, compact }: { label: string; onClick: () => void; compact: boolean }) {
    return (
        <button
            type="button"
            onClick={(e) => {
                e.stopPropagation();
                onClick();
            }}
            className={cn(
                "inline-flex shrink-0 cursor-pointer items-center gap-1 text-ink-mid hover:text-foreground",
                compact ? "text-[11.5px]" : "text-[12px]"
            )}
        >
            {label}
            <ArrowUpRight size={11} strokeWidth={2.2} aria-hidden />
        </button>
    );
}

interface HeadProps {
    icon?: ReactNode;
    label?: string;
    headline?: string;
    tone?: Tone;
    meta?: string;
    link?: ReactNode;
    // set when the row opens to a body
    open?: boolean;
    onToggle?: () => void;
    compact: boolean;
}

// an event's head: who acted, what happened in its tone, the facts after it, a link and the chevron
function EventHead({ icon, label, headline, tone = "plain", meta, link, open, onToggle, compact }: HeadProps) {
    const toggles = onToggle != null;
    const ToneIcon = tone === "fail" ? X : tone === "pass" ? Check : null;
    const content = (
        <>
            {!compact && icon}
            {label ? <span className="shrink-0 text-ink-mid">{label}</span> : null}
            {headline ? (
                <span className={cn("inline-flex min-w-0 items-center gap-[5px] font-semibold", TONE_TEXT[tone])}>
                    {ToneIcon && !compact ? <ToneIcon size={11} strokeWidth={3} aria-hidden /> : null}
                    <span className="truncate">{headline}</span>
                </span>
            ) : null}
            {compact ? <span className="flex-1" /> : null}
            {meta ? (
                <span className={cn("min-w-0 truncate text-muted", compact ? "text-[11.5px]" : "text-[12.5px]")}>
                    {meta}
                </span>
            ) : null}
            {compact ? null : <span className="flex-1" />}
            {link}
            {toggles ? <Chevron open={open === true} compact={compact} /> : null}
        </>
    );
    const cls = cn(
        "flex w-full items-center text-left font-sans",
        compact ? "gap-[7px] text-[12.5px]" : "gap-2.5 text-[13.5px]"
    );
    return toggles ? (
        <button type="button" aria-expanded={open} onClick={onToggle} className={cn(cls, "cursor-pointer")}>
            {content}
        </button>
    ) : (
        <div className={cls}>{content}</div>
    );
}

// the opened body under an event's head, indented past its icon
function EventBody({ children, mono, compact }: { children: ReactNode; mono?: boolean; compact: boolean }) {
    return (
        <div
            className={cn(
                "overflow-hidden border border-edge-faint",
                mono ? "bg-surface-code font-mono text-ink-mid" : "bg-surface font-sans text-secondary",
                compact
                    ? "mt-1.5 ml-[19px] rounded-[6px] px-2.5 py-[7px] text-[12px] leading-[1.5]"
                    : cn(
                          "mt-2 ml-6 rounded-[8px] px-3.5 py-[11px] leading-[1.55]",
                          mono ? "text-[12px]" : "text-[13px]"
                      )
            )}
        >
            {children}
        </div>
    );
}

function Rows({ items, compact }: { items: string[]; compact: boolean }) {
    return (
        <>
            {items.map((t, i) => (
                <div key={i} className={cn("[overflow-wrap:anywhere]", i > 0 && (compact ? "mt-1" : "mt-1.5"))}>
                    {t}
                </div>
            ))}
        </>
    );
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const join = (...parts: (string | false | undefined | null)[]) => parts.filter(Boolean).join(" · ");

interface PartWords {
    tone: Tone;
    headline: string;
    meta?: string;
    body?: "findings" | "items" | "mono" | "files";
}

// a wake line in words: the headline and its facts (decision 9's card wording for the rest)
function partWords(p: WakePart, ev: WakeEvents, run: BriefRun | undefined): PartWords {
    const t = p.taskId ?? "";
    const roundMeta = p.round != null ? `round ${p.round}${p.last ? ", the last" : ""}` : undefined;
    switch (p.kind) {
        case "plan-review-failed":
            return {
                tone: "fail",
                headline: "Plan review failed",
                meta: join(roundMeta, plural(p.findings?.length ?? 0, "finding")),
                body: "findings",
            };
        case "plan-reviewer-lost":
            return { tone: "warn", headline: "Plan reviewer did not finish", meta: join(roundMeta, p.reason) };
        case "never-started":
            return {
                tone: "warn",
                headline: `${t} never started`,
                meta: `no worker process ${p.minutes}m after spawn`,
            };
        case "merge-conflict":
            return { tone: "fail", headline: "Merge conflict", meta: `landing the lane ending at ${t}`, body: "files" };
        case "may-be-stuck":
            return { tone: "warn", headline: `${t} may be stuck`, meta: p.reason };
        case "task-failed":
            return {
                tone: "fail",
                headline: `${t} failed`,
                meta: join(p.failKind, p.retrySpent && "retry spent"),
                body: "mono",
            };
        case "task-hung":
            return { tone: "warn", headline: `${t} hung`, meta: `silent ${p.minutes}m, process alive` };
        case "worker-idle":
            return {
                tone: "warn",
                headline: `${t}'s worker is idle`,
                meta: p.reason ?? "ended its turn without completing",
            };
        case "worker-exited":
            return { tone: "warn", headline: `${t}'s worker exited`, meta: "without reporting complete" };
        case "final-failed": {
            const r = finalRoundOf(p);
            const rounds = r ? `round ${r.round} of ${r.of}${p.last ? ", the last" : ""}` : undefined;
            return {
                tone: "fail",
                headline: "Final failed",
                meta: join(rounds, "on the merged result", plural(p.items?.length ?? 0, "defect")),
                body: "items",
            };
        }
        case "final-killed":
            return {
                tone: "warn",
                headline: "A Final step was killed",
                meta: join(roundMeta, "before it judged anything"),
                body: "items",
            };
        case "run-finished": {
            const n = landedCount(run);
            const meta =
                n == null
                    ? undefined
                    : n.landed === n.total
                      ? `all ${plural(n.total, "task")} landed`
                      : `${n.landed} of ${plural(n.total, "task")} landed`;
            return { tone: "plain", headline: "Run finished", meta, body: "items" };
        }
        case "questions":
            if (ev.ask && p.count === 1) {
                const left =
                    ev.ask.deadlineMs > 0 ? `deadline in ${fmtDuration(ev.ask.deadlineMs)}` : "deadline passed";
                return { tone: "warn", headline: `${ev.ask.taskId} asks a question`, meta: left, body: "items" };
            }
            return { tone: "warn", headline: plural(p.count ?? 0, "question") + " waiting" };
        case "verify-failed":
            return { tone: "fail", headline: `Verify failed after merging ${t}`, meta: p.reason, body: "mono" };
        case "review-failed":
            return { tone: "fail", headline: `Review failed for ${t}`, meta: p.reason };
        case "review-note":
            return { tone: "pass", headline: `${t} passed review with a note`, body: "items" };
        case "engine-stuck":
            return { tone: "fail", headline: "The engine is stuck", meta: p.reason };
        case "autonomous-on":
            return { tone: "plain", headline: "Approvals are autonomous", meta: "the human is away" };
        case "autonomous-off":
            return { tone: "plain", headline: "Approvals are back to Ask me" };
        case "caveats":
            return { tone: "warn", headline: "Unverified", body: "items" };
        case "quiet":
            return { tone: "plain", headline: "Since the last wake", body: "items" };
        case "unknown":
            return { tone: "plain", headline: "" };
    }
}

function FindingsBody({ part, compact }: { part: WakePart; compact: boolean }) {
    const findings = part.findings ?? [];
    // compact shows the first finding and how many more
    const shown = compact ? findings.slice(0, 1) : findings;
    return (
        <EventBody compact={compact}>
            {shown.map((f, i) => (
                <div key={i} data-finding className={cn(i > 0 && "mt-2")}>
                    {!compact && f.lens && f.lens !== shown[i - 1]?.lens ? (
                        <div className="mb-1 text-[12px] font-semibold text-ink-mid">{f.lens}</div>
                    ) : null}
                    <span className="[overflow-wrap:anywhere]">
                        {compact ? f.text : `${i + 1}) ${f.text}`}
                        {compact && findings.length > 1 ? (
                            <span className="text-muted"> +{findings.length - 1} more</span>
                        ) : null}
                    </span>
                </div>
            ))}
        </EventBody>
    );
}

function PartBody({
    part,
    words,
    ev,
    compact,
}: {
    part: WakePart;
    words: PartWords;
    ev: WakeEvents;
    compact: boolean;
}) {
    if (words.body === "findings") return part.findings?.length ? <FindingsBody part={part} compact={compact} /> : null;
    if (words.body === "files") {
        return part.files?.length ? (
            <EventBody compact={compact}>
                {part.files.map((f) => (
                    <div key={f} className="font-mono text-[12px] text-foreground [overflow-wrap:anywhere]">
                        {f}
                    </div>
                ))}
            </EventBody>
        ) : null;
    }
    const items = part.kind === "questions" && ev.ask?.question ? [ev.ask.question] : (part.items ?? []);
    if (items.length === 0) return null;
    if (part.kind === "final-failed") {
        return (
            <EventBody compact={compact}>
                {items.map((t, i) => (
                    <div
                        key={i}
                        data-defect
                        className={cn("[overflow-wrap:anywhere]", i > 0 && "mt-2 border-t border-edge-faint pt-2")}
                    >
                        {t}
                    </div>
                ))}
            </EventBody>
        );
    }
    return (
        <EventBody mono={words.body === "mono"} compact={compact}>
            <Rows items={items} compact={compact} />
        </EventBody>
    );
}

// one wake line: its head, and its body open by default (the boards draw findings, defects and failures open)
function WakePartRow({
    part,
    label,
    events,
    ts,
    run,
    ctx,
    compact,
}: {
    part: WakePart;
    label?: string;
    events: RunEvent[];
    ts?: number;
    run: BriefRun | undefined;
    ctx: TranscriptContext;
    compact: boolean;
}) {
    const [open, setOpen] = useState(true);
    const ev = wakeEvents(part, events, ts);
    const words = partWords(part, ev, run);
    const runId = ctx.role ? roleRunId(ctx.role) : undefined;
    const shots =
        part.kind === "final-failed" && ctx.model && runId ? (
            <LinkButton
                label="Shots"
                compact={compact}
                onClick={() => fireAndForget(() => openTarget(ctx.model!, { kind: "run", runId }))}
            />
        ) : null;
    if (part.kind === "unknown") {
        return (
            <div data-wake-part="unknown">
                <EventHead
                    icon={<Bell size={14} strokeWidth={2} className="shrink-0 text-ink-mid" aria-hidden />}
                    label={label}
                    compact={compact}
                />
                <EventBody compact={compact}>
                    <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                        {part.text.replace(/^wake:\s*/, "")}
                    </div>
                </EventBody>
            </div>
        );
    }
    const body = <PartBody part={part} words={words} ev={ev} compact={compact} />;
    const hasBody = words.body != null && hasPartBody(part, ev);
    return (
        <div data-wake-part={part.kind}>
            <EventHead
                icon={<Bell size={14} strokeWidth={2} className="shrink-0 text-ink-mid" aria-hidden />}
                label={label}
                headline={words.headline}
                tone={words.tone}
                meta={words.meta}
                link={shots}
                open={hasBody ? open : undefined}
                onToggle={hasBody ? () => setOpen(!open) : undefined}
                compact={compact}
            />
            {hasBody && open ? body : null}
            {part.kind === "run-finished" && ev.finalPassed ? (
                <div className={compact ? "mt-2" : "mt-2.5"}>
                    <FinalVerdictCard passed round={ev.finalPassed.round} runId={runId} ctx={ctx} compact={compact} />
                </div>
            ) : null}
        </div>
    );
}

function hasPartBody(part: WakePart, ev: WakeEvents): boolean {
    if (part.kind === "plan-review-failed") return (part.findings?.length ?? 0) > 0;
    if (part.kind === "merge-conflict") return (part.files?.length ?? 0) > 0;
    if (part.kind === "questions") return ev.ask?.question != null;
    return (part.items?.length ?? 0) > 0;
}

const WOKE = "Arc woke the lead";

// the lead's silence before the wake, folded; opened, the run's events in it
function WaitedFold({
    summary,
    compact,
}: {
    summary: NonNullable<ReturnType<typeof waitedSummary>>;
    compact: boolean;
}) {
    const [open, setOpen] = useState(false);
    const phrase = [
        summary.landed > 0 && (summary.landed === 1 ? "1 task landed" : `${summary.landed} tasks landed`),
        summary.failed > 0 && `${summary.failed} failed`,
        summary.finalRuns > 0 && "Final ran",
        summary.landed + summary.failed + summary.finalRuns === 0 &&
            summary.events.length > 0 &&
            plural(summary.events.length, "event"),
    ]
        .filter(Boolean)
        .join(", ");
    return (
        <div data-waited className={compact ? "mb-2" : "mb-3"}>
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                className={cn(
                    "inline-flex cursor-pointer items-center gap-1.5 font-sans text-muted",
                    compact ? "text-[12.5px]" : "text-[14px]"
                )}
            >
                <span className="text-secondary">Waited {fmtGap(summary.gapMs)}</span>
                {phrase ? <span>· {phrase}</span> : null}
                {summary.events.length > 0 ? <Chevron open={open} compact={compact} /> : null}
            </button>
            {open && summary.events.length > 0 ? (
                <EventBody compact={compact}>
                    {summary.events.map((e) => (
                        <div key={e.id} data-waited-event className="flex gap-2.5">
                            <span className="shrink-0 font-mono text-[11.5px] text-muted">{tsLabel(e.ts)}</span>
                            <span className="min-w-0 [overflow-wrap:anywhere]">{eventText(e)}</span>
                        </div>
                    ))}
                </EventBody>
            ) : null}
        </div>
    );
}

function WakeRow({ message, ts, idleMs, ctx, compact }: ArcMessageRowProps) {
    const events = useRunEventsOf(ctx);
    const parts = wakeParts(message.text);
    const runFinished = parts.some((p) => p.kind === "run-finished");
    const runState = useBriefRun(runFinished ? ctx : {});
    const waited = waitedSummary(ctx.role, ts, idleMs, events);
    const passed = planPassedInGap(ctx.role, ts, idleMs, events);
    const bell = <Bell size={14} strokeWidth={2} className="shrink-0 text-ink-mid" aria-hidden />;
    const several = parts.length > 1;
    return (
        <div data-arc-message="wake" className={compact ? "my-2" : "mt-1 mb-4"}>
            {waited ? <WaitedFold summary={waited} compact={compact} /> : null}
            {passed ? (
                <div data-wake-part="plan-review-passed" className={compact ? "mb-2" : "mb-3"}>
                    <EventHead
                        icon={bell}
                        label={WOKE}
                        headline="Plan review passed"
                        tone="pass"
                        meta={join(
                            passed.round != null && `round ${passed.round}`,
                            passed.tasks > 0 && `${passed.tasks} tasks dispatched`
                        )}
                        compact={compact}
                    />
                </div>
            ) : null}
            {several ? <EventHead icon={bell} label={WOKE} compact={compact} /> : null}
            <div
                className={cn(
                    several && (compact ? "mt-1.5 ml-[19px] flex flex-col gap-2" : "mt-2 ml-6 flex flex-col gap-2.5")
                )}
            >
                {parts.map((p, i) => (
                    <WakePartRow
                        key={i}
                        part={p}
                        label={several ? undefined : WOKE}
                        events={events}
                        ts={ts}
                        run={runState.data}
                        ctx={ctx}
                        compact={compact}
                    />
                ))}
            </div>
            {runFinished ? <LoadError state={runState} compact={compact} /> : null}
        </div>
    );
}

const BRIEF_LABEL: Record<"lead" | "worker" | "stage", string> = {
    lead: "Run brief from Arc",
    worker: "Task brief from Arc",
    stage: "Brief from Arc",
};

// a run agent's first prompt: folded to who sent it and what it is about; opened, the brief whole
function BriefRow({ message, ctx, compact }: ArcMessageRowProps & { message: Extract<ArcMessage, { kind: "brief" }> }) {
    const [open, setOpen] = useState(false);
    const runState = useBriefRun(ctx);
    const view = ctx.role ? briefView(ctx.role, message.text, runState.data) : null;
    const subject =
        view?.role === "lead"
            ? view.goal
            : view?.role === "worker"
              ? view.label
                  ? `${view.taskId}: ${view.label}`
                  : view.taskId
              : view?.role === "stage"
                ? stageLabel(view.stageRole)
                : "";
    const meta =
        view?.role === "lead"
            ? join(view.planSkill && `plan skill ${view.planSkill}`, view.autonomous && "autonomous")
            : "";
    return (
        <div data-arc-message="brief" data-brief-role={message.role} className={compact ? "mb-3" : "mb-5"}>
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                className={cn(
                    "flex w-full cursor-pointer items-center border border-edge-mid bg-surface text-left font-sans",
                    compact
                        ? "gap-[7px] rounded-[8px] px-2.5 py-2 text-[12.5px]"
                        : "gap-2.5 rounded-[10px] px-3.5 py-[11px] text-[13.5px]"
                )}
            >
                {compact ? null : <FileText size={14} strokeWidth={2} className="shrink-0 text-ink-mid" aria-hidden />}
                <span className="shrink-0 text-ink-mid">{BRIEF_LABEL[message.role]}</span>
                <span className="min-w-0 truncate text-foreground">{subject}</span>
                <span className="flex-1" />
                {meta ? (
                    <span className={cn("shrink-0 text-muted", compact ? "text-[11.5px]" : "text-[12px]")}>{meta}</span>
                ) : null}
                <Chevron open={open} compact={compact} />
            </button>
            {open ? (
                <div
                    data-brief-text
                    className={cn(
                        "mt-2 rounded-[8px] border border-edge-faint bg-surface",
                        compact ? "px-2.5 py-2" : "px-3.5 py-3"
                    )}
                >
                    <MarkdownMessage text={message.text} />
                </div>
            ) : null}
            <LoadError state={runState} compact={compact} />
        </div>
    );
}

// a pane action as "In the brainstorm pane, you <phrase>", its count or detail after it
function paneWords(a: PaneAction): { phrase: string; meta?: string } {
    switch (a.kind) {
        case "confirm-all":
            return { phrase: "confirmed every guess" };
        case "keep-all":
            return { phrase: "kept every change" };
        case "guess":
            return { phrase: "asked the agent to guess" };
        case "skip":
            return { phrase: "skipped the questions" };
        case "check":
            return { phrase: "asked for the builder check" };
        case "approved":
            return { phrase: "approved the design" };
        case "keep-talking":
            return { phrase: "kept talking" };
        case "settle":
            return { phrase: "settled your picks", meta: plural(a.count ?? 0, "part") };
        case "edit":
            return { phrase: `edited ${a.part}`, meta: a.text };
        case "builder-answer":
            return { phrase: "answered the builder", meta: a.text };
        case "builder-decide":
            return { phrase: "left the builder's questions to the agent" };
        case "run":
            return { phrase: "started run", meta: a.text };
    }
}

function PaneRow({ action, compact }: { action: PaneAction; compact: boolean }) {
    const { phrase, meta } = paneWords(action);
    return (
        <div
            data-pane-action={action.kind}
            className={cn(
                "flex items-center font-sans text-ink-mid",
                compact ? "gap-[7px] py-0.5 text-[12.5px]" : "gap-2.5 px-0.5 py-1 text-[13.5px]"
            )}
        >
            {compact ? null : <MousePointerClick size={14} strokeWidth={2} className="shrink-0" aria-hidden />}
            <span className="shrink-0">In the brainstorm pane, you</span>
            <span className="shrink-0 text-foreground">{phrase}</span>
            {meta ? (
                <span className={cn("min-w-0 truncate text-muted", compact ? "text-[11.5px]" : "text-[12px]")}>
                    {meta}
                </span>
            ) : null}
        </div>
    );
}

// the judge's result on a question, from the brainstorm file's record of it
function JudgedRow({ path, ctx, compact }: { path: string; ctx: TranscriptContext; compact: boolean }) {
    const [open, setOpen] = useState(true);
    const state = useBrainstormFile(brainstormFileFor(path, ctx.brainstormFile));
    const result = state.data ? judgeResultOf(state.data) : null;
    const scale = <Scale size={14} strokeWidth={2} className="shrink-0 text-ink-mid" aria-hidden />;
    const label = result?.n != null ? `The judge weighed question ${result.n}` : "The judge weighed the question";
    const rows = result ? result.kept.length + result.dropped.length : 0;
    return (
        <div>
            <EventHead
                icon={scale}
                label={label}
                headline={result?.pick ? `picks ${result.pick}` : undefined}
                meta={result ? `dropped ${result.dropped.length}` : undefined}
                open={rows > 0 ? open : undefined}
                onToggle={rows > 0 ? () => setOpen(!open) : undefined}
                compact={compact}
            />
            {result && rows > 0 && open ? (
                <EventBody compact={compact}>
                    {result.kept.map((k, i) => (
                        <div
                            key={`k${i}`}
                            data-judge-kept
                            className={cn(
                                "flex items-baseline gap-2.5",
                                i > 0 && "mt-1.5 border-t border-edge-faint pt-1.5",
                                !k.pick && "text-ink-mid"
                            )}
                        >
                            <span
                                className={cn("shrink-0", k.pick ? "font-semibold text-foreground" : "text-secondary")}
                            >
                                {k.name}
                            </span>
                            {k.detail ? <span className="min-w-0 [overflow-wrap:anywhere]">{k.detail}</span> : null}
                        </div>
                    ))}
                    {result.dropped.map((d, i) => (
                        <div
                            key={`d${i}`}
                            data-judge-dropped
                            className="mt-1.5 flex items-baseline gap-2.5 border-t border-edge-faint pt-1.5 text-muted"
                        >
                            <span className="shrink-0 line-through">{d.name}</span>
                            <span className="min-w-0 [overflow-wrap:anywhere]">{d.reason}</span>
                        </div>
                    ))}
                </EventBody>
            ) : null}
            <LoadError state={state} compact={compact} />
        </div>
    );
}

// the builder check's questions back: how many, and how they split between answered, the agent's calls and yours
function BuilderRow({ ctx, compact }: { ctx: TranscriptContext; compact: boolean }) {
    const state = useBrainstormFile(ctx.brainstormFile);
    const counts = state.data ? builderCountsOf(state.data) : null;
    const topic = ctx.brainstormFile ? parseBrainstormPath(ctx.brainstormFile)?.topic : undefined;
    const spec =
        ctx.model && topic ? (
            <LinkButton
                label="Spec"
                compact={compact}
                onClick={() => fireAndForget(() => openTarget(ctx.model!, { kind: "brainstorm", topic }))}
            />
        ) : null;
    const pad = compact ? "px-2.5" : "px-3.5";
    return (
        <div
            className={cn(
                "overflow-hidden border border-edge-mid font-sans",
                compact ? "rounded-[8px]" : "rounded-[10px]"
            )}
        >
            <div
                className={cn(
                    "flex items-center",
                    pad,
                    compact ? "gap-2 py-2 text-[12.5px]" : "gap-2.5 py-3 text-[13.5px]"
                )}
            >
                <span className="text-ink-mid">Builder check</span>
                {counts ? (
                    <span className="font-semibold text-foreground">{plural(counts.total, "question")} back</span>
                ) : null}
                <span className="flex-1" />
                {spec}
            </div>
            {state.data?.spec ? (
                <div
                    className={cn(
                        "border-t border-edge-faint pt-[9px] pb-1 font-mono text-[12px] text-ink-mid [overflow-wrap:anywhere]",
                        pad
                    )}
                >
                    {state.data.spec}
                </div>
            ) : null}
            {counts ? (
                <div
                    data-builder-counts
                    className={cn("flex flex-wrap gap-x-4 pt-1.5 pb-[11px] text-[12.5px] text-muted", pad)}
                >
                    <span>
                        <span className="text-secondary">{counts.answered}</span> answered already
                    </span>
                    <span>
                        <span className="text-secondary">{counts.calls}</span> minor, my call
                    </span>
                    <span>
                        <span className="text-warning">{counts.yours}</span> for you
                    </span>
                </div>
            ) : null}
            <div className={pad}>
                <LoadError state={state} compact={compact} />
            </div>
        </div>
    );
}

function BrainstormRow({ message, ctx, compact }: ArcMessageRowProps) {
    const view = brainstormLineView(message.text);
    let inner: ReactNode;
    switch (view.kind) {
        case "judged":
            inner = <JudgedRow path={view.path} ctx={ctx} compact={compact} />;
            break;
        case "judge-failed":
            inner = (
                <EventHead
                    icon={<Scale size={14} strokeWidth={2} className="shrink-0 text-ink-mid" aria-hidden />}
                    label="The judge"
                    headline="failed"
                    tone="fail"
                    meta={view.reason}
                    compact={compact}
                />
            );
            break;
        case "builder":
            inner = <BuilderRow ctx={ctx} compact={compact} />;
            break;
        case "pane":
            inner = view.actions.map((a, i) => <PaneRow key={i} action={a} compact={compact} />);
            break;
        case "unknown":
            inner = (
                <div className="font-mono text-[11.5px] whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">
                    {message.text}
                </div>
            );
    }
    return (
        <div data-arc-message="brainstorm" data-brainstorm-line={view.kind} className={compact ? "my-2" : "mt-1 mb-4"}>
            {inner}
        </div>
    );
}

export function ArcMessageRow(props: ArcMessageRowProps) {
    const { message } = props;
    switch (message.kind) {
        case "wake":
            return <WakeRow {...props} />;
        case "brief":
            return <BriefRow {...props} message={message} />;
        case "brainstorm":
            return <BrainstormRow {...props} />;
    }
}
