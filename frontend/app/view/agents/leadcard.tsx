// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A run's card in the cockpit grid: the lead's status, the run's tasks as rows, a worker's question or failed
// review answered inside its row, and the run's controls. The rows come from leadcardmodel.ts; this renders
// them and sends the actions.

import { openFileInCode } from "@/app/cockpit/openfilestore";
import { cardVariants, composerReveal } from "@/app/element/motiontokens";
import { useDimensionsWithCallbackRef } from "@/app/hook/useDimensions";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { atom, useAtomValue, type Atom, type PrimitiveAtom } from "jotai";
import { motion } from "motion/react";
import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { AgentComposer } from "./agentcomposer";
import { entriesToShow } from "./agentrowmodel";
import type { AgentsViewModel } from "./agents";
import {
    askSentKey,
    displayAgeMs,
    formatAge,
    formatAgeShort,
    latestMessageText,
    type AgentEntry,
    type AgentVM,
} from "./agentsviewmodel";
import { AnswerBar } from "./answerbar";
import { AttentionBanner } from "./attentioncard";
import { diffStatsByIdAtom } from "./cardgitstore";
import type { CardShare } from "./cardgridlayout";
import { dagAction, rowAction, runCardAction, runCardErrorAtom, tellingRowAtom } from "./leadcardactions";
import {
    foldOpen,
    REVIEW_ACTIONS,
    reviewFindings,
    type LeadCardVM,
    type RowAction,
    type RowTone,
    type TaskRowVM,
} from "./leadcardmodel";
import { entriesAtomFor } from "./livetranscriptatoms";
import { NarrationTimeline } from "./narrationtimeline";
import { clampParallelism } from "./runconfig";
import type { RunInfo } from "./runlineage";
import { openRunDag } from "./runrailsections";
import { parseSpecReview, type SpecReview } from "./specreview";
import { StatusLine } from "./statusline";
import { JumpToLatestPill, useStickToBottom } from "./sticktobottom";

const CTL_BOX =
    "flex h-[23px] w-[25px] shrink-0 cursor-pointer items-center justify-center rounded-sm border border-edge-mid text-secondary hover:border-edge-strong hover:bg-surface-hover";
const BTN =
    "h-[23px] shrink-0 cursor-pointer rounded-[6px] border border-edge-mid bg-transparent px-[9px] text-[11.5px] font-medium text-secondary hover:border-edge-strong";
const ROW_BTN =
    "flex h-6 cursor-pointer items-center gap-1.5 rounded-[6px] border border-edge-strong bg-transparent pl-1.5 pr-2.5 text-[11.5px] font-semibold text-secondary hover:bg-surface-hover";
const SECTION_LABEL = "text-[10px] font-semibold uppercase tracking-[0.08em] text-muted";

// below this body height the lead's pane would squeeze the tasks, so a card that small starts it collapsed
const LEAD_PANE_MIN_BODY_PX = 320;

// the lead pane's open state per run id, set only once you toggle it; the card unmounts on a surface switch
const leadPaneOpenAtom = atom<Record<string, boolean>>({}) as PrimitiveAtom<Record<string, boolean>>;

const TONE_DOT: Record<RowTone, string> = {
    run: "bg-accent animate-[pulseDot_1.6s_infinite] motion-reduce:animate-none",
    ask: "bg-warning",
    soft: "bg-accent-soft",
    warn: "shadow-[inset_0_0_0_1.5px_var(--color-warning)]",
    err: "bg-error",
    ok: "bg-success",
    muted: "bg-muted",
    wait: "shadow-[inset_0_0_0_1.5px_var(--color-muted)]",
};
const TONE_SEG: Record<RowTone, string> = {
    run: "bg-accent",
    ask: "bg-warning",
    soft: "bg-accent-soft",
    warn: "bg-warning",
    err: "bg-error",
    ok: "bg-success",
    muted: "bg-muted",
    wait: "bg-edge-strong",
};
const ACTION_LABEL: Record<RowAction, string> = {
    retry: "Retry",
    skip: "Skip",
    takeover: "Take over",
    tell: "Tell",
    resolve: "Continue",
};

export interface LeadCardProps {
    model: AgentsViewModel;
    cardId: string;
    run: RunInfo;
    lead?: AgentVM;
    vm: LeadCardVM;
    events: RunEvent[];
    leadDown: boolean;
    share: CardShare;
    isCursor: boolean;
    cursorKey?: string;
    pulse: boolean;
    composerOpen: boolean;
    onComposerEscape: () => void;
    onCursor: (key: string) => void;
    onOpen: (id: string) => void;
    onOpenDiff: (id: string) => void;
    onBackground?: () => void;
}

export function LeadCard(p: LeadCardProps) {
    const { model, run, lead, vm } = p;
    const answerSel = useAtomValue(model.answerSelAtom);
    const answerText = useAtomValue(model.answerTextAtom);
    const answerTab = useAtomValue(model.answerTabAtom);
    const sentIds = useAtomValue(model.sentIdsAtom);
    const diff = useAtomValue(diffStatsByIdAtom)[lead?.id ?? ""];
    const error = useAtomValue(runCardErrorAtom)[run.runId];
    const [panel, setPanel] = useState<"adjust" | "cancel" | null>(null);
    const [par, setPar] = useState<number | null>(null);
    const [doneOpen, setDoneOpen] = useState(false);
    const [bodyRef, , bodyRect] = useDimensionsWithCallbackRef<HTMLDivElement>(null);
    const paneOpen =
        useAtomValue(leadPaneOpenAtom)[run.runId] ?? (bodyRect == null || bodyRect.height >= LEAD_PANE_MIN_BODY_PX);
    const telling = useAtomValue(tellingRowAtom);
    const [guide, setGuide] = useState<Record<string, string>>({});

    // one path for every engine action, shared with the keyboard: a refusal is shown on the card, never swallowed
    const act = (label: string, fn: () => Promise<unknown>) => fireAndForget(() => runCardAction(run.runId, label, fn));
    const dag = (taskId: string, action: string, notes?: string) =>
        fireAndForget(() => dagAction(run, taskId, action, notes));

    const answerBarFor = (agent: AgentVM, className: string) => (
        <AnswerBar
            agent={agent}
            selections={answerSel[agent.id] ?? {}}
            texts={answerText[agent.id] ?? {}}
            sent={sentIds.has(askSentKey(agent) ?? "")}
            numbered
            hideQuestion
            activeQuestion={answerTab[agent.id] ?? 0}
            onSelectQuestion={(qi) => globalStore.set(model.answerTabAtom, (prev) => ({ ...prev, [agent.id]: qi }))}
            onToggle={(qi, oi) => model.toggleAnswer(agent.id, qi, oi)}
            onText={(qi, v) => model.setAnswerText(agent.id, qi, v)}
            onSubmit={() => model.submitAnswer(agent.id)}
            className={className}
        />
    );

    const leadAsking = lead?.state === "asking";
    const spec = leadAsking ? parseSpecReview(lead.ask) : null;
    const question = lead?.ask?.questions?.[answerTab[lead.id] ?? 0]?.question;
    const parValue = par ?? run.dag?.parallelism ?? 1;

    return (
        <motion.div
            variants={cardVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            style={{ flex: `${p.share.grow} 0 0px`, minHeight: p.share.minPx }}
            data-agent-id={p.cardId}
            onClick={() => p.onCursor(p.cardId)}
            className={cn(
                "group relative flex cursor-pointer flex-col overflow-hidden rounded-[13px] border bg-lane",
                vm.needsYou ? "border-warning/40" : "border-edge-mid",
                p.isCursor &&
                    (vm.needsYou
                        ? "shadow-[0_0_0_1.5px_var(--color-warning)]"
                        : "shadow-[0_0_0_1.5px_var(--color-accent)]"),
                p.pulse && "ring-2 ring-warning ring-inset"
            )}
        >
            <div className="flex shrink-0 items-center gap-2 border-b border-edge-mid bg-surface px-3 py-1.5">
                <span title="Orchestrator lead" className="shrink-0 text-[10px] leading-none text-accent-soft">
                    ◆
                </span>
                {lead ? (
                    <StatusLine agent={lead} nowAtom={model.nowAtom} className="min-w-0 flex-1" />
                ) : (
                    <>
                        <b className="min-w-0 truncate font-mono text-[13.5px] font-semibold text-primary">
                            {run.title}
                        </b>
                        <span
                            title="A lead starts at the run's first judgment event"
                            className="font-mono text-[10px] text-muted"
                        >
                            no lead
                        </span>
                        <div className="flex-1" />
                    </>
                )}
                {vm.askCount > 0 ? (
                    <span
                        title="Questions answered in this card; n cycles them"
                        className="shrink-0 rounded-[5px] bg-warning/15 px-[7px] py-px font-mono text-[10px] font-semibold text-warning"
                    >
                        {vm.askCount} asking you
                    </span>
                ) : null}
                {diff && lead ? (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            p.onOpenDiff(lead.id);
                        }}
                        title="Review changes in Diff"
                        className="flex shrink-0 cursor-pointer items-center gap-1 rounded-[5px] border border-edge-mid px-1.5 py-0.5 font-mono text-[9.5px] font-bold hover:border-accent hover:bg-accent/10"
                    >
                        <span className="text-success">+{diff.adds}</span>
                        <span className="text-error">−{diff.dels}</span>
                    </button>
                ) : null}
                {lead ? (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            model.openTerminal(lead.id);
                        }}
                        title="Open the lead's terminal (T)"
                        className={cn(CTL_BOX, "font-mono text-[9px] font-bold")}
                    >
                        {">_"}
                    </button>
                ) : null}
                {p.onBackground ? (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            p.onBackground!();
                        }}
                        title="Move to background (B)"
                        className={CTL_BOX}
                    >
                        <svg
                            viewBox="0 0 16 16"
                            width="12"
                            height="12"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={1.6}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M4 5 L8 9 L12 5" />
                            <path d="M4 11.5 H12" />
                        </svg>
                    </button>
                ) : null}
            </div>

            {leadAsking ? (
                <AttentionBanner glyph="diamond" label="Waiting on you" meta={formatAge(displayAgeMs(lead))} />
            ) : null}

            <div className="flex shrink-0 flex-col gap-2 px-[18px] pb-2.5 pt-3">
                <div className="flex h-[3px] gap-[3px]">
                    {vm.segs.map((s, i) => (
                        <div key={i} className={cn("h-full flex-1 rounded-[2px]", TONE_SEG[s])} />
                    ))}
                </div>
                <div className="flex items-center gap-2 text-[11.5px] text-muted">
                    <span className="min-w-0 flex-1 truncate text-accent-soft first-letter:uppercase">
                        {vm.activity}
                    </span>
                    <span className="shrink-0 font-mono text-[10.5px]">
                        {[vm.progress.total > 0 ? `${vm.progress.done}/${vm.progress.total}` : "", vm.elapsed, vm.cost]
                            .filter(Boolean)
                            .join(" · ")}
                    </span>
                </div>
            </div>

            <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
                <div
                    className={cn(
                        "min-h-0 overflow-y-auto overflow-x-hidden px-2.5 pb-3",
                        lead && paneOpen ? "max-h-[50%]" : "flex-1"
                    )}
                >
                    {p.leadDown ? (
                        <div className="mb-1.5 mt-0.5 flex flex-wrap items-center gap-2.5 rounded-[7px] border border-error/35 bg-error/[0.08] px-2.5 py-2">
                            <div className="min-w-[180px] flex-1">
                                <div className="font-mono text-[11.5px] font-semibold text-error">Lead wake failed</div>
                                <div className="text-[11.5px] leading-[1.45] text-secondary">
                                    Its judgment events and held questions come to you until you relaunch it.
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    dag("", "relaunch-lead");
                                }}
                                className="h-[23px] cursor-pointer rounded-[6px] border-0 bg-error px-[11px] text-[11.5px] font-bold text-background"
                            >
                                Relaunch lead
                            </button>
                        </div>
                    ) : null}

                    {vm.planning ? (
                        <div className="mb-2 mt-0.5 rounded-[7px] bg-background px-[11px] py-[9px] text-[12px] leading-[1.5] text-muted">
                            <b className="font-semibold text-secondary">Planning · no plan submitted yet.</b> The lead
                            works the goal with you in its terminal. Tasks appear here when it submits a plan.
                        </div>
                    ) : null}

                    {leadAsking && lead ? (
                        <div onClick={(e) => e.stopPropagation()} className="mb-2 flex flex-col gap-2">
                            {spec ? (
                                <SpecReviewBlock
                                    spec={spec}
                                    onOpen={() => fireAndForget(() => openFileInCode(model, spec.path))}
                                />
                            ) : question ? (
                                <p className="m-0 text-[14px] font-semibold leading-[1.45] text-primary">{question}</p>
                            ) : null}
                            {answerBarFor(lead, "px-0 py-0")}
                        </div>
                    ) : null}

                    <div className="flex flex-col gap-0.5">
                        {vm.rows.map((row) => (
                            <TaskRow
                                key={row.key}
                                row={row}
                                focused={p.cursorKey === row.key}
                                onFocus={() => p.onCursor(row.key)}
                                onOpen={() => row.openId && p.onOpen(row.openId)}
                                onAction={(a) => fireAndForget(() => rowAction(run, row, a))}
                                tell={
                                    telling === row.key ? (
                                        <TellInput
                                            taskId={row.taskId}
                                            onSend={(text) => dag(row.taskId, "tell", text)}
                                        />
                                    ) : null
                                }
                            >
                                {row.inline === "ask" && row.worker ? (
                                    <InlineBlock>
                                        <p className="m-0 text-[13px] font-semibold leading-[1.45] text-primary">
                                            {row.worker.ask?.questions?.[answerTab[row.worker.id] ?? 0]?.question}
                                        </p>
                                        {answerBarFor(row.worker, "px-0 py-0")}
                                    </InlineBlock>
                                ) : null}
                                {row.inline === "review" ? (
                                    <InlineBlock>
                                        {reviewFindings(p.events, row.taskId).map((f) => (
                                            <div
                                                key={f.round}
                                                className="grid grid-cols-[58px_minmax(0,1fr)] items-baseline gap-x-2"
                                            >
                                                <span className="font-mono text-[10px] font-semibold text-error">
                                                    Round {f.round}
                                                </span>
                                                <span className="text-[12px] leading-[1.45] text-secondary">
                                                    {f.note}
                                                </span>
                                            </div>
                                        ))}
                                        <div className="flex flex-wrap gap-1.5">
                                            {REVIEW_ACTIONS.map(([action, label], i) => (
                                                <button
                                                    key={action}
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        dag(
                                                            row.taskId,
                                                            action,
                                                            action === "sendback"
                                                                ? guide[row.taskId]?.trim()
                                                                : undefined
                                                        );
                                                    }}
                                                    className="flex cursor-pointer items-center gap-[7px] rounded-[6px] border border-edge-mid bg-transparent py-1 pl-1.5 pr-2.5 hover:border-warning"
                                                >
                                                    <span className="inline-flex h-4 w-4 items-center justify-center rounded-[4px] bg-surface-code font-mono text-[10px] text-secondary">
                                                        {i + 1}
                                                    </span>
                                                    <span className="text-[12px] font-semibold text-primary">
                                                        {label}
                                                    </span>
                                                </button>
                                            ))}
                                        </div>
                                        <input
                                            value={guide[row.taskId] ?? ""}
                                            onClick={(e) => e.stopPropagation()}
                                            onChange={(e) => setGuide((g) => ({ ...g, [row.taskId]: e.target.value }))}
                                            onKeyDown={(e) => {
                                                e.stopPropagation();
                                                if (e.key === "Enter" && guide[row.taskId]?.trim()) {
                                                    dag(row.taskId, "sendback", guide[row.taskId].trim());
                                                }
                                            }}
                                            placeholder="guidance for the next round… (Enter sends back)"
                                            className="w-full rounded-[6px] border border-edge-mid bg-surface-code px-[9px] py-[5px] text-[12px] text-primary outline-none"
                                        />
                                    </InlineBlock>
                                ) : null}
                            </TaskRow>
                        ))}
                        {vm.waiting.length > 0 ? (
                            <div className={cn(SECTION_LABEL, "px-2.5 pb-1 pt-3")}>Waiting · {vm.waiting.length}</div>
                        ) : null}
                        {vm.waiting.map((row) => (
                            <TaskRow
                                key={row.key}
                                row={row}
                                focused={p.cursorKey === row.key}
                                onFocus={() => p.onCursor(row.key)}
                                onOpen={() => {}}
                                onAction={() => {}}
                            />
                        ))}
                        <Fold
                            label={`Done · ${vm.done.length}`}
                            open={foldOpen(doneOpen, vm.done, p.cursorKey)}
                            onToggle={() => setDoneOpen((v) => !v)}
                            hidden={vm.done.length === 0}
                        >
                            {vm.done.map((row) => (
                                <TaskRow
                                    key={row.key}
                                    row={row}
                                    focused={p.cursorKey === row.key}
                                    onFocus={() => p.onCursor(row.key)}
                                    onOpen={() => row.openId && p.onOpen(row.openId)}
                                    onAction={() => {}}
                                />
                            ))}
                        </Fold>
                    </div>
                </div>
                {lead ? (
                    <LeadPane
                        lead={lead}
                        open={paneOpen}
                        onToggle={() =>
                            globalStore.set(leadPaneOpenAtom, (prev) => ({ ...prev, [run.runId]: !paneOpen }))
                        }
                        nowAtom={model.structuralNowAtom}
                    />
                ) : null}
            </div>

            {p.composerOpen && lead ? (
                <motion.div
                    variants={composerReveal}
                    initial="initial"
                    animate="animate"
                    onClick={(e) => e.stopPropagation()}
                    className="flex shrink-0 flex-col overflow-hidden border-t border-edge-mid px-3 py-2"
                >
                    <AgentComposer
                        blockId={lead.blockId}
                        placeholder={`message ${lead.name}…`}
                        onEscape={p.onComposerEscape}
                        className="border-t-0 px-0 py-0"
                    />
                </motion.div>
            ) : null}

            <div
                onClick={(e) => e.stopPropagation()}
                className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-edge-mid py-[7px] pl-3.5 pr-3"
            >
                <span
                    title={vm.settingsTitle}
                    className="min-w-[120px] flex-1 truncate font-mono text-[10.5px] text-muted"
                >
                    {vm.settings}
                </span>
                {run.dag && !vm.finished ? (
                    <button
                        type="button"
                        onClick={() => setPanel((v) => (v === "adjust" ? null : "adjust"))}
                        className={BTN}
                    >
                        Adjust
                    </button>
                ) : null}
                {run.dag ? (
                    <button type="button" onClick={() => openRunDag(model, run)} className={BTN}>
                        DAG ↗
                    </button>
                ) : null}
                {run.dag && !vm.finished ? (
                    <button
                        type="button"
                        onClick={() => setPanel((v) => (v === "cancel" ? null : "cancel"))}
                        className={cn(BTN, "text-error hover:border-error/45")}
                    >
                        Cancel run
                    </button>
                ) : null}
                {panel === "adjust" ? (
                    <div className="flex w-full flex-wrap items-center gap-2 rounded-[7px] bg-background px-2.5 py-[7px]">
                        <span className="text-[11.5px] text-muted">Worker parallelism</span>
                        <button
                            type="button"
                            onClick={() => setPar(clampParallelism(parValue - 1))}
                            className={cn(BTN, "w-[23px] px-0")}
                        >
                            −
                        </button>
                        <span className="min-w-[14px] text-center font-mono text-[12px] font-semibold text-primary">
                            {parValue}
                        </span>
                        <button
                            type="button"
                            onClick={() => setPar(clampParallelism(parValue + 1))}
                            className={cn(BTN, "w-[23px] px-0")}
                        >
                            +
                        </button>
                        <span className="min-w-0 flex-1 text-[11px] text-muted">applies to new dispatches</span>
                        <button
                            type="button"
                            onClick={() => {
                                act("Parallelism", () =>
                                    RpcApi.SetRunSettingsCommand(TabRpcClient, {
                                        channelid: run.channelId,
                                        runid: run.runId,
                                        parallelism: parValue,
                                    })
                                );
                                setPanel(null);
                            }}
                            className="h-[23px] cursor-pointer rounded-[6px] border-0 bg-accent px-[11px] text-[11.5px] font-semibold text-background"
                        >
                            Save
                        </button>
                    </div>
                ) : null}
                {panel === "cancel" ? (
                    <div className="flex w-full flex-wrap items-center gap-2 rounded-[7px] bg-error/[0.08] px-2.5 py-2">
                        <span className="min-w-[200px] flex-1 text-[11.5px] leading-[1.45] text-primary">
                            Stop {vm.rows.length} running tasks and cancel this run? Landed tasks, transcripts and
                            artifacts are kept.
                        </span>
                        <button type="button" onClick={() => setPanel(null)} className={BTN}>
                            Keep running
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                dag("", "cancel");
                                setPanel(null);
                            }}
                            className="h-[23px] cursor-pointer rounded-[6px] border-0 bg-error px-[11px] text-[11.5px] font-bold text-background"
                        >
                            Cancel run
                        </button>
                    </div>
                ) : null}
                {error ? <div className="w-full font-mono text-[11px] text-error">{error}</div> : null}
            </div>
        </motion.div>
    );
}

// TellInput sends one message to a row's worker. Closing it hands the keyboard back to the cockpit.
function TellInput({ taskId, onSend }: { taskId: string; onSend: (text: string) => void }) {
    const [draft, setDraft] = useState("");
    const close = (e: KeyboardEvent<HTMLInputElement>) => {
        (e.currentTarget.closest('[tabindex="0"]') as HTMLElement | null)?.focus();
        globalStore.set(tellingRowAtom, null);
    };
    return (
        <input
            autoFocus
            value={draft}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") {
                    close(e);
                } else if (e.key === "Enter" && draft.trim()) {
                    onSend(draft.trim());
                    close(e);
                }
            }}
            placeholder={`tell ${taskId}… (Enter sends, Esc cancels)`}
            className="mt-1 w-full rounded-[6px] border border-accent/60 bg-surface-code px-[9px] py-[5px] text-[12px] text-primary outline-none"
        />
    );
}

// One line per task; the cursor's row opens to what it is doing and what you can do about it.
function TaskRow({
    row,
    focused,
    onFocus,
    onOpen,
    onAction,
    tell,
    children,
}: {
    row: TaskRowVM;
    focused: boolean;
    onFocus: () => void;
    onOpen: () => void;
    onAction: (a: RowAction) => void;
    tell?: ReactNode;
    children?: ReactNode;
}) {
    const wait = row.kind === "wait";
    const canOpen = row.openId != null && !wait;
    return (
        <div
            data-row-key={row.key}
            data-agent-id={row.worker?.id}
            onClick={(e) => {
                e.stopPropagation();
                onFocus();
            }}
            onDoubleClick={onOpen}
            className={cn(
                "rounded-[8px]",
                focused ? "bg-surface-selected" : row.needsYou ? "bg-warning/[0.06]" : "hover:bg-surface-hover"
            )}
        >
            <div className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-x-3 px-2.5 py-[9px]">
                <span className={cn("h-[7px] w-[7px] rounded-full", TONE_DOT[row.tone])} />
                <span className={cn("truncate text-[13px]", wait ? "text-ink-mid" : "font-medium text-primary")}>
                    {row.label}
                </span>
                <span
                    className={cn(
                        "whitespace-nowrap font-mono text-[10.5px]",
                        row.needsYou ? "text-warning" : row.tone === "err" ? "text-error" : "text-muted"
                    )}
                >
                    {row.tag ?? row.age}
                </span>
            </div>
            {focused || tell ? (
                <div className="flex flex-col gap-[9px] pb-[11px] pl-[30px] pr-2.5">
                    <div className={cn("truncate text-[11.5px]", row.tone === "warn" ? "text-warning" : "text-muted")}>
                        {row.sub}
                    </div>
                    {tell ??
                        (row.actions.length > 0 || canOpen ? (
                            <div className="flex flex-wrap gap-1.5">
                                {row.actions.map((a, i) => (
                                    <button
                                        key={a}
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onAction(a);
                                        }}
                                        className={ROW_BTN}
                                    >
                                        <span className="rounded-[3px] bg-surface-code px-1 font-mono text-[9.5px] text-ink-mid">
                                            {i + 1}
                                        </span>
                                        {ACTION_LABEL[a]}
                                    </button>
                                ))}
                                {canOpen ? (
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onOpen();
                                        }}
                                        className={cn(ROW_BTN, "pl-2.5")}
                                    >
                                        {row.kind === "done" ? "Open transcript" : "Open worker"}
                                    </button>
                                ) : null}
                            </div>
                        ) : null)}
                </div>
            ) : null}
            {children}
        </div>
    );
}

function InlineBlock({ children }: { children: ReactNode }) {
    return (
        <div
            onClick={(e) => e.stopPropagation()}
            className="mb-2 ml-[30px] mr-2.5 flex flex-col gap-[7px] border-l-2 border-warning/55 pb-[5px] pl-[11px] pt-[3px]"
        >
            {children}
        </div>
    );
}

function Fold({
    label,
    open,
    onToggle,
    hidden,
    children,
}: {
    label: string;
    open: boolean;
    onToggle: () => void;
    hidden: boolean;
    children: ReactNode;
}) {
    if (hidden) {
        return null;
    }
    return (
        <>
            <div
                onClick={(e) => {
                    e.stopPropagation();
                    onToggle();
                }}
                className={cn(
                    SECTION_LABEL,
                    "flex cursor-pointer items-center gap-2 px-2.5 pb-1 pt-3 hover:text-secondary"
                )}
            >
                {label}
                <span className="ml-auto font-normal">{open ? "▾" : "▸"}</span>
            </div>
            {open ? children : null}
        </>
    );
}

function SpecReviewBlock({ spec, onOpen }: { spec: SpecReview; onOpen: () => void }) {
    const file = spec.path.split(/[\\/]/).pop() ?? spec.path;
    return (
        <>
            <p className="m-0 text-[14px] font-semibold leading-[1.45] text-primary">
                Review the spec before I write the plan
            </p>
            <div className="flex items-center gap-2.5 rounded-[7px] border border-edge-mid bg-background px-2.5 py-2">
                <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[12px] font-semibold text-primary">{file}</div>
                    <div className="truncate font-mono text-[10.5px] text-muted">{spec.path}</div>
                </div>
                <button
                    type="button"
                    onClick={onOpen}
                    className="h-[25px] shrink-0 cursor-pointer rounded-[6px] border border-accent/45 bg-transparent px-2.5 text-[11.5px] font-semibold text-accent-soft hover:bg-accent/10"
                >
                    Open in Code ↗
                </button>
            </div>
            {spec.decisions.length > 0 ? (
                <div className="flex flex-col gap-1">
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">
                        Decisions in it
                    </span>
                    {spec.decisions.map((d, i) => (
                        <div
                            key={i}
                            className="grid grid-cols-[10px_minmax(0,1fr)] text-[12.5px] leading-[1.45] text-secondary"
                        >
                            <span className="text-muted">·</span>
                            <span>{d}</span>
                        </div>
                    ))}
                </div>
            ) : null}
        </>
    );
}

// The lead's own transcript under the tasks. Hidden, it stays as one line holding its newest message.
function LeadPane({
    lead,
    open,
    onToggle,
    nowAtom,
}: {
    lead: AgentVM;
    open: boolean;
    onToggle: () => void;
    nowAtom: Atom<number>;
}) {
    const live = useAtomValue(entriesAtomFor(lead.id));
    const entries = entriesToShow(live, lead.previousInfo);
    const now = useAtomValue(nowAtom);
    const toggle = (e: MouseEvent) => {
        e.stopPropagation();
        onToggle();
    };
    if (open) {
        return <LeadTranscript lead={lead} entries={entries} onHide={toggle} />;
    }
    // an idle lead's newest message is from when it went idle; a busy lead's has no time of its own
    const age = lead.state === "idle" && lead.idleSince != null ? formatAgeShort(now - lead.idleSince) : "";
    return (
        <button
            type="button"
            onClick={toggle}
            aria-expanded={false}
            title="Show the lead's transcript"
            className="flex w-full shrink-0 cursor-pointer items-center gap-2.5 border-0 border-t border-edge-mid bg-surface py-[9px] pl-[18px] pr-3 text-left hover:bg-surface-hover"
        >
            <span className={SECTION_LABEL}>Lead</span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-mid">
                {latestMessageText(entries) ?? lead.activity ?? ""}
            </span>
            {age ? <span className="shrink-0 font-mono text-[10px] text-muted">{age}</span> : null}
            <span className="shrink-0 px-2 text-[11px] font-semibold text-ink-mid">Show</span>
        </button>
    );
}

// its own component so the scroll region pins to the newest entry each time the pane opens
function LeadTranscript({
    lead,
    entries,
    onHide,
}: {
    lead: AgentVM;
    entries: AgentEntry[];
    onHide: (e: MouseEvent) => void;
}) {
    const { scrollRef, onScroll, atBottom, jumpToBottom } = useStickToBottom(entries);
    return (
        <div className="flex min-h-0 flex-1 flex-col border-t border-edge-mid bg-surface">
            <div className="flex shrink-0 items-center gap-2 pb-1 pl-[18px] pr-3 pt-[9px]">
                <span className={cn(SECTION_LABEL, "flex-1")}>Lead</span>
                <button
                    type="button"
                    onClick={onHide}
                    aria-expanded={true}
                    title="Hide the lead's transcript"
                    className="h-[22px] cursor-pointer rounded-[5px] border-0 bg-transparent px-2 text-[11px] font-semibold text-ink-mid hover:bg-surface-hover hover:text-secondary"
                >
                    Hide
                </button>
            </div>
            <div className="relative min-h-0 flex-1">
                <div
                    ref={scrollRef}
                    onScroll={onScroll}
                    className="h-full overflow-y-auto overflow-x-hidden px-5 pb-3.5"
                >
                    <NarrationTimeline entries={entries} accentLatest active={lead.state !== "idle"} />
                </div>
                {atBottom ? null : <JumpToLatestPill onClick={jumpToBottom} />}
            </div>
        </div>
    );
}
