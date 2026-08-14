// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Briefing Stage body: attention banner, efforts, active work, since-last-visit delta,
// seven-day shipped, and the inline all-work answer above the composer. Pure projection in
// briefingmodel.ts; this file only renders rows and never reinterprets wire kinds.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { formatAge } from "@/app/view/agents/agentsviewmodel";
import { cn } from "@/util/util";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useMemo } from "react";
import { BRIEFING_FIXTURES } from "./briefingfixtures";
import { normalizeBriefingNav, projectBriefing, SEVEN_DAYS_MS } from "./briefingmodel";
import { EffortCard } from "./effortcard";
import { expandedEffortOrefAtom, toggleEffort } from "./effortstore";
import {
    briefingAnswerAtom,
    briefingAskStateAtom,
    briefingFixtureAtom,
    briefingStateAtom,
    loadBriefing,
    refreshBriefing,
} from "./briefingstore";
import { stageRailOpenAtom } from "./jarvisstore";
import { selectSubject } from "./jarvissubjectstore";
import { openORef, orefNavPlan } from "./openref";
import { STAGE_GUTTER, STAGE_SCROLLER } from "./stagemeasure";

// one consistent row chrome for the active-work kinds; only the middle line differs.
function RowShell({
    kind,
    name,
    meta,
    onClick,
    children,
}: {
    kind: string;
    name: string;
    meta: string;
    onClick: (() => void) | null;
    children?: React.ReactNode;
}) {
    const body = (
        <>
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
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 py-[7px] text-left transition-colors duration-[140ms] hover:bg-surface-hover"
        >
            {body}
        </button>
    );
}

function statusChip(status: string): string {
    const tone =
        status === "blocked"
            ? "bg-asking/15 text-asking"
            : status === "done"
              ? "bg-success/15 text-success"
              : "bg-surface-raised text-secondary";
    return cn("flex-none rounded-[4px] px-1.5 py-[2px] font-mono text-[9.5px] font-semibold uppercase", tone);
}

function MoreLink({ label, onClick }: { label: string; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="w-fit cursor-pointer rounded-[7px] px-2.5 py-1 font-mono text-[10.5px] font-semibold text-accent-soft hover:bg-surface-hover"
        >
            {label}
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
    const expandedEffort = useAtomValue(expandedEffortOrefAtom);

    // load on entry (mount == transitioned into Briefing); Refresh / Retry / pinned-row re-click
    // call refreshBriefing() directly.
    useEffect(() => {
        loadBriefing();
    }, []);

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
                            className="mt-1 w-fit cursor-pointer rounded-[7px] border border-border bg-surface-raised px-2.5 py-1 text-[11px] font-semibold text-secondary hover:text-primary"
                        >
                            Retry
                        </button>
                    </div>
                ) : null}
                {firstLoad ? (
                    <div className="flex flex-col gap-4">
                        {[
                            ["Efforts", "h-12"],
                            ["Runs", "h-12"],
                            ["Since last visit", "h-16"],
                            ["Recently shipped · 7 days", "h-12"],
                        ].map(([label, h]) => (
                            <div key={label} className="flex flex-col gap-2">
                                <span className="font-mono text-[9.5px] font-bold uppercase tracking-[.12em] text-muted">
                                    {label}
                                </span>
                                <div className={cn("animate-pulse rounded-[10px] bg-surface", h)} />
                            </div>
                        ))}
                    </div>
                ) : null}
                {snapshot != null && model_ != null ? (
                    <>
                        {failedRefresh ? (
                            <div className="flex items-center gap-2 rounded-[10px] border border-border bg-surface px-4 py-2.5">
                                <span className="text-[12px] text-secondary">
                                    Showing previous snapshot · refresh failed
                                </span>
                                <button
                                    type="button"
                                    onClick={refreshBriefing}
                                    className="ml-auto cursor-pointer rounded-[6px] border border-border bg-surface-raised px-2 py-0.5 text-[10.5px] font-semibold text-secondary hover:text-primary"
                                >
                                    Retry
                                </button>
                            </div>
                        ) : null}
                        {snapshot.cursorSaved === false ? (
                            <div className="rounded-[10px] border border-border bg-surface px-4 py-2.5 text-[12px] text-secondary">
                                Visit marker not saved — the next load will repeat this window.
                            </div>
                        ) : null}
                        {!model_.health.complete ? (
                            <div className="rounded-[10px] border border-border bg-surface px-4 py-2.5 text-[12px] text-secondary">
                                Couldn't fully read: {model_.health.missingLegs.join(", ")}
                            </div>
                        ) : null}
                        {model_.attention != null || model_.attentionLines.length > 0 ? (
                            <button
                                type="button"
                                data-jarvis-briefing-banner
                                onClick={openRail}
                                className="flex w-full cursor-pointer flex-col items-start gap-1 rounded-[10px] border border-asking/30 bg-asking/10 px-4 py-2.5 text-left transition-colors duration-[140ms] hover:bg-asking/15"
                            >
                                <span className="flex items-center gap-2">
                                    <span className="h-2 w-2 flex-none rounded-full bg-asking" />
                                    <span className="text-[13px] font-semibold text-primary">
                                        Needs you{model_.attention != null ? ` · ${model_.attention.count}` : ""}
                                    </span>
                                </span>
                                {model_.attentionLines.map((l) => (
                                    <span key={l} className="block pl-4 text-[12px] text-secondary">
                                        {l}
                                    </span>
                                ))}
                            </button>
                        ) : null}
                        {/* Efforts — full width, first section */}
                        <section data-jarvis-briefing-section="efforts" className="flex flex-col gap-2">
                            <div className="mb-1 flex items-center gap-2">
                                <span className="font-mono text-[9.5px] font-bold uppercase tracking-[.12em] text-muted">
                                    Efforts
                                </span>
                                <span className="rounded-[9px] bg-surface px-1.5 font-mono text-[9.5px] font-semibold text-muted">
                                    {model_.efforts.length + model_.effortMore}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => {}}
                                    className="ml-auto cursor-pointer rounded-[7px] border border-accent/40 bg-accentbg px-2.5 py-1 text-[11px] font-semibold text-accent-soft hover:border-accent/60"
                                >
                                    + Effort
                                </button>
                            </div>
                            {model_.efforts.length === 0 ? (
                                <div className="rounded-[10px] border border-dashed border-edge-strong px-4 py-4 text-center text-[12px] text-muted">
                                    <span className="font-medium text-secondary">No efforts yet.</span> Big tasks — a
                                    migration, an enablement, a multi-week refactor — get a tracker here. Paste your
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
                                            onChipClick={() => void toggleEffort(e.oref)}
                                            onOpenDetail={() =>
                                                selectSubject({ kind: "effort", id: e.oref.replace(/^effort:/, "") })
                                            }
                                        />
                                    ))}
                                    {model_.effortMore > 0 ? (
                                        <MoreLink label={`+${model_.effortMore} more`} onClick={() => {}} />
                                    ) : null}
                                </div>
                            )}
                        </section>
                        {/* two-column cockpit grid: Active work | Since last visit + Shipped */}
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                            <section data-jarvis-briefing-section="active" className="flex min-w-0 flex-col gap-1">
                                <div className="mb-1 flex items-center gap-2">
                                    <span className="font-mono text-[9.5px] font-bold uppercase tracking-[.12em] text-muted">
                                        Active work
                                    </span>
                                    <span className="rounded-[9px] bg-surface px-1.5 font-mono text-[9.5px] font-semibold text-muted">
                                        {model_.counts.runs + model_.blockers.length + model_.counts.agents}
                                    </span>
                                </div>
                                <div className="flex flex-col gap-1">
                                    <span
                                        data-jarvis-briefing-section="runs"
                                        className="font-mono text-[9.5px] font-semibold uppercase tracking-[.12em] text-muted"
                                    >
                                        Runs · {model_.counts.runs}
                                    </span>
                                    {model_.activeRuns.length === 0 ? (
                                        <span className="px-2.5 py-1 text-[12px] text-secondary">
                                            No active Wave runs.
                                        </span>
                                    ) : (
                                        model_.activeRuns.map((r) => (
                                            <RowShell
                                                key={r.oref}
                                                kind="run"
                                                name={r.goal}
                                                meta={`${r.project} · ${r.status}`}
                                                onClick={() => void openORef(model, r.oref)}
                                            >
                                                <span className={statusChip(r.status)}>{r.status}</span>
                                            </RowShell>
                                        ))
                                    )}
                                </div>
                                <div className="mt-2 flex flex-col gap-1">
                                    <span
                                        data-jarvis-briefing-section="blockers"
                                        className="font-mono text-[9.5px] font-semibold uppercase tracking-[.12em] text-muted"
                                    >
                                        Blocked records · {model_.blockers.length}
                                    </span>
                                    {model_.blockers.length === 0 ? (
                                        <span className="px-2.5 py-1 text-[12px] text-secondary">
                                            No blocked records.
                                        </span>
                                    ) : (
                                        model_.blockers.map((b) => (
                                            <RowShell
                                                key={b.oref}
                                                kind="blocker"
                                                name={b.objective}
                                                meta={b.blockers}
                                                onClick={b.oref !== "" ? () => void openORef(model, b.oref) : null}
                                            >
                                                {b.project == null ? (
                                                    <span className="flex-none rounded-[4px] bg-surface-raised px-1.5 py-[2px] font-mono text-[9.5px] font-semibold uppercase text-secondary">
                                                        Unscoped record
                                                    </span>
                                                ) : null}
                                            </RowShell>
                                        ))
                                    )}
                                </div>
                                <div className="mt-2 flex flex-col gap-1">
                                    <span
                                        data-jarvis-briefing-section="agents"
                                        className="font-mono text-[9.5px] font-semibold uppercase tracking-[.12em] text-muted"
                                    >
                                        Direct agents · {model_.counts.agents}
                                    </span>
                                    {model_.directAgents.length === 0 ? (
                                        <span className="px-2.5 py-1 text-[12px] text-secondary">
                                            No direct agents working right now.
                                        </span>
                                    ) : (
                                        model_.directAgents.map((a) => (
                                            <RowShell
                                                key={a.oref}
                                                kind="agent"
                                                name={a.name + " · " + (a.task || a.name)}
                                                meta={`${a.runtime}${a.project != null ? " · " + a.project : ""} · ${formatAge(Date.now() - a.startedTs)}`}
                                                onClick={() => void openORef(model, a.oref)}
                                            >
                                                <span
                                                    className={cn(
                                                        "flex-none rounded-[4px] px-1.5 py-[2px] font-mono text-[9.5px] font-semibold uppercase",
                                                        a.state === "asking"
                                                            ? "bg-asking/15 text-asking"
                                                            : "bg-surface-raised text-secondary"
                                                    )}
                                                >
                                                    {a.state}
                                                </span>
                                            </RowShell>
                                        ))
                                    )}
                                    {model_.activeMore > 0 ? (
                                        <MoreLink label={`+${model_.activeMore} more`} onClick={openRail} />
                                    ) : null}
                                </div>
                            </section>
                            <section className="flex min-w-0 flex-col gap-4">
                                <section className="flex flex-col gap-1">
                                    <div className="mb-1 flex items-center gap-2">
                                        <span
                                            data-jarvis-briefing-section="delta"
                                            className="font-mono text-[9.5px] font-bold uppercase tracking-[.12em] text-muted"
                                        >
                                            Since last visit
                                        </span>
                                        <span className="rounded-[9px] bg-surface px-1.5 font-mono text-[9.5px] font-semibold text-muted">
                                            {model_.counts.delta}
                                        </span>
                                    </div>
                                    {model_.delta.length === 0 ? (
                                        <span className="px-2.5 py-1 text-[12px] text-secondary">
                                            No changes in this visit window.
                                        </span>
                                    ) : (
                                        model_.delta.map((d) => {
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
                                                            {d.wording}
                                                            {d.detail != null ? " · " + d.detail : ""}
                                                        </span>
                                                    </span>
                                                    <span className="flex-none font-mono text-[9.5px] text-muted">
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
                                                    className="flex w-full cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 py-[7px] text-left transition-colors duration-[140ms] hover:bg-surface-hover"
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
                                        })
                                    )}
                                    {model_.deltaMore > 0 ? <MoreLink label="see all" onClick={openRail} /> : null}
                                </section>
                                <section className="flex flex-col gap-1">
                                    <div className="mb-1 flex items-center gap-2">
                                        <span
                                            data-jarvis-briefing-section="shipped"
                                            className="font-mono text-[9.5px] font-bold uppercase tracking-[.12em] text-muted"
                                        >
                                            Recently shipped · 7 days
                                        </span>
                                        <span className="rounded-[9px] bg-surface px-1.5 font-mono text-[9.5px] font-semibold text-muted">
                                            {model_.counts.shipped}
                                        </span>
                                    </div>
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
                                                className="flex w-full cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 py-[7px] text-left transition-colors duration-[140ms] hover:bg-surface-hover"
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
                                                <span className="flex-none font-mono text-[9.5px] text-muted">
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
                            <span className="mb-1 font-mono text-[9.5px] font-bold uppercase tracking-[.12em] text-muted">
                                Ask across your work
                            </span>
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
                                                            className="cursor-pointer rounded-[6px] border border-border bg-surface-raised px-2 py-0.5 text-[10.5px] font-semibold text-accent-soft hover:border-accent/40"
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
        </div>
    );
}
