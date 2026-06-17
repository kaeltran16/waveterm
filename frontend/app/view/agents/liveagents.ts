// frontend/app/view/agents/liveagents.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The live Agents roster: derived from sessionSidebarViewModelAtom (single source of truth for
// running sessions) + per-block agent status. previous-info + task are fetched on demand for
// asking agents only (spec §10.3). No ask_human / answer routing here (Plan 3b).

import { globalStore } from "@/app/store/jotaiStore";
import { getAgentStatusAtom } from "@/app/tab/sessionsidebar/agentstatusstore";
import { sessionSidebarViewModelAtom } from "@/app/tab/sessionsidebar/sessionsidebarmodel";
import { flattenVisualOrder } from "@/app/tab/sessionsidebar/sessionviewmodel";
import { atom, type Atom, type PrimitiveAtom } from "jotai";
import { agentVMFromInput, askingCount, type AgentEntry, type AgentVM } from "./agentsviewmodel";
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
        agents.push(
            agentVMFromInput(
                {
                    id: row.tabId,
                    name: row.label,
                    status: row.status,
                    detail: row.detail,
                    model: row.model,
                    ts: status.ts,
                    transcriptPath: status.transcriptpath,
                },
                now
            )
        );
    }
    return agents;
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
export async function ensurePreviousInfo(id: string, transcriptPath: string): Promise<void> {
    if (!transcriptPath || previousInfoLoading.has(id)) {
        return;
    }
    if (globalStore.get(previousInfoByIdAtom)[id]) {
        return;
    }
    previousInfoLoading.add(id);
    try {
        const result = await fetchPreviousInfo(transcriptPath);
        const current = globalStore.get(previousInfoByIdAtom);
        globalStore.set(previousInfoByIdAtom, { ...current, [id]: { entries: result.entries, title: result.title } });
    } finally {
        previousInfoLoading.delete(id);
    }
}
