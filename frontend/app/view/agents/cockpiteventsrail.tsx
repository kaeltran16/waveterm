// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Events rail: state changes across the fleet, new ones above a "mark all read" line. Plain-agent
// transitions are tracked by useRailTracking while the cockpit is mounted; run events come from the surface.

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { atom, useAtomValue, type PrimitiveAtom } from "jotai";
import { useEffect, useMemo } from "react";
import type { AgentsViewModel } from "./agents";
import { formatAgo, type AgentVM } from "./agentsviewmodel";
import {
    agentTransitions,
    mergeRailEvents,
    RAIL_MAX,
    runRailEvents,
    splitUnread,
    type AgentSnap,
    type RailEvent,
    type RailKind,
} from "./cockpitevents";
import type { Lineage } from "./runlineage";

const snapsAtom = atom<Record<string, AgentSnap>>({}) as PrimitiveAtom<Record<string, AgentSnap>>;
const agentEventsAtom = atom<RailEvent[]>([]) as PrimitiveAtom<RailEvent[]>;
const seenTsAtom = atom<number>(0) as PrimitiveAtom<number>;

const KIND: Record<RailKind, { glyph: string; verb: string; tone: string }> = {
    asked: { glyph: "◆", verb: "asked", tone: "text-warning" },
    answered: { glyph: "›", verb: "answered", tone: "text-accent-soft" },
    finished: { glyph: "✓", verb: "finished", tone: "text-accent-soft" },
    quiet: { glyph: "○", verb: "went quiet", tone: "text-warning" },
    failed: { glyph: "✕", verb: "failed", tone: "text-error" },
    told: { glyph: "›", verb: "you told", tone: "text-accent-soft" },
    landed: { glyph: "●", verb: "landed", tone: "text-success" },
};

// useRailTracking observes plain agents' state changes. Workers and leads are covered by their run's events.
export function useRailTracking(agents: AgentVM[], lineage: Lineage): void {
    const plain = agents.filter((a) => lineage.roles[a.id] == null);
    const key = plain.map((a) => `${a.id}:${a.state}`).join(",");
    useEffect(() => {
        const { events, next } = agentTransitions(globalStore.get(snapsAtom), plain, Date.now());
        globalStore.set(snapsAtom, next);
        if (events.length > 0) {
            globalStore.set(agentEventsAtom, (prev) => mergeRailEvents([events, prev], RAIL_MAX));
        }
    }, [key]);
}

export function CockpitEventsRail({
    model,
    lineage,
    runEvents,
    onSelect,
}: {
    model: AgentsViewModel;
    lineage: Lineage;
    runEvents: Record<string, RunEvent[]>;
    onSelect: (id: string) => void;
}) {
    const now = useAtomValue(model.nowAtom);
    const agentEvents = useAtomValue(agentEventsAtom);
    const seenTs = useAtomValue(seenTsAtom);
    // the 1s clock only moves the "ago" labels; the list itself changes with the events
    const all = useMemo(() => {
        const leadOf = (runId: string) =>
            Object.entries(lineage.roles).find(([, r]) => r.kind === "lead" && r.runId === runId)?.[0];
        const runLists = Object.values(lineage.runs).map((r) =>
            runRailEvents(r, runEvents[r.runId] ?? [], leadOf(r.runId))
        );
        return mergeRailEvents([agentEvents, ...runLists]);
    }, [agentEvents, lineage, runEvents]);
    const { fresh, old } = splitUnread(all, seenTs);
    if (all.length === 0) {
        return <div className="text-[12px] text-muted">Nothing has changed state yet.</div>;
    }
    const row = (e: RailEvent, isNew: boolean) => {
        const k = KIND[e.kind];
        return (
            <button
                key={e.key}
                type="button"
                onClick={() => e.focusId && onSelect(e.focusId)}
                className={cn(
                    "flex w-full gap-[11px] border-b border-border py-[9px] text-left hover:bg-surface-hover",
                    isNew && "bg-accent/[0.05]"
                )}
            >
                <span className={cn("mt-px w-3 shrink-0 text-center font-mono text-[11px]", k.tone)}>{k.glyph}</span>
                <div className="min-w-0 flex-1">
                    <div className="text-[12px] leading-[1.4] text-secondary">
                        <span className="font-mono font-semibold text-primary">{e.who}</span>{" "}
                        <span className={k.tone}>{k.verb}</span>
                        {e.text ? <span className="text-secondary"> · {e.text}</span> : null}
                    </div>
                    <div className="mt-[3px] font-mono text-[10px] text-muted">{formatAgo(now - e.ts)}</div>
                </div>
            </button>
        );
    };
    return (
        <div>
            <div className="mb-3 flex items-center justify-between">
                <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Events</h3>
                {fresh.length > 0 ? (
                    <button
                        type="button"
                        onClick={() => globalStore.set(seenTsAtom, all[0].ts)}
                        className="cursor-pointer border-0 bg-transparent text-[11.5px] text-accent"
                    >
                        Mark {fresh.length} read
                    </button>
                ) : null}
            </div>
            <div className="flex flex-col">
                {fresh.map((e) => row(e, true))}
                {old.map((e) => row(e, false))}
            </div>
        </div>
    );
}
