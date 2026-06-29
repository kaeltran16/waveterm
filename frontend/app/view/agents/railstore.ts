// frontend/app/view/agents/railstore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Agent details-rail state: the rail visibility toggle (global, persisted) + a thin git load
// (branch + changed-file list, no per-file diff). Mirrors filesstore.ts but lighter — the rail
// shows the list, not the diff. cwd resolution is shared via agentcwdresolve.ts.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { resolveCwd } from "./agentcwdresolve";
import { parseGitChanges, type GitChanges } from "./gitstatus";

export interface RailGitState {
    cwd: string | null;
    branch: string;
    isRepo: boolean;
    changes: GitChanges | null;
}

// First persisted FE pref in frontend/app: rail is global + off by default (localStorage key
// "agent.rail.visible"). Keep persisted prefs to this one atom for now.
export const railVisibleAtom = atomWithStorage("agent.rail.visible", false);

// Terminal-fullscreen toggle for the Agent surface: when on, the AgentTree (and the rail) are
// hidden so the focused agent's live terminal fills the surface. Session-scoped UI, not persisted.
export const terminalFullscreenAtom = atom(false);

export const railStateAtom = atom<RailGitState | null>(null) as PrimitiveAtom<RailGitState | null>;

// guards against a stale focus's load overwriting a newer one (same pattern as filesstore.ts)
const current = { id: "" };

const EMPTY: RailGitState = { cwd: null, branch: "", isRepo: false, changes: null };

export async function loadRailForAgent(
    id: string,
    transcriptPath: string | undefined,
    blockId?: string
): Promise<void> {
    current.id = id;
    globalStore.set(railStateAtom, null);

    const cwd = await resolveCwd(transcriptPath, blockId);
    if (current.id !== id) {
        return;
    }
    if (!cwd) {
        globalStore.set(railStateAtom, EMPTY);
        return;
    }
    try {
        const ch = await RpcApi.GitChangesCommand(TabRpcClient, { cwd });
        if (current.id !== id) {
            return;
        }
        const changes = ch.isrepo ? parseGitChanges(ch.statusz, ch.numstat) : null;
        globalStore.set(railStateAtom, { cwd, branch: ch.branch, isRepo: ch.isrepo, changes });
    } catch {
        if (current.id === id) {
            globalStore.set(railStateAtom, { ...EMPTY, cwd });
        }
    }
}
