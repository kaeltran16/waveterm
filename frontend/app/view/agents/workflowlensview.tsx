// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Usage surface's Workflow lens (workflow-scan Main.dc.html and States.dc.html): the newest scan run's
// state, read from that run's own record and followed through WOS, so stages and verdicts show as they land.
// The model is workflowlens.ts; this file only draws it and sends what the owner does.

import { palettePickChannel } from "@/app/cockpit/palette-data";
import { useCopyFeedback } from "@/app/element/copyfeedback";
import { CrossFade } from "@/app/element/crossfade";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { openTarget } from "@/app/view/jarvis/openref";
import { AVATAR_SURFACE_REACH_PX } from "@/app/view/jarvis/petview";
import { cn, fireAndForget } from "@/util/util";
import { atom, useAtom, useAtomValue, useSetAtom, type Atom, type PrimitiveAtom } from "jotai";
import { Check } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { AgentsViewModel } from "./agents";
import { errText, useAction } from "./brainstormui";
import { CANVAS_BTN, CANVAS_PRIMARY_BTN } from "./canvaspane";
import { activeChannelAtom, primeChannels } from "./channelsstore";
import { projectListAtom, recentProjectsAtom } from "./projectsstore";
import { fmtDuration } from "./runcompletion";
import { StatusDot } from "./statusdot";
import { SurfaceToolbar } from "./surfacescaffold";
import {
    canSend,
    copyText,
    ctaLabel,
    picksPayload,
    RUN_FLOOR,
    SCAN_WINDOW_DAYS,
    scanButton,
    scanHead,
    workflowView,
    type DoneRow,
    type FiledRow,
    type PickDraft,
    type StageDetail,
    type StageRow,
    type WorkflowCard,
    type WorkflowView,
} from "./workflowlens";
import { startWorkflowScan, workflowScanRunAtom } from "./workflowscanstart";

// drafted picks per scan run, module-level so a surface switch mid-decision keeps them
const pickDraftsAtom = atom<Record<string, Record<string, PickDraft>>>({}) as PrimitiveAtom<
    Record<string, Record<string, PickDraft>>
>;

const NO_RUN: Atom<Run | undefined> = atom(undefined as Run | undefined);
const NOT_LOADING: Atom<boolean> = atom(false);

const MONO_META = "font-mono text-[11px] text-muted";
const TEXT_LINK =
    "cursor-pointer border-0 bg-transparent p-0 font-mono text-[12px] text-accent-soft hover:text-accenthover hover:underline";
const SEG_BTN = "cursor-pointer rounded-sm border-0 px-[14px] py-[5px] font-mono text-[11px] font-bold";
const TAG = "justify-self-start rounded-[4px] px-[7px] py-px font-mono text-[10.5px] font-bold";
const TAG_STYLE: Record<FiledRow["tag"] | DoneRow["tag"], string> = {
    covered: "bg-surface-hover text-success",
    applied: "bg-surface-hover text-success",
    declined: "bg-askingbg text-warning",
    under: "bg-surface-hover text-muted",
};
const TAG_LABEL: Record<FiledRow["tag"] | DoneRow["tag"], string> = {
    covered: "covered",
    applied: "applied",
    declined: "declined",
    under: `under ${RUN_FLOOR}`,
};

function openRun(model: AgentsViewModel, runId: string, channelId?: string) {
    fireAndForget(() => openTarget(model, channelId ? { kind: "channel", channelId, runId } : { kind: "run", runId }));
}

const PANEL = "flex flex-col rounded-[14px] border border-border bg-surface-raised px-[22px]";
const ELAPSED_TICK_MS = 1000;

function Panel({
    label,
    detail,
    children,
    className,
}: {
    label: string;
    detail?: string;
    children: ReactNode;
    className?: string;
}) {
    return (
        <section aria-label={label} data-workflow-detail={detail} className={cn(PANEL, "gap-3 py-5", className)}>
            {children}
        </section>
    );
}

function StageMark({ phase }: { phase: StageRow["phase"] }) {
    if (phase === "done") {
        return <Check size={14} strokeWidth={2.4} aria-label="done" className="text-success" />;
    }
    if (phase === "now") {
        return <StatusDot state="working" pulse />;
    }
    return (
        <span aria-label="to do" className="box-border h-[9px] w-[9px] rounded-full border-[1.5px] border-ink-faint" />
    );
}

const STAGE_LABEL: Record<StageRow["phase"], string> = {
    done: "font-medium text-primary",
    now: "font-semibold text-primary",
    todo: "font-medium text-muted",
};

function StageList({ stages }: { stages: StageRow[] }) {
    return (
        <section aria-label="Stages" className={cn(PANEL, "pt-5 pb-1.5")}>
            {stages.map((s, i) => (
                <div
                    key={s.label}
                    data-workflow-stage={s.label}
                    data-phase={s.phase}
                    className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-x-3"
                >
                    <div className="flex flex-col items-center self-stretch">
                        <span className="flex h-[18px] w-4 items-center justify-center">
                            <StageMark phase={s.phase} />
                        </span>
                        {i < stages.length - 1 ? (
                            <span
                                className={cn(
                                    "my-1 min-h-[14px] w-px flex-1",
                                    s.phase === "done" ? "bg-edge-strong" : "bg-border"
                                )}
                            />
                        ) : null}
                    </div>
                    <span className={cn("pb-4 text-[13.5px]", STAGE_LABEL[s.phase])}>{s.label}</span>
                    <span data-workflow-stage-fact className="pt-0.5 font-mono text-[11px] text-ink-mid">
                        {s.fact}
                    </span>
                </div>
            ))}
        </section>
    );
}

// the stage column beside what the scan is doing or did; below lg the two stack, stages first
function Split({ stages, children }: { stages: StageRow[]; children: ReactNode }) {
    return (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
            <StageList stages={stages} />
            {children}
        </div>
    );
}

function PaneText({ title, body }: { title: string; body: string }) {
    return (
        <div className="flex flex-col gap-1">
            <span className="text-[15px] font-semibold text-primary">{title}</span>
            <span className="max-w-[720px] text-[13px] leading-[1.5] text-ink-mid">{body}</span>
        </div>
    );
}

function KeptRows({
    kept,
    underFloor,
}: {
    kept: Extract<StageDetail, { stage: "checking" }>["kept"];
    underFloor: number;
}) {
    return (
        <>
            {kept.length > 0 ? (
                <div className="flex flex-col border-t border-edge-faint">
                    {kept.map((k) => (
                        <div
                            key={k.id}
                            data-workflow-kept={k.id}
                            className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-5 border-b border-edge-faint py-[9px]"
                        >
                            <span className="text-[13px] text-secondary">{k.title}</span>
                            <span className="whitespace-nowrap font-mono text-[11px] text-muted">
                                <b className="text-primary">{k.runs}</b> runs · {k.days} days
                                {k.where ? ` · ${k.where}` : ""}
                            </span>
                        </div>
                    ))}
                </div>
            ) : null}
            {underFloor > 0 ? (
                <span className={MONO_META}>
                    {underFloor} under {RUN_FLOOR} runs set aside
                </span>
            ) : null}
        </>
    );
}

function ScanDetail({ detail }: { detail: StageDetail }) {
    switch (detail.stage) {
        case "read":
            return (
                <Panel label="Read runs" detail="read" className="gap-3.5">
                    <PaneText
                        title="Reading run records"
                        body={`Every project's runs from ${detail.from} to ${detail.to}.`}
                    />
                </Panel>
            );
        case "patterns":
            return (
                <Panel label="Sonnet patterns" detail="patterns" className="gap-3.5">
                    <PaneText
                        title={`Sonnet reads ${detail.runs} runs from ${detail.projects} projects`}
                        body={`It names the problems that recur in them. Code then recounts each one against the run records and sets aside any seen in fewer than ${RUN_FLOOR} runs.`}
                    />
                </Panel>
            );
        case "recount":
            return (
                <Panel label="Recount" detail="recount" className="gap-3.5">
                    <PaneText
                        title={`Recounting ${detail.candidates} patterns`}
                        body={`Code counts each one against the run records and sets aside any seen in fewer than ${RUN_FLOOR} runs.`}
                    />
                </Panel>
            );
        case "checking":
            return (
                <Panel label="Opus checks files" detail="checking" className="gap-3.5">
                    <PaneText
                        title={`Opus checks ${detail.kept.length} patterns against the files`}
                        body="The scan's agent reads each pattern's fix target and docs/deferred.md, marks it covered, declined or a suggestion, and drafts the fix. Your picks open here when it is done."
                    />
                    <KeptRows kept={detail.kept} underFloor={detail.underFloor} />
                </Panel>
            );
    }
}

// mounts only while scanning, so the interval never outlives that view
function Elapsed({ startedTs }: { startedTs: number }) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
        return () => clearInterval(id);
    }, []);
    return <span data-workflow-elapsed>{fmtDuration(now - startedTs)}</span>;
}

const HEAD_STATUS = "flex items-center gap-[7px] font-mono text-[11px]";

function HeadStatus({ view }: { view: Exclude<WorkflowView, { kind: "idle" }> }) {
    switch (view.kind) {
        case "scanning":
        case "applying":
            return (
                <span data-workflow-status={view.kind} className={cn(HEAD_STATUS, "text-accent-soft")}>
                    <StatusDot state="working" pulse className="h-1.5 w-1.5" />
                    {view.kind === "scanning" ? (
                        <span>
                            scanning · <Elapsed startedTs={view.startedTs} />
                        </span>
                    ) : (
                        "applying your picks"
                    )}
                </span>
            );
        case "picking":
            return (
                <span data-workflow-status="picking" className={cn(HEAD_STATUS, "text-warning")}>
                    <span className="h-1.5 w-1.5 rounded-full bg-warning" />
                    {view.cards.length} to decide
                </span>
            );
        case "done":
        case "nothing":
            return (
                <span data-workflow-status={view.kind} className={cn(HEAD_STATUS, "gap-1.5 text-success")}>
                    <Check size={11} strokeWidth={2.4} aria-hidden="true" />
                    done
                </span>
            );
    }
}

function TaggedRows({ rows, attr }: { rows: (FiledRow | DoneRow)[]; attr: string }) {
    return (
        <>
            {rows.map((r, i) => (
                <div
                    key={`${r.tag}:${r.title}:${i}`}
                    {...{ [attr]: r.tag }}
                    className="grid grid-cols-[72px_minmax(0,1fr)] items-baseline gap-2.5"
                >
                    <span className={cn(TAG, TAG_STYLE[r.tag])}>{TAG_LABEL[r.tag]}</span>
                    <span className="flex flex-col gap-0.5">
                        <span className="text-[13px] text-secondary">{r.title}</span>
                        {"file" in r ? (
                            <span className="font-mono text-[11px] text-accent-soft">{r.file}</span>
                        ) : (
                            <span className={MONO_META}>{r.fact}</span>
                        )}
                    </span>
                </div>
            ))}
        </>
    );
}

function Idle({
    last,
    button,
    onScan,
    busy,
    error,
}: {
    last: Extract<WorkflowView, { kind: "idle" }>["last"];
    button: ReturnType<typeof scanButton>;
    onScan: () => void;
    busy: boolean;
    error: string | null;
}) {
    return (
        <Panel label="Idle" className="min-h-[300px] items-center justify-center">
            <button
                type="button"
                data-workflow-idle-scan
                disabled={!button.enabled || busy}
                title={button.title}
                onClick={onScan}
                className={cn(CANVAS_PRIMARY_BTN, "h-[38px] px-5 text-[14px]")}
            >
                Scan workflow
            </button>
            <span className={MONO_META}>last {SCAN_WINDOW_DAYS} days · every project</span>
            {last != null ? (
                <span data-workflow-last={last.outcome} className="font-mono text-[11px] text-ink-mid">
                    last: {last.date} ·{" "}
                    <span className={last.outcome === "failed" ? "text-error" : "text-warning"}>{last.outcome}</span>
                    {last.error ? <span className="text-error"> · {last.error}</span> : null}
                </span>
            ) : null}
            {error != null ? (
                <span data-workflow-start-error className="text-[12px] text-error">
                    {error}
                </span>
            ) : null}
        </Panel>
    );
}

function Quotes({ model, card }: { model: AgentsViewModel; card: WorkflowCard }) {
    const [open, setOpen] = useState(false);
    const quotes = open ? [...card.quotes, ...card.more] : card.quotes;
    return (
        <div className="flex flex-col gap-[3px]">
            {quotes.map((q) => (
                <div
                    key={q.runid + q.text}
                    className="grid grid-cols-[76px_minmax(0,1fr)] items-baseline text-[13px] leading-[1.5]"
                >
                    <button
                        type="button"
                        data-workflow-quote-run={q.runid}
                        title={`Open run ${q.runid.slice(0, 8)}`}
                        onClick={() => openRun(model, q.runid)}
                        className={cn(TEXT_LINK, "justify-self-start")}
                    >
                        {q.runid.slice(0, 8)}
                    </button>
                    <span className="text-ink-mid">“{q.text}”</span>
                </div>
            ))}
            {card.more.length > 0 ? (
                <button
                    type="button"
                    data-workflow-more
                    aria-expanded={open}
                    onClick={() => setOpen(!open)}
                    className="ml-[76px] cursor-pointer self-start border-0 bg-transparent p-0 font-mono text-[11px] text-muted hover:text-secondary"
                >
                    {open ? "fewer" : `+ ${card.more.length} more`}
                </button>
            ) : null}
        </div>
    );
}

function EditBlock({ card }: { card: WorkflowCard }) {
    return (
        <div className="overflow-hidden rounded-[8px] border border-border bg-surface-code">
            <div className="border-b border-edge-faint px-3 py-1.5 font-mono text-[11px] text-accent-soft">
                {card.where ? `${card.file} · ${card.where}` : card.file}
            </div>
            <div className="py-2 pr-3">
                {card.edit.map((l, i) => (
                    <div
                        key={i}
                        className={cn(
                            "grid grid-cols-[22px_minmax(0,1fr)] font-mono text-[12px] leading-[1.55]",
                            l.sign === "+" ? "text-diff-added" : "text-diff-removed"
                        )}
                    >
                        <span className="text-center">{l.sign}</span>
                        <span className="whitespace-pre-wrap break-words">{l.text}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

function CopyButton({ card }: { card: WorkflowCard }) {
    const { state, copy } = useCopyFeedback();
    return (
        <button
            type="button"
            data-workflow-copy={card.id}
            onClick={() => copy(copyText(card))}
            className="flex cursor-pointer items-center gap-1.5 rounded border border-accent-700 bg-accentbg px-3 py-1.5 text-[12px] font-semibold text-accent-soft hover:text-accenthover"
        >
            <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
            >
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            <CrossFade swapKey={state}>
                {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : `Copy for #${card.elsewhere}`}
            </CrossFade>
        </button>
    );
}

function Decision({ card, onPick }: { card: WorkflowCard; onPick?: (pick: "apply" | "drop" | undefined) => void }) {
    const toggle = (pick: "apply" | "drop") => onPick?.(card.pick === pick ? undefined : pick);
    const options: ("apply" | "drop")[] = card.elsewhere != null ? ["drop"] : ["apply", "drop"];
    return (
        <div className="flex flex-none items-center gap-2.5">
            {card.elsewhere != null && onPick != null ? <CopyButton card={card} /> : null}
            <div role="group" aria-label="Decision" className="flex rounded border border-border bg-surface p-[3px]">
                {options.map((o) => (
                    <button
                        key={o}
                        type="button"
                        data-workflow-pick={o}
                        aria-pressed={card.pick === o}
                        disabled={onPick == null}
                        onClick={() => toggle(o)}
                        className={cn(
                            SEG_BTN,
                            "disabled:cursor-default",
                            card.pick === o ? "bg-accentbg text-primary" : "bg-transparent text-muted"
                        )}
                    >
                        {o === "apply" ? "Apply" : "Drop"}
                    </button>
                ))}
            </div>
        </div>
    );
}

function Card({
    model,
    card,
    onPick,
    onReason,
}: {
    model: AgentsViewModel;
    card: WorkflowCard;
    onPick?: (pick: "apply" | "drop" | undefined) => void;
    onReason?: (reason: string) => void;
}) {
    const dropped = card.pick === "drop";
    return (
        <article
            data-workflow-card={card.id}
            className={cn(
                "flex flex-col gap-3 rounded-[14px] border bg-surface-raised px-5 py-4",
                dropped ? "border-edge-strong opacity-85" : "border-border"
            )}
        >
            <div className="flex items-center gap-3.5">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                        {card.raisedAgain != null ? (
                            <span data-workflow-raised className={cn(TAG, "bg-askingbg text-warning")}>
                                raised again
                            </span>
                        ) : null}
                        {card.elsewhere != null ? (
                            <span data-workflow-elsewhere className={cn(TAG, "bg-askingbg text-warning")}>
                                fix in #{card.elsewhere}
                            </span>
                        ) : null}
                        <h4 className="m-0 text-[15px] font-semibold text-primary">{card.title}</h4>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1.5 font-mono text-[11px] text-muted">
                        <span>
                            <b className="text-primary">{card.runs}</b> runs ·{" "}
                            <b className="text-primary">{card.days}</b> days
                        </span>
                        {card.projects.map((p) => (
                            <span key={p.name} className="text-ink-mid">
                                #{p.name} {p.runs}
                            </span>
                        ))}
                        {card.raisedAgain != null ? (
                            <span className="text-ink-mid">
                                declined at {card.raisedAgain.declinedAt} runs → now{" "}
                                <b className="text-primary">{card.raisedAgain.now}</b>
                            </span>
                        ) : null}
                    </div>
                </div>
                <Decision card={card} onPick={onPick} />
            </div>
            <Quotes model={model} card={card} />
            <EditBlock card={card} />
            {dropped ? (
                onReason != null ? (
                    <input
                        type="text"
                        data-workflow-reason={card.id}
                        aria-label="Reason for dropping"
                        placeholder="Reason"
                        value={card.reason}
                        onChange={(e) => onReason(e.target.value)}
                        className="box-border h-[34px] w-full rounded border border-edge-strong bg-surface-code px-2.5 text-[13px] text-primary outline-none focus:border-accent"
                    />
                ) : (
                    <span className="text-[13px] text-ink-mid">Reason: {card.reason}</span>
                )
            ) : null}
        </article>
    );
}

function FiledToggle({ label, rows, attr }: { label: string; rows: FiledRow[]; attr: string }) {
    const [open, setOpen] = useState(false);
    if (rows.length === 0) {
        return null;
    }
    return (
        <div className="flex flex-col gap-2.5">
            <button
                type="button"
                {...{ [attr]: "" }}
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                className="cursor-pointer self-start border-0 bg-transparent p-0 font-mono text-[11px] text-muted hover:text-secondary"
            >
                {rows.length} {label} {open ? "⌄" : "›"}
            </button>
            {open ? <TaggedRows rows={rows} attr="data-workflow-filed" /> : null}
        </div>
    );
}

function Head({
    run,
    view,
    model,
}: {
    run: Run;
    view: Exclude<WorkflowView, { kind: "idle" }>;
    model: AgentsViewModel;
}) {
    const head = scanHead(run);
    if (head == null) {
        return null;
    }
    return (
        <div data-workflow-head className="flex items-baseline gap-4">
            <h2 className="m-0 text-[14px] font-semibold text-primary">{head.title}</h2>
            <span className={MONO_META}>{head.span}</span>
            <HeadStatus view={view} />
            <span className="flex-1" />
            <button
                type="button"
                data-workflow-open-run
                onClick={() => openRun(model, run.id, run.channeloid)}
                className={CANVAS_BTN}
            >
                Open run
            </button>
        </div>
    );
}

// per scan run, and outside the picking view: the server stores the picks and sets applying before it tries the
// agent, so the delivery error lands after the lens has already switched to applying
const sendErrorAtom = atom<Record<string, string | undefined>>({}) as PrimitiveAtom<Record<string, string | undefined>>;

function SendError({ runId }: { runId: string }) {
    const error = useAtomValue(sendErrorAtom)[runId];
    if (error == null) {
        return null;
    }
    return (
        <span data-workflow-send-error className="text-[12px] text-error">
            {error}
        </span>
    );
}

function Footer({ children }: { children: ReactNode }) {
    return (
        <div className="flex flex-none flex-col items-end gap-1.5 border-t border-edge-mid bg-surface-raised px-7 py-3.5">
            {children}
        </div>
    );
}

function PicksBar({ run, cards, drafts }: { run: Run; cards: WorkflowCard[]; drafts: Record<string, PickDraft> }) {
    const [busy, setBusy] = useState(false);
    const setErrors = useSetAtom(sendErrorAtom);
    const label = ctaLabel(cards, drafts);
    const ready = canSend(cards, drafts);
    const submit = async () => {
        setBusy(true);
        setErrors((prev) => ({ ...prev, [run.id]: undefined }));
        try {
            await RpcApi.WorkflowScanPicksCommand(TabRpcClient, {
                channelid: run.channeloid ?? "",
                runid: run.id,
                picks: picksPayload(cards, drafts),
            });
        } catch (e) {
            setErrors((prev) => ({ ...prev, [run.id]: errText(e) }));
        } finally {
            setBusy(false);
        }
    };
    return (
        <Footer>
            <button
                type="button"
                data-workflow-send
                disabled={!ready || busy}
                title={ready ? undefined : "Pick Apply or Drop, and give every Drop a reason"}
                onClick={() => void submit()}
                className={cn(CANVAS_PRIMARY_BTN, "h-[34px] px-4 text-[13px]")}
            >
                {label || "Pick a suggestion"}
            </button>
            <SendError runId={run.id} />
        </Footer>
    );
}

function Picking({
    model,
    run,
    view,
    drafts,
    setDrafts,
}: {
    model: AgentsViewModel;
    run: Run;
    view: Extract<WorkflowView, { kind: "picking" }>;
    drafts: Record<string, PickDraft>;
    setDrafts: (next: Record<string, PickDraft>) => void;
}) {
    const edit = (id: string, patch: Partial<PickDraft>) =>
        setDrafts({ ...drafts, [id]: { reason: "", ...drafts[id], ...patch } });
    return (
        <>
            <Head run={run} view={view} model={model} />
            {view.cards.map((c) => (
                <Card
                    key={c.id}
                    model={model}
                    card={c}
                    onPick={(pick) => edit(c.id, { pick })}
                    onReason={(reason) => edit(c.id, { reason })}
                />
            ))}
            <div className="flex flex-col gap-3 px-0.5 py-1">
                <FiledToggle label="already covered" rows={view.covered} attr="data-workflow-covered-toggle" />
                <FiledToggle label="still declined" rows={view.declined} attr="data-workflow-declined-toggle" />
                <FiledToggle
                    label={`under ${RUN_FLOOR} runs`}
                    rows={view.underFloor}
                    attr="data-workflow-under-toggle"
                />
            </div>
        </>
    );
}

function Done({
    model,
    run,
    view,
}: {
    model: AgentsViewModel;
    run: Run;
    view: Extract<WorkflowView, { kind: "done" }>;
}) {
    return (
        <Panel label="Done" detail="done" className="gap-3.5">
            <div className="flex items-center gap-2">
                <Check size={13} strokeWidth={2.4} aria-hidden="true" className="text-success" />
                <span className="text-[14px] font-semibold text-primary">{view.commit ? "Committed" : "Finished"}</span>
                {view.commit ? (
                    <span data-workflow-commit className="font-mono text-[12px] text-accent-soft">
                        {view.commit.slice(0, 8)}
                    </span>
                ) : null}
                <span className="flex-1" />
                {/* the scan run's evidence shows its commit */}
                <button
                    type="button"
                    data-workflow-open-diff
                    onClick={() => openRun(model, run.id, run.channeloid)}
                    className={cn(CANVAS_BTN, "px-2.5 py-[5px] text-[12px]")}
                >
                    Open in Diff
                </button>
            </div>
            <TaggedRows rows={view.rows} attr="data-workflow-done-row" />
        </Panel>
    );
}

function Nothing({ view }: { view: Extract<WorkflowView, { kind: "nothing" }> }) {
    const notRaised = [...view.covered, ...view.declined, ...view.underFloor];
    const facts = [
        view.underFloor.length > 0 ? `${view.underFloor.length} under ${RUN_FLOOR} runs` : "",
        view.covered.length > 0 ? `${view.covered.length} covered` : "",
        view.declined.length > 0 ? `${view.declined.length} declined` : "",
    ].filter(Boolean);
    return (
        <Panel label="Nothing to suggest" detail="nothing" className="gap-3.5">
            <div className="flex items-center gap-2.5">
                <Check size={18} strokeWidth={2.4} aria-hidden="true" className="text-success" />
                <span className="text-[15px] font-semibold text-primary">Nothing to suggest</span>
                {facts.length > 0 ? <span className={MONO_META}>{facts.join(" · ")}</span> : null}
            </div>
            {notRaised.length > 0 ? (
                <div className="flex flex-col gap-3 border-t border-edge-faint pt-3.5">
                    <h3 className="m-0 text-[13px] font-semibold text-secondary">Not raised</h3>
                    <TaggedRows rows={notRaised} attr="data-workflow-filed" />
                </div>
            ) : null}
        </Panel>
    );
}

function Applying({ run, view }: { run: Run; view: Extract<WorkflowView, { kind: "applying" }> }) {
    return (
        <Panel label="Applying" detail="applying" className="gap-3.5">
            <PaneText
                title="Opus applies your picks"
                body={`${view.sent} sent. The scan's agent edits the files, writes each Declined entry to docs/deferred.md and commits. The commit shows here when it is done.`}
            />
            <SendError runId={run.id} />
        </Panel>
    );
}

function Body({
    model,
    run,
    view,
    drafts,
    setDrafts,
    idle,
}: {
    model: AgentsViewModel;
    run: Run | null;
    view: WorkflowView;
    drafts: Record<string, PickDraft>;
    setDrafts: (next: Record<string, PickDraft>) => void;
    idle: ReactNode;
}) {
    if (view.kind === "idle" || run == null) {
        return idle;
    }
    if (view.kind === "picking") {
        return <Picking model={model} run={run} view={view} drafts={drafts} setDrafts={setDrafts} />;
    }
    return (
        <>
            <Head run={run} view={view} model={model} />
            <Split stages={view.stages}>
                {view.kind === "scanning" ? (
                    <ScanDetail detail={view.detail} />
                ) : view.kind === "applying" ? (
                    <Applying run={run} view={view} />
                ) : view.kind === "done" ? (
                    <Done model={model} run={run} view={view} />
                ) : (
                    <Nothing view={view} />
                )}
            </Split>
            {view.kind === "applying" ? view.cards.map((c) => <Card key={c.id} model={model} card={c} />) : null}
        </>
    );
}

// the lens owns the page below the shared toolbar: the other lenses' range and scope bar mean nothing here
export function WorkflowLens({ model, lensSwitch }: { model: AgentsViewModel; lensSwitch: ReactNode }) {
    const [runId, setRunId] = useAtom(workflowScanRunAtom);
    const oref = runId ? WOS.makeORef("run", runId) : null;
    const run = useAtomValue(oref ? WOS.getWaveObjectAtom<Run>(oref) : NO_RUN) ?? null;
    const loading = useAtomValue(oref ? WOS.getWaveObjectLoadingAtom(oref) : NOT_LOADING);
    const [allDrafts, setAllDrafts] = useAtom(pickDraftsAtom);
    const activeChannel = useAtomValue(activeChannelAtom);
    const projectRows = useAtomValue(projectListAtom);
    const recentProjects = useAtomValue(recentProjectsAtom);
    const [loadError, setLoadError] = useState<string | null>(null);
    const start = useAction();

    // the router writes the run before it switches here; only a plain lens pick asks for the newest scan
    useEffect(() => {
        // only Jarvis loads the channel list, and the home project needs it
        fireAndForget(primeChannels);
        if (runId != null) {
            return;
        }
        let live = true;
        RpcApi.GetWorkflowScanCommand(TabRpcClient, {})
            .then((rtn) => {
                if (live && rtn?.runid) {
                    setRunId(rtn.runid);
                }
            })
            .catch((e) => {
                if (live) {
                    setLoadError(errText(e));
                }
            });
        return () => {
            live = false;
        };
    }, []);

    const drafts = (runId != null ? allDrafts[runId] : undefined) ?? {};
    const setDrafts = (next: Record<string, PickDraft>) => {
        if (runId != null) {
            setAllDrafts({ ...allDrafts, [runId]: next });
        }
    };
    const view = workflowView(run, drafts);
    const home = palettePickChannel(activeChannel, projectRows, recentProjects[0] ?? null);
    const button = scanButton(view, home);
    const scan = () => {
        const channelId = button.channelId;
        if (channelId != null) {
            void start.run(async () => {
                await startWorkflowScan(model, channelId);
            });
        }
    };

    const footer =
        run != null && view.kind === "picking" ? <PicksBar run={run} cards={view.cards} drafts={drafts} /> : null;
    const scanDisabled = !button.enabled || start.busy;

    return (
        <div
            data-workflow-lens={loading ? "loading" : view.kind}
            className="flex h-full min-h-0 flex-col bg-background"
        >
            <SurfaceToolbar
                title="Usage"
                actions={
                    <>
                        {start.error != null && view.kind !== "idle" ? (
                            <span
                                data-workflow-start-error
                                title={start.error}
                                className="min-w-0 truncate text-[12px] text-error"
                            >
                                {start.error}
                            </span>
                        ) : null}
                        <button
                            type="button"
                            data-workflow-scan-button
                            disabled={scanDisabled}
                            title={button.title}
                            onClick={scan}
                            className={cn(
                                CANVAS_BTN,
                                scanDisabled &&
                                    "cursor-default text-ink-faint hover:border-edge-mid hover:bg-surface-raised"
                            )}
                        >
                            Scan workflow
                        </button>
                    </>
                }
            >
                {lensSwitch}
            </SurfaceToolbar>
            {loadError != null ? (
                <div data-workflow-load-error className="px-7 pt-3 text-[12px] text-error">
                    Couldn’t read the last scan: {loadError}
                </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto">
                <div
                    className="flex flex-col gap-4 px-7 pt-[18px]"
                    style={{ paddingBottom: footer != null ? 20 : AVATAR_SURFACE_REACH_PX + 20 }}
                >
                    {loading ? null : (
                        <Body
                            model={model}
                            run={run}
                            view={view}
                            drafts={drafts}
                            setDrafts={setDrafts}
                            idle={
                                <Idle
                                    last={view.kind === "idle" ? view.last : undefined}
                                    button={button}
                                    onScan={scan}
                                    busy={start.busy}
                                    error={start.error}
                                />
                            }
                        />
                    )}
                </div>
            </div>
            {footer}
        </div>
    );
}
