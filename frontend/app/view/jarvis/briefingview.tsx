// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Briefing Stage body: status strip, needs-you card, efforts, active work, since-last-visit
// delta, seven-day shipped, and the inline all-work answer above the composer. Pure projection in
// briefingmodel.ts; this file only renders rows and never reinterprets wire kinds.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { formatAge } from "@/app/view/agents/agentsviewmodel";
import { attentionAtom } from "@/app/view/agents/attentionstore";
import { pendingRunFocusAtom } from "@/app/view/agents/runactions";
import { cn } from "@/util/util";
import { useAtomValue, useSetAtom } from "jotai";
import { Fragment, useEffect, useMemo, useState } from "react";
import { BRIEFING_FIXTURES } from "./briefingfixtures";
import {
    buildAttentionQueue,
    groupDelta,
    mergeActiveWork,
    normalizeBriefingNav,
    projectBriefing,
    SEVEN_DAYS_MS,
    type ActiveWorkRow,
    type QueueRow,
} from "./briefingmodel";
import {
    ackBriefingVisit,
    briefingAckAtom,
    briefingAnswerAtom,
    briefingAskStateAtom,
    briefingFixtureAtom,
    briefingStateAtom,
    loadBriefing,
    refreshBriefing,
} from "./briefingstore";
import { EffortCard } from "./effortcard";
import { EffortCreateForm } from "./effortcreateform";
import { effortDeltaRow } from "./effortmodel";
import { expandedEffortOrefAtom, toggleEffort } from "./effortstore";
import { stageRailOpenAtom } from "./jarvisstore";
import { selectSubject } from "./jarvissubjectstore";
import { openORef, orefNavPlan } from "./openref";
import { STAGE_GUTTER, STAGE_SCROLLER } from "./stagemeasure";

// the section-header chrome: mono label + count pill + hairline rule + optional action.
function SectionHead({ label, count, action }: { label: string; count?: number; action?: React.ReactNode }) {
    return (
        <div className="mb-1.5 flex items-center gap-2">
            <span className="font-mono text-[9.5px] font-bold uppercase tracking-[.12em] text-feed-label">{label}</span>
            {count != null ? (
                <span className="rounded-full border border-edge-faint bg-surface-raised px-2 py-[1px] font-mono text-[9.5px] font-semibold text-muted">
                    {count}
                </span>
            ) : null}
            <span className="h-px min-w-3 flex-1 bg-edge-faint" />
            {action}
        </div>
    );
}

// one consistent row chrome for the active-work kinds; only the middle line differs. `lead`
// renders before the text (kind badge), children after it (chip, age).
function RowShell({
    kind,
    name,
    meta,
    lead,
    onClick,
    children,
}: {
    kind: string;
    name: string;
    meta: string;
    lead?: React.ReactNode;
    onClick: (() => void) | null;
    children?: React.ReactNode;
}) {
    const body = (
        <>
            {lead}
            <span className="min-w-0 flex-1 flex-col gap-0.5">
                <span className="block min-w-0 truncate text-[12.5px] font-medium text-primary">{name}</span>
                <span className="mt-[2px] block truncate font-mono text-[9.5px] text-muted">{meta}</span>
            </span>
            {children}
        </>
    );
    if (onClick == null) {
        return <div className="flex items-center gap-2.5 rounded-[8px] px-2.5 py-[7px]">{body}</div>;
    }
    return (
        <button
            type="button"
            data-jarvis-briefing-row
            data-row-kind={kind}
            aria-label={name + ", " + meta}
            onClick={onClick}
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 py-[7px] text-left transition-colors duration-[140ms] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
            {body}
        </button>
    );
}

// chip tones mirror the model's chip union; blocked/asking get the asking tint, the rest quiet.
type ChipTone = "blocked" | "asking" | "running" | "muted";
function chipClass(tone: ChipTone): string {
    return tone === "blocked" || tone === "asking" ? "bg-asking/15 text-asking" : "bg-surface-raised text-secondary";
}

// a blocker row, or any row whose chip says blocked/asking — the same tiering mergeActiveWork sorts by.
function needsEyes(r: ActiveWorkRow): boolean {
    return r.kind === "blocker" || (r.chip != null && (r.chip.tone === "blocked" || r.chip.tone === "asking"));
}

function kindBadge(kind: ActiveWorkRow["kind"]): string {
    return cn(
        "flex-none rounded-[4px] border px-1.5 py-[2px] font-mono text-[8.5px] font-bold uppercase tracking-[.06em]",
        kind === "run"
            ? "border-edge-faint bg-surface-raised text-ink-mid"
            : kind === "agent"
              ? "border-accent/25 bg-accentbg text-accent-soft"
              : "border-asking/30 bg-asking/15 text-asking"
    );
}

function MoreLink({ label, onClick }: { label: string; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="w-fit cursor-pointer rounded-[7px] px-2.5 py-1 font-mono text-[10.5px] font-semibold text-accent-soft hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
            {label}
        </button>
    );
}

// one waiting-on-you row: tone bar, kind badge, what is waiting, how long, and its own action. The
// action navigates to the run body that owns the gate/ask — the briefing surfaces the queue, the run
// body still resolves it, so there is one place a decision is actually made.
function QueueRowView({ row, first, onGo }: { row: QueueRow; first: boolean; onGo: () => void }) {
    const body = (
        <>
            <span className={cn("my-3 self-stretch rounded-[2px]", row.tone === "error" ? "bg-error" : "bg-asking")} />
            <span className="flex min-w-0 flex-col gap-1.5 py-[11px]">
                <span className="flex min-w-0 flex-wrap items-center gap-2.5">
                    <span className="flex-none rounded-[4px] bg-asking/15 px-1.5 py-[2px] font-mono text-[8.5px] font-bold uppercase tracking-[.06em] text-asking">
                        {row.kind}
                    </span>
                    <span className="min-w-[180px] flex-1 text-[12.5px] font-semibold text-primary">{row.title}</span>
                    {row.ts != null ? (
                        <span className="flex-none font-mono text-[9.5px] text-muted">
                            {formatAge(Date.now() - row.ts)}
                        </span>
                    ) : null}
                    {row.action != null ? (
                        <span className="flex-none rounded-[7px] border border-accent/40 bg-surface-raised px-3 py-[5px] text-[11px] font-semibold text-accent-soft">
                            {row.action}
                        </span>
                    ) : null}
                </span>
                <span className="text-[11px] leading-[1.45] text-ink-mid">{row.detail}</span>
            </span>
        </>
    );
    const shell = cn("grid grid-cols-[3px_minmax(0,1fr)] gap-3 pl-[11px] pr-3.5", !first && "border-t border-border");
    // no nav → the owning channel could not be resolved; static info, not a dead control.
    if (row.nav == null) {
        return <div className={shell}>{body}</div>;
    }
    return (
        <button
            type="button"
            data-jarvis-briefing-row
            data-row-kind="queue"
            aria-label={row.kind + ": " + row.title + ", " + row.detail}
            onClick={onGo}
            className={cn(
                shell,
                "w-full cursor-pointer text-left transition-colors duration-[140ms] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            )}
        >
            {body}
        </button>
    );
}

export function BriefingView({ model }: { model: AgentsViewModel }) {
    const { snapshot, loading, error } = useAtomValue(briefingStateAtom);
    const fixture = useAtomValue(briefingFixtureAtom);
    const liveAgents = useAtomValue(model.agentsAtom);
    const askState = useAtomValue(briefingAskStateAtom);
    const answer = useAtomValue(briefingAnswerAtom);
    const setRailOpen = useSetAtom(stageRailOpenAtom);
    const setPendingFocus = useSetAtom(pendingRunFocusAtom);
    const liveAttention = useAtomValue(attentionAtom);
    const expandedEffort = useAtomValue(expandedEffortOrefAtom);
    const [showCreateForm, setShowCreateForm] = useState(false);

    // load on entry (mount == transitioned into Briefing); Refresh / Retry / pinned-row re-click
    // call refreshBriefing() directly.
    useEffect(() => {
        loadBriefing();
    }, []);

    // visit marker advances on dwell, not at load: a glance-and-close leaves the delta unseen and
    // repeating on the next brief. The timer restarts whenever a new snapshot lands (refresh/reload).
    const ack = useAtomValue(briefingAckAtom);
    const snapshotComplete = snapshot?.complete === true;
    const queryStartedAt = snapshot?.queryStartedAt;
    useEffect(() => {
        if (!snapshotComplete) {
            return;
        }
        const t = window.setTimeout(ackBriefingVisit, 3000);
        return () => window.clearTimeout(t);
    }, [snapshotComplete, queryStartedAt]);

    const model_ = useMemo(() => {
        if (snapshot == null) {
            return null;
        }
        const agents = fixture != null ? BRIEFING_FIXTURES[fixture].agents : liveAgents;
        return projectBriefing({
            state: snapshot.state,
            agents,
            actualCursor: snapshot.actualCursor,
            queryStartedAt: snapshot.queryStartedAt,
            sevenDaysAgo: snapshot.queryStartedAt - SEVEN_DAYS_MS,
        });
    }, [snapshot, fixture, liveAgents]);

    const activeRows: ActiveWorkRow[] | null =
        model_ != null
            ? mergeActiveWork({
                  activeRuns: model_.activeRuns,
                  blockers: model_.blockers,
                  directAgents: model_.directAgents,
              })
            : null;
    const deltaGroups = model_ != null ? groupDelta(model_.delta, Date.now()) : null;

    // the queue reads the live attention poll rather than the snapshot's count, so an ask raised
    // after the snapshot still lands here without waiting for a refresh — and a fixture seeds it the
    // same way it seeds the agent roster, so every fixture state previews the queue too.
    const attention = fixture != null ? BRIEFING_FIXTURES[fixture].attention : liveAttention;
    const queue = model_ != null ? buildAttentionQueue({ attention, efforts: model_.efforts }) : [];

    // a queued item in another channel has to move the Stage there first; pendingRunFocus is the
    // one-shot the Stage already consumes to land on a run once that channel's runs have loaded.
    const goToQueueRow = (row: QueueRow): void => {
        if (row.nav == null) {
            return;
        }
        if (row.nav.kind === "effort") {
            selectSubject({ kind: "effort", id: row.nav.oref.replace(/^effort:/, "") });
            return;
        }
        if (row.nav.runId != null) {
            setPendingFocus({ channelId: row.nav.channelId, runId: row.nav.runId });
            return;
        }
        selectSubject({ kind: "channel", id: row.nav.channelId });
    };

    // one effort expanded at a time, owned by the store so subjects and delta rows can drive it.
    const failedRefresh = error != null && snapshot != null;
    const firstLoad = snapshot == null && loading;
    const loadFailed = snapshot == null && error != null;

    // overflow links land on the rail: the per-leg full lists are not subjects yet, so the rail's
    // browsing surface is the honest target for what the caps hid.
    const openRail = () => setRailOpen(true);

    return (
        <div className={cn(STAGE_SCROLLER, "min-h-0 flex-1")}>
            <div className={cn(STAGE_GUTTER, "flex flex-col gap-4 py-4")} aria-live="polite">
                {loadFailed ? (
                    <div
                        data-jarvis-briefing-error
                        className="flex flex-col gap-2 rounded-[10px] border border-border bg-surface px-4 py-3"
                    >
                        <span className="text-[13px] font-semibold text-primary">Couldn't load your work state.</span>
                        <span className="text-[12px] text-secondary">{error}</span>
                        <button
                            type="button"
                            onClick={refreshBriefing}
                            className="mt-1 w-fit cursor-pointer rounded-[7px] border border-border bg-surface-raised px-2.5 py-1 text-[11px] font-semibold text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                            Retry
                        </button>
                    </div>
                ) : null}
                {firstLoad ? (
                    <div className="flex flex-col gap-4">
                        {[
                            ["Initiatives", "h-12"],
                            ["Active work", "h-12"],
                            ["Since last visit", "h-16"],
                            ["Recently shipped · 7 days", "h-12"],
                        ].map(([label, h]) => (
                            <div key={label} className="flex flex-col gap-2">
                                <span className="font-mono text-[9.5px] font-bold uppercase tracking-[.12em] text-muted">
                                    {label}
                                </span>
                                <div
                                    className={cn(
                                        "animate-pulse motion-reduce:animate-none rounded-[10px] bg-surface",
                                        h
                                    )}
                                />
                            </div>
                        ))}
                    </div>
                ) : null}
                {snapshot != null && model_ != null && activeRows != null && deltaGroups != null ? (
                    <>
                        {/* one quiet status line instead of stacked health/error boxes */}
                        <div
                            data-jarvis-briefing-strip
                            className="flex items-center gap-2 rounded-[8px] border border-edge-faint px-3 py-1.5 font-mono text-[10px] text-ink-faint"
                        >
                            <span
                                className={cn(
                                    "h-[5px] w-[5px] flex-none rounded-full",
                                    failedRefresh ? "bg-error" : "bg-success"
                                )}
                            />
                            <span className="text-muted">
                                snapshot {formatAge(Date.now() - snapshot.queryStartedAt)} ago
                            </span>
                            <span className="text-edge-strong">·</span>
                            <span className="text-muted">
                                {ack === "failed"
                                    ? "visit marker not saved"
                                    : ack === "saved"
                                      ? "visit marker saved"
                                      : "visit marker pending"}
                            </span>
                            {!model_.health.complete ? (
                                <>
                                    <span className="text-edge-strong">·</span>
                                    <span className="text-error">
                                        couldn't fully read: {model_.health.missingLegs.join(", ")}
                                    </span>
                                </>
                            ) : null}
                            {failedRefresh ? (
                                <>
                                    <span className="text-edge-strong">·</span>
                                    <span className="text-error">refresh failed — showing previous snapshot</span>
                                </>
                            ) : null}
                        </div>
                        {/* waiting on you: one actionable row per waiting thing, not a count that
                            only opened the rail. Absent rather than empty when nothing waits. */}
                        {queue.length > 0 ? (
                            <section data-jarvis-briefing-section="queue" className="flex flex-col">
                                <div className="mb-1.5 flex items-center gap-2">
                                    <span className="h-[7px] w-[7px] flex-none animate-pulse rounded-full bg-asking motion-reduce:animate-none" />
                                    <span className="font-mono text-[9.5px] font-bold uppercase tracking-[.12em] text-asking">
                                        Waiting on you
                                    </span>
                                    <span className="rounded-full bg-asking px-1.5 py-[1px] font-mono text-[9.5px] font-bold text-on-warning">
                                        {queue.length}
                                    </span>
                                    <span className="h-px min-w-3 flex-1 bg-edge-faint" />
                                    <MoreLink label="Review all →" onClick={openRail} />
                                </div>
                                <div className="overflow-hidden rounded-[10px] border border-asking/30 bg-asking/10">
                                    {queue.map((q, i) => (
                                        <QueueRowView
                                            key={q.key}
                                            row={q}
                                            first={i === 0}
                                            onGo={() => goToQueueRow(q)}
                                        />
                                    ))}
                                </div>
                            </section>
                        ) : null}
                        {/* Efforts — full width, first section */}
                        <section data-jarvis-briefing-section="efforts" className="flex flex-col gap-2">
                            <SectionHead
                                label="Initiatives"
                                count={model_.efforts.length + model_.effortMore}
                                action={
                                    <button
                                        type="button"
                                        onClick={() => setShowCreateForm(true)}
                                        className="cursor-pointer rounded-[7px] border border-accent/40 bg-accentbg px-2.5 py-1 text-[11px] font-semibold text-accent-soft hover:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                    >
                                        + Initiative
                                    </button>
                                }
                            />
                            {model_.efforts.length === 0 ? (
                                <div className="rounded-[10px] border border-dashed border-edge-strong px-4 py-4 text-center text-[12px] text-muted">
                                    <span className="font-medium text-secondary">No initiatives yet.</span> Big tasks —
                                    a migration, an enablement, a multi-week refactor — get a tracker here. Paste your
                                    phase list once, then tick chunks as work lands.
                                </div>
                            ) : (
                                <div className="flex flex-col gap-2">
                                    {model_.efforts.map((e) => (
                                        <EffortCard
                                            key={e.oref}
                                            model={e}
                                            expanded={expandedEffort === e.oref}
                                            onToggle={() => void toggleEffort(e.oref)}
                                            onOpenDetail={() =>
                                                selectSubject({ kind: "effort", id: e.oref.replace(/^effort:/, "") })
                                            }
                                        />
                                    ))}
                                    {model_.effortMore > 0 ? (
                                        <MoreLink
                                            label={`+${model_.effortMore} more`}
                                            onClick={() => selectSubject({ kind: "effort-list", id: "all" })}
                                        />
                                    ) : null}
                                </div>
                            )}
                        </section>
                        {/* two-column cockpit grid: Active work | Since last visit + Shipped */}
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                            {/* active work: one triage queue, kind badge per row */}
                            <section data-jarvis-briefing-section="active" className="flex min-w-0 flex-col gap-1">
                                <SectionHead
                                    label="Active work"
                                    count={model_.counts.runs + model_.blockers.length + model_.counts.agents}
                                    action={
                                        /* the whole point of the queue above is that this section is
                                           then just running work — but only say so when no row here
                                           actually carries a blocked/asking chip. */
                                        activeRows.length > 0 && !activeRows.some(needsEyes) ? (
                                            <span className="font-mono text-[9.5px] text-muted">
                                                nothing here needs you
                                            </span>
                                        ) : null
                                    }
                                />
                                {activeRows.length === 0 ? (
                                    <span className="px-2.5 py-1 text-[12px] text-secondary">
                                        No active work right now.
                                    </span>
                                ) : (
                                    activeRows.map((r) => (
                                        <RowShell
                                            key={r.key}
                                            kind={r.kind}
                                            name={r.name}
                                            meta={r.meta}
                                            lead={<span className={kindBadge(r.kind)}>{r.kind}</span>}
                                            onClick={r.oref !== "" ? () => void openORef(model, r.oref) : null}
                                        >
                                            {r.chip != null ? (
                                                <span
                                                    className={cn(
                                                        "flex-none rounded-[4px] px-1.5 py-[2px] font-mono text-[9.5px] font-semibold uppercase",
                                                        chipClass(r.chip.tone)
                                                    )}
                                                >
                                                    {r.chip.label}
                                                </span>
                                            ) : null}
                                            <span className="flex-none font-mono text-[9.5px] text-ink-faint">
                                                {formatAge(Date.now() - r.ts)}
                                            </span>
                                        </RowShell>
                                    ))
                                )}
                                {model_.activeMore > 0 ? (
                                    <MoreLink label={`+${model_.activeMore} more`} onClick={openRail} />
                                ) : null}
                            </section>
                            <section className="flex min-w-0 flex-col gap-4">
                                <section data-jarvis-briefing-section="delta" className="flex flex-col gap-1">
                                    <SectionHead label="Since last visit" count={model_.counts.delta} />
                                    {model_.delta.length === 0 ? (
                                        <span className="px-2.5 py-1 text-[12px] text-secondary">
                                            No changes in this visit window.
                                        </span>
                                    ) : (
                                        deltaGroups.map((g) => (
                                            <Fragment key={g.label}>
                                                <span className="px-2.5 pb-0.5 pt-2 font-mono text-[9.5px] font-semibold uppercase tracking-[.12em] text-feed-label">
                                                    {g.label}
                                                </span>
                                                {g.rows.map((d) => {
                                                    const eff = effortDeltaRow({
                                                        kind: d.kind,
                                                        title: d.title,
                                                        detail: d.detail,
                                                    });
                                                    const oref =
                                                        d.oref != null &&
                                                        d.oref !== "" &&
                                                        orefNavPlan(d.oref).kind !== "unsupported"
                                                            ? d.oref
                                                            : null;
                                                    const inner = (
                                                        <>
                                                            <span className="min-w-0 flex-1 flex-col">
                                                                <span className="block text-[12.5px] font-medium text-primary">
                                                                    {d.title}
                                                                </span>
                                                                <span className="mt-[2px] block truncate font-mono text-[9.5px] text-muted">
                                                                    {eff != null
                                                                        ? eff.meta
                                                                        : `${d.wording}${d.detail != null ? " · " + d.detail : ""}`}
                                                                </span>
                                                            </span>
                                                            <span className="flex-none font-mono text-[9.5px] text-ink-faint">
                                                                {formatAge(Date.now() - d.ts)}
                                                            </span>
                                                        </>
                                                    );
                                                    return oref != null ? (
                                                        <button
                                                            key={d.key}
                                                            type="button"
                                                            data-jarvis-briefing-row
                                                            data-row-kind={d.kind}
                                                            aria-label={d.title + ", " + d.wording}
                                                            onClick={() => void openORef(model, oref!)}
                                                            className="flex w-full cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 py-[7px] text-left transition-colors duration-[140ms] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                                        >
                                                            {inner}
                                                        </button>
                                                    ) : (
                                                        <div
                                                            key={d.key}
                                                            className="flex items-center gap-2.5 rounded-[8px] px-2.5 py-[7px]"
                                                        >
                                                            {inner}
                                                        </div>
                                                    );
                                                })}
                                            </Fragment>
                                        ))
                                    )}
                                    {model_.deltaMore > 0 ? <MoreLink label="see all" onClick={openRail} /> : null}
                                </section>
                                <section data-jarvis-briefing-section="shipped" className="flex flex-col gap-1">
                                    <SectionHead label="Recently shipped · 7 days" count={model_.counts.shipped} />
                                    {model_.shipped.length === 0 ? (
                                        <span className="px-2.5 py-1 text-[12px] text-secondary">
                                            No evidence-sealed Runs shipped in the last 7 days.
                                        </span>
                                    ) : (
                                        model_.shipped.map((s) => (
                                            <button
                                                key={s.oref}
                                                type="button"
                                                data-jarvis-briefing-row
                                                data-row-kind="shipped"
                                                aria-label={s.goal + ", shipped"}
                                                onClick={() => void openORef(model, s.oref)}
                                                className="flex w-full cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 py-[7px] text-left transition-colors duration-[140ms] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                            >
                                                <span className="min-w-0 flex-1 flex-col">
                                                    <span className="block min-w-0 truncate text-[12.5px] font-medium text-primary">
                                                        {s.goal}
                                                    </span>
                                                    <span className="mt-[2px] block truncate font-mono text-[9.5px] text-muted">
                                                        {s.project}
                                                        {s.summary !== "" ? " · " + s.summary : ""}
                                                    </span>
                                                </span>
                                                {s.fresh ? (
                                                    <span className="flex-none rounded-[4px] bg-success/15 px-1.5 py-[2px] font-mono text-[9.5px] font-semibold uppercase text-success">
                                                        New
                                                    </span>
                                                ) : null}
                                                <span className="flex-none font-mono text-[9.5px] text-ink-faint">
                                                    {formatAge(Date.now() - s.completedTs)}
                                                </span>
                                            </button>
                                        ))
                                    )}
                                    {model_.shippedMore > 0 ? (
                                        <MoreLink label={`+${model_.shippedMore} more`} onClick={openRail} />
                                    ) : null}
                                </section>
                            </section>
                        </div>
                        {/* Ask — full width, above the composer */}
                        <section data-jarvis-briefing-section="ask" className="flex flex-col gap-1">
                            <SectionHead label="Ask across your work" />
                            {answer != null ? (
                                <>
                                    <div className="rounded-[10px] border border-border bg-surface px-4 py-3">
                                        <p className="whitespace-pre-wrap text-[13px] leading-[1.5] text-primary">
                                            {answer.answer}
                                        </p>
                                        {answer.sources.length > 0 ? (
                                            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                                                {answer.sources.map((s, i) => {
                                                    const normalized = normalizeBriefingNav(s.oref);
                                                    const navigable =
                                                        normalized != null &&
                                                        orefNavPlan(normalized).kind !== "unsupported";
                                                    return navigable ? (
                                                        <button
                                                            key={i}
                                                            type="button"
                                                            onClick={() => void openORef(model, normalized!)}
                                                            className="cursor-pointer rounded-[6px] border border-border bg-surface-raised px-2 py-0.5 text-[10.5px] font-semibold text-accent-soft hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                                        >
                                                            [{i + 1}] {s.title}
                                                        </button>
                                                    ) : (
                                                        <span
                                                            key={i}
                                                            className="rounded-[6px] border border-border bg-surface-raised px-2 py-0.5 text-[10.5px] text-muted"
                                                        >
                                                            [{i + 1}] {s.title}
                                                        </span>
                                                    );
                                                })}
                                            </div>
                                        ) : null}
                                    </div>
                                    {askState === "error" ? (
                                        <span className="px-1 text-[11.5px] text-secondary">
                                            Ask failed — try again.
                                        </span>
                                    ) : null}
                                </>
                            ) : null}
                            {askState === "pending" ? (
                                <span className="px-1 font-mono text-[10.5px] text-muted">Answering…</span>
                            ) : null}
                        </section>
                    </>
                ) : null}
            </div>
            {showCreateForm ? <EffortCreateForm onClose={() => setShowCreateForm(false)} /> : null}
        </div>
    );
}
