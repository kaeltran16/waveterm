// frontend/app/view/agents/railstore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Cockpit rail state: the agent details-rail toggle + the channels context-rail toggle (both
// global, persisted) plus a thin git load for the agent rail (branch + changed-file list, no
// per-file diff). Mirrors filesstore.ts but lighter — the rail shows the list, not the diff.
// cwd resolution is shared via agentcwdresolve.ts.

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

// Channels context-rail expanded state (localStorage "channel.rail.open", default collapsed so
// narrow panes keep maximum message width; replaces the old @[1320px] container-query auto-show).
export const channelRailOpenAtom = atomWithStorage("channel.rail.open", false);

// Channels Jarvis-profile drawer (the header ⚙). It shares the context rail's right-edge slot instead
// of stacking beside it: while this is open the context rail force-collapses to 0 (see ContextPanel),
// so only one right rail is ever visible. Session-scoped, not persisted.
export const profileRailOpenAtom = atom(false);

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
        // worktreeBase: show the branch's changed-file list vs its merge-base, matching the card pill
        // and Files surface (a plain vs-HEAD list would drop committed files).
        const ch = await RpcApi.GitChangesCommand(TabRpcClient, { cwd, worktreebase: true });
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
