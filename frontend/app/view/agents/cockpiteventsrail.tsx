// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The fleet's state changes, which the project Overview's Finished region reads. Plain-agent transitions are
// tracked by useRailTracking in the always-mounted shell (cockpit-root.tsx), so a finish while another surface
// shows is still recorded.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, useAtomValue, type PrimitiveAtom } from "jotai";
import { useEffect } from "react";
import type { AgentState, AgentVM } from "./agentsviewmodel";
import {
    agentTransitions,
    fillAskedText,
    leadAskEvents,
    mergeRailEvents,
    NO_RAIL_SEEN,
    RAIL_MAX,
    type AgentSnap,
    type RailEvent,
    type RailSeen,
} from "./cockpitevents";
import type { Lineage } from "./runlineage";
import { isStandingBy } from "./shelltasks";
import { shellReadAtByIdAtom, shellReadPending, shellTasksByIdAtom } from "./shelltasksstore";
import { subagentsByIdAtom } from "./subagentsstore";

const snapsAtom = atom<Record<string, AgentSnap>>({}) as PrimitiveAtom<Record<string, AgentSnap>>;
const leadSnapsAtom = atom<Record<string, AgentState>>({}) as PrimitiveAtom<Record<string, AgentState>>;
// exported for reading only (the project Overview's Finished region): useRailTracking writes the events, and the
// seen marks were written by the Events rail, which is gone, so they stay at none
export const agentEventsAtom = atom<RailEvent[]>([]) as PrimitiveAtom<RailEvent[]>;
export const railSeenAtom = atom<RailSeen>(NO_RAIL_SEEN) as PrimitiveAtom<RailSeen>;

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
