// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Merged Sessions surface (absorbs the old Activity tab). Master-detail: a recency-grouped list with a pinned
// "All activity" entry. An orchestrator run is one entry, with a row under it only for the members that need
// you; its detail lists the lead and every task and reads the one in view. Every other session is its own
// entry. Live agents are overlaid (matched by transcript path) so the primary action is Jump (live) or Resume
// (ended). @theme tokens only — no hardcoded colors.

import { cardVariants, MOTION } from "@/app/element/motiontokens";
import { SkeletonLine, SkeletonRows } from "@/app/element/skeleton";
import { globalStore } from "@/app/store/jotaiStore";
import { useSurfaceListNav, type ListNavController } from "@/app/store/keybindings/listnav";
import * as WOS from "@/app/store/wos";
import { REGION_LABEL } from "@/app/view/jarvis/briefstyle";
import { cn, fireAndForget } from "@/util/util";
import { atom, useAtom, useAtomValue } from "jotai";
import { Activity, Check, Search, Workflow } from "lucide-react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { formatAge, formatAgeShort, formatTokens } from "./agentsviewmodel";
import type { RunInfo } from "./runlineage";
import { runDigestsAtom, useRunDigests } from "./runlineagestore";
import { runtimeMeta } from "./runtimemeta";
import {
    groupByRecency,
    loadSessionsArchive,
    mergedFeed,
    overlayLive,
    pageFeed,
    pageGroups,
    resolveSelectedSession,
    sessionsArchiveAtom,
    sessionsErrorAtom,
    sessionsIncompleteAtom,
    totalEvents,
    type LiveSession,
    type SessionStatusFilter,
} from "./sessionsarchivestore";
import { eventColor, RunDetail, runSessionPrimary, SEG_COLOR, SoloDetail, StatusMark } from "./sessionsdetail";
import { openSessionHit } from "./sessionsfind";
import {
    defaultMember,
    groupRunSessions,
    LEAD_MEMBER,
    memberSession,
    rosterSession,
    runIdOfSel,
    runSelKey,
    runView,
    sessionKey,
    sessionLabel,
    sessionSelection,
    type RunMember,
    type RunView,
    type Status,
} from "./sessionsruns";
import {
    composeSearchRows,
    foldHits,
    isSearchQuery,
    keepRow,
    mergeResultSessions,
    scopeRows,
    searchSummary,
    snippetParts,
    type CardMatch,
    type Row,
    type SnippetRow,
} from "./sessionssearch";
import { useSessionsSearch } from "./sessionssearchstore";
import { SurfaceEmptyState, SurfaceError, SurfaceToolbar, ToolbarFact } from "./surfacescaffold";

const FILTERS: { key: SessionStatusFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "live", label: "Live" },
    { key: "needs", label: "Needs you" },
    { key: "done", label: "Done" },
];

// ~2,400 sessions and ~8,600 events in 30 days: the list and the feed render in pages so neither freezes
const LIST_PAGE = 60;
const FEED_PAGE = 200;
const ARCHIVE_POLL_MS = 3000;

// how many of `total` rows to render: `page` more each time the sentinel at the list's end scrolls into view.
// The observer is rebuilt on every growth, so a sentinel still in view after one page grows another.
function usePaging(page: number, total: number) {
    const [count, setCount] = useState(page);
    const sentinelRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = sentinelRef.current;
        if (el == null || count >= total) {
            return;
        }
        const io = new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting)) {
                setCount((c) => c + page);
            }
        });
        io.observe(el);
        return () => io.disconnect();
    }, [count, total, page]);
    return { count, setCount, sentinelRef };
}

function needsRow(r: Row): boolean {
    return r.run ? r.run.view.needs.length > 0 : r.session!.needsAttention;
}

function soloStatus(s: LiveSession, now: number): Status {
    if (s.live) {
        return s.needsAttention ? { key: "asking", text: "asking" } : { key: "running", text: "running" };
    }
    return { key: "muted", text: formatAge(now - s.lastactivets) };
}

// the session a member opens: its own, else the live agent of its run the scan has not picked up yet
function memberLiveSession(m: RunMember, runId: string, roster: AgentVM[]): LiveSession | undefined {
    if (m.session) {
        return m.session;
    }
    const childRunId = m.key === LEAD_MEMBER ? runId : m.childRunId;
    const agent = childRunId ? roster.find((a) => a.runId === childRunId) : undefined;
    return agent ? rosterSession(agent) : undefined;
}

export function SessionsSurface({ model }: { model: AgentsViewModel }) {
    const base = useAtomValue(sessionsArchiveAtom);
    const loadError = useAtomValue(sessionsErrorAtom);
    const roster = useAtomValue(model.agentsAtom);
    const now = useAtomValue(model.nowAtom);
    const [sel, setSel] = useAtom(model.sessionsSelAtom);
    const [member, setMember] = useAtom(model.sessionsMemberAtom);
    const [filter, setFilter] = useAtom(model.sessionsStatusFilterAtom);
    const projectFilter = useAtomValue(model.projectFilterAtom);
    const digests = useAtomValue(runDigestsAtom);
    const incomplete = useAtomValue(sessionsIncompleteAtom);
    const [query, setQuery] = useAtom(model.sessionsQueryAtom);
    // off on every visit: run agents are a deliberate widening, not a mode the list remembers
    const [runAgents, setRunAgents] = useState(false);
    const search = useSessionsSearch(query, runAgents);
    const searching = isSearchQuery(query);
    const results = searching ? search.results : null;

    useEffect(() => {
        fireAndForget(loadSessionsArchive);
    }, []);
    useEffect(() => {
        if (!incomplete) {
            return;
        }
        const t = setInterval(() => fireAndForget(loadSessionsArchive), ARCHIVE_POLL_MS);
        return () => clearInterval(t);
    }, [incomplete]);

    const live = useMemo(
        () => (base == null ? [] : overlayLive(results ? mergeResultSessions(base, results) : base, roster, now)),
        [base, results, roster, now]
    );
    const matches = useMemo(() => (results ? foldHits(results) : null), [results]);
    const { runs: runGroups, solos } = useMemo(() => groupRunSessions(live), [live]);

    // each run's own object and its dag, read from the object store (loaded on first read)
    const runIdsKey = runGroups.map((g) => g.runId).join(",");
    const runObjsAtom = useMemo(
        () =>
            atom((get) => {
                const out: Record<string, { run?: Run; dag?: TaskGroup }> = {};
                for (const id of runIdsKey.split(",").filter(Boolean)) {
                    const run = get(WOS.getWaveObjectAtom<Run>(WOS.makeORef("run", id)));
                    const dag = run?.dagoref
                        ? get(WOS.getWaveObjectAtom<TaskGroup>(WOS.makeORef("dag", run.dagoref)))
                        : undefined;
                    out[id] = { run, dag };
                }
                return out;
            }),
        [runIdsKey]
    );
    const runObjs = useAtomValue(runObjsAtom);

    const runRows: Row[] = useMemo(
        () =>
            runGroups.map((group) => {
                const lead = memberSession(group.lead);
                const leadAgent = lead?.liveId ? roster.find((a) => a.id === lead.liveId) : undefined;
                const o = runObjs[group.runId];
                const view = runView({
                    group,
                    run: o?.run,
                    dag: o?.dag,
                    digest: digests[group.runId],
                    leadAtPrompt: leadAgent?.atPrompt,
                    now,
                });
                return {
                    key: runSelKey(group.runId),
                    live: group.live,
                    lastactivets: group.lastactivets,
                    run: { group, view },
                };
            }),
        [runGroups, runObjs, digests, roster, now]
    );

    // only a live run can raise a question, and the one in view shows its ask
    const selRunId = runIdOfSel(sel);
    useRunDigests(
        runGroups
            .filter((g) => g.live || g.runId === selRunId)
            .map(
                (g): RunInfo => ({
                    runId: g.runId,
                    channelId: g.channelId || runObjs[g.runId]?.dag?.channelid || "",
                    title: "",
                    project: "",
                    dag: runObjs[g.runId]?.dag,
                })
            )
    );

    const soloRows: Row[] = solos.map((s) => ({
        key: sessionKey(s),
        live: s.live,
        lastactivets: s.lastactivets,
        session: s,
    }));
    const rows = [...runRows, ...soloRows];
    const scoped = scopeRows(rows, projectFilter);
    const shown = matches
        ? composeSearchRows(rows, matches, filter, projectFilter)
        : scoped.filter((r) => keepRow(r, filter));
    const groups = groupByRecency(shown, now);
    const summary = matches ? searchSummary(new Map(shown.map((r) => [r.key, matches.get(r.key)!]))) : "";
    const openCard = (m: CardMatch) => openSessionHit(model, m.results[0], query, search.terms);
    const openHit = (row: SnippetRow) => openSessionHit(model, row.result, query, search.terms, row.hit);
    const scopedSessions = scoped.flatMap((r) => (r.run ? r.run.group.sessions : [r.session!]));
    const liveCount = scopedSessions.filter((s) => s.live).length;
    const needsCount = scoped.filter(needsRow).length;

    // detail resolves against every row so project and status filters never blank an explicit selection
    const selSession = selRunId ? undefined : resolveSelectedSession(live, sel);
    const viewRunId = selRunId ?? selSession?.runid;
    const selRun = viewRunId ? runRows.find((r) => r.run!.group.runId === viewRunId)?.run : undefined;
    const selMember = selRun
        ? (selRun.view.members.find((m) => m.key === member) ?? selRun.view.members[0])
        : undefined;
    const selMemberSession = selRun && selMember ? memberLiveSession(selMember, selRun.view.runId, roster) : undefined;
    const primary = selRun ? selMemberSession : selSession;

    const select = (key: string) => {
        setSel(key);
        const runId = runIdOfSel(key);
        const view = runId ? runRows.find((r) => r.run!.group.runId === runId)?.run?.view : undefined;
        if (view) {
            setMember(defaultMember(view));
        }
    };
    const selectMember = (runId: string, key: string) => {
        setSel(runSelKey(runId));
        setMember(key);
    };
    const openSession = (key: string) => {
        const s = live.find((x) => sessionKey(x) === key);
        const to: { sel: string; member?: string } = s != null ? sessionSelection(s) : { sel: key };
        setSel(to.sel);
        if (to.member != null) {
            setMember(to.member);
        }
    };

    // publish the "All activity" + row order for global j/k list-nav. cursor==selection. Refs keep the
    // controller stable while reading this render's rows, so it isn't re-registered on every roster tick.
    const navIds = useMemo(() => ["all", ...groups.flatMap((g) => g.items.map((r) => r.key))], [groups]);
    const listPage = usePaging(LIST_PAGE, navIds.length - 1);
    const paged = pageGroups(groups, listPage.count);
    const selectRef = useRef(select);
    selectRef.current = select;
    const actRef = useRef<() => void>(() => {});
    actRef.current = () => {
        if (primary) {
            runSessionPrimary(model, primary);
        }
    };
    const cursorId = viewRunId ? runSelKey(viewRunId) : sel;
    const listNav = useMemo<ListNavController>(
        () => ({
            surface: "sessions",
            navigableIds: navIds,
            cursorId,
            setCursor: (id) => selectRef.current(id),
            activate: () => actRef.current(),
        }),
        [navIds, cursorId]
    );
    useSurfaceListNav(listNav);

    // j/k walks every row: a cursor past the rendered rows grows the page to reach it, then its card scrolls
    // into view once rendered. Only a cursor move scrolls, so growing the page by scrolling never yanks back.
    const cursorIdx = navIds.indexOf(cursorId ?? "") - 1;
    const setListCount = listPage.setCount;
    useEffect(() => {
        if (cursorIdx >= 0) {
            setListCount((c) => (cursorIdx < c ? c : Math.ceil((cursorIdx + 1) / LIST_PAGE) * LIST_PAGE));
        }
    }, [cursorIdx, setListCount]);
    const listRef = useRef<HTMLDivElement>(null);
    const scrollTo = useRef<string | null>(null);
    useEffect(() => {
        scrollTo.current = cursorId && cursorId !== "all" ? cursorId : null;
    }, [cursorId]);
    useEffect(() => {
        const key = scrollTo.current;
        const card = key ? listRef.current?.querySelector(`[data-session-row="${CSS.escape(key)}"]`) : null;
        if (card) {
            card.scrollIntoView({ block: "nearest" });
            scrollTo.current = null;
        }
    });

    const runTitles = Object.fromEntries(runRows.map((r) => [r.run!.group.runId, r.run!.view.title]));
    const detailKind = selRun ? "run" : selSession ? "solo" : "feed";

    return (
        <MotionConfig reducedMotion="user">
            <div className="flex h-full min-h-0 flex-col bg-background">
                <SurfaceToolbar
                    title="Sessions"
                    actions={
                        <div
                            role="group"
                            aria-label="Status filter"
                            className="flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5"
                        >
                            {FILTERS.map((f) => (
                                <button
                                    key={f.key}
                                    type="button"
                                    aria-pressed={filter === f.key}
                                    onClick={() => setFilter(f.key)}
                                    className={cn(
                                        "flex cursor-pointer items-center gap-1.5 rounded-[6px] px-[11px] py-[5px] text-[11.5px] font-semibold",
                                        filter === f.key
                                            ? "bg-accentbg text-primary"
                                            : "text-ink-mid hover:text-primary"
                                    )}
                                >
                                    {f.label}
                                    {f.key === "needs" && needsCount > 0 ? (
                                        <span className="font-mono text-[10.5px] text-asking">{needsCount}</span>
                                    ) : null}
                                </button>
                            ))}
                        </div>
                    }
                >
                    {liveCount > 0 ? (
                        <ToolbarFact>
                            <span className="h-1.5 w-1.5 pulse-dot rounded-full bg-working" />
                            {liveCount} {liveCount === 1 ? "agent" : "agents"} live
                        </ToolbarFact>
                    ) : null}
                </SurfaceToolbar>

                {loadError ? (
                    <SurfaceError
                        message="Couldn’t load sessions."
                        onRetry={() => fireAndForget(loadSessionsArchive)}
                    />
                ) : null}

                <div className="flex min-h-0 flex-1">
                    {/* layoutScroll: the cards' layout animations read a cursor scroll as scroll, not as every card moving */}
                    <motion.div
                        layoutScroll
                        ref={listRef}
                        data-sessions-list=""
                        className="flex w-[380px] flex-none flex-col gap-1.5 overflow-y-auto border-r border-edge-faint p-3 pb-10"
                    >
                        <SearchHeader
                            query={query}
                            setQuery={setQuery}
                            runAgents={runAgents}
                            setRunAgents={setRunAgents}
                            summary={summary}
                            incomplete={searching && search.incomplete}
                        />
                        <button
                            type="button"
                            onClick={() => setSel("all")}
                            className={cn(
                                "flex w-full cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-[9px] text-left",
                                sel === "all"
                                    ? "border-accent bg-surface-selected"
                                    : "border-border bg-surface hover:bg-surface-hover"
                            )}
                        >
                            <Activity size={14} strokeWidth={1.8} className="flex-none text-ink-mid" aria-hidden />
                            <span className="flex-1 text-[12.5px] font-semibold text-secondary">All activity</span>
                            <span className="font-mono text-[10.5px] text-muted">
                                {totalEvents(scopedSessions)} events
                            </span>
                        </button>

                        {searching && search.error != null ? (
                            <div
                                data-sessions-search-error=""
                                className="mt-3 flex items-center gap-2 px-1 text-[12px] text-error"
                            >
                                <span className="flex-1">Search failed</span>
                                <button
                                    type="button"
                                    onClick={search.retry}
                                    className="cursor-pointer rounded-[6px] border border-border px-2 py-[3px] text-[11px] text-secondary hover:text-primary"
                                >
                                    Retry
                                </button>
                            </div>
                        ) : base == null || (searching && results == null) ? (
                            <SkeletonRows className="mt-3 min-h-0 flex-1 space-y-[7px]">
                                {(i) => <SkeletonLine key={i} className="h-[58px] rounded-[10px]" />}
                            </SkeletonRows>
                        ) : searching && groups.length === 0 ? (
                            <div
                                data-sessions-search-empty=""
                                className="mt-6 px-1 text-center text-[12.5px] text-muted"
                            >
                                No sessions match “{query.trim()}”.
                            </div>
                        ) : groups.length === 0 ? (
                            <div className="mt-6">
                                <SurfaceEmptyState
                                    title="No sessions found"
                                    body="Sessions appear here as agents run. Start one to begin."
                                    action={{
                                        label: "New agent",
                                        onClick: () => globalStore.set(model.newAgentOpenAtom, true),
                                    }}
                                />
                            </div>
                        ) : (
                            paged.map((g) => (
                                <div key={g.key} className="flex flex-col gap-1.5">
                                    <div className="flex items-center gap-2.5 px-1 pb-0.5 pt-3">
                                        <span className={cn(REGION_LABEL, "text-muted")}>{g.label}</span>
                                        <div className="h-px flex-1 bg-edge-faint" />
                                        <span className="font-mono text-[10.5px] text-muted">{g.total}</span>
                                    </div>
                                    <AnimatePresence initial={false} mode="popLayout">
                                        {g.items.map((r) =>
                                            r.run ? (
                                                <RunCard
                                                    key={r.key}
                                                    rowKey={r.key}
                                                    view={r.run.view}
                                                    active={viewRunId === r.run.group.runId}
                                                    member={member}
                                                    now={now}
                                                    match={matches?.get(r.key)}
                                                    onSelect={() => select(r.key)}
                                                    onOpen={openCard}
                                                    onHit={openHit}
                                                    onMember={(key) => selectMember(r.run!.group.runId, key)}
                                                />
                                            ) : (
                                                <SoloCard
                                                    key={r.key}
                                                    rowKey={r.key}
                                                    session={r.session!}
                                                    active={sel === r.key}
                                                    now={now}
                                                    match={matches?.get(r.key)}
                                                    onSelect={() => setSel(r.key)}
                                                    onOpen={openCard}
                                                    onHit={openHit}
                                                />
                                            )
                                        )}
                                    </AnimatePresence>
                                </div>
                            ))
                        )}
                        <div ref={listPage.sentinelRef} className="h-px flex-none" />
                        {base != null && incomplete ? (
                            <div data-sessions-loading="" className="px-1 pt-2 text-[12px] text-muted">
                                Loading older sessions…
                            </div>
                        ) : null}
                    </motion.div>

                    <div className="flex min-w-0 flex-1 flex-col px-8 py-[22px]">
                        <AnimatePresence mode="wait" initial={false}>
                            <motion.div
                                key={detailKind}
                                className="flex min-h-0 flex-1 flex-col"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                            >
                                {selRun && selMember ? (
                                    <RunDetail
                                        model={model}
                                        view={selRun.view}
                                        member={selMember}
                                        memberSession={selMemberSession}
                                        now={now}
                                    />
                                ) : selSession ? (
                                    <SoloDetail model={model} session={selSession} />
                                ) : (
                                    <MergedFeed
                                        list={scopedSessions}
                                        titles={runTitles}
                                        now={now}
                                        onOpen={openSession}
                                    />
                                )}
                            </motion.div>
                        </AnimatePresence>
                    </div>
                </div>
            </div>
        </MotionConfig>
    );
}

function RunCard({
    rowKey,
    view,
    active,
    member,
    now,
    match,
    onSelect,
    onOpen,
    onHit,
    onMember,
}: {
    rowKey: string;
    view: RunView;
    active: boolean;
    member: string;
    now: number;
    match?: CardMatch;
    onSelect: () => void;
    onOpen: (m: CardMatch) => void;
    onHit: (row: SnippetRow) => void;
    onMember: (key: string) => void;
}) {
    const rt = runtimeMeta(view.runtime);
    // a finished run reads as its age alone; its members' checks already say it landed
    const head: Status = view.head.key === "done" ? { key: "muted", text: view.head.text } : view.head;
    const elapsed = (view.live ? now : view.lastactivets) - view.startedts;
    return (
        <motion.div
            layout
            data-session-row={rowKey}
            variants={cardVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className={cn(
                "rounded-[10px] border",
                active ? "border-accent bg-surface-selected" : "border-border bg-surface hover:border-edge-strong"
            )}
        >
            <button
                type="button"
                onClick={() => (match ? onOpen(match) : onSelect())}
                className="flex w-full cursor-pointer flex-col gap-2 rounded-[10px] px-3 pb-[11px] pt-2.5 text-left"
            >
                <span className="flex w-full items-center gap-2">
                    <Workflow size={13} strokeWidth={1.8} className="flex-none text-ink-mid" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-primary">{view.title}</span>
                    <StatusMark status={head} />
                </span>
                <span className="flex w-full items-center gap-2 font-mono text-[10.5px] text-muted">
                    {view.segs.length > 0 ? (
                        <span className="flex gap-[3px]" aria-hidden="true">
                            {view.segs.map((k, i) => (
                                <span
                                    key={i}
                                    className="h-1 w-3.5 rounded-[2px]"
                                    style={{ backgroundColor: view.complete ? "var(--color-success)" : SEG_COLOR[k] }}
                                />
                            ))}
                        </span>
                    ) : null}
                    {view.complete ? (
                        <span className="flex items-center gap-[5px] text-success">
                            <Check size={11} aria-hidden className="flex-none" />
                            {view.total > 0 ? `${view.landed}/${view.total} landed` : "complete"}
                        </span>
                    ) : (
                        <span>{view.total > 0 ? `${view.landed}/${view.total} landed` : "planning"}</span>
                    )}
                    <span className="flex-1" />
                    <span className="truncate">
                        <span className={rt.text}>{rt.glyph}</span>{" "}
                        {[view.project, formatAgeShort(elapsed)].filter(Boolean).join(" · ")}
                    </span>
                </span>
            </button>
            {view.needs.length > 0 ? (
                <div
                    role="group"
                    aria-label={`Needs you in ${view.title}`}
                    className="flex flex-col gap-px border-t border-edge-faint px-1.5 pb-1.5 pt-1"
                >
                    {view.needs.map((m) => (
                        <button
                            key={m.key}
                            type="button"
                            onClick={() => onMember(m.key)}
                            className={cn(
                                "grid h-[30px] cursor-pointer grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-2 rounded-[6px] px-1.5 text-left",
                                active && member === m.key ? "bg-surface-selected" : "hover:bg-surface-hover"
                            )}
                        >
                            <span
                                className={cn(
                                    "text-center font-mono text-[10.5px]",
                                    m.key === LEAD_MEMBER ? rt.text : "text-muted"
                                )}
                            >
                                {m.key === LEAD_MEMBER ? rt.glyph : m.num}
                            </span>
                            <span className="truncate text-[12px] text-secondary">{m.label}</span>
                            <StatusMark status={m.status} />
                        </button>
                    ))}
                </div>
            ) : null}
            {match ? <SnippetRows match={match} runtime={view.runtime} onHit={onHit} /> : null}
        </motion.div>
    );
}

function SoloCard({
    rowKey,
    session,
    active,
    now,
    match,
    onSelect,
    onOpen,
    onHit,
}: {
    rowKey: string;
    session: LiveSession;
    active: boolean;
    now: number;
    match?: CardMatch;
    onSelect: () => void;
    onOpen: (m: CardMatch) => void;
    onHit: (row: SnippetRow) => void;
}) {
    const rt = runtimeMeta(session.runtime);
    return (
        <motion.div
            layout
            data-session-row={rowKey}
            variants={cardVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className={cn(
                "rounded-[10px] border",
                active ? "border-accent bg-surface-selected" : "border-border bg-surface hover:border-edge-strong"
            )}
        >
            <button
                type="button"
                onClick={() => (match ? onOpen(match) : onSelect())}
                className="flex w-full cursor-pointer flex-col gap-2 rounded-[10px] px-3 py-2.5 text-left"
            >
                <span className="flex w-full items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-primary">
                        {session.task || "(untitled session)"}
                    </span>
                    <StatusMark status={soloStatus(session, now)} />
                </span>
                <span className="flex w-full items-center gap-2 font-mono text-[10.5px] text-muted">
                    <span className={rt.text}>{rt.glyph}</span>
                    <span className="min-w-0 truncate text-secondary" title={session.projectname}>
                        {session.projectname}
                    </span>
                    <span className="min-w-0 truncate" title={session.branch || undefined}>
                        {session.branch || "—"}
                    </span>
                    <span className="flex-1" />
                    {session.tokenstotal > 0 ? (
                        <span className="flex-none whitespace-nowrap">{formatTokens(session.tokenstotal)} tok</span>
                    ) : null}
                </span>
            </button>
            {match ? <SnippetRows match={match} runtime={session.runtime} onHit={onHit} /> : null}
        </motion.div>
    );
}

function SearchHeader({
    query,
    setQuery,
    runAgents,
    setRunAgents,
    summary,
    incomplete,
}: {
    query: string;
    setQuery: (q: string) => void;
    runAgents: boolean;
    setRunAgents: (on: boolean) => void;
    summary: string;
    incomplete: boolean;
}) {
    return (
        <div className="flex flex-none flex-col gap-1.5">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-[7px] focus-within:border-accent focus-within:ring-[3px] focus-within:ring-accent/15">
                <Search size={14} strokeWidth={1.8} className="flex-none text-ink-mid" aria-hidden />
                <input
                    data-sessions-search=""
                    aria-label="Search sessions"
                    placeholder="Search what was said"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Escape" && query !== "") {
                            e.preventDefault();
                            e.stopPropagation();
                            setQuery("");
                        }
                    }}
                    className="min-w-0 flex-1 bg-transparent text-[12.5px] text-primary outline-none placeholder:text-muted"
                />
                {query !== "" ? (
                    <button
                        type="button"
                        aria-label="Clear search"
                        onClick={() => setQuery("")}
                        className="flex-none cursor-pointer font-mono text-[10.5px] text-muted hover:text-primary"
                    >
                        Esc
                    </button>
                ) : null}
            </div>
            <div className="flex items-center gap-2 px-0.5">
                <span data-sessions-search-summary="" className="font-mono text-[10.5px] text-muted">
                    {summary}
                </span>
                <span className="flex-1" />
                <button
                    type="button"
                    role="switch"
                    aria-checked={runAgents}
                    onClick={() => setRunAgents(!runAgents)}
                    className="flex cursor-pointer items-center gap-[7px] py-0.5 text-[11.5px] font-semibold text-ink-mid hover:text-primary"
                >
                    <span
                        className={cn(
                            "relative h-[15px] w-[26px] flex-none rounded-full border transition-colors",
                            runAgents ? "border-accent bg-accent/30" : "border-edge-strong bg-surface"
                        )}
                    >
                        <span
                            className={cn(
                                "absolute top-[2px] h-[9px] w-[9px] rounded-full transition-all",
                                runAgents ? "left-[13px] bg-primary" : "left-[2px] bg-muted"
                            )}
                        />
                    </span>
                    Run agents
                </button>
            </div>
            {incomplete ? (
                <div data-sessions-search-incomplete="" className="px-0.5 text-[11.5px] text-muted">
                    Results may be incomplete — still indexing
                </div>
            ) : null}
        </div>
    );
}

// a card lists this many of its hits, then a row that expands to every hit returned
const SNIPPET_ROWS = 3;

function whoClass(row: SnippetRow, runtimeText: string): string {
    if (row.who === "you") {
        return "text-ink-mid";
    }
    return row.who === "agent" || row.who === "lead" ? runtimeText : "text-muted";
}

function SnippetRows({
    match,
    runtime,
    onHit,
}: {
    match: CardMatch;
    runtime: string;
    onHit: (row: SnippetRow) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    if (match.hits.length === 0) {
        return null;
    }
    const rt = runtimeMeta(runtime);
    const rows = expanded ? match.hits : match.hits.slice(0, SNIPPET_ROWS);
    const more = match.hits.length - rows.length;
    return (
        <div
            role="group"
            aria-label="Matches in this session"
            data-session-hits=""
            className="flex flex-col gap-px border-t border-edge-faint px-1.5 pb-1.5 pt-1"
        >
            {rows.map((row) => (
                <button
                    key={row.key}
                    type="button"
                    data-session-hit={row.who}
                    onClick={() => onHit(row)}
                    className="grid cursor-pointer grid-cols-[58px_minmax(0,1fr)] items-start gap-x-2 rounded-[6px] px-2 py-1 text-left hover:bg-surface-hover"
                >
                    <span
                        title={row.who}
                        className={cn(
                            "truncate pt-px text-right font-mono text-[10.5px]",
                            row.hit.kind === "event" ? "" : whoClass(row, rt.text)
                        )}
                        style={row.hit.kind === "event" ? { color: eventColor(row.who) } : undefined}
                    >
                        {row.who}
                    </span>
                    {/* two lines, so a hit past the first line's end still shows */}
                    <span className="line-clamp-2 min-w-0 break-words text-[12px] leading-[1.45] text-secondary">
                        {snippetParts(row.hit.text, row.hit.marks).map((p, i) =>
                            p.mark ? (
                                <mark key={i} className="rounded-[3px] bg-accent/20 px-px text-primary">
                                    {p.text}
                                </mark>
                            ) : (
                                <span key={i}>{p.text}</span>
                            )
                        )}
                    </span>
                </button>
            ))}
            {more > 0 ? (
                <button
                    type="button"
                    data-session-hits-more=""
                    onClick={() => setExpanded(true)}
                    className="cursor-pointer py-[3px] pl-[74px] text-left font-mono text-[10.5px] text-muted hover:text-primary"
                >
                    {more} more {more === 1 ? "match" : "matches"}
                </button>
            ) : null}
        </div>
    );
}

function MergedFeed({
    list,
    titles,
    now,
    onOpen,
}: {
    list: LiveSession[];
    titles: Record<string, string>;
    now: number;
    onOpen: (sessionKey: string) => void;
}) {
    const feed = mergedFeed(list, (s) => sessionLabel(s, titles));
    const feedPage = usePaging(FEED_PAGE, feed.length);
    return (
        <div data-sessions-feed="" className="min-h-0 flex-1 overflow-y-auto">
            <div className="mb-1.5 flex items-center gap-2.5">
                <h2 className={cn(REGION_LABEL, "text-muted")}>All activity</h2>
                <div className="h-px flex-1 bg-edge-faint" />
                <span className="font-mono text-[10.5px] text-muted">{feed.length} events</span>
            </div>
            {feed.length === 0 ? (
                <div className="mt-8 text-center text-[13px] text-muted">No recent activity.</div>
            ) : (
                <div className="flex flex-col">
                    {pageFeed(feed, feedPage.count).map((e) => (
                        <button
                            key={e.key}
                            data-sessions-feed-row=""
                            type="button"
                            onClick={() => onOpen(e.sessionKey)}
                            className="grid cursor-pointer grid-cols-[8px_minmax(0,1fr)_auto] items-start gap-x-3.5 border-b border-edge-faint px-2 py-2.5 text-left hover:bg-surface-hover"
                        >
                            <span
                                className="mt-[7px] h-[7px] w-[7px] rounded-full"
                                style={{ backgroundColor: eventColor(e.type) }}
                            />
                            <span className="min-w-0">
                                <span className="block text-[13px] leading-[1.5] text-secondary">{e.text}</span>
                                <span className="mt-[3px] flex items-center gap-2 whitespace-nowrap font-mono text-[10.5px]">
                                    <span
                                        className="flex-none uppercase tracking-[0.06em]"
                                        style={{ color: eventColor(e.type) }}
                                    >
                                        {e.type}
                                    </span>
                                    <span className="min-w-0 truncate text-muted">{e.sessionTitle}</span>
                                </span>
                            </span>
                            <span className="pt-0.5 font-mono text-[10.5px] text-muted">
                                {now - e.ts < 60_000 ? "now" : formatAge(now - e.ts)}
                            </span>
                        </button>
                    ))}
                    <div ref={feedPage.sentinelRef} className="h-px flex-none" />
                </div>
            )}
        </div>
    );
}
