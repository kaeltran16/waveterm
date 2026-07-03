// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue, useSetAtom, type PrimitiveAtom } from "jotai";
import { Reorder } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { AgentRow } from "./agentrow";
import type { AgentsViewModel, ChipFilter, SurfaceKey } from "./agents";
import {
    canSubmitAsk,
    filterAgents,
    formatAge,
    formatReset,
    formatTokens,
    groupAgents,
    hasAnswerableAsk,
    isRecentlyIdle,
    applyAgentOrder,
    streamableTranscriptAgents,
    matchesProjectFilter,
    mergeOrder,
    moveCursor,
    nextAskId,
    partitionBackgrounded,
    projectsFromAgents,
    providerPlanUsage,
    toggleSelection,
    usageLevel,
    type AgentVM,
} from "./agentsviewmodel";
import { BackgroundedSection } from "./backgroundedsection";
import { dropCardGit, refreshCardGit, scheduleCardGit } from "./cardgitstore";
import { IdleSection } from "./idlesection";
import { ensurePreviousInfo } from "./liveagents";
import {
    lastActivityByIdAtom,
    liveEntriesByIdAtom,
    startTranscriptStream,
    stopTranscriptStream,
} from "./livetranscript";
import { ProjectSwitcher } from "./projectswitcher";
import { mergeRateLimitWindows, savedRateLimitsAtom } from "./ratelimitstore";
import { buildRecentActivity, RECENT_ACTIVITY_LIMIT } from "./recentactivity";
import { SectionHeader } from "./sectionheader";
import { loadWindowTokens, windowTokensAtom } from "./windowtokenstore";

function RollingCount({ value, className }: { value: number; className?: string }) {
    return <span className={cn("tabular-nums", className)}>{value}</span>;
}

const PLAN_BAR: Record<"ok" | "warn" | "hot", string> = { ok: "bg-accent", warn: "bg-warning", hot: "bg-error" };
const PLAN_TXT: Record<"ok" | "warn" | "hot", string> = { ok: "text-accent", warn: "text-warning", hot: "text-error" };

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

// Provider identity dots for the plan strip. Not theme tokens — Claude clay / Codex periwinkle are
// brand colors, kept here as the single source.
const PROVIDER_DOT: Record<string, string> = { claude: "bg-[#d97757]", codex: "bg-[#96aacd]" };
const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex" };

// recent-activity dot color by agent state (matches the in-view StatusDot palette)
const RECENT_DOT: Record<string, string> = {
    asking: "var(--color-warning)",
    working: "var(--color-accent)",
    idle: "var(--color-muted)",
};

// One plan window as a full-width handoff bar: label + pct + bar + (real used tokens) + reset
// countdown. A null pct (API-key auth, or a window not yet reported) renders nothing. `used` is
// the real Claude-only token sum for the window (windowtokenstore); absent -> no token line.
function UsageBar({
    label,
    pct,
    reset,
    used,
    now,
}: {
    label: string;
    pct?: number;
    reset?: number;
    used?: number;
    now: number;
}) {
    if (pct == null) {
        return null;
    }
    const lvl = usageLevel(pct);
    return (
        <div>
            <div className="mb-[7px] flex items-baseline justify-between">
                <span className="text-[12.5px] font-medium text-secondary">{label}</span>
                <span className={cn("font-mono text-[12px] font-semibold", PLAN_TXT[lvl])}>{Math.round(pct)}%</span>
            </div>
            <div className="h-[7px] overflow-hidden rounded-[4px] bg-surface-raised">
                <div
                    className={cn("h-full rounded-[4px]", PLAN_BAR[lvl])}
                    style={{ width: `${Math.min(100, pct)}%` }}
                />
            </div>
            {used != null || reset ? (
                <div className="mt-[6px] flex justify-between font-mono text-[10.5px] text-muted">
                    <span>{used != null ? `${formatTokens(used)} tok` : ""}</span>
                    {reset ? <span>resets {formatReset(reset, now)}</span> : null}
                </div>
            ) : null}
        </div>
    );
}

const HINTS: [string, string][] = [
    ["↑↓ / j k", "move"],
    ["⏎", "open"],
    ["esc", "back"],
    ["1–9", "answer"],
    ["r", "reply"],
    ["t", "terminal"],
    ["b", "background"],
    ["n", "next ask"],
    ["[ ]", "switch surface"],
];

function HelpOverlay({ onClose }: { onClose: () => void }) {
    const rows: [string, string][] = [
        ["↑ / k", "move cursor up"],
        ["↓ / j", "move cursor down"],
        ["n", "jump to next ask"],
        ["1–9", "select an answer option"],
        ["← → / h l", "switch question (multi-question asks)"],
        ["↵ (Enter)", "confirm selected answer, else open focus view"],
        ["r", "reply inline to the highlighted agent"],
        ["t", "open the highlighted agent's terminal tab"],
        ["b", "background the highlighted agent (keeps running)"],
        ["esc", "leave focus view / blur reply box / close this"],
        ["?", "toggle this help"],
    ];
    return (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
            <div
                className="min-w-[320px] rounded-[10px] border border-border bg-background p-4 shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="mb-2 text-[13px] font-semibold text-primary">Keyboard</div>
                {rows.map(([k, d]) => (
                    <div key={k} className="flex items-center justify-between gap-6 py-1 text-[12px]">
                        <span className="font-mono text-secondary">{k}</span>
                        <span className="text-muted">{d}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

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
    const { asking, working, idle } = groupAgents(agents);

    // 1s tick so the liveness cue (age / quiet) stays current; drives the model's nowAtom
    const now = useAtomValue(model.nowAtom);
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

    // open a live transcript stream per rendered active agent; keep recently-idle streams during
    // the grace window so final transcript writes cannot race the stop event.
    // per-card git tracking rides the same rendered set as the transcript stream: refreshCardGit on
    // enter, dropCardGit on leave, and a debounced re-load on transcript activity (effect below).
    const streamedRef = useRef<Set<string>>(new Set());
    const gitTrackedRef = useRef<Map<string, { path?: string; blockId?: string }>>(new Map());
    const gitSeenActivityRef = useRef<Map<string, number>>(new Map());
    useEffect(() => {
        const wantedById = new Map<string, { path: string; agent?: string; blockId?: string }>();
        for (const a of streamableTranscriptAgents([...asking, ...working, ...recentlyIdle], now)) {
            wantedById.set(a.id, { path: a.transcriptPath!, agent: a.agent, blockId: a.blockId });
        }
        for (const [id, { path, agent, blockId }] of wantedById) {
            if (!streamedRef.current.has(id)) {
                startTranscriptStream(id, path, agent);
                streamedRef.current.add(id);
                gitTrackedRef.current.set(id, { path, blockId });
                void refreshCardGit(id, path, blockId);
            }
        }
        for (const id of [...streamedRef.current]) {
            if (!wantedById.has(id)) {
                stopTranscriptStream(id);
                streamedRef.current.delete(id);
                gitTrackedRef.current.delete(id);
                gitSeenActivityRef.current.delete(id);
                dropCardGit(id);
            }
        }
    }, [asking, working, recentlyIdle, now]);

    useEffect(() => {
        return () => {
            for (const id of streamedRef.current) {
                stopTranscriptStream(id);
                dropCardGit(id);
            }
            streamedRef.current.clear();
            gitTrackedRef.current.clear();
            gitSeenActivityRef.current.clear();
        };
    }, []);

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
    const [answerTab, setAnswerTab] = useModelAtom(model.answerTabAtom);
    const [cardPrefs, setCardPrefs] = useModelAtom(model.cardPrefsAtom);
    const toggleWide = (id: string) => setCardPrefs((p) => ({ ...p, [id]: { ...p[id], wide: !p[id]?.wide } }));
    const setCardHeight = (id: string, h: number) => setCardPrefs((p) => ({ ...p, [id]: { ...p[id], height: h } }));
    const openComposerId = useAtomValue(model.openComposerIdAtom);
    const setOpenComposerId = useSetAtom(model.openComposerIdAtom);
    const sentIds = useAtomValue(model.sentIdsAtom);
    const railOpen = useAtomValue(model.railOpenAtom);
    const chip = useAtomValue(model.chipFilterAtom);
    const setChip = (c: ChipFilter) => globalStore.set(model.chipFilterAtom, c);
    const recentEntriesById = useAtomValue(liveEntriesByIdAtom);
    const recentLastActivityById = useAtomValue(lastActivityByIdAtom);
    const recent = buildRecentActivity(agents, recentEntriesById, recentLastActivityById, RECENT_ACTIVITY_LIMIT, now);

    // debounced git re-load when a tracked card narrates. First sighting of an id adopts its current
    // activity stamp as the baseline (the enter-time refresh already covered that state) so only
    // subsequent advances schedule a reload.
    useEffect(() => {
        for (const [id, meta] of gitTrackedRef.current) {
            const ts = recentLastActivityById[id];
            if (ts == null) {
                continue;
            }
            const seen = gitSeenActivityRef.current.get(id);
            if (seen == null) {
                gitSeenActivityRef.current.set(id, ts);
                continue;
            }
            if (ts > seen) {
                gitSeenActivityRef.current.set(id, ts);
                scheduleCardGit(id, meta.path, meta.blockId);
            }
        }
    }, [recentLastActivityById]);
    const [showHelp, setShowHelp] = useState(false);
    const [pulseId, setPulseId] = useState<string>();
    const lastJumpRef = useRef<string>(undefined);
    const containerRef = useRef<HTMLDivElement>(null);

    // status chips narrow what the grid renders; cursor/order still operate over the full set
    const projectFilter = useAtomValue(model.projectFilterAtom);
    const liveOnly = useAtomValue(model.liveOnlyAtom);
    // project scope + live-only first; the chip narrows what the grid renders (counts ignore the chip)
    const visibleOrdered = filterAgents(orderedAgents, projectFilter, liveOnly);
    const shownAgents = chip === "all" ? visibleOrdered : visibleOrdered.filter((a) => a.state === chip);
    const liveCount = visibleOrdered.length;
    const liveAsking = visibleOrdered.filter((a) => a.state === "asking").length;
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

    const onKeyDown = (e: React.KeyboardEvent) => {
        const t = e.target as HTMLElement;
        if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) {
            return; // typing — let the input own its keys
        }
        // surface switch: `[` previous / `]` next (rail order). 1–9 are answer keys, so no number jumps.
        if (e.key === "]" || e.key === "[") {
            e.preventDefault();
            const surfaceOrder: SurfaceKey[] = [
                "cockpit",
                "agent",
                "activity",
                "channels",
                "sessions",
                "files",
                "memory",
                "usage",
            ];
            const curSurface = globalStore.get(model.surfaceAtom);
            const idx = surfaceOrder.indexOf(curSurface);
            const nextSurface =
                surfaceOrder[(idx + (e.key === "]" ? 1 : surfaceOrder.length - 1)) % surfaceOrder.length];
            globalStore.set(model.surfaceAtom, nextSurface);
            return;
        }
        const cur = orderedAgents.find((a) => a.id === cursorId);
        if (e.key === "ArrowDown" || e.key === "j") {
            e.preventDefault();
            setCursorId((c) => moveCursor(navigableIds, c, 1));
        } else if (e.key === "ArrowUp" || e.key === "k") {
            e.preventDefault();
            setCursorId((c) => moveCursor(navigableIds, c, -1));
        } else if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "h" || e.key === "l") {
            const n = cur?.ask?.questions?.length ?? 0;
            if (cur?.state !== "asking" || n <= 1) {
                return;
            }
            e.preventDefault();
            const delta = e.key === "ArrowLeft" || e.key === "h" ? -1 : 1;
            const curTab = Math.min(answerTab[cur.id] ?? 0, n - 1);
            selectQuestion(cur.id, Math.max(0, Math.min(n - 1, curTab + delta)));
        } else if (e.key === "n") {
            e.preventDefault();
            const target = nextAskId(
                asking.map((a) => a.id),
                lastJumpRef.current
            );
            if (target) {
                lastJumpRef.current = target;
                setCursorId(target);
                scrollToPulse(target);
            }
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (!cur) return;
            if (cur.state === "asking" && canSubmitAsk(cur.ask?.questions ?? [], answerSel[cur.id] ?? {})) {
                submitAnswer(cur.id);
            } else {
                openFocus(cur.id, false);
            }
        } else if (e.key === "r") {
            e.preventDefault();
            if (cur && !hasAnswerableAsk(cur)) {
                setOpenComposerId(cur.id);
                requestAnimationFrame(() => focusRowComposer(cur.id));
            }
        } else if (e.key === "t") {
            e.preventDefault();
            if (cur) {
                model.openTerminal(cur.id);
            }
        } else if (e.key === "b") {
            e.preventDefault();
            if (cur && cur.state !== "asking") {
                toggleBackground(cur.id);
            }
        } else if (e.key === "Escape") {
            if (showHelp) {
                e.preventDefault();
                setShowHelp(false);
            }
        } else if (e.key === "?") {
            e.preventDefault();
            setShowHelp((v) => !v);
        } else if (/^[1-9]$/.test(e.key)) {
            if (cur?.state === "asking") {
                const qi = Math.min(answerTab[cur.id] ?? 0, (cur.ask?.questions?.length ?? 1) - 1);
                const oi = parseInt(e.key, 10) - 1;
                const opts = cur.ask?.questions?.[qi]?.options ?? [];
                if (oi < opts.length) {
                    e.preventDefault();
                    toggleAnswer(cur.id, qi, oi);
                }
            }
        }
    };

    const empty = asking.length === 0 && working.length === 0 && idle.length === 0;

    return (
        <div
            ref={containerRef}
            tabIndex={0}
            onKeyDown={onKeyDown}
            className="relative flex h-full w-full text-secondary outline-none"
        >
            <div className="flex min-w-0 flex-1 flex-col bg-background">
                <div className="sticky top-0 z-[5] shrink-0 border-b border-border bg-background px-[30px] pb-3 pt-4">
                    <div className="mb-3 flex items-baseline gap-3">
                        <h1 className="text-[20px] font-bold tracking-[-0.02em] text-primary">Cockpit</h1>
                        <p className="text-[12.5px] text-muted">
                            {agents.length} agents · {projectCount} projects ·{" "}
                            <span className="font-semibold text-warning">
                                <RollingCount value={asking.length} /> need you
                            </span>
                        </p>
                        <div className="ml-auto flex shrink-0 items-center gap-2">
                            <button
                                type="button"
                                onClick={() => globalStore.set(model.railOpenAtom, !railOpen)}
                                className="cursor-pointer rounded-[8px] border border-edge-mid px-2.5 py-1.5 text-[12px] text-muted hover:border-edge-strong"
                            >
                                {railOpen ? "Hide panel ›" : "‹ Usage"}
                            </button>
                            <ProjectSwitcher model={model} variant="header" />
                            <button
                                type="button"
                                onClick={() => globalStore.set(model.liveOnlyAtom, !liveOnly)}
                                className={cn(
                                    "flex cursor-pointer items-center gap-[7px] rounded-[8px] border px-2.5 py-1.5 text-[12px] font-medium",
                                    liveOnly
                                        ? "border-success/60 bg-success/10 text-success"
                                        : "border-edge-mid bg-surface-raised text-muted-foreground hover:border-edge-strong"
                                )}
                            >
                                <span className="h-1.5 w-1.5 rounded-full bg-success" />
                                Live only
                            </button>
                        </div>
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
                                    "grid cursor-pointer grid-cols-[minmax(0,auto)_1.25rem] items-center rounded-[8px] border px-3 py-1.5 text-[12.5px]",
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

                <div className="flex min-h-0 flex-1 flex-col">
                    {empty ? (
                        <div className="flex flex-1 flex-col items-center justify-center gap-1 p-[18px] text-center">
                            <div className="text-[18px] opacity-40">🤖</div>
                            <div className="text-[13px] font-semibold text-secondary">No active agents</div>
                            <div className="text-[11px] text-muted">
                                Agents appear here the moment one starts working or asks a question.
                            </div>
                        </div>
                    ) : null}

                    {liveCount > 0 ? (
                        <div className="shrink-0 px-5 pt-4">
                            <SectionHeader
                                label="Live agents"
                                labelClassName="text-accent-soft"
                                count={liveCount}
                                dotClassName="bg-accent-soft"
                                countPillClassName="bg-accent/10 text-accent-soft"
                                dividerClassName="bg-gradient-to-r from-accent/20 to-transparent"
                                right={
                                    <span className="text-[11.5px] text-muted">
                                        <span className="font-semibold text-warning">{liveAsking} need you</span> ·{" "}
                                        {liveWorking} working
                                    </span>
                                }
                            />
                        </div>
                    ) : null}

                    <Reorder.Group
                        as="div"
                        axis="y"
                        values={orderedIds}
                        onReorder={setOrder}
                        className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-3.5 overflow-y-auto px-5 pb-5 pt-2.5"
                    >
                        {shownAgents.map((a) => (
                            <AgentRow
                                key={a.id}
                                agent={a}
                                now={now}
                                isCursor={cursorId === a.id}
                                pulse={pulseId === a.id}
                                wide={cardPrefs[a.id]?.wide}
                                height={cardPrefs[a.id]?.height}
                                onToggleWide={() => toggleWide(a.id)}
                                onResize={(h) => setCardHeight(a.id, h)}
                                selections={answerSel[a.id] ?? {}}
                                sent={sentIds.has(a.id)}
                                activeQuestion={answerTab[a.id] ?? 0}
                                composerOpen={openComposerId === a.id}
                                onCursor={() => setCursorId(a.id)}
                                onOpen={() => openFocus(a.id, false)}
                                onOpenTerminal={() => model.openTerminal(a.id)}
                                onOpenDiff={() => openDiff(a.id)}
                                onOpenComposer={() => setOpenComposerId(a.id)}
                                onToggleAnswer={(qi, oi) => toggleAnswer(a.id, qi, oi)}
                                onSubmitAnswer={() => submitAnswer(a.id)}
                                onSelectQuestion={(qi) => selectQuestion(a.id, qi)}
                                onComposerEscape={() => {
                                    setOpenComposerId(undefined);
                                    containerRef.current?.focus();
                                }}
                                onBackground={
                                    a.state === "working" || a.state === "asking"
                                        ? () => toggleBackground(a.id)
                                        : undefined
                                }
                                onDismiss={
                                    a.state === "idle"
                                        ? () => setDismissed((prev) => new Set(prev).add(dismissKey(a)))
                                        : undefined
                                }
                            />
                        ))}
                    </Reorder.Group>

                    <div className="shrink-0 px-[18px]">
                        <BackgroundedSection agents={shownBackgrounded} onRestore={(id) => toggleBackground(id)} />
                        <IdleSection agents={shownParkedIdle} onOpen={(id) => model.openTerminal(id)} />
                    </div>
                </div>

                {!empty ? (
                    <div className="flex shrink-0 items-center gap-4 border-t border-border bg-background px-[18px] py-1.5 text-[11px] text-muted">
                        {HINTS.map(([k, d]) => (
                            <span key={k} className="flex items-center gap-1">
                                <span className="rounded-[4px] bg-white/[0.06] px-1.5 py-0.5 font-mono text-secondary">
                                    {k}
                                </span>
                                {d}
                            </span>
                        ))}
                        <button
                            type="button"
                            onClick={() => setShowHelp(true)}
                            className="ml-auto cursor-pointer font-mono hover:text-secondary"
                        >
                            ?
                        </button>
                    </div>
                ) : null}
            </div>

            {railOpen ? (
                <aside className="flex w-[300px] shrink-0 flex-col gap-6 overflow-y-auto border-l border-border bg-surface px-5 py-5">
                    <div>
                        <div className="mb-3.5 flex items-center justify-between">
                            <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                                Usage
                            </h3>
                            <button
                                type="button"
                                onClick={() => globalStore.set(model.surfaceAtom, "usage")}
                                className="cursor-pointer border-0 bg-transparent text-[11.5px] text-accent"
                            >
                                Details →
                            </button>
                        </div>
                        <div className="flex flex-col gap-4">
                            {usageDonuts.map((d) => (
                                <div key={d.provider} className="flex flex-col gap-4">
                                    {usageDonuts.length > 1 ? (
                                        <div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold text-primary">
                                            <span
                                                className={cn(
                                                    "h-[7px] w-[7px] rounded-full",
                                                    PROVIDER_DOT[d.provider] ?? "bg-muted"
                                                )}
                                            />
                                            {PROVIDER_LABEL[d.provider] ?? d.provider}
                                        </div>
                                    ) : null}
                                    <UsageBar
                                        label="5-hour window"
                                        pct={d.fivehour.pct}
                                        reset={d.fivehour.reset}
                                        used={d.provider === "claude" ? windowTokens?.fivehour : undefined}
                                        now={now}
                                    />
                                    <UsageBar
                                        label="Weekly"
                                        pct={d.week.pct}
                                        reset={d.week.reset}
                                        used={d.provider === "claude" ? windowTokens?.week : undefined}
                                        now={now}
                                    />
                                </div>
                            ))}
                        </div>
                    </div>
                    {recent.length > 0 ? (
                        <div>
                            <div className="mb-3 flex items-center justify-between">
                                <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                                    Recent activity
                                </h3>
                                <button
                                    type="button"
                                    onClick={() => globalStore.set(model.surfaceAtom, "activity")}
                                    className="cursor-pointer border-0 bg-transparent text-[11.5px] text-accent"
                                >
                                    View all →
                                </button>
                            </div>
                            <div className="flex flex-col">
                                {recent.map((e) => (
                                    <div key={e.id} className="flex gap-[11px] border-b border-border py-[9px]">
                                        <span
                                            className="mt-[5px] h-[7px] w-[7px] shrink-0 rounded-full"
                                            style={{ backgroundColor: RECENT_DOT[e.state] }}
                                        />
                                        <div className="min-w-0 flex-1">
                                            <div className="text-[12px] leading-[1.4] text-secondary">
                                                <span className="font-mono font-semibold text-primary">{e.agent}</span>{" "}
                                                {e.text}
                                            </div>
                                            <div className="mt-[3px] font-mono text-[10px] text-muted">
                                                {e.typeLabel} ·{" "}
                                                {now - e.ts < 60_000 ? "just now" : `${formatAge(now - e.ts)} ago`}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : null}
                </aside>
            ) : null}
            {showHelp ? <HelpOverlay onClose={() => setShowHelp(false)} /> : null}
        </div>
    );
}
