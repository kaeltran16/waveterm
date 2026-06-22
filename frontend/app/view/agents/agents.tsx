// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { getApi, setActiveTab } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { TabModel } from "@/app/store/tab-model";
import { atom, useAtomValue, type Atom } from "jotai";
import { cn, fireAndForget } from "@/util/util";
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
    buildAskAnswers,
    canSubmitAsk,
    formatReset,
    groupAgents,
    isRecentlyIdle,
    mergeOrder,
    moveCursor,
    nextAskId,
    reorderList,
    usageLevel,
    type AgentVM,
} from "./agentsviewmodel";
import { ensurePreviousInfo, liveAgentsAtom } from "./liveagents";
import { mockAgentsAtom, USE_MOCK_AGENTS } from "./mockagents";
import { startTranscriptStream, stopTranscriptStream } from "./livetranscript";
import { AgentRow } from "./agentrow";
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

const PLAN_BAR: Record<"ok" | "warn" | "hot", string> = { ok: "bg-accent", warn: "bg-warning", hot: "bg-error" };
const PLAN_TXT: Record<"ok" | "warn" | "hot", string> = { ok: "text-accent", warn: "text-warning", hot: "text-error" };

// One account-global plan-usage gauge (5h or weekly window). A null pct — API-key auth, or a window
// not yet reported — renders nothing rather than a misleading 0%.
function PlanGauge({ label, pct, reset, now }: { label: string; pct?: number; reset?: number; now: number }) {
    if (pct == null) {
        return null;
    }
    const lvl = usageLevel(pct);
    return (
        <span className="flex items-center gap-2">
            <span className="text-secondary">{label}</span>
            <span className="h-1 w-20 overflow-hidden rounded-full bg-white/10">
                <span className={cn("block h-full rounded-full", PLAN_BAR[lvl])} style={{ width: `${Math.min(100, pct)}%` }} />
            </span>
            <span className={cn("font-semibold tabular-nums", PLAN_TXT[lvl])}>{Math.round(pct)}%</span>
            {reset ? <span className="text-muted">· {formatReset(reset, now)}</span> : null}
        </span>
    );
}

const HINTS: [string, string][] = [
    ["↑↓ / j k", "move"],
    ["n", "next ask"],
    ["1–9", "answer"],
    ["↵", "open / confirm"],
    ["r", "reply"],
    ["esc", "back"],
];

function HelpOverlay({ onClose }: { onClose: () => void }) {
    const rows: [string, string][] = [
        ["↑ / k", "move cursor up"],
        ["↓ / j", "move cursor down"],
        ["n", "jump to next ask"],
        ["1–9", "select an answer option"],
        ["↵ (Enter)", "confirm selected answer, else open focus view"],
        ["r", "open focus view and reply"],
        ["esc", "leave focus view / close this"],
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
    // plan usage is account-global; every agent reports the same numbers — take the freshest (active agents first)
    const planUsage = [...asking, ...working, ...idle]
        .map((a) => a.usage)
        .find((u) => u?.fivehourpct != null || u?.weekpct != null);
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
    const recentlyIdle = idle.filter((a) => isRecentlyIdle(a, now) && !dismissed.has(dismissKey(a)));
    const recentIds = new Set(recentlyIdle.map((a) => a.id));
    const parkedIdle = idle.filter((a) => !recentIds.has(a.id));
    const listAgents = [...asking, ...working, ...recentlyIdle];

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

    // anchored order (kept ids hold their slot; new ids append) + manual drag reorder
    const [order, setOrder] = useState<string[]>([]);
    const [dragId, setDragId] = useState<string>();
    useEffect(() => {
        const ids = listAgents.map((a) => a.id);
        setOrder((prev) => mergeOrder(prev, ids));
    }, [listAgents.map((a) => a.id).join(",")]);
    const orderedList = order.map((id) => listAgents.find((a) => a.id === id)).filter(Boolean) as AgentVM[];
    const orderedIds = orderedList.map((a) => a.id);

    // cursor + answer selection + focus + help
    const [cursorId, setCursorId] = useState<string>();
    const [answerSel, setAnswerSel] = useState<Record<string, Record<number, Set<number>>>>({});
    const [sentIds, setSentIds] = useState<Set<string>>(() => new Set());
    const [focusId, setFocusId] = useState<string>();
    const [focusReply, setFocusReply] = useState(false);
    const [showHelp, setShowHelp] = useState(false);
    const [pulseId, setPulseId] = useState<string>();
    const lastJumpRef = useRef<string>(undefined);
    const containerRef = useRef<HTMLDivElement>(null);

    // keep the cursor valid as the set changes; seed it to the first row
    useEffect(() => {
        if (orderedIds.length === 0) {
            if (cursorId != null) setCursorId(undefined);
            return;
        }
        if (cursorId == null || !orderedIds.includes(cursorId)) {
            setCursorId(orderedIds[0]);
        }
    }, [orderedIds.join(",")]);

    const scrollToPulse = (id: string) => {
        document.querySelector(`[data-agent-id="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        setPulseId(id);
        setTimeout(() => setPulseId((p) => (p === id ? undefined : p)), 1200);
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

    const openFocus = (id: string, reply: boolean) => {
        setFocusId(id);
        setFocusReply(reply);
    };

    const focusStep = (delta: number) => {
        setFocusId((cur) => moveCursor(orderedIds, cur, delta) ?? cur);
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
            }
            return;
        }
        const cur = orderedList.find((a) => a.id === cursorId);
        if (e.key === "ArrowDown" || e.key === "j") {
            e.preventDefault();
            setCursorId((c) => moveCursor(orderedIds, c, 1));
        } else if (e.key === "ArrowUp" || e.key === "k") {
            e.preventDefault();
            setCursorId((c) => moveCursor(orderedIds, c, -1));
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
            if (cursorId) openFocus(cursorId, true);
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
                const oi = parseInt(e.key, 10) - 1;
                const opts = cur.ask?.questions?.[0]?.options ?? [];
                if (oi < opts.length) {
                    e.preventDefault();
                    toggleAnswer(cur.id, 0, oi);
                }
            }
        }
    };

    const empty = asking.length === 0 && working.length === 0 && idle.length === 0;
    const focusAgent = focusId != null ? orderedList.find((a) => a.id === focusId) : undefined;

    if (focusAgent) {
        const i = orderedIds.indexOf(focusAgent.id);
        return (
            <div ref={containerRef} tabIndex={0} onKeyDown={onKeyDown} className="h-full w-full outline-none">
                <FocusView
                    agent={focusAgent}
                    now={now}
                    autofocusComposer={focusReply}
                    hasPrev={i > 0}
                    hasNext={i < orderedIds.length - 1}
                    selections={answerSel[focusAgent.id] ?? {}}
                    sent={sentIds.has(focusAgent.id)}
                    onBack={() => setFocusId(undefined)}
                    onPrev={() => focusStep(-1)}
                    onNext={() => focusStep(1)}
                    onOpenTerminal={() => setActiveTab(focusAgent.id)}
                    onToggleAnswer={(qi, oi) => toggleAnswer(focusAgent.id, qi, oi)}
                    onSubmitAnswer={() => submitAnswer(focusAgent.id)}
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
                    <span className="flex items-center gap-1">
                        <RollingCount value={working.length} />
                        <span>working</span>
                    </span>
                </span>
            </div>

            {planUsage ? (
                <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-1 border-b border-border bg-accent/[0.035] px-[18px] py-2 text-[11px]">
                    <span className="text-[10px] uppercase tracking-wide text-muted">Plan usage</span>
                    <PlanGauge label="Session" pct={planUsage.fivehourpct} reset={planUsage.fivehourreset} now={now} />
                    <PlanGauge label="This week" pct={planUsage.weekpct} reset={planUsage.weekreset} now={now} />
                </div>
            ) : null}

            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
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

                <AnimatePresence mode="popLayout">
                    {orderedList.map((a) => (
                        <motion.div
                            key={a.id}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.18 }}
                            className={cn(pulseId === a.id && "ring-2 ring-warning ring-inset")}
                        >
                            <AgentRow
                                agent={a}
                                now={now}
                                isCursor={cursorId === a.id}
                                selections={answerSel[a.id] ?? {}}
                                sent={sentIds.has(a.id)}
                                onCursor={() => setCursorId(a.id)}
                                onOpen={() => openFocus(a.id, false)}
                                onOpenTerminal={() => setActiveTab(a.id)}
                                onToggleAnswer={(qi, oi) => toggleAnswer(a.id, qi, oi)}
                                onSubmitAnswer={() => submitAnswer(a.id)}
                                onDismiss={a.state === "idle" ? () => setDismissed((prev) => new Set(prev).add(dismissKey(a))) : undefined}
                                onDragStart={() => setDragId(a.id)}
                                onDropOn={(before) => {
                                    if (dragId) {
                                        setOrder((o) => reorderList(o, dragId, a.id, before));
                                    }
                                    setDragId(undefined);
                                }}
                            />
                        </motion.div>
                    ))}
                </AnimatePresence>

                <div className="px-[18px]">
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
