// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Events rail: state changes across the fleet, new ones above a "mark all read" line. Plain-agent
// transitions are tracked by useRailTracking in the always-mounted shell (cockpit-root.tsx), so a finish while
// another surface shows is still recorded; run events come from the surface.

import { cardVariants, computeEntrances, initialEntranceState } from "@/app/element/motiontokens";
import { PaneReveal } from "@/app/element/panereveal";
import { TickNumber } from "@/app/element/ticknumber";
import { globalStore } from "@/app/store/jotaiStore";
import { REGION_LABEL } from "@/app/view/jarvis/briefstyle";
import { cn } from "@/util/util";
import { atom, useAtomValue, type PrimitiveAtom } from "jotai";
import {
    Check,
    CircleDashed,
    CornerDownRight,
    GitMerge,
    Hand,
    MessageCircleQuestion,
    MessageSquare,
    Workflow,
    X,
    type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentsViewModel } from "./agents";
import { formatAgeShort, type AgentState, type AgentVM } from "./agentsviewmodel";
import {
    agentTransitions,
    fillAskedText,
    groupRailEvents,
    leadAskEvents,
    markRailRead,
    mergeRailEvents,
    NO_RAIL_SEEN,
    RAIL_MAX,
    runRailEvents,
    scopeRailRows,
    splitUnreadScoped,
    type AgentSnap,
    type RailEvent,
    type RailKind,
    type RailRow,
    type RailSeen,
} from "./cockpitevents";
import type { Lineage } from "./runlineage";
import { SectionLabel } from "./sectionlabel";
import { isStandingBy } from "./shelltasks";
import { shellReadAtByIdAtom, shellReadPending, shellTasksByIdAtom } from "./shelltasksstore";
import { subagentsByIdAtom } from "./subagentsstore";

const snapsAtom = atom<Record<string, AgentSnap>>({}) as PrimitiveAtom<Record<string, AgentSnap>>;
const leadSnapsAtom = atom<Record<string, AgentState>>({}) as PrimitiveAtom<Record<string, AgentState>>;
// exported for reading only (the project Overview's Finished region); the rail alone writes them
export const agentEventsAtom = atom<RailEvent[]>([]) as PrimitiveAtom<RailEvent[]>;
export const railSeenAtom = atom<RailSeen>(NO_RAIL_SEEN) as PrimitiveAtom<RailSeen>;

const KIND: Record<RailKind, { icon: LucideIcon; verb: string; tone: string }> = {
    asked: { icon: MessageCircleQuestion, verb: "asked", tone: "text-warning" },
    answered: { icon: CornerDownRight, verb: "answered", tone: "text-accent-soft" },
    finished: { icon: Check, verb: "finished", tone: "text-accent-soft" },
    quiet: { icon: CircleDashed, verb: "went quiet", tone: "text-warning" },
    failed: { icon: X, verb: "failed", tone: "text-error" },
    told: { icon: MessageSquare, verb: "you told", tone: "text-accent-soft" },
    acted: { icon: Hand, verb: "you acted", tone: "text-accent-soft" },
    landed: { icon: GitMerge, verb: "landed", tone: "text-success" },
    sentback: { icon: CornerDownRight, verb: "review sent back", tone: "text-warning" },
};

// useRailTracking observes plain agents' state changes, and a run lead's own questions. Workers and reviewers
// are covered by their run's events.
export function useRailTracking(agents: AgentVM[], lineage: Lineage): void {
    const shellTasks = useAtomValue(shellTasksByIdAtom);
    const shellReadAt = useAtomValue(shellReadAtByIdAtom);
    const subagents = useAtomValue(subagentsByIdAtom);
    const plain = agents.filter((a) => lineage.roles[a.id] == null);
    const leads = agents.flatMap((a) => {
        const role = lineage.roles[a.id];
        return role?.kind === "lead" ? [{ agent: a, title: lineage.runs[role.runId]?.title || a.name }] : [];
    });
    const leadsKey = leads.map((l) => `${l.agent.id}:${l.agent.state}`).join(",");
    useEffect(() => {
        const { events, next } = leadAskEvents(globalStore.get(leadSnapsAtom), leads, Date.now());
        globalStore.set(leadSnapsAtom, next);
        if (events.length > 0) {
            globalStore.set(agentEventsAtom, (prev) => mergeRailEvents([events, prev], RAIL_MAX));
        }
    }, [leadsKey]);
    const standingBy = new Set(
        plain.filter((a) => isStandingBy(a.state, shellTasks[a.id] ?? [], subagents[a.id] ?? [])).map((a) => a.id)
    );
    const pending = new Set(plain.filter((a) => shellReadPending(a, shellReadAt[a.id])).map((a) => a.id));
    const key = plain.map((a) => `${a.id}:${a.state}:${standingBy.has(a.id)}:${pending.has(a.id)}`).join(",");
    useEffect(() => {
        const { events, next } = agentTransitions(globalStore.get(snapsAtom), plain, Date.now(), standingBy, pending);
        globalStore.set(snapsAtom, next);
        if (events.length > 0) {
            globalStore.set(agentEventsAtom, (prev) => mergeRailEvents([events, prev], RAIL_MAX));
        }
    }, [key]);
    // an ask's question can land after the state change that recorded it
    const askers = [...plain, ...leads.map((l) => l.agent)];
    const questionsKey = askers
        .filter((a) => a.state === "asking")
        .map((a) => `${a.id}:${a.ask?.questions?.[0]?.question ?? ""}`)
        .join("\n");
    useEffect(() => {
        globalStore.set(agentEventsAtom, (prev) => fillAskedText(prev, askers));
    }, [key, leadsKey, questionsKey]);
}

// useRailRows is the rail's list: plain-agent and run events merged, narrowed to the project scope, and split
// at the last "mark all read".
export function useRailRows(
    model: AgentsViewModel,
    lineage: Lineage,
    runEvents: Record<string, RunEvent[]>
): { all: RailEvent[]; fresh: RailEvent[]; old: RailEvent[] } {
    const agentEvents = useAtomValue(agentEventsAtom);
    const seen = useAtomValue(railSeenAtom);
    const agents = useAtomValue(model.agentsAtom);
    const projectFilter = useAtomValue(model.projectFilterAtom);
    const all = useMemo(() => {
        const leadOf = (runId: string) =>
            Object.entries(lineage.roles).find(([, r]) => r.kind === "lead" && r.runId === runId)?.[0];
        const runLists = Object.values(lineage.runs).map((r) =>
            runRailEvents(r, runEvents[r.runId] ?? [], leadOf(r.runId))
        );
        return scopeRailRows(mergeRailEvents([agentEvents, ...runLists]), agents, lineage, projectFilter);
    }, [agentEvents, lineage, runEvents, agents, projectFilter]);
    return { all, ...splitUnreadScoped(all, seen, agents, lineage) };
}

export function CockpitEventsRail({
    model,
    lineage,
    runEvents,
    tags,
    onSelect,
}: {
    model: AgentsViewModel;
    lineage: Lineage;
    runEvents: Record<string, RunEvent[]>;
    // a plain agent's standing ("background", "idle"), shown beside its name
    tags: Record<string, string>;
    onSelect: (id: string) => void;
}) {
    // the 1s clock only moves the age labels; the list itself changes with the events
    const now = useAtomValue(model.nowAtom);
    const { all, fresh, old } = useRailRows(model, lineage, runEvents);
    const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
    // an event arriving while the rail is open enters as a card; keyed on the project scope, so the rows already
    // there when the rail opens or the scope changes never cascade. Committed in a layout effect: render can run twice
    const projectFilter = useAtomValue(model.projectFilterAtom);
    const scopeKey = projectFilter ?? "";
    const ids = all.map((e) => e.key);
    const entranceRef = useRef(initialEntranceState());
    const { animate: entering } = computeEntrances(entranceRef.current, scopeKey, ids);
    const idsKey = ids.join(",");
    useLayoutEffect(() => {
        entranceRef.current = computeEntrances(entranceRef.current, scopeKey, ids).state;
    }, [idsKey, scopeKey]);
    const row = (e: RailRow, isNew: boolean) => {
        const k = KIND[e.kind];
        const tag = e.group == null && e.focusId ? tags[e.focusId] : undefined;
        return (
            <motion.div
                key={e.key}
                data-rail-event={e.key}
                variants={cardVariants}
                initial={entering.has(e.key) ? "initial" : false}
                animate="animate"
                role="button"
                tabIndex={-1}
                onClick={() => e.focusId && onSelect(e.focusId)}
                className={cn(
                    "grid cursor-pointer grid-cols-[16px_minmax(0,1fr)_auto] gap-x-2.5 rounded-[7px] p-2 hover:bg-surface-raised",
                    isNew && "bg-accent/[0.05]"
                )}
            >
                <span className={cn("flex justify-center pt-px", k.tone)}>
                    <k.icon size={13} aria-hidden />
                </span>
                <div className="flex min-w-0 flex-col gap-[3px]">
                    <div className="flex min-w-0 items-center gap-1.5">
                        <span className="inline-flex min-w-0 items-center gap-[5px] font-mono text-[11.5px] font-semibold text-secondary">
                            {e.group != null ? (
                                <Workflow size={11} aria-hidden className="shrink-0 text-muted" />
                            ) : null}
                            <span className="truncate">{e.who}</span>
                        </span>
                        {tag ? (
                            <span className="shrink-0 rounded-[4px] border border-edge-mid px-[5px] font-mono text-[10.5px] text-muted">
                                {tag}
                            </span>
                        ) : null}
                    </div>
                    {/* a run event's text names the event ("Task failed · t-1"), so its verb would repeat it */}
                    <span className={cn("text-[12px] leading-[1.4]", k.tone)}>
                        {e.group != null && e.text ? (
                            e.text
                        ) : (
                            <>
                                {k.verb}
                                {e.text ? <span className="text-ink-mid"> {e.text}</span> : null}
                            </>
                        )}
                    </span>
                    {e.more ? (
                        <button
                            type="button"
                            onClick={(ev) => {
                                ev.stopPropagation();
                                setOpenGroups((prev) => ({ ...prev, [e.group!]: !prev[e.group!] }));
                            }}
                            className="cursor-pointer self-start border-0 bg-transparent p-0 text-[11px] text-accent hover:text-accent-soft"
                        >
                            {e.more}
                        </button>
                    ) : null}
                </div>
                <div className="flex flex-col items-end gap-1.5 pt-px">
                    <span className="font-mono text-[10.5px] text-muted">{formatAgeShort(now - e.ts)}</span>
                    {isNew ? <span className="h-1.5 w-1.5 rounded-full bg-accent" /> : null}
                </div>
            </motion.div>
        );
    };
    // a group's later events reveal under its first when "+N more" opens them, in their own places in the list
    const rows = (events: RailEvent[], isNew: boolean) => {
        const shown = new Map(groupRailEvents(events, openGroups).map((e) => [e.key, e]));
        const everyGroup = Object.fromEntries(events.flatMap((e) => (e.group != null ? [[e.group, true]] : [])));
        const full = groupRailEvents(events, everyGroup);
        const heads = new Set(full.flatMap((e) => (e.more != null && e.group != null ? [e.group] : [])));
        return full.map((e) => {
            if (e.more != null || e.group == null || !heads.has(e.group)) {
                return row(shown.get(e.key) ?? e, isNew);
            }
            return (
                <PaneReveal key={e.key} open={shown.has(e.key)}>
                    {row(e, isNew)}
                </PaneReveal>
            );
        });
    };
    const section = (label: ReactNode, tone: string, top: boolean) => (
        <div className={cn("flex items-center gap-2 px-2 pb-1", top ? "pt-0.5" : "pt-2.5")}>
            <span className={cn(REGION_LABEL, tone)}>{label}</span>
            <div className="h-px flex-1 bg-border" />
        </div>
    );
    return (
        <MotionConfig reducedMotion="user">
            <div className="-mx-2 flex flex-col gap-1">
                <div className="flex items-center justify-between px-2 pb-2">
                    <SectionLabel>Events</SectionLabel>
                    {fresh.length > 0 ? (
                        <button
                            type="button"
                            onClick={() =>
                                globalStore.set(
                                    railSeenAtom,
                                    markRailRead(
                                        globalStore.get(railSeenAtom),
                                        globalStore.get(model.projectFilterAtom),
                                        all[0].ts
                                    )
                                )
                            }
                            className="cursor-pointer border-0 bg-transparent text-[11.5px] text-accent hover:text-accent-soft"
                        >
                            Mark all read
                        </button>
                    ) : null}
                </div>
                {all.length === 0 ? (
                    <div className="px-2 text-[12px] text-muted">Nothing has changed state yet.</div>
                ) : null}
                {fresh.length > 0
                    ? section(
                          <>
                              {/* keyed on the scope like the rows: a scope switch is a new list, not a count that moved */}
                              New · <TickNumber key={scopeKey} value={fresh.length} />
                          </>,
                          "text-accent-soft",
                          true
                      )
                    : null}
                {/* their own presence: a row mounted later under an ancestor's presence would skip its entrance */}
                <AnimatePresence initial={false}>{rows(fresh, true)}</AnimatePresence>
                {old.length > 0 ? section("Earlier", "text-muted", fresh.length === 0) : null}
                <AnimatePresence initial={false}>{rows(old, false)}</AnimatePresence>
                <span className="px-2 pt-3 text-[11px] leading-[1.5] text-muted">
                    State changes only. Tool calls stay on the cards.
                </span>
            </div>
        </MotionConfig>
    );
}
