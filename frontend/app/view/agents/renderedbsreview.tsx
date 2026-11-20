// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The check review card, in the Rendered transcript: what the builder check changed, each change kept or put back,
// the new guesses to confirm, the picks waiting to go. Picks and Keep all send what the pane sends; Edit and the part
// links open the pane at the part.

import { turnTransition } from "@/app/element/motiontokens";
import { PaneReveal } from "@/app/element/panereveal";
import { TickNumber } from "@/app/element/ticknumber";
import { cn } from "@/util/util";
import { ChevronRight } from "lucide-react";
import type { JSX } from "react";
import type { AgentVM } from "./agentsviewmodel";
import type { BrainstormFile, BrainstormPart, PartPick, ReviewRow } from "./brainstormmodel";
import { pickPart, sendBrainstorm } from "./brainstormsend";
import { openBrainstormAt, shownPicks, toggleReviewRow, type BrainstormState } from "./brainstormstore";
import { ChangeDiff, ErrorLine, PART_BTN, PickButton, SECTION_HEAD, useAction, WORKING_TITLE } from "./brainstormui";
import { CANVAS_PRIMARY_BTN } from "./canvaspane";
import { CardFrame } from "./renderedbrainstorm";
import type { CardProps } from "./renderedbrainstormmodel";
import { reviewCardView, type ReviewPicksView } from "./renderedbsreviewmodel";

const QUIET_BTN =
    "cursor-pointer whitespace-nowrap border-0 bg-transparent px-[2px] py-[4px] text-[12px] text-ink-mid hover:text-secondary disabled:cursor-default disabled:opacity-50";
const LINK_BTN = "cursor-pointer border-0 bg-transparent p-0 hover:underline";
// a decision the check rewrote waits on keep or put back: an accent ring until it is yours again
const DOT_BASE = "mt-[6px] box-border h-[7px] w-[7px] flex-none rounded-full";
const DOT_STATE: Record<string, string> = {
    changed: "border-[1.5px] border-accent",
    yours: "bg-success",
    guess: "border-[1.5px] border-dashed border-ink-mid",
    asked: "bg-warning",
    writing: "bg-success",
    open: "border-[1.5px] border-edge-strong",
};

function Actions({
    agent,
    s,
    row,
    compact,
    locked,
    lockTitle,
    run,
}: {
    agent: AgentVM;
    s: BrainstormState;
    row: ReviewRow;
    compact: boolean;
    locked: boolean;
    lockTitle?: string;
    run: (fn: () => Promise<void>) => Promise<boolean>;
}): JSX.Element | null {
    const picked = shownPicks(s)[row.id];
    const pick = (label: string, kind: PartPick, className: string) => (
        <PickButton
            label={label}
            pressed={picked === kind}
            dimmed={picked != null}
            className={className}
            disabled={locked}
            title={lockTitle}
            onClick={() => void run(() => pickPart(agent, row.id, kind))}
        />
    );
    const box = cn("flex items-center gap-3", compact ? "pt-1" : "-mt-[3px] flex-none justify-end");
    if (row.action === "keep-restore") {
        return (
            <span data-rendered-bs-review-actions className={box}>
                {pick("Keep the change", "keep", cn(PART_BTN, "whitespace-nowrap"))}
                {pick("Put mine back", "restore", QUIET_BTN)}
            </span>
        );
    }
    if (row.action === "confirm") {
        return (
            <span data-rendered-bs-review-actions className={box}>
                {pick("That’s right", "confirm", cn(PART_BTN, "whitespace-nowrap"))}
                <button
                    type="button"
                    data-rendered-bs-review-edit
                    onClick={() => openBrainstormAt(agent.id, { part: row.id })}
                    className={QUIET_BTN}
                >
                    Edit
                </button>
            </span>
        );
    }
    return null;
}

function ReviewRowCard({
    agent,
    s,
    f,
    row,
    compact,
    open,
}: {
    agent: AgentVM;
    s: BrainstormState;
    f: BrainstormFile;
    row: ReviewRow;
    compact: boolean;
    open: boolean;
}): JSX.Element {
    const act = useAction();
    const part = f.parts.find((p) => p.id === row.id);
    const working = f.working != null;
    const expandable = row.action === "keep-restore" || row.view === "yours";
    const toggle = () => toggleReviewRow(agent.id, row.id);
    const text = compact ? "text-[12.5px]" : "text-[13.5px]";
    return (
        <div
            data-rendered-bs-review-row={row.id}
            data-state={row.view}
            className={cn("flex flex-col gap-[6px] border-t border-edge-faint py-[9px]", compact ? "px-1" : "px-[6px]")}
        >
            <div className={cn("flex gap-x-3 gap-y-1", compact ? "flex-col" : "items-start")}>
                <div className={cn("flex min-w-0 gap-[10px]", compact ? "items-start" : "flex-1")}>
                    <span className={cn(DOT_BASE, DOT_STATE[row.view])} />
                    <div className={cn("flex min-w-0 flex-1 gap-x-3 gap-y-0.5", compact ? "flex-col" : "items-start")}>
                        {expandable ? (
                            <button
                                type="button"
                                data-rendered-bs-review-toggle
                                aria-expanded={open}
                                onClick={toggle}
                                className={cn(
                                    "flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left font-semibold leading-[1.45] text-primary",
                                    text,
                                    !compact && "w-[170px] flex-none"
                                )}
                            >
                                <span className="min-w-0">{row.title}</span>
                                <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 12 12"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                    aria-hidden
                                    style={turnTransition}
                                    className={cn(
                                        "flex-none text-muted transition-transform motion-reduce:transition-none",
                                        open && "rotate-180"
                                    )}
                                >
                                    <path d="M3 4.5l3 3 3-3" />
                                </svg>
                            </button>
                        ) : (
                            <span
                                className={cn(
                                    "font-semibold leading-[1.45] text-primary",
                                    text,
                                    !compact && "w-[170px] flex-none"
                                )}
                            >
                                {row.title}
                            </span>
                        )}
                        <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                            <span data-rendered-bs-review-gist className={cn("leading-[1.45] text-secondary", text)}>
                                {row.gist}
                            </span>
                            {row.cause ? (
                                <span data-rendered-bs-review-cause className="text-[12px] leading-[1.4] text-muted">
                                    {row.cause}
                                </span>
                            ) : null}
                            {row.calls.map((c, i) => (
                                <span
                                    key={i}
                                    data-rendered-bs-review-call
                                    className="mt-[2px] text-[12.5px] leading-[1.5] text-ink-mid"
                                >
                                    <b className="mr-1.5 font-semibold text-secondary">Agent’s call</b>
                                    {c}
                                </span>
                            ))}
                        </span>
                    </div>
                </div>
                <div className={cn(compact && "pl-[17px]")}>
                    <Actions
                        agent={agent}
                        s={s}
                        row={row}
                        compact={compact}
                        locked={working}
                        lockTitle={working ? WORKING_TITLE : undefined}
                        run={act.run}
                    />
                </div>
            </div>
            <PaneReveal open={open && expandable} className="pl-[17px]">
                <div data-rendered-bs-review-diff className="flex flex-col gap-1 pb-1">
                    {row.was != null && part != null ? (
                        <ChangeDiff part={{ ...part, why: undefined }} />
                    ) : (
                        <div className="whitespace-pre-line rounded-[6px] bg-surface-raised px-[10px] py-[6px] text-[13px] leading-[1.5] text-secondary">
                            {row.body}
                        </div>
                    )}
                </div>
            </PaneReveal>
            <ErrorLine error={act.error} className="pl-[17px]" />
        </div>
    );
}

function PartLinks({
    kind,
    label,
    agent,
    parts,
}: {
    kind: string;
    label: string;
    agent: AgentVM;
    parts: BrainstormPart[];
}): JSX.Element | null {
    if (parts.length === 0) {
        return null;
    }
    return (
        <section
            aria-label={label}
            data-rendered-bs-review-links={kind}
            className="flex flex-wrap items-center gap-x-[10px] gap-y-[6px] border-t border-edge-faint py-[10px] text-[13px] text-muted"
        >
            <ChevronRight size={12} strokeWidth={2} aria-hidden className="flex-none" />
            <h2 className="m-0 text-[13px] font-semibold text-secondary">
                {label} · {parts.length}
            </h2>
            {parts.map((p) => (
                <button
                    key={p.id}
                    type="button"
                    data-rendered-bs-review-link={p.id}
                    onClick={() => openBrainstormAt(agent.id, { part: p.id })}
                    className={cn(LINK_BTN, "text-[13px] text-muted hover:text-secondary")}
                >
                    {p.title}
                </button>
            ))}
        </section>
    );
}

function KeepAll({ agent, pending, working }: { agent: AgentVM; pending: number; working: boolean }) {
    const act = useAction();
    return (
        <span className="ml-auto flex flex-none flex-col items-end gap-1">
            <button
                type="button"
                data-rendered-bs-keep-all
                disabled={working || act.busy}
                title={working ? WORKING_TITLE : undefined}
                onClick={() =>
                    void act.run(() => sendBrainstorm(agent, { kind: "keep-all" }, undefined, undefined, "transcript"))
                }
                className={cn(PART_BTN, "whitespace-nowrap")}
            >
                Keep all <TickNumber value={pending} /> changes
            </button>
            <ErrorLine error={act.error} />
        </span>
    );
}

function PicksBar({
    agent,
    picks,
    working,
    compact,
}: {
    agent: AgentVM;
    picks: ReviewPicksView;
    working: boolean;
    compact: boolean;
}) {
    const act = useAction();
    return (
        <div data-rendered-bs-picks className="flex flex-col gap-1 border-t border-edge-faint pt-3">
            <div className={cn("flex gap-x-[14px] gap-y-2", compact ? "flex-col" : "items-center")}>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span
                        data-rendered-bs-picks-line
                        title={picks.line}
                        className={cn("font-semibold text-secondary", compact ? "text-[12.5px]" : "text-[13.5px]")}
                    >
                        <TickNumber value={picks.picked} /> {picks.picked === 1 ? "choice" : "choices"} made
                        {picks.open > 0 ? (
                            <>
                                , <TickNumber value={picks.open} /> still open
                            </>
                        ) : null}
                    </span>
                    <span className="text-[12px] text-muted">
                        They go with the next line you send, or by themselves once every decision is settled.
                    </span>
                </div>
                <button
                    type="button"
                    data-rendered-bs-send-picks
                    disabled={act.busy || working}
                    title={working ? WORKING_TITLE : undefined}
                    onClick={() =>
                        void act.run(() =>
                            sendBrainstorm(agent, { kind: "settle" }, undefined, undefined, "transcript")
                        )
                    }
                    className={cn(CANVAS_PRIMARY_BTN, "flex-none self-start")}
                >
                    {picks.send}
                </button>
            </div>
            <ErrorLine error={act.error} />
        </div>
    );
}

const REVIEW_TITLE = "Review what the check changed";

export function ReviewCard({ agent, s, f, compact }: CardProps): JSX.Element | null {
    const v = reviewCardView(f, shownPicks(s));
    const working = f.working != null;
    const row = (x: ReviewRow) => (
        <ReviewRowCard
            key={x.id}
            agent={agent}
            s={s}
            f={f}
            row={x}
            compact={compact}
            open={s.review.open[x.id] === true}
        />
    );
    return (
        <CardFrame
            agent={agent}
            s={s}
            f={f}
            asking={true}
            title={REVIEW_TITLE}
            compact={compact}
            attr="data-rendered-bs-review"
        >
            <div className="flex flex-col gap-1">
                <span className={cn("font-bold leading-[1.4] text-primary", compact ? "text-[15px]" : "text-[17px]")}>
                    {REVIEW_TITLE}
                </span>
                {v.summary ? (
                    <span
                        data-rendered-bs-review-summary
                        className={cn("leading-[1.5] text-ink-mid", compact ? "text-[12.5px]" : "text-[13px]")}
                    >
                        {v.summary}
                    </span>
                ) : null}
            </div>
            {v.changed.length > 0 ? (
                <section data-rendered-bs-review-section="changed" aria-label="Changed" className="flex flex-col">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 pb-1.5">
                        <h2 className={SECTION_HEAD}>
                            Changed since you confirmed · <TickNumber value={v.changed.length} />
                        </h2>
                        {v.anyWas ? <span className="text-[12px] text-muted">open one to see what it was</span> : null}
                        {v.keepAll != null ? <KeepAll agent={agent} pending={v.keepAll} working={working} /> : null}
                    </div>
                    {v.changed.map(row)}
                </section>
            ) : null}
            {v.fresh.length > 0 ? (
                <section data-rendered-bs-review-section="fresh" aria-label="New" className="flex flex-col">
                    <h2 className={cn(SECTION_HEAD, "pb-1.5")}>New since the check · {v.fresh.length}</h2>
                    {v.fresh.map(row)}
                </section>
            ) : null}
            <PartLinks kind="unchanged" label="Yours, unchanged" agent={agent} parts={v.unchanged} />
            <PartLinks kind="notes" label="What the agent found" agent={agent} parts={v.notes} />
            {v.picks != null ? <PicksBar agent={agent} picks={v.picks} working={working} compact={compact} /> : null}
        </CardFrame>
    );
}
