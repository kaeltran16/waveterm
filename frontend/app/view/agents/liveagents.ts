// frontend/app/view/agents/liveagents.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The live Agents roster: derived from sessionSidebarViewModelAtom (single source of truth for
// running sessions) + per-block agent status. previous-info + task are fetched on demand for
// asking agents only (spec §10.3). ask routing via getAgentAskAtom + withAsk (Plan 3c).

import { globalStore } from "@/app/store/jotaiStore";
import { getAgentStatusAtom, getAgentUsageAtom } from "@/app/view/agents/session-models/agentstatusstore";
import { sessionSidebarViewModelAtom } from "@/app/view/agents/session-models/sessionsidebarmodel";
import { flattenVisualOrder } from "@/app/view/agents/session-models/sessionviewmodel";
import { atom, type Atom, type PrimitiveAtom } from "jotai";
import { agentVMFromInput, askingCount, deriveTerminalVMs, isAskStale, withAsk, type AgentEntry, type AgentVM } from "./agentsviewmodel";
import { getAgentAskAtom } from "./agentaskstore";
import { fetchPreviousInfo } from "./previousinfo";

interface PreviousInfoEntry {
    entries: AgentEntry[];
    title?: string;
}

// id (tabId) -> fetched previous-info + title; filled by ensurePreviousInfo for asking agents.
export const previousInfoByIdAtom = atom<Record<string, PreviousInfoEntry>>({}) as PrimitiveAtom<Record<string, PreviousInfoEntry>>;

// in-flight guard so the view effect doesn't double-fetch the same agent
const previousInfoLoading = new Set<string>();

// The roster without previous-info: every running session that has emitted an agent status,
// mapped to an AgentVM. Sessions with no agent status (plain shells, the Agents tab itself) are
// excluded. Recomputes on any sidebar/status change; age is computed at recompute time.
export const liveAgentBaseAtom: Atom<AgentVM[]> = atom((get) => {
    const vm = get(sessionSidebarViewModelAtom);
    const now = Date.now();
    const agents: AgentVM[] = [];
    for (const row of flattenVisualOrder(vm)) {
        if (!row.termBlockOref) {
            continue;
        }
        const status = get(getAgentStatusAtom(row.termBlockOref));
        if (!status?.state) {
            continue; // not an agent (no status emitted) — skip
        }
        const vm = agentVMFromInput(
            {
                id: row.tabId,
                name: row.label,
                status: row.status,
                detail: row.detail,
                agent: status.agent,
                model: row.model,
                ts: status.ts,
                transcriptPath: status.transcriptpath,
                blockId: row.termBlockOref?.split(":")[1],
                project: row.projectLabel,
            },
            now
        );
        vm.usage = get(getAgentUsageAtom(row.termBlockOref));
        const ask = get(getAgentAskAtom(row.termBlockOref));
        const effectiveAsk = ask && !isAskStale(ask.ts, status.ts, status.state) ? ask : null;
        agents.push(withAsk(vm, effectiveAsk, now));
    }
    return agents;
});

// The plain-terminal sessions (background terminals launched via New Agent): rows that own a term
// block but never emitted an agent status. Rendered by the Agent surface separately from the roster
// (own tree group + focus pane), so they never pollute agentsAtom / the cockpit grid counts.
export const liveTerminalsAtom: Atom<AgentVM[]> = atom((get) => {
    const vm = get(sessionSidebarViewModelAtom);
    return deriveTerminalVMs(flattenVisualOrder(vm), (oref) => !!get(getAgentStatusAtom(oref))?.state);
});

// The rendered roster: base agents with fetched previous-info + task merged onto asking agents.
export const liveAgentsAtom: Atom<AgentVM[]> = atom((get) => {
    const base = get(liveAgentBaseAtom);
    const info = get(previousInfoByIdAtom);
    return base.map((a) => {
        if (a.state !== "asking") {
            return a;
        }
        const pi = info[a.id];
        if (!pi) {
            return a;
        }
        return { ...a, previousInfo: pi.entries, task: pi.title ?? a.task };
    });
});

// The sidebar badge count — derived from the base roster (no need to wait on previous-info).
export const liveAskingCountAtom: Atom<number> = atom((get) => askingCount(get(liveAgentBaseAtom)));

/** Fetch + cache previous-info (and the ai-title task) for one asking agent. Idempotent: skips if
 *  already loaded or in flight. Fetched once when the agent enters asking — the question moment;
 *  it is not refreshed while the agent stays asking (a noted 3a limitation). */
export async function ensurePreviousInfo(id: string, transcriptPath: string, agent?: string): Promise<void> {
    if (!transcriptPath || previousInfoLoading.has(id)) {
        return;
    }
    if (globalStore.get(previousInfoByIdAtom)[id]) {
        return;
    }
    previousInfoLoading.add(id);
    try {
        const result = await fetchPreviousInfo(transcriptPath, agent);
        const current = globalStore.get(previousInfoByIdAtom);
        globalStore.set(previousInfoByIdAtom, { ...current, [id]: { entries: result.entries, title: result.title } });
    } finally {
        previousInfoLoading.delete(id);
    }
}
