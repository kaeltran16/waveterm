// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue, useSetAtom, type PrimitiveAtom } from "jotai";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { cardVariants } from "@/app/element/motiontokens";
import { useEffect, useRef, useState } from "react";
import { AgentRow } from "./agentrow";
import type { AgentsViewModel, ChipFilter } from "./agents";
import {
    filterAgents,
    groupAgents,
    isRecentlyIdle,
    applyAgentOrder,
    computeGridLayout,
    GRID_PAGE_ROWS,
    FULLWIDTH_MAX_VIEWPORT_FRAC,
    streamableTranscriptAgents,
    matchesProjectFilter,
    mergeOrder,
    partitionBackgrounded,
    projectsFromAgents,
    providerPlanUsage,
    toggleSelection,
    type AgentVM,
    type CardRect,
    type GridLayout,
} from "./agentsviewmodel";
import { BackgroundedSection } from "./backgroundedsection";
import { channelsAtom } from "./channelsstore";
import { answeredAskORefsAcross, needsHuman } from "./jarvisderive";
import { IdleSection } from "./idlesection";
import { ensurePreviousInfo } from "./liveagents";
import { CockpitEmptyState } from "./cockpitemptystate";
import { CockpitRail } from "./cockpitrail";
import { HelpOverlay, HintsBar } from "./cockpithelp";
import { RollingCount } from "./rollingcount";
import { useCardResize } from "./usecardresize";
import { useCockpitKeyboard } from "./usecockpitkeyboard";
import { useCardStreams } from "./usecardstreams";
import { ProjectSwitcher } from "./projectswitcher";
import { mergeRateLimitWindows, savedRateLimitsAtom } from "./ratelimitstore";
import { SectionHeader } from "./sectionheader";
import { loadWindowTokens, windowTokensAtom } from "./windowtokenstore";
import { useSubagentTracking } from "./subagenttracking";
import { SurfaceHeader } from "./surfacescaffold";

// Filter-chip palette (handoff mkChip, dc.html:1945-1981): an active chip takes its status color for the
// border + a soft tint, and the count renders in that color; the label brightens to primary. Inactive
// chips keep an edge border + muted label, but the count stays brighter (secondary) so it reads at a glance.
const CHIP_ACTIVE: Record<ChipFilter, string> = {
    all: "border-accent bg-accent/[0.12]",
    asking: "border-warning bg-warning/[0.12]",
    working: "border-success bg-success/[0.12]",
    idle: "border-edge-strong bg-surface-raised",
};
const CHIP_NUM: Record<ChipFilter, string> = {
    all: "text-accent-soft",
    asking: "text-warning",
    working: "text-success",
    idle: "text-secondary",
};

// Bridges a model PrimitiveAtom to a useState-shaped [value, setter] pair so the lifted orchestration
// state reads/writes through the model while the existing call sites (incl. functional updaters) work.
function useModelAtom<T>(a: PrimitiveAtom<T>): [T, (v: T | ((p: T) => T)) => void] {
    const value = useAtomValue(a);
    const set = (v: T | ((p: T) => T)) =>
        globalStore.set(a, typeof v === "function" ? (v as (p: T) => T)(globalStore.get(a)) : v);
    return [value, set];
}

export function CockpitSurface({ model }: { model: AgentsViewModel }) {
    const agents = useAtomValue(model.agentsAtom);
    useSubagentTracking(agents);
    const { asking, working, idle } = groupAgents(agents);

    // channel-aware "needs you": excludes asks Jarvis already auto-answered, so it matches the Channels
    // rail dot and nav badge (raw asking historically over-counted). one answered set feeds both the
    // header counter and the sticky-bar counter (liveAsking) below.
    const channels = useAtomValue(channelsAtom);
    const answeredAsks = answeredAskORefsAcross(channels ?? []);
    const needsYou = agents.filter((a) => needsHuman(a, answeredAsks)).length;

    // `now` feeds structural computations below (usage-window rollover, the idle-grace window, and which
    // transcripts stay streamed). Read it NON-reactively: subscribing would re-render the whole surface
    // (and its agent grid) every second. The 1s writer stays (below); the live "age/quiet" cues that need
    // per-second precision now live in self-subscribing leaves (QuietDot, RecentActivityRail, CockpitRail).
    // These structural values tolerate <=1s staleness and refresh on the next real re-render (agent status,
    // prefs, cursor, etc.).
    const now = globalStore.get(model.nowAtom);
    // Rate-limit windows are account-scoped, not per-agent: collapse every agent's live reading to one
    // block per provider (last live wins), merged over the saved snapshot so it survives idle — the
    // same aggregation the full Usage surface uses.
    const savedRateLimits = useAtomValue(savedRateLimitsAtom);
    const usageDonuts = mergeRateLimitWindows(providerPlanUsage([...asking, ...working, ...idle]), savedRateLimits, now);
    const windowTokens = useAtomValue(windowTokensAtom);
    const claudeDonut = usageDonuts.find((d) => d.provider === "claude");
    useEffect(() => {
        const t = setInterval(() => globalStore.set(model.nowAtom, Date.now()), 1000);
        return () => clearInterval(t);
    }, []);
    useEffect(() => {
        if (claudeDonut == null) {
            return;
        }
        fireAndForget(() => loadWindowTokens(claudeDonut.fivehour.reset, claudeDonut.week.reset));
    }, [claudeDonut?.fivehour.reset, claudeDonut?.week.reset]);

    // A just-finished agent keeps its full row (so you can reply) for the grace window, then collapses
    // into the Idle list. Dismissals are keyed by idle episode (id:idleSince).
    const [dismissed, setDismissed] = useModelAtom(model.dismissedAtom);
    const dismissKey = (a: AgentVM) => `${a.id}:${a.idleSince ?? ""}`;
    const [backgroundedIds, setBackgroundedIds] = useModelAtom(model.backgroundedIdsAtom);
    const recentlyIdle = idle.filter((a) => isRecentlyIdle(a, now) && !dismissed.has(dismissKey(a)));
    const recentIds = new Set(recentlyIdle.map((a) => a.id));
    const parkedIdle = idle.filter((a) => !recentIds.has(a.id));
    // one unified list: asks stay in place alongside active working + just-finished (grace) rows,
    // minus anything backgrounded. Asking agents are never backgrounded (the effect below un-mutes any
    // that start asking), so they always land in `active` and hold whatever slot they already had.
    const { active: activeAgents, backgrounded } = partitionBackgrounded(
        [...asking, ...working, ...recentlyIdle],
        backgroundedIds
    );

    // one-shot previous-info for asking agents (seeds first paint; the live stream supersedes it)
    useEffect(() => {
        for (const a of asking) {
            if (a.transcriptPath) {
                void ensurePreviousInfo(a.id, a.transcriptPath, a.agent);
            }
        }
    }, [asking]);

    // open a live transcript stream + git tracking per rendered active agent; keep recently-idle
    // streams during the grace window so final transcript writes cannot race the stop event.
    useCardStreams(
        streamableTranscriptAgents([...asking, ...working, ...recentlyIdle], now)
            .filter((a) => a.transcriptPath)
            .map((a) => ({ id: a.id, path: a.transcriptPath!, agent: a.agent, blockId: a.blockId })),
        { trackGit: true },
    );

    // anchored order (kept ids hold their slot; new ids append) + manual drag reorder. This is what
    // stops a working->asking transition from jumping: the id already holds a slot, so it stays put.
    const [order, setOrder] = useModelAtom(model.orderAtom);
    useEffect(() => {
        const ids = activeAgents.map((a) => a.id);
        setOrder((prev) => mergeOrder(prev, ids));
    }, [activeAgents.map((a) => a.id).join(",")]);
    const orderedAgents = applyAgentOrder(order, activeAgents);
    const orderedIds = orderedAgents.map((a) => a.id);
    // cursor traverses the single unified list
    const navigableIds = orderedIds;

    // cursor + answer selection (lifted onto the model); help/pulse stay ephemeral surface-local
    const [cursorId, setCursorId] = useModelAtom(model.cursorIdAtom);
    const [answerSel, setAnswerSel] = useModelAtom(model.answerSelAtom);
    const answerText = useAtomValue(model.answerTextAtom);
    const [answerTab, setAnswerTab] = useModelAtom(model.answerTabAtom);
    const [cardPrefs, setCardPrefs] = useModelAtom(model.cardPrefsAtom);
    const openComposerId = useAtomValue(model.openComposerIdAtom);
    const setOpenComposerId = useSetAtom(model.openComposerIdAtom);
    const sentIds = useAtomValue(model.sentIdsAtom);
    const chip = useAtomValue(model.chipFilterAtom);
    const setChip = (c: ChipFilter) => globalStore.set(model.chipFilterAtom, c);

    const [showHelp, setShowHelp] = useState(false);
    const [pulseId, setPulseId] = useState<string>();
    const lastJumpRef = useRef<string>(undefined);
    const containerRef = useRef<HTMLDivElement>(null);
    const gridScrollRef = useRef<HTMLDivElement>(null);
    const [gridViewportPx, setGridViewportPx] = useState(0);
    const [gridViewportW, setGridViewportW] = useState(0);
    useEffect(() => {
        const el = gridScrollRef.current;
        if (!el) {
            return;
        }
        // fill against the content box (clientHeight/Width include padding — sizing to the full client
        // box overflows by exactly that padding and shows a spurious scrollbar)
        const measure = () => {
            const cs = getComputedStyle(el);
            setGridViewportPx(el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
            setGridViewportW(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
        };
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        measure();
        return () => ro.disconnect();
    }, []);

    // status chips narrow what the grid renders; cursor/order still operate over the full set
    const projectFilter = useAtomValue(model.projectFilterAtom);
    const liveOnly = useAtomValue(model.liveOnlyAtom);
    // project scope + live-only first; the chip narrows what the grid renders (counts ignore the chip)
    const visibleOrdered = filterAgents(orderedAgents, projectFilter, liveOnly);
    const shownAgents = chip === "all" ? visibleOrdered : visibleOrdered.filter((a) => a.state === chip);
    // full-width cards float to a top stack; the rest fill two independent columns below. One pure pass
    // computes every card's absolute rect (px) + the column partition the resize handlers read.
    const layout: GridLayout = computeGridLayout(shownAgents, cardPrefs, gridViewportW, gridViewportPx);
    const { rects, totalHeight, columnsAvail, colA, colB } = layout;
    const pageRowPx = gridViewportPx / GRID_PAGE_ROWS;
    const fwMaxPx = FULLWIDTH_MAX_VIEWPORT_FRAC * gridViewportPx;

    const { isResizing, activeResizeId, getGeom, beginCardResize, dragResizeMove, endCardResize } =
        useCardResize({ rects, cardPrefs, setCardPrefs, colA, colB, columnsAvail, pageRowPx, fwMaxPx, gridViewportW });
    const liveCount = visibleOrdered.length;
    const liveAsking = visibleOrdered.filter((a) => needsHuman(a, answeredAsks)).length;
    const liveWorking = visibleOrdered.filter((a) => a.state === "working").length;
    const projectCount = projectsFromAgents(agents).length;
    // idle/backgrounded sections share the project scope; live-only hides the parked-idle section
    const shownParkedIdle = liveOnly ? [] : parkedIdle.filter((a) => matchesProjectFilter(a, projectFilter));
    const shownBackgrounded = backgrounded.filter((a) => matchesProjectFilter(a, projectFilter));

    // keep the cursor valid as the set changes; seed it to the first row
    useEffect(() => {
        if (navigableIds.length === 0) {
            if (cursorId != null) setCursorId(undefined);
            return;
        }
        if (cursorId == null || !navigableIds.includes(cursorId)) {
            setCursorId(navigableIds[0]);
        }
    }, [navigableIds.join(",")]);

    // asking overrides backgrounded: a muted agent that starts asking re-surfaces (it's in `asking`,
    // not `working`), so drop it from the set to avoid re-muting when it returns to working.
    useEffect(() => {
        const askingSet = new Set(asking.map((a) => a.id));
        setBackgroundedIds((prev) => {
            let changed = false;
            const next = new Set(prev);
            for (const id of prev) {
                if (askingSet.has(id)) {
                    next.delete(id);
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [asking.map((a) => a.id).join(",")]);

    const scrollToPulse = (id: string) => {
        document.querySelector(`[data-agent-id="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        setPulseId(id);
        setTimeout(() => setPulseId((p) => (p === id ? undefined : p)), 1200);
    };

    const focusRowComposer = (id: string) => {
        (document.querySelector(`[data-agent-id="${id}"] textarea`) as HTMLTextAreaElement)?.focus();
    };

    const toggleAnswer = (id: string, qi: number, oi: number) => {
        const a = agents.find((x) => x.id === id);
        const multi = a?.ask?.questions?.[qi]?.multiSelect ?? false;
        setAnswerSel((prev) => ({ ...prev, [id]: toggleSelection(prev[id] ?? {}, qi, oi, multi) }));
        model.setAnswerText(id, qi, ""); // selecting an option clears this question's free text (exclusive)
    };

    const submitAnswer = (id: string) => model.submitAnswer(id);

    const selectQuestion = (id: string, qi: number) => setAnswerTab((prev) => ({ ...prev, [id]: qi }));

    const toggleBackground = (id: string) => {
        setBackgroundedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    };

    // open the agent in the Agent surface: clear any open terminal, set focus, switch surface
    const openFocus = (id: string, reply: boolean) => {
        globalStore.set(model.terminalTargetAtom, undefined);
        globalStore.set(model.focusIdAtom, id);
        globalStore.set(model.focusReplyAtom, reply);
        globalStore.set(model.surfaceAtom, "agent");
    };

    // open this agent's changed files in the Diff surface (which scopes to focusIdAtom)
    const openDiff = (id: string) => {
        globalStore.set(model.focusIdAtom, id);
        globalStore.set(model.surfaceAtom, "files");
    };

    const onKeyDown = useCockpitKeyboard({
        model, orderedAgents, navigableIds, cursorId, setCursorId, answerTab, answerSel, asking,
        lastJumpRef, setOpenComposerId, showHelp, setShowHelp,
        selectQuestion, toggleAnswer, submitAnswer, toggleBackground, openFocus, scrollToPulse, focusRowComposer,
    });

    // one AgentRow with every callback wired — shared by all cards in the single absolute tree
    const renderCard = (a: AgentVM, rect: CardRect) => {
        const g = getGeom(a.id, rect);
        // keep the bound values tracking the computed layout when not dragging; during a drag the
        // resize handlers own h/y for the affected column, so leave them alone
        if (!isResizing) {
            g.x.set(rect.x);
            g.y.set(rect.y);
            g.w.set(rect.w);
            g.h.set(rect.h);
        }
        return (
            <AgentRow
                key={a.id}
                agent={a}
                nowAtom={model.nowAtom}
                rect={rect}
                xMV={g.x}
                yMV={g.y}
                wMV={g.w}
                hMV={g.h}
                fullWidth={!!cardPrefs[a.id]?.fullWidth}
                elevated={activeResizeId === a.id}
                isCursor={cursorId === a.id}
                pulse={pulseId === a.id}
                selections={answerSel[a.id] ?? {}}
                texts={answerText[a.id] ?? {}}
                sent={sentIds.has(a.id)}
                activeQuestion={answerTab[a.id] ?? 0}
                composerOpen={openComposerId === a.id}
                onCursor={() => setCursorId(a.id)}
                onOpen={() => openFocus(a.id, false)}
                onOpenTerminal={() => model.openTerminal(a.id)}
                onOpenDiff={() => openDiff(a.id)}
                onOpenComposer={() => setOpenComposerId(a.id)}
                onToggleAnswer={(qi, oi) => toggleAnswer(a.id, qi, oi)}
                onAnswerText={(qi, value) => model.setAnswerText(a.id, qi, value)}
                onSubmitAnswer={() => submitAnswer(a.id)}
                onSelectQuestion={(qi) => selectQuestion(a.id, qi)}
                onComposerEscape={() => {
                    setOpenComposerId(undefined);
                    containerRef.current?.focus();
                }}
                onBackground={a.state === "working" || a.state === "asking" ? () => toggleBackground(a.id) : undefined}
                onDismiss={a.state === "idle" ? () => setDismissed((prev) => new Set(prev).add(dismissKey(a))) : undefined}
                onResizeStart={() => beginCardResize(a.id)}
                onResizeMove={(dx, dy) => dragResizeMove(a.id, dx, dy)}
                onResizeEnd={(full) => endCardResize(a.id, full)}
                onToggleFullWidth={() =>
                    setCardPrefs((p) => ({ ...p, [a.id]: { ...p[a.id], fullWidth: !p[a.id]?.fullWidth } }))
                }
            />
        );
    };

    const empty = asking.length === 0 && working.length === 0 && idle.length === 0;

    return (
        <MotionConfig reducedMotion="user">
        <div
            ref={containerRef}
            tabIndex={0}
            onKeyDown={onKeyDown}
            className="relative flex h-full w-full text-secondary outline-none"
        >
            <div className="flex min-w-0 flex-1 flex-col bg-background">
                <div className="sticky top-0 z-[5] shrink-0 border-b border-border bg-background px-[30px] pb-3 pt-4">
                    <div className="mb-3 -mx-[30px] -mt-4">
                        <SurfaceHeader
                            border={false}
                            title="Cockpit"
                            subtitle={
                                <>
                                    {agents.length} agents · {projectCount} projects ·{" "}
                                    <span className="font-semibold text-warning">
                                        <RollingCount value={needsYou} /> need you
                                    </span>
                                </>
                            }
                            actions={
                                <>
                                    <ProjectSwitcher model={model} variant="header" />
                                    <button
                                        type="button"
                                        onClick={() => globalStore.set(model.liveOnlyAtom, !liveOnly)}
                                        className={cn(
                                            "flex cursor-pointer items-center gap-[7px] rounded border px-2.5 py-1.5 text-[12px] font-medium",
                                            liveOnly
                                                ? "border-success/60 bg-success/10 text-success"
                                                : "border-edge-mid bg-surface-raised text-muted-foreground hover:border-edge-strong"
                                        )}
                                    >
                                        <span className="h-1.5 w-1.5 rounded-full bg-success" />
                                        Live only
                                    </button>
                                    {Object.values(cardPrefs).some((p) => p.fullWidth || p.heightWeight != null) ? (
                                        <button
                                            type="button"
                                            onClick={() => setCardPrefs({})}
                                            className="cursor-pointer rounded border border-edge-mid px-2.5 py-1.5 text-[12px] text-muted hover:border-edge-strong"
                                        >
                                            Reset layout
                                        </button>
                                    ) : null}
                                </>
                            }
                        />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        {(
                            [
                                ["all", "All", agents.length],
                                ["asking", "Asking", asking.length],
                                ["working", "Working", working.length],
                                ["idle", "Idle", idle.length],
                            ] as [ChipFilter, string, number][]
                        ).map(([key, label, count]) => (
                            <button
                                key={key}
                                type="button"
                                onClick={() => setChip(key)}
                                className={cn(
                                    "grid cursor-pointer grid-cols-[minmax(0,auto)_1.25rem] items-center rounded border px-3 py-1.5 text-[12.5px]",
                                    chip === key
                                        ? cn(CHIP_ACTIVE[key], "text-primary")
                                        : "border-border text-muted hover:border-edge-mid"
                                )}
                            >
                                <span className="leading-none">{label}</span>
                                <RollingCount
                                    value={count}
                                    className={cn(
                                        "justify-self-end text-center font-mono text-[11px] font-semibold leading-none",
                                        chip === key ? CHIP_NUM[key] : "text-secondary"
                                    )}
                                />
                            </button>
                        ))}
                    </div>
                </div>

                <div className="relative flex min-h-0 flex-1 flex-col">
                    <AnimatePresence initial={false}>
                        {empty ? (
                            <CockpitEmptyState
                                key="empty"
                                onNewAgent={() => globalStore.set(model.newAgentOpenAtom, true)}
                            />
                        ) : null}
                    </AnimatePresence>

                    <AnimatePresence initial={false}>
                        {liveCount > 0 ? (
                            <motion.div
                                key="live-header"
                                variants={cardVariants}
                                initial="initial"
                                animate="animate"
                                exit="exit"
                                className="shrink-0 px-5 pt-4"
                            >
                                <SectionHeader
                                    label="Live agents"
                                    labelClassName="text-accent-soft"
                                    count={liveCount}
                                    dotClassName="bg-accent-soft"
                                    countPillClassName="bg-accent/10 text-accent-soft"
                                    dividerClassName="bg-gradient-to-r from-accent/20 to-transparent"
                                    right={
                                        <span className="text-[11.5px] text-muted">
                                            <span className="font-semibold text-warning">
                                                <RollingCount value={liveAsking} /> need you
                                            </span>{" "}
                                            ·{" "}
                                            {liveWorking} working
                                        </span>
                                    }
                                />
                            </motion.div>
                        ) : null}
                    </AnimatePresence>

                    <div ref={gridScrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-2.5">
                        {/* one absolute canvas; every card is a sibling in one AnimatePresence, positioned
                            by its spring-driven rect. A move retargets springs (no remount, no crossfade);
                            only genuine add/remove runs the opacity+scale variants. */}
                        <div style={{ position: "relative", height: totalHeight }}>
                            <AnimatePresence initial={false}>
                                {shownAgents.map((a) => {
                                    const rect = rects.get(a.id);
                                    return rect ? renderCard(a, rect) : null;
                                })}
                            </AnimatePresence>
                        </div>
                    </div>

                    <div className="shrink-0 px-[18px]">
                        <BackgroundedSection agents={shownBackgrounded} onRestore={(id) => toggleBackground(id)} />
                        <IdleSection agents={shownParkedIdle} onOpen={(id) => model.openTerminal(id)} />
                    </div>
                </div>

                {!empty ? <HintsBar onOpenHelp={() => setShowHelp(true)} /> : null}
            </div>

            <CockpitRail model={model} usageDonuts={usageDonuts} windowTokens={windowTokens} agents={agents} />
            {showHelp ? <HelpOverlay onClose={() => setShowHelp(false)} /> : null}
        </div>
        </MotionConfig>
    );
}

