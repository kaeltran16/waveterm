// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Usage surface's Workflow lens (workflow-scan Main.dc.html and States.dc.html): the newest scan run's
// state, read from that run's own record and followed through WOS, so stages and verdicts show as they land.
// The model is workflowlens.ts; this file only draws it and sends what the owner does.

import { palettePickChannel } from "@/app/cockpit/palette-data";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { openTarget } from "@/app/view/jarvis/openref";
import { AVATAR_SURFACE_REACH_PX } from "@/app/view/jarvis/petview";
import { cn, fireAndForget } from "@/util/util";
import { atom, useAtom, useAtomValue, useSetAtom, type Atom, type PrimitiveAtom } from "jotai";
import { useEffect, useState, type ReactNode } from "react";
import type { AgentsViewModel } from "./agents";
import { errText, useAction } from "./brainstormui";
import { CANVAS_BTN, CANVAS_PRIMARY_BTN } from "./canvaspane";
import { activeChannelAtom, primeChannels } from "./channelsstore";
import { projectListAtom, recentProjectsAtom } from "./projectsstore";
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

function Check({ size }: { size: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="text-success"
        >
            <path d="M20 6 9 17l-5-5" />
        </svg>
    );
}

function Panel({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
    return (
        <section
            aria-label={label}
            className={cn(
                "flex flex-col gap-3 rounded-[14px] border border-border bg-surface-raised px-[22px] py-5",
                className
            )}
        >
            {children}
        </section>
    );
}

function StatusDot({ label, tone }: { label: string; tone: "success" | "warning" }) {
    return (
        <span
            className={cn(
                "flex items-center gap-2 font-mono text-[11px]",
                tone === "success" ? "text-success" : "text-warning"
            )}
        >
            <span className={cn("h-1.5 w-1.5 rounded-full", tone === "success" ? "bg-success" : "bg-warning")} />
            {label}
        </span>
    );
}

function Stages({ label, stages }: { label: string; stages: StageRow[] }) {
    return (
        <Panel label="Stages" className="max-w-[520px]">
            <StatusDot label={label} tone="success" />
            {stages.map((s) => (
                <div
                    key={s.label}
                    data-workflow-stage={s.label}
                    data-phase={s.phase}
                    className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2.5 text-[13px]"
                >
                    <span className={cn("text-[12px]", s.phase === "todo" ? "text-ink-faint" : "text-success")}>
                        {s.phase === "done" ? "✓" : s.phase === "now" ? "●" : "○"}
                    </span>
                    <span className={s.phase === "todo" ? "text-muted" : "text-secondary"}>{s.label}</span>
                    <span className="font-mono text-[11px] text-ink-mid">{s.fact}</span>
                </div>
            ))}
        </Panel>
    );
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
    const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(copyText(card));
            setState("copied");
        } catch (e) {
            console.warn("workflow lens: copy failed", e);
            setState("failed");
        }
    };
    return (
        <button
            type="button"
            data-workflow-copy={card.id}
            onClick={() => void copy()}
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
            {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : `Copy for #${card.elsewhere}`}
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

function Head({ run, extra, model }: { run: Run; extra?: ReactNode; model: AgentsViewModel }) {
    const head = scanHead(run);
    if (head == null) {
        return null;
    }
    return (
        <div data-workflow-head className="flex items-baseline gap-4">
            <h2 className="m-0 text-[14px] font-semibold text-primary">{head.title}</h2>
            <span className={MONO_META}>{head.span}</span>
            {extra}
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
            <Head
                run={run}
                model={model}
                extra={<StatusDot label={`${view.cards.length} to decide`} tone="warning" />}
            />
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
        <Panel label="Done" className="max-w-[640px]">
            <div className="flex items-center gap-2">
                <Check size={13} />
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
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <Panel label="Nothing to suggest" className="min-h-[220px] items-center justify-center">
                <Check size={22} />
                <span className="text-[15px] font-semibold text-primary">Nothing to suggest</span>
                {facts.length > 0 ? <span className={MONO_META}>{facts.join(" · ")}</span> : null}
            </Panel>
            {notRaised.length > 0 ? (
                <Panel label="Not raised">
                    <h3 className="m-0 font-mono text-[10.5px] font-bold uppercase tracking-[0.1em] text-muted">
                        Not raised
                    </h3>
                    <TaggedRows rows={notRaised} attr="data-workflow-filed" />
                </Panel>
            ) : null}
        </div>
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
    switch (view.kind) {
        case "scanning":
            return <Stages label="scanning" stages={view.stages} />;
        case "picking":
            return <Picking model={model} run={run} view={view} drafts={drafts} setDrafts={setDrafts} />;
        case "applying":
            return (
                <>
                    <Head run={run} model={model} />
                    <Stages label="applying your picks" stages={view.stages} />
                    {view.cards.map((c) => (
                        <Card key={c.id} model={model} card={c} />
                    ))}
                </>
            );
        case "done":
            return (
                <>
                    <Head run={run} model={model} />
                    <Done model={model} run={run} view={view} />
                </>
            );
        case "nothing":
            return (
                <>
                    <Head run={run} model={model} />
                    <Nothing view={view} />
                </>
            );
    }
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
        run == null ? null : view.kind === "picking" ? (
            <PicksBar run={run} cards={view.cards} drafts={drafts} />
        ) : view.kind === "applying" ? (
            <Footer>
                <span className="text-[12.5px] text-ink-mid">Picks sent. The scan’s agent is applying them.</span>
                <SendError runId={run.id} />
            </Footer>
        ) : null;
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
