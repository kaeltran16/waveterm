// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { atom, type PrimitiveAtom } from "jotai";
import { recordRateLimit } from "../ratelimitstore";
import { persistClaudeResume } from "./agentresumestore";

function invertPct(pct: number | undefined): number | undefined {
    if (pct == null) {
        return undefined;
    }
    return Math.max(0, Math.min(100, 100 - pct));
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
                globalStore.set(getAgentStatusAtom(data.oref), data);
                // resume-on-reopen: bake this Claude session's --resume key into the block's launch command
                void persistClaudeResume(data.oref, data.agent, data.transcriptpath);
                if (data.state === "idle") {
                    // turn ended: reset the manual subagent-expand override (disk-backed list persists)
                    globalStore.set(getSubagentExpandAtom(data.oref), undefined);
                }
            }
        },
    });
}
