// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Per-agent git branch cache for the AgentTree rows. Kept separate from cardgitstore (whose lifecycle
// is tied to the cockpit grid's stream ownership and clears on unmount) so the always-mounted Agent
// surface shows real branches even when opened straight from boot. Branch rarely changes, so each id is
// resolved once and re-resolved only when its cwd source (transcript path / block) changes — no polling.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { resolveCwd } from "./agentcwdresolve";

// agentId -> current branch name. Absent = unresolved (row shows a neutral fallback, never a fake "main").
export const agentBranchesAtom = atom<Record<string, string>>({}) as PrimitiveAtom<Record<string, string>>;

// last cwd-source key resolved per id, so a moved/rebased agent re-resolves but a steady one doesn't refetch
const resolvedKey = new Map<string, string>();

export async function loadAgentBranch(id: string, transcriptPath: string | undefined, blockId?: string): Promise<void> {
    const key = `${transcriptPath ?? ""}|${blockId ?? ""}`;
    if (resolvedKey.get(id) === key) {
        return;
    }
    resolvedKey.set(id, key);
    const cwd = await resolveCwd(transcriptPath, blockId);
    if (resolvedKey.get(id) !== key || !cwd) {
        return;
    }
    try {
        const ch = await RpcApi.GitChangesCommand(TabRpcClient, { cwd });
        if (resolvedKey.get(id) !== key) {
            return;
        }
        if (ch.isrepo && ch.branch) {
            globalStore.set(agentBranchesAtom, (prev) => ({ ...prev, [id]: ch.branch }));
        }
    } catch {
        // leave unresolved — the tree row keeps its neutral fallback
    }
}
