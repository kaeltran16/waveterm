// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { atom, useAtomValue, useSetAtom, type PrimitiveAtom } from "jotai";
import { AnimatePresence, MotionConfig } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildCockpitBindings } from "@/app/store/keybindings/bindings";
import { useKeybindings } from "@/app/store/keybindings/store";
import { cheatsheetOpenAtom } from "@/app/cockpit/shortcuts-cheatsheet";
import { AgentRow } from "./agentrow";
import type { AgentsViewModel, ChipFilter } from "./agents";
import {
    askSentKey,
    filterAgents,
    groupAgents,
    applyAgentOrder,
    streamableTranscriptAgents,
    matchesProjectFilter,
    mergeOrder,
    partitionBackgrounded,
    projectsFromAgents,
    providerPlanUsage,
    type AgentVM,
} from "./agentsviewmodel";
import {
    buildGridCards,
    cardMatchesChip,
    cardShare,
    columnNavIds,
    isBackgroundedRun,
    resolveCursor,
    splitGridColumns,
    toggleChip,
    withActiveRunLeads,
    type CardShare,
    type GridCard,
    type RowTarget,
} from "./cardgridlayout";
import { dismissKey, isCockpitEmpty, splitRecentlyIdle, toggleInSet } from "./cockpitsurfacemodel";
import { BackgroundAgentsStrip } from "./backgroundagentsstrip";
import { BackgroundedSection } from "./backgroundedsection";
import { channelsAtom } from "./channelsstore";
import { filterByFocus, focusBannerText } from "./focusscope";
import { activeFocusAtom, focusRevealAtom, focusScopeAtom } from "./focusstore";
import { FocusBanner } from "./focusbanner";
import { answeredAskORefsAcross, needsHuman } from "./jarvisderive";
import { IdleSection } from "./idlesection";
import { LeadCard } from "./leadcard";
import { rowAction } from "./leadcardactions";
import { buildLeadCard, isLeadDown, rowKeyActions, stopSelector, type LeadCardVM } from "./leadcardmodel";
import { ensurePreviousInfo } from "./liveagents";
import { CockpitEmptyState } from "./cockpitemptystate";
import { CockpitRail } from "./cockpitrail";
import { useRailTracking } from "./cockpiteventsrail";
import { HintsBar } from "./cockpithelp";
import { RollingCount } from "./rollingcount";
import { ensureRunEvents, runEventsAtom } from "./runeventstore";
import { loadRunTokens, runTokensAtom } from "./runtokenstore";
import { useRunDigests } from "./runlineagestore";
import { useCockpitKeyboard } from "./usecockpitkeyboard";
import { useCardStreams } from "./usecardstreams";
import { ProjectSwitcher } from "./projectswitcher";
import { mergeRateLimitWindows, savedRateLimitsAtom } from "./ratelimitstore";
import { loadWindowTokens, windowTokensAtom } from "./windowtokenstore";
import { useSubagentTracking } from "./subagenttracking";
import { SurfaceHeader } from "./surfacescaffold";
import { UsageMeters } from "./usagemeters";

// Status tabs (mockup A3): a tab's count takes its status color while it has any, the selected tab underlines
const TAB_TONE: Record<ChipFilter, { text: string; line: string }> = {
    asking: { text: "text-warning", line: "border-warning" },
    working: { text: "text-accent", line: "border-accent" },
    idle: { text: "text-accent-soft", line: "border-accent-soft" },
    all: { text: "text-primary", line: "border-primary" },
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
    // header counter and the need-you tab (liveAsking) below.
    const channels = useAtomValue(channelsAtom);
    const answeredAsks = answeredAskORefsAcross(channels ?? []);
    const needsYou = agents.filter((a) => needsHuman(a, answeredAsks)).length;

    // `structuralNow` feeds structural computations below (usage-window rollover, the idle-grace window,
    // and which transcripts stay streamed). Subscribe to the coarse (~15s) structural clock REACTIVELY —
    // coarse enough to avoid the per-second grid reconcile, but reactive so these decisions still roll
    // over on their own in a quiescent fleet (no chunk/status churn to piggyback on). The live "age/quiet"
    // cues that need per-second precision live in self-subscribing leaves (QuietDot, CockpitEventsRail,
    // CockpitRail), which read the 1s `nowAtom` directly.
    const structuralNow = useAtomValue(model.structuralNowAtom);
    // Rate-limit windows are account-scoped, not per-agent: collapse every agent's live reading to one
    // block per provider (last live wins), merged over the saved snapshot so it survives idle — the
    // same aggregation the full Usage surface uses.
    const savedRateLimits = useAtomValue(savedRateLimitsAtom);
    const usageDonuts = mergeRateLimitWindows(
        providerPlanUsage([...asking, ...working, ...idle]),
        savedRateLimits,
        structuralNow
    );
    const windowTokens = useAtomValue(windowTokensAtom);
    const claudeDonut = usageDonuts.find((d) => d.provider === "claude");
    // The 1s now-clock is driven by a single always-mounted NowTicker (cockpit root); the leaf
    // indicators (QuietDot, CockpitEventsRail, CockpitRail) self-subscribe to `nowAtom` directly.
    // 15s writer: coarse enough that re-rendering CockpitSurface on it is cheap, frequent enough that
    // idle-grace collapse / stream teardown / usage rollover can't lag a quiescent fleet indefinitely.
    useEffect(() => {
        const t = setInterval(() => globalStore.set(model.structuralNowAtom, Date.now()), 15000);
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
    const [backgroundedIds, setBackgroundedIds] = useModelAtom(model.backgroundedIdsAtom);
    const { recently: recentlyIdle, parked: parkedIdle } = splitRecentlyIdle(idle, structuralNow, dismissed);
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
        streamableTranscriptAgents([...asking, ...working, ...recentlyIdle], structuralNow)
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

    // cursor + answer selection (lifted onto the model); help/pulse stay ephemeral surface-local
    const [cursorId, setCursorId] = useModelAtom(model.cursorIdAtom);
    const [answerSel] = useModelAtom(model.answerSelAtom);
    const answerText = useAtomValue(model.answerTextAtom);
    const [answerTab, setAnswerTab] = useModelAtom(model.answerTabAtom);
    const openComposerId = useAtomValue(model.openComposerIdAtom);
    const setOpenComposerId = useSetAtom(model.openComposerIdAtom);
    const sentIds = useAtomValue(model.sentIdsAtom);
    const chip = useAtomValue(model.chipFilterAtom);
    const setChip = (c: ChipFilter) => globalStore.set(model.chipFilterAtom, c);

    const [pulseId, setPulseId] = useState<string>();
    const lastJumpRef = useRef<string>(undefined);
    const containerRef = useRef<HTMLDivElement>(null);
    const gridScrollRef = useRef<HTMLDivElement>(null);
    const [gridViewportPx, setGridViewportPx] = useState(0);
    useEffect(() => {
        const el = gridScrollRef.current;
        if (!el) {
            return;
        }
        // fill against the content box (clientHeight includes padding — sizing to the full client
        // box overflows by exactly that padding and shows a spurious scrollbar)
        const measure = () => {
            const cs = getComputedStyle(el);
            setGridViewportPx(el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
        };
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        measure();
        return () => ro.disconnect();
    }, []);

    // status chips narrow what the grid renders; cursor/order still operate over the full set
    const projectFilter = useAtomValue(model.projectFilterAtom);
    const liveOnly = useAtomValue(model.liveOnlyAtom);
    const spaceScope = useAtomValue(focusScopeAtom);
    const activeSpace = useAtomValue(activeFocusAtom);
    const agentRevealed = useAtomValue(focusRevealAtom).has("agent");
    // project + live-only first (global/needs-you counts read the unfiltered set — see needsYou above),
    // then the Space lens. hidden = rows the Space filter removed (drives the banner's count).
    const projectScoped = filterAgents(orderedAgents, projectFilter, liveOnly);
    const visibleOrdered = filterByFocus(projectScoped, spaceScope, agentRevealed);
    const spaceHidden = projectScoped.length - visibleOrdered.length;
    // run events feed lead-down, review findings and the Events rail; digests feed lanes and question owners
    const lineage = useAtomValue(model.lineageAtom);
    const runsInView = Object.values(lineage.runs);
    useRunDigests(runsInView);
    const runKey = runsInView.map((r) => `${r.runId}:${r.channelId}`).join(",");
    useEffect(() => {
        runsInView.filter((r) => r.channelId).forEach((r) => ensureRunEvents(r.runId, r.channelId));
    }, [runKey]);
    const runEventsAtomForView = useMemo(
        () => atom((get) => Object.fromEntries(runsInView.map((r) => [r.runId, get(runEventsAtom(r.runId))]))),
        [runKey]
    );
    const runEvents = useAtomValue(runEventsAtomForView) as Record<string, RunEvent[]>;
    useRailTracking(agents, lineage);
    const runTokens = useAtomValue(runTokensAtom);
    useEffect(() => {
        runsInView.forEach((r) => fireAndForget(() => loadRunTokens(r, Date.now())));
    }, [runKey, structuralNow]);

    // one card per plain agent or run; a run's workers are rows of its card. A running run keeps its card while
    // its lead idles between wakes, so its lead is looked up in scope before parking and Live only.
    const runScope = filterByFocus(filterAgents(agents, projectFilter, false), spaceScope, agentRevealed);
    const allCards = buildGridCards(withActiveRunLeads(visibleOrdered, runScope, lineage), lineage, agents);
    const leadVMs = new Map<string, LeadCardVM & { down: boolean }>();
    for (const c of allCards) {
        if (c.kind === "run") {
            const down = isLeadDown(runEvents[c.run.runId] ?? []);
            leadVMs.set(c.id, {
                ...buildLeadCard({
                    cardId: c.id,
                    run: c.run,
                    lead: c.lead,
                    roster: agents,
                    lineage,
                    leadDown: down,
                    now: structuralNow,
                    tokens: runTokens[c.run.runId],
                }),
                down,
            });
        }
    }
    const cardNeedsYou = (c: GridCard) =>
        c.kind === "agent" ? needsHuman(c.agent, answeredAsks) : leadVMs.get(c.id)!.needsYou;
    const shownCards = allCards.filter((c) => !isBackgroundedRun(c, backgroundedIds, cardNeedsYou(c)));
    const cards = shownCards.filter((c) => cardMatchesChip(c, chip, cardNeedsYou(c)));
    // counted by card, as the tab filters: a run's idle workers and a lead between wakes are not up for review
    const readyCount = shownCards.filter((c) => cardMatchesChip(c, "idle", cardNeedsYou(c))).length;
    const columns = splitGridColumns(cards, (c) => c.kind === "run");
    // cursor stops: cards, and each lead card's shown task rows; a worker's id aliases to its row
    const rowsOf = (c: GridCard) => {
        const vm = c.kind === "run" ? leadVMs.get(c.id) : undefined;
        return vm ? [...vm.rows, ...vm.waiting, ...vm.done] : [];
    };
    const navCols = columnNavIds(columns, (c) => rowsOf(c).map((r) => r.key));
    const navigableIds = navCols.flat();
    const rowTargets: Record<string, RowTarget> = {};
    const cursorAlias: Record<string, string> = {};
    const askTargets: string[] = [];
    for (const c of columns.flat()) {
        if (c.kind === "agent" ? c.agent.state === "asking" : c.lead?.state === "asking") {
            askTargets.push(c.id);
        }
        for (const r of rowsOf(c)) {
            const run = c.kind === "run" ? c.run : undefined;
            rowTargets[r.key] = {
                openId: r.openId,
                askAgentId: r.inline === "ask" ? r.worker?.id : undefined,
                actions: rowKeyActions(r).map((a) => () => run && fireAndForget(() => rowAction(run, r, a))),
            };
            if (r.worker) {
                cursorAlias[r.worker.id] = r.key;
            }
            if (r.needsYou) {
                askTargets.push(r.key);
            }
        }
    }
    const liveCount = visibleOrdered.length;
    const liveAsking = visibleOrdered.filter((a) => needsHuman(a, answeredAsks)).length;
    const liveWorking = visibleOrdered.filter((a) => a.state === "working").length;
    const projectCount = projectsFromAgents(agents).length;
    // idle/backgrounded sections share the project scope; live-only hides the parked-idle section
    const shownParkedIdle = liveOnly ? [] : parkedIdle.filter((a) => matchesProjectFilter(a, projectFilter));
    const shownBackgrounded = backgrounded.filter((a) => matchesProjectFilter(a, projectFilter));
    // an Events row names where a plain agent now sits when it is off the grid
    const railTags: Record<string, string> = {
        ...Object.fromEntries(parkedIdle.map((a) => [a.id, "idle"])),
        ...Object.fromEntries(backgrounded.map((a) => [a.id, "background"])),
    };

    // keep the cursor on a visible stop as the set changes; a worker's id follows its row, else the first stop
    useEffect(() => {
        const next = resolveCursor(cursorId, navigableIds, cursorAlias);
        if (next !== cursorId) {
            setCursorId(next);
        }
    }, [navigableIds.join(","), cursorId]);

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

    // a moved cursor scrolls its stop into view, a task row inside its card too; a jump (n, the rail) centers
    // its own target, so the follow-up here leaves that one alone
    const jumpedRef = useRef<string>(undefined);
    useEffect(() => {
        if (jumpedRef.current === cursorId) {
            jumpedRef.current = undefined;
            return;
        }
        if (cursorId == null) {
            return;
        }
        document.querySelector(stopSelector(cursorId))?.scrollIntoView({ block: "nearest" });
    }, [cursorId]);

    const scrollToPulse = (id: string) => {
        jumpedRef.current = id;
        document.querySelector(stopSelector(id))?.scrollIntoView({ behavior: "smooth", block: "center" });
        setPulseId(id);
        setTimeout(() => setPulseId((p) => (p === id ? undefined : p)), 1200);
    };

    const focusRowComposer = (id: string) => {
        (document.querySelector(`[data-agent-id="${id}"] textarea`) as HTMLTextAreaElement)?.focus();
    };

    const toggleAnswer = (id: string, qi: number, oi: number) => model.toggleAnswer(id, qi, oi);

    const submitAnswer = (id: string) => model.submitAnswer(id);

    const selectQuestion = (id: string, qi: number) => setAnswerTab((prev) => ({ ...prev, [id]: qi }));

    const toggleBackground = (id: string) => {
        setBackgroundedIds((prev) => toggleInSet(prev, id));
    };

    // open the agent in the Agent surface: set focus, switch surface
    const openFocus = (id: string, reply: boolean) => {
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
        model, navigableIds, cursorId, setCursorId, answerTab, answerSel,
        navCols, rowTargets, askTargets, roster: agents, lastJumpRef, setOpenComposerId,
        selectQuestion, toggleAnswer, submitAnswer, toggleBackground, openFocus, scrollToPulse, focusRowComposer,
    });

    // Cockpit triage keys are documented in the shared cheat sheet via these pass-through bindings (see
    // buildCockpitBindings); onKeyDown above still performs them. One help surface, one key registry.
    const cockpitBindings = useMemo(() => buildCockpitBindings(), []);
    useKeybindings(cockpitBindings);

    // one AgentRow with every callback wired
    const renderAgent = (a: AgentVM, share: CardShare) => (
        <AgentRow
            key={a.id}
            agent={a}
            nowAtom={model.nowAtom}
            share={share}
            isCursor={cursorId === a.id}
            pulse={pulseId === a.id}
            selections={answerSel[a.id] ?? {}}
            texts={answerText[a.id] ?? {}}
            sent={sentIds.has(askSentKey(a) ?? "")}
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
        />
    );

    const renderCard = (c: GridCard) => {
        const share = cardShare(c.kind === "run", cardNeedsYou(c));
        if (c.kind === "agent") {
            return renderAgent(c.agent, share);
        }
        const vm = leadVMs.get(c.id)!;
        return (
            <LeadCard
                key={c.id}
                model={model}
                cardId={c.id}
                run={c.run}
                lead={c.lead}
                vm={vm}
                events={runEvents[c.run.runId] ?? []}
                leadDown={vm.down}
                share={share}
                isCursor={cursorId === c.id}
                cursorKey={cursorId}
                pulse={pulseId === c.id}
                composerOpen={c.lead != null && openComposerId === c.lead.id}
                onComposerEscape={() => {
                    setOpenComposerId(undefined);
                    containerRef.current?.focus();
                }}
                onCursor={(key) => setCursorId(key)}
                onOpen={(id) => openFocus(id, false)}
                onOpenDiff={openDiff}
                onBackground={c.lead && c.lead.state !== "asking" ? () => toggleBackground(c.lead!.id) : undefined}
            />
        );
    };

    const empty = isCockpitEmpty(asking, working, idle);

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
                                    <UsageMeters
                                        donuts={usageDonuts}
                                        windowTokens={windowTokens}
                                        now={structuralNow}
                                        onOpen={() => globalStore.set(model.surfaceAtom, "usage")}
                                    />
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
                                </>
                            }
                        />
                    </div>
                    {activeSpace != null ? (
                        <FocusBanner
                            surface="agent"
                            text={focusBannerText(activeSpace.label, spaceHidden, agentRevealed)}
                            revealed={agentRevealed}
                        />
                    ) : null}
                    <div className="-mb-3 -ml-1 mt-1 flex flex-wrap gap-0.5">
                        {(
                            [
                                ["asking", "need you", liveAsking],
                                ["working", "working", liveWorking],
                                ["idle", "ready for review", readyCount],
                                ["all", "live", liveCount],
                            ] as [ChipFilter, string, number][]
                        ).map(([key, label, count]) => (
                            <button
                                key={key}
                                type="button"
                                onClick={() => setChip(toggleChip(chip, key))}
                                className={cn(
                                    "flex cursor-pointer items-baseline gap-[7px] border-0 border-b-2 bg-transparent px-2.5 pb-[9px] pt-1.5 hover:bg-surface-hover",
                                    chip === key ? TAB_TONE[key].line : "border-transparent"
                                )}
                            >
                                <RollingCount
                                    value={count}
                                    className={cn(
                                        "font-mono text-[17px] font-semibold",
                                        count > 0 || chip === key ? TAB_TONE[key].text : "text-muted"
                                    )}
                                />
                                <span
                                    className={cn(
                                        "text-[12.5px] font-medium",
                                        chip === key ? "text-primary" : "text-ink-mid"
                                    )}
                                >
                                    {label}
                                </span>
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

                    <div ref={gridScrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-2.5">
                        <div className="flex items-start gap-3.5">
                            {columns.map((col, ci) => (
                                <div
                                    key={ci}
                                    className="flex min-w-0 flex-1 flex-col gap-3.5"
                                    style={{ minHeight: gridViewportPx }}
                                >
                                    <AnimatePresence initial={false}>{col.map(renderCard)}</AnimatePresence>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="shrink-0 px-[18px]">
                        <BackgroundedSection agents={shownBackgrounded} onRestore={(id) => toggleBackground(id)} />
                        <IdleSection agents={shownParkedIdle} onOpen={(id) => model.openTerminal(id)} />
                        <BackgroundAgentsStrip model={model} />
                    </div>
                </div>

                {!empty ? <HintsBar onOpenHelp={() => globalStore.set(cheatsheetOpenAtom, true)} /> : null}
            </div>

            <CockpitRail
                model={model}
                lineage={lineage}
                runEvents={runEvents}
                tags={railTags}
                onSelectAgent={(id) => {
                    setCursorId(id);
                    scrollToPulse(id);
                }}
            />
        </div>
        </MotionConfig>
    );
}

