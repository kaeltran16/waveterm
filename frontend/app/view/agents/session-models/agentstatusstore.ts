// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { atom, type PrimitiveAtom } from "jotai";
import { recordRateLimit } from "../ratelimitstore";
import { persistResume } from "./agentresumestore";

function invertPct(pct: number | undefined): number | undefined {
    if (pct == null) {
        return undefined;
    }
    return Math.max(0, Math.min(100, 100 - pct));
}

// Stable identity/context fields carried on some events but not others (the Claude hook omits
// title+model on Notification/AskUserQuestion; the backend worker emitters carry only state+agent).
// State events are deltas, so an omitted field means "unchanged", not "cleared" — a full replacement
// would wipe the retained title and drop the row label back to the project name until the next
// titled event, i.e. the rename flicker. detail/ts are always transient (current activity / event
// time) and are never retained.
const RETAINED_FIELDS = ["title", "model", "agent", "provider", "cwd", "transcriptpath", "sessionid"] as const;

/** Pure: fold a state-delta event onto the previous status, keeping last-known values for fields the
 *  event omits. null prev (first event) passes through unchanged. */
export function mergeAgentStatusData(prev: AgentStatusData | null, next: AgentStatusData): AgentStatusData {
    if (!prev) {
        return next;
    }
    const merged: AgentStatusData = { ...next };
    for (const field of RETAINED_FIELDS) {
        if (!merged[field]) {
            merged[field] = prev[field];
        }
    }
    return merged;
}

export function normalizeAgentUsage(provider: string, usage: AgentUsage): AgentUsage {
    if (provider.toLowerCase() !== "codex") {
        return usage;
    }
    return {
        ...usage,
        contextpct: invertPct(usage.contextpct),
        fivehourpct: invertPct(usage.fivehourpct),
        weekpct: invertPct(usage.weekpct),
    };
}

// keyed by block ORef string ("block:<uuid>")
const agentStatusAtoms = new Map<string, PrimitiveAtom<AgentStatusData>>();

export function getAgentStatusAtom(oref: string): PrimitiveAtom<AgentStatusData> {
    let statusAtom = agentStatusAtoms.get(oref);
    if (!statusAtom) {
        statusAtom = atom(null) as PrimitiveAtom<AgentStatusData>;
        agentStatusAtoms.set(oref, statusAtom);
    }
    return statusAtom;
}

// per-block latest usage snapshot (context %, cost, plan rate limits); set by usage-only events
const agentUsageAtoms = new Map<string, PrimitiveAtom<AgentUsage>>();

export function getAgentUsageAtom(oref: string): PrimitiveAtom<AgentUsage> {
    let usageAtom = agentUsageAtoms.get(oref);
    if (!usageAtom) {
        usageAtom = atom(null) as PrimitiveAtom<AgentUsage>;
        agentUsageAtoms.set(oref, usageAtom);
    }
    return usageAtom;
}

// per-block manual expand override (undefined = auto). Reset to undefined on the parent's idle transition.
const subagentExpandAtoms = new Map<string, PrimitiveAtom<boolean>>();

export function getSubagentExpandAtom(oref: string): PrimitiveAtom<boolean> {
    let expandAtom = subagentExpandAtoms.get(oref);
    if (!expandAtom) {
        expandAtom = atom(undefined) as PrimitiveAtom<boolean>;
        subagentExpandAtoms.set(oref, expandAtom);
    }
    return expandAtom;
}

export function toggleSubagentExpand(oref: string, currentlyExpanded: boolean) {
    if (!oref) {
        return;
    }
    globalStore.set(getSubagentExpandAtom(oref), !currentlyExpanded);
}

let subscribed = false;
export function setupAgentStatusSubscription() {
    if (subscribed) {
        return;
    }
    subscribed = true;
    waveEventSubscribeSingle({
        eventType: "agent:status",
        handler: (event) => {
            const data = event.data as AgentStatusData;
            if (data?.oref == null) {
                return;
            }
            if (data.usage != null) {
                const provider = data.agent ?? globalStore.get(getAgentStatusAtom(data.oref))?.agent ?? "claude";
                const usage = normalizeAgentUsage(provider, data.usage);
                globalStore.set(getAgentUsageAtom(data.oref), usage);
                // persist account-level windows so the Usage donuts survive idle (no-op if none present)
                recordRateLimit(provider, usage);
            }
            // a delta-only event carries an empty state; only a real state update should touch the parent atom
            if (data.state) {
                const prev = globalStore.get(getAgentStatusAtom(data.oref));
                globalStore.set(getAgentStatusAtom(data.oref), mergeAgentStatusData(prev, data));
                // resume-on-reopen: bake this session's resume key into the block's launch command
                void persistResume(data.oref, data.agent, data.transcriptpath);
                if (data.state === "idle") {
                    // turn ended: reset the manual subagent-expand override (disk-backed list persists)
                    globalStore.set(getSubagentExpandAtom(data.oref), undefined);
                }
            }
        },
    });
}
