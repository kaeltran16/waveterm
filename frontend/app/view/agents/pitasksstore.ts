// frontend/app/view/agents/pitasksstore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Read-only pi-tasks mirror for the agent detail rail. Mirrors recentsessionsstore.ts (a
// single atom for the focused agent; null = not loaded, [] = loaded-empty) and
// railstore.ts loadRailForAgent (cwd resolution + stale-focus guard).

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { resolveCwd } from "./agentcwdresolve";

export const tasksAtom = atom<PiTask[] | null>(null) as PrimitiveAtom<PiTask[] | null>;

// guards against a stale focus's load overwriting a newer one (same pattern as railstore.ts)
const current = { id: "" };

export async function loadTasksForAgent(
    id: string,
    transcriptPath: string | undefined,
    blockId?: string
): Promise<void> {
    current.id = id;
    globalStore.set(tasksAtom, null);
    const cwd = await resolveCwd(transcriptPath, blockId);
    if (current.id !== id) {
        return;
    }
    if (!cwd) {
        globalStore.set(tasksAtom, []);
        return;
    }
    try {
        const rtn = await RpcApi.GetTasksCommand(TabRpcClient, { cwd });
        if (current.id !== id) {
            return;
        }
        globalStore.set(tasksAtom, rtn.tasks ?? []);
    } catch {
        if (current.id === id) {
            globalStore.set(tasksAtom, []); // scan failure -> empty, never breaks the rail
        }
    }
}
