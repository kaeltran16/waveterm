// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Skills tab's state and its agentsync loaders. Module-level atoms, like setupstore.ts: the keep
// choices must survive a surface switch.

import { openFileInCode } from "@/app/cockpit/openfilestore";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import type { AgentsViewModel } from "./agents";
import { busy, errText, READ_TIMEOUT_MS } from "./setupstore";
import { adoptKeep, type SkillKeep } from "./skillsmatrix";

export const setupSkillsAtom = atom<CommandAgentSyncSkillsRtnData | null>(
    null
) as PrimitiveAtom<CommandAgentSyncSkillsRtnData | null>;
export const setupSkillKeepAtom = atom<SkillKeep>({}) as PrimitiveAtom<SkillKeep>;
export const setupSkillSelectedAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const setupSkillsErrorAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

export async function loadSkills(): Promise<void> {
    try {
        globalStore.set(
            setupSkillsAtom,
            await RpcApi.AgentSyncSkillsCommand(TabRpcClient, { timeout: READ_TIMEOUT_MS })
        );
        // a read that failed on an earlier visit must not leave its banner over fresh data
        globalStore.set(setupSkillsErrorAtom, null);
    } catch (e) {
        globalStore.set(setupSkillsErrorAtom, errText(e));
    }
}

export function selectSkill(name: string): void {
    globalStore.set(setupSkillSelectedAtom, name);
}

export function setSkillKeep(name: string, runtime: string | null): void {
    const { [name]: _, ...rest } = globalStore.get(setupSkillKeepAtom);
    globalStore.set(setupSkillKeepAtom, runtime == null ? rest : { ...rest, [name]: runtime });
}

// Moves every adoptable skill into the vault; an undecided one without a keep stays where it is.
export function adoptSkills(): Promise<void> {
    return busy(setupSkillsErrorAtom, async () => {
        const data = globalStore.get(setupSkillsAtom);
        if (data == null) {
            return;
        }
        const keep = adoptKeep(data, globalStore.get(setupSkillKeepAtom));
        // a failed adopt may have moved some skills already, so the matrix is re-read either way
        try {
            await RpcApi.AgentSyncAdoptCommand(TabRpcClient, { apply: true, keep });
            globalStore.set(setupSkillKeepAtom, {});
        } finally {
            await loadSkills();
        }
    });
}

export function openSkillFile(model: AgentsViewModel, path: string): Promise<void> {
    return busy(setupSkillsErrorAtom, () => openFileInCode(model, path));
}
