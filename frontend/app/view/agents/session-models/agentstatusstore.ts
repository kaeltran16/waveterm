// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { atom, type PrimitiveAtom } from "jotai";
import { reduceSubagents, type SubagentDelta, type SubagentVM } from "./sessionviewmodel";
import { recordRateLimit } from "../ratelimitstore";

// a completed subagent is noise after a minute; drop it this long after it stops
const COMPLETED_SUBAGENT_TTL_MS = 60_000;

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

// per-block ephemeral subagent list, reduced from start/stop deltas; cleared on the parent's idle transition
const subagentAtoms = new Map<string, PrimitiveAtom<SubagentVM[]>>();

export function getSubagentsAtom(oref: string): PrimitiveAtom<SubagentVM[]> {
    let saAtom = subagentAtoms.get(oref);
    if (!saAtom) {
        saAtom = atom<SubagentVM[]>([]) as PrimitiveAtom<SubagentVM[]>;
        subagentAtoms.set(oref, saAtom);
    }
    return saAtom;
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

function normalizeSubagentStatus(status: string): "success" | "failure" | undefined {
    if (status === "failure") {
        return "failure";
    }
    if (status === "success") {
        return "success";
    }
    return undefined;
}

function scheduleSubagentExpiry(oref: string, id: string) {
    setTimeout(() => {
        const saAtom = getSubagentsAtom(oref);
        const list = globalStore.get(saAtom);
        const next = list.filter((s) => s.id !== id);
        if (next.length !== list.length) {
            globalStore.set(saAtom, next);
        }
    }, COMPLETED_SUBAGENT_TTL_MS);
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
            if (data.subagent != null) {
                const sa = data.subagent;
                const action: SubagentDelta["action"] =
                    sa.action === "stop" ? "stop" : sa.action === "model" ? "model" : "start";
                const delta: SubagentDelta = {
                    action,
                    id: sa.id,
                    type: sa.type ?? "",
                    status: normalizeSubagentStatus(sa.status),
                    model: sa.model,
                };
                const saAtom = getSubagentsAtom(data.oref);
                globalStore.set(saAtom, reduceSubagents(globalStore.get(saAtom), delta));
                if (action === "stop") {
                    scheduleSubagentExpiry(data.oref, sa.id);
                }
            }
            if (data.usage != null) {
                globalStore.set(getAgentUsageAtom(data.oref), data.usage);
                // persist account-level windows so the Usage donuts survive idle (no-op if none present)
                const provider = data.agent ?? globalStore.get(getAgentStatusAtom(data.oref))?.agent ?? "claude";
                recordRateLimit(provider, data.usage);
            }
            // a delta-only event carries an empty state; only a real state update should touch the parent atom
            if (data.state) {
                globalStore.set(getAgentStatusAtom(data.oref), data);
                if (data.state === "idle") {
                    // turn ended: subagent state is ephemeral — clear the list and the manual expand override
                    globalStore.set(getSubagentsAtom(data.oref), []);
                    globalStore.set(getSubagentExpandAtom(data.oref), undefined);
                }
            }
        },
    });
}
