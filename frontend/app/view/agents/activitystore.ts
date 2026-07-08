// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Activity surface store: the loaded event set (activityEventsAtom), pure group/filter helpers, and
// the impure loader. The loader reads recent session files newest-first (discoverSessions) up to a
// cap and within a recent window; live sessions are just recent files flagged live=true (so Jump
// works) — no separate live-event path, no dedupe (single source).

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { extractEvents, type ActivityEvent, type ActivityType } from "./activityevents";
import { discoverSessions } from "./activitydiscovery";
import type { AgentsViewModel } from "./agents";

export const ACTIVITY_WINDOW_DAYS = 7;
export const ACTIVITY_EVENT_CAP = 200;
export const ACTIVITY_TAIL_LINES = 2000;

export const activityEventsAtom = atom<ActivityEvent[]>([]) as PrimitiveAtom<ActivityEvent[]>;
export const activityLoadedAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;

export interface ActivityGroup {
    project: string;
    count: number;
    attn: number; // unanswered-question events drive the group's attention badge
    events: ActivityEvent[];
}

export function applyFilter(events: ActivityEvent[], filter: ActivityType | "all"): ActivityEvent[] {
    return filter === "all" ? events : events.filter((e) => e.type === filter);
}

// Project scope filter. "all" passes everything; otherwise matches the same normalized key groupByProject
// uses (blank project -> "—") so the chip selection lines up with the rendered groups.
export function applyProjectFilter(events: ActivityEvent[], project: string): ActivityEvent[] {
    return project === "all" ? events : events.filter((e) => (e.project || "—") === project);
}

// Distinct project keys present, most-recent-first (so the chip order matches the group order).
export function activityProjects(events: ActivityEvent[]): string[] {
    const latest = new Map<string, number>();
    for (const e of events) {
        const key = e.project || "—";
        const cur = latest.get(key);
        if (cur == null || e.ts > cur) {
            latest.set(key, e.ts);
        }
    }
    return [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
}

export function groupByProject(events: ActivityEvent[]): ActivityGroup[] {
    const byProj = new Map<string, ActivityEvent[]>();
    for (const ev of events) {
        const key = ev.project || "—";
        const arr = byProj.get(key);
        if (arr) {
            arr.push(ev);
        } else {
            byProj.set(key, [ev]);
        }
    }
    const groups: ActivityGroup[] = [];
    for (const [project, evs] of byProj) {
        const sorted = [...evs].sort((a, b) => b.ts - a.ts);
        groups.push({ project, count: sorted.length, attn: sorted.filter((e) => e.type === "asked").length, events: sorted });
    }
    return groups.sort((a, b) => (b.events[0]?.ts ?? 0) - (a.events[0]?.ts ?? 0));
}

let loading = false;

function norm(p: string): string {
    return p.replace(/\\/g, "/").toLowerCase();
}

export async function loadActivity(model: AgentsViewModel): Promise<void> {
    if (loading) {
        return;
    }
    loading = true;
    try {
        const liveByPath = new Map<string, string>();
        for (const a of globalStore.get(model.agentsAtom)) {
            if (a.transcriptPath) {
                liveByPath.set(norm(a.transcriptPath), a.id);
            }
        }
        const sessions = await discoverSessions();
        const now = Date.now();
        const windowMs = ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
        const events: ActivityEvent[] = [];
        for (const s of sessions) {
            if (events.length >= ACTIVITY_EVENT_CAP) {
                break;
            }
            let lines: string[];
            try {
                const rtn = await RpcApi.GetAgentTranscriptCommand(TabRpcClient, { path: s.path, maxlines: ACTIVITY_TAIL_LINES });
                lines = rtn.lines ?? [];
            } catch {
                continue;
            }
            const liveId = liveByPath.get(norm(s.path));
            const evs = extractEvents(lines, {
                agent: s.agent,
                sessionPath: s.path,
                agentName: s.name,
                project: s.project,
                live: liveId != null,
                liveId,
            });
            for (const ev of evs) {
                if (now - ev.ts <= windowMs) {
                    events.push(ev);
                }
            }
        }
        globalStore.set(activityEventsAtom, events.slice(0, ACTIVITY_EVENT_CAP));
        globalStore.set(activityLoadedAtom, true);
    } finally {
        loading = false;
    }
}
