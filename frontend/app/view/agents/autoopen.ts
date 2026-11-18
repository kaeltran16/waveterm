// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Rendered view's auto-open (autoopenmodel.ts): once the agent's turn ends, what it brought opens beside the
// transcript. Only while you are on that agent's Rendered view, so what arrives elsewhere waits until you come back.
// The memory is per agent for this session: a restart starts clean, and what agents did before it is history.

import * as WOS from "@/app/store/wos";
import { useAtomValue } from "jotai";
import { useEffect, useMemo } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentEntry, AgentVM } from "./agentsviewmodel";
import { arrivals, dismissed, EMPTY_MEMORY, offers, remember, type AutoOpenMemory } from "./autoopenmodel";
import { brainstormAtom, brainstormWaitOf } from "./brainstormstore";
import { canvasStateAtom } from "./canvasstore";
import { NO_BLOCK, useCheckoutFacts, useRailGit } from "./railgit";
import { focusSubagentAtom } from "./subagentsstore";
import { tabKey, type WorkspaceTab } from "./workspacemodel";
import { addArrivals, closeWorkspaceTab, rendersNow } from "./workspacestore";

const SESSION_START = Date.now();

const memories = new Map<string, AutoOpenMemory>();

function memoryOf(agentId: string): AutoOpenMemory {
    return memories.get(agentId) ?? EMPTY_MEMORY;
}

// the pane's own close: closing a tab auto-open put there turns that kind down for the session
export function dismissWorkspaceTab(agentId: string, tab: WorkspaceTab): void {
    memories.set(agentId, dismissed(memoryOf(agentId), tab));
    closeWorkspaceTab(agentId, tabKey(tab));
}

export function useAutoOpen(model: AgentsViewModel, agent: AgentVM, entries: AgentEntry[]): void {
    const surface = useAtomValue(model.surfaceAtom);
    const interior = useAtomValue(focusSubagentAtom);
    const bs = useAtomValue(brainstormAtom(agent.id));
    const canvas = useAtomValue(canvasStateAtom(agent.id));
    const block = useAtomValue(
        agent.blockId ? WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", agent.blockId)) : NO_BLOCK
    );
    useRailGit(agent);
    const hasChanges = useCheckoutFacts(model, agent).chip != null;
    const lastEditMs = block?.meta?.["agent:lasteditts"] ?? null;
    const wait = brainstormWaitOf(bs, agent)?.key ?? null;
    const working = agent.state === "working";
    const offered = useMemo(
        () =>
            offers({
                since: SESSION_START,
                entries,
                brainstorm:
                    bs != null ? { path: bs.path, modifiedMs: bs.modifiedMs, wait, run: bs.file?.run ?? null } : null,
                // an agent with a brainstorm never shows its canvas: the brainstorm pane opens its boards
                canvas:
                    bs == null && canvas != null ? { topic: canvas.topic, removed: canvas.status === "removed" } : null,
                lastEditMs,
                hasChanges,
            }),
        [entries, bs, wait, canvas, lastEditMs, hasChanges]
    );
    useEffect(() => {
        if (working || surface !== "agent" || !rendersNow(model, agent.id)) {
            return;
        }
        const memory = memoryOf(agent.id);
        const arrived = arrivals(offered, memory);
        if (arrived.length === 0) {
            return;
        }
        memories.set(agent.id, remember(memory, arrived, addArrivals(agent.id, arrived)));
    }, [working, surface, interior, offered, model, agent.id]);
}
