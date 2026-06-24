// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { getApi, setActiveTab } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { TabModel } from "@/app/store/tab-model";
import { atom, useAtomValue, type Atom } from "jotai";
import { cn, fireAndForget } from "@/util/util";
import { Fragment, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence, Reorder } from "motion/react";
import {
    buildAskAnswers,
    canSubmitAsk,
    expandedWorkingIds,
    formatReset,
    groupAgents,
    hasAnswerableAsk,
    isRecentlyIdle,
    mergeOrder,
    moveCursor,
    nextAskId,
    partitionBackgrounded,
    providerPlanUsage,
    usageLevel,
    type AgentVM,
    type MaxPanels,
} from "./agentsviewmodel";
import { ensurePreviousInfo, liveAgentsAtom } from "./liveagents";
import { mockAgentsAtom, USE_MOCK_AGENTS } from "./mockagents";
import { startTranscriptStream, stopTranscriptStream } from "./livetranscript";
import { AgentRow } from "./agentrow";
import { BackgroundedSection } from "./backgroundedsection";
import { FocusView } from "./focusview";
import { IdleSection } from "./idlesection";

// Rolls a changing integer: the old value slides up and out while the new one slides in.
function RollingCount({ value, className }: { value: number; className?: string }) {
    return (
        <span className={cn("relative inline-flex overflow-hidden align-baseline", className)}>
            <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                    key={value}
                    initial={{ y: "-100%", opacity: 0 }}
                    animate={{ y: "0%", opacity: 1 }}
                    exit={{ y: "100%", opacity: 0 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                    className="tabular-nums"
                >
                    {value}
                </motion.span>
            </AnimatePresence>
        </span>
    );
}

const MAX_PANEL_OPTIONS: MaxPanels[] = ["auto", 1, 2, 3, 4];

function MaxPanelsControl({ value, onChange }: { value: MaxPanels; onChange: (v: MaxPanels) => void }) {
    return (
        <span className="flex items-center gap-1" title="Max expanded panels">
            <span className="text-[10px] uppercase tracking-wide text-muted">panels</span>
            {MAX_PANEL_OPTIONS.map((opt) => (
                <button
                    key={String(opt)}
                    type="button"
                    onClick={() => onChange(opt)}
                    className={cn(
                        "cursor-pointer rounded-[4px] border px-1.5 py-0.5 text-[10px] transition-colors",
                        value === opt ? "border-accent bg-accent/15 text-primary" : "border-border text-muted hover:bg-white/[0.04]"
                    )}
                >
                    {opt === "auto" ? "Auto" : opt}
                </button>
            ))}
        </span>
    );
}

const PLAN_BAR: Record<"ok" | "warn" | "hot", string> = { ok: "bg-accent", warn: "bg-warning", hot: "bg-error" };
const PLAN_TXT: Record<"ok" | "warn" | "hot", string> = { ok: "text-accent", warn: "text-warning", hot: "text-error" };

// Provider identity dots for the plan strip. Not theme tokens — Claude clay / Codex periwinkle are
// brand colors, kept here as the single source.
const PROVIDER_DOT: Record<string, string> = { claude: "bg-[#d97757]", codex: "bg-[#96aacd]" };

// One rate-limit window (5h or weekly) as a compact mini-gauge. A null pct — API-key auth, or a window
// not yet reported — renders nothing rather than a misleading 0%. The reset countdown rides the title
// (hover) so the whole strip stays on one line.
function MiniGauge({ win, pct, reset, now }: { win: string; pct?: number; reset?: number; now: number }) {
    if (pct == null) {
        return null;
    }
    const lvl = usageLevel(pct);
    return (
        <span className="flex items-center gap-1.5" title={reset ? `${win} resets in ${formatReset(reset, now)}` : undefined}>
            <span className="text-[10px] uppercase tracking-wide text-muted">{win}</span>
            <span className="h-1 w-9 overflow-hidden rounded-full bg-white/10">
                <span className={cn("block h-full rounded-full", PLAN_BAR[lvl])} style={{ width: `${Math.min(100, pct)}%` }} />
            </span>
            <span className={cn("font-semibold tabular-nums", PLAN_TXT[lvl])}>{Math.round(pct)}%</span>
        </span>
    );
}

// One provider's plan limits (5h + weekly) as an inline group; Claude and Codex bill separate quotas.
function ProviderPlan({ provider, usage, now }: { provider: string; usage: AgentVM["usage"]; now: number }) {
    return (
        <span className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 font-semibold text-primary">
                <span className={cn("h-[7px] w-[7px] rounded-full", PROVIDER_DOT[provider] ?? "bg-muted")} />
                {provider.charAt(0).toUpperCase() + provider.slice(1)}
            </span>
            <MiniGauge win="5h" pct={usage.fivehourpct} reset={usage.fivehourreset} now={now} />
            <MiniGauge win="wk" pct={usage.weekpct} reset={usage.weekreset} now={now} />
        </span>
    );
}

const HINTS: [string, string][] = [
    ["↑↓ / j k", "move"],
    ["n", "next ask"],
    ["1–9", "answer"],
    ["←→ / h l", "question"],
    ["↵", "open / confirm"],
    ["r", "reply"],
    ["t", "terminal"],
    ["b", "background"],
    ["esc", "back"],
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
            <div className="min-w-[320px] rounded-[10px] border border-border bg-background p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
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

function AgentsView({ model }: { model: AgentsViewModel }) {
    const agents = useAtomValue(model.agentsAtom);
    const { asking, working, idle } = groupAgents(agents);
    // plan limits are per-provider: Claude (Claude.ai) and Codex (ChatGPT) bill separate 5h/weekly
    // quotas, so we surface one snapshot per provider rather than a single global figure.
    const planByProvider = providerPlanUsage([...asking, ...working, ...idle]);
    const answer = (oref: string, answers: AgentAnswerItem[]) => {
        if (!oref) {
            return;
        }
        fireAndForget(() => RpcApi.AnswerAgentCommand(TabRpcClient, { oref, answers }));
    };

    // 1s tick so the liveness cue (age / quiet) stays current without a global ticker
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);

    // A just-finished agent keeps its full row (so you can reply) for the grace window, then collapses
    // into the Idle list. Dismissals are keyed by idle episode (id:idleSince).
    const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
    const dismissKey = (a: AgentVM) => `${a.id}:${a.idleSince ?? ""}`;
    const [backgroundedIds, setBackgroundedIds] = useState<Set<string>>(() => new Set());
    const [maxPanels, setMaxPanels] = useState<MaxPanels>("auto");
    const recentlyIdle = idle.filter((a) => isRecentlyIdle(a, now) && !dismissed.has(dismissKey(a)));
    const recentIds = new Set(recentlyIdle.map((a) => a.id));
    const parkedIdle = idle.filter((a) => !recentIds.has(a.id));
    // one unified list: asks stay in place alongside active working + just-finished (grace) rows,
    // minus anything backgrounded. Asking agents are never backgrounded (the effect below un-mutes any
    // that start asking), so they always land in `active` and hold whatever slot they already had.
    const { active: activeAgents, backgrounded } = partitionBackgrounded([...asking, ...working, ...recentlyIdle], backgroundedIds);

    // one-shot previous-info for asking agents (seeds first paint; the live stream supersedes it)
    useEffect(() => {
        for (const a of asking) {
            if (a.transcriptPath) {
                void ensurePreviousInfo(a.id, a.transcriptPath, a.agent);
            }
        }
    }, [asking]);

    // open a live transcript stream per visible asking/working agent; stop streams that left the set
    const streamedRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        const wantedById = new Map<string, { path: string; agent?: string }>();
        for (const a of [...asking, ...working]) {
            if (a.transcriptPath) {
                wantedById.set(a.id, { path: a.transcriptPath, agent: a.agent });
            }
        }
        for (const [id, { path, agent }] of wantedById) {
            if (!streamedRef.current.has(id)) {
                startTranscriptStream(id, path, agent);
                streamedRef.current.add(id);
            }
        }
        for (const id of [...streamedRef.current]) {
            if (!wantedById.has(id)) {
                stopTranscriptStream(id);
                streamedRef.current.delete(id);
            }
        }
    }, [asking, working]);

    useEffect(() => {
        return () => {
            for (const id of streamedRef.current) {
                stopTranscriptStream(id);
            }
            streamedRef.current.clear();
        };
    }, []);

    // anchored order (kept ids hold their slot; new ids append) + manual drag reorder. This is what
    // stops a working->asking transition from jumping: the id already holds a slot, so it stays put.
    const [order, setOrder] = useState<string[]>([]);
    useEffect(() => {
        const ids = activeAgents.map((a) => a.id);
        setOrder((prev) => mergeOrder(prev, ids));
    }, [activeAgents.map((a) => a.id).join(",")]);
    const orderedAgents = order.map((id) => activeAgents.find((a) => a.id === id)).filter(Boolean) as AgentVM[];
    const orderedIds = orderedAgents.map((a) => a.id);
    // cursor traverses the single unified list
    const navigableIds = orderedIds;

    // cursor + answer selection + focus + help
    const [cursorId, setCursorId] = useState<string>();
    const [answerSel, setAnswerSel] = useState<Record<string, Record<number, Set<number>>>>({});
    const [answerTab, setAnswerTab] = useState<Record<string, number>>({});
    const [sentIds, setSentIds] = useState<Set<string>>(() => new Set());
    const [focusId, setFocusId] = useState<string>();
    const [focusReply, setFocusReply] = useState(false);
    const [showHelp, setShowHelp] = useState(false);
    const [pulseId, setPulseId] = useState<string>();
    const lastJumpRef = useRef<string>(undefined);
    const containerRef = useRef<HTMLDivElement>(null);

    // asks are always expanded (their answer bar must show); working/idle rows expand per maxPanels.
    const askingIds = new Set(asking.map((a) => a.id));
    const cappableIds = orderedIds.filter((id) => !askingIds.has(id));
    const expandedSet = new Set<string>([...askingIds, ...expandedWorkingIds(cappableIds, cursorId, maxPanels)]);

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
        setAnswerSel((prev) => {
            const a = agents.find((x) => x.id === id);
            const q = a?.ask?.questions?.[qi];
            const forAgent = { ...(prev[id] ?? {}) };
            const set = new Set(forAgent[qi] ?? []);
            if (q?.multiSelect) {
                if (set.has(oi)) set.delete(oi);
                else set.add(oi);
            } else {
                set.clear();
                set.add(oi);
            }
            forAgent[qi] = set;
            return { ...prev, [id]: forAgent };
        });
    };

    const submitAnswer = (id: string) => {
        const a = agents.find((x) => x.id === id);
        if (!a || sentIds.has(id)) {
            return;
        }
        const qs = a.ask?.questions ?? [];
        const sel = answerSel[id] ?? {};
        if (!canSubmitAsk(qs, sel)) {
            return;
        }
        answer(a.ask?.oref, buildAskAnswers(qs, sel));
        setSentIds((s) => new Set(s).add(id));
    };

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

    const openFocus = (id: string, reply: boolean) => {
        setFocusId(id);
        setFocusReply(reply);
    };

    const focusStep = (delta: number) => {
        setFocusId((cur) => moveCursor(navigableIds, cur, delta) ?? cur);
        setFocusReply(false);
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        const t = e.target as HTMLElement;
        if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) {
            return; // typing — let the input own its keys
        }
        // focus view: only back/prev/next
        if (focusId != null) {
            if (e.key === "Escape") {
                e.preventDefault();
                setFocusId(undefined);
            } else if (e.key === "ArrowLeft") {
                e.preventDefault();
                focusStep(-1);
            } else if (e.key === "ArrowRight") {
                e.preventDefault();
                focusStep(1);
            } else if (e.key === "t") {
                e.preventDefault();
                setActiveTab(focusId);
            }
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
            const target = nextAskId(asking.map((a) => a.id), lastJumpRef.current);
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
                focusRowComposer(cur.id);
            }
        } else if (e.key === "t") {
            e.preventDefault();
            if (cur) {
                setActiveTab(cur.id);
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
    const focusAgent = focusId != null ? orderedAgents.find((a) => a.id === focusId) : undefined;

    if (focusAgent) {
        const i = navigableIds.indexOf(focusAgent.id);
        return (
            <div ref={containerRef} tabIndex={0} onKeyDown={onKeyDown} className="h-full w-full outline-none">
                <FocusView
                    agent={focusAgent}
                    now={now}
                    autofocusComposer={focusReply}
                    hasPrev={i > 0}
                    hasNext={i < navigableIds.length - 1}
                    selections={answerSel[focusAgent.id] ?? {}}
                    sent={sentIds.has(focusAgent.id)}
                    activeQuestion={answerTab[focusAgent.id] ?? 0}
                    onBack={() => setFocusId(undefined)}
                    onPrev={() => focusStep(-1)}
                    onNext={() => focusStep(1)}
                    onOpenTerminal={() => setActiveTab(focusAgent.id)}
                    onToggleAnswer={(qi, oi) => toggleAnswer(focusAgent.id, qi, oi)}
                    onSubmitAnswer={() => submitAnswer(focusAgent.id)}
                    onSelectQuestion={(qi) => selectQuestion(focusAgent.id, qi)}
                />
            </div>
        );
    }

    return (
        <div
            ref={containerRef}
            tabIndex={0}
            onKeyDown={onKeyDown}
            className="relative flex h-full w-full flex-col text-secondary outline-none"
        >
            <div className="flex shrink-0 items-center justify-between border-b border-border px-[18px] py-3">
                <b className="text-[14px] font-semibold text-primary">Agents</b>
                <span className="flex items-center gap-2 text-[12px] text-muted">
                    {asking.length > 0 ? (
                        <button
                            type="button"
                            onClick={() => {
                                const target = nextAskId(asking.map((a) => a.id), lastJumpRef.current);
                                if (!target) return;
                                lastJumpRef.current = target;
                                setCursorId(target);
                                scrollToPulse(target);
                            }}
                            className="flex cursor-pointer items-center gap-1.5 rounded-[6px] border border-warning bg-warning/10 px-2 py-0.5 text-[11px] font-semibold text-warning hover:bg-warning/15"
                        >
                            <span className="h-2 w-2 rounded-full bg-warning" />
                            <RollingCount value={asking.length} /> needs you
                            <span className="font-normal text-muted">· jump →</span>
                        </button>
                    ) : null}
                    <MaxPanelsControl value={maxPanels} onChange={setMaxPanels} />
                    <span className="flex items-center gap-1">
                        <RollingCount value={working.length} />
                        <span>working</span>
                    </span>
                </span>
            </div>

            {planByProvider.length > 0 ? (
                <div className="flex shrink-0 items-center gap-4 overflow-x-auto border-b border-border bg-accent/[0.035] px-[18px] py-2 text-[11px]">
                    <span className="text-[10px] uppercase tracking-wide text-muted">Plan</span>
                    {planByProvider.map(({ provider, usage }, i) => (
                        <Fragment key={provider}>
                            {i > 0 ? <span className="text-white/15">|</span> : null}
                            <ProviderPlan provider={provider} usage={usage} now={now} />
                        </Fragment>
                    ))}
                </div>
            ) : null}

            <div className="flex min-h-0 flex-1 flex-col">
                <AnimatePresence>
                    {empty && (
                        <motion.div
                            key="empty"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.25 }}
                            className="flex flex-1 flex-col items-center justify-center gap-1 p-[18px] text-center"
                        >
                            <div className="text-[18px] opacity-40">🤖</div>
                            <div className="text-[13px] font-semibold text-secondary">No active agents</div>
                            <div className="text-[11px] text-muted">Agents appear here the moment one starts working or asks a question.</div>
                        </motion.div>
                    )}
                </AnimatePresence>

                <Reorder.Group
                    as="div"
                    axis="y"
                    values={orderedIds}
                    onReorder={setOrder}
                    className="flex min-h-0 flex-1 flex-col overflow-y-auto"
                >
                    <AnimatePresence mode="popLayout">
                        {orderedAgents.map((a) => {
                            const isExpanded = expandedSet.has(a.id);
                            return (
                                <AgentRow
                                    key={a.id}
                                    agent={a}
                                    now={now}
                                    isCursor={cursorId === a.id}
                                    expanded={isExpanded}
                                    fill={isExpanded && a.state !== "asking"}
                                    pulse={pulseId === a.id}
                                    selections={answerSel[a.id] ?? {}}
                                    sent={sentIds.has(a.id)}
                                    activeQuestion={answerTab[a.id] ?? 0}
                                    onCursor={() => setCursorId(a.id)}
                                    onOpen={() => openFocus(a.id, false)}
                                    onOpenTerminal={() => setActiveTab(a.id)}
                                    onToggleAnswer={(qi, oi) => toggleAnswer(a.id, qi, oi)}
                                    onSubmitAnswer={() => submitAnswer(a.id)}
                                    onSelectQuestion={(qi) => selectQuestion(a.id, qi)}
                                    onComposerEscape={() => containerRef.current?.focus()}
                                    onBackground={a.state === "working" ? () => toggleBackground(a.id) : undefined}
                                    onDismiss={a.state === "idle" ? () => setDismissed((prev) => new Set(prev).add(dismissKey(a))) : undefined}
                                />
                            );
                        })}
                    </AnimatePresence>
                </Reorder.Group>

                <div className="shrink-0 px-[18px]">
                    <BackgroundedSection agents={backgrounded} onRestore={(id) => toggleBackground(id)} />
                    <IdleSection agents={parkedIdle} onOpen={(id) => setActiveTab(id)} />
                </div>
            </div>

            {!empty ? (
                <div className="flex shrink-0 items-center gap-4 border-t border-border bg-background px-[18px] py-1.5 text-[11px] text-muted">
                    {HINTS.map(([k, d]) => (
                        <span key={k} className="flex items-center gap-1">
                            <span className="rounded-[4px] bg-white/[0.06] px-1.5 py-0.5 font-mono text-secondary">{k}</span>
                            {d}
                        </span>
                    ))}
                    <button type="button" onClick={() => setShowHelp(true)} className="ml-auto cursor-pointer font-mono hover:text-secondary">
                        ?
                    </button>
                </div>
            ) : null}

            {showHelp ? <HelpOverlay onClose={() => setShowHelp(false)} /> : null}
        </div>
    );
}

export class AgentsViewModel implements ViewModel {
    viewType: string;
    blockId: string;
    nodeModel: BlockNodeModel;
    tabModel: TabModel;
    viewIcon = atom<string>("robot");
    viewName = atom<string>("Agents");
    noPadding = atom(true);
    agentsAtom: Atom<AgentVM[]>;

    constructor({ blockId, nodeModel, tabModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
        this.viewType = "agents";
        // DEV-only: swap in the throwaway mock roster (see mockagents.ts). Never active in a prod build.
        this.agentsAtom = USE_MOCK_AGENTS && getApi().getIsDev() ? mockAgentsAtom : liveAgentsAtom;
    }

    get viewComponent(): ViewComponent {
        return AgentsView;
    }
}
