// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Skills tab's state and its agentsync loaders. Module-level atoms, like setupstore.ts: the keep
// choices must survive a surface switch.

import { pushToast } from "@/app/cockpit/notificationstore";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { busy, errText, READ_TIMEOUT_MS } from "./setupstore";
import { adoptKeep, adoptResultText, adoptSkip, KEEP_LEAVE, type SkillKeep } from "./skillsmatrix";

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

// choice is a runtime, KEEP_VAULT or KEEP_LEAVE; null returns the skill to its default
export function setSkillKeep(name: string, choice: string | null): void {
    const { [name]: _, ...rest } = globalStore.get(setupSkillKeepAtom);
    globalStore.set(setupSkillKeepAtom, choice == null ? rest : { ...rest, [name]: choice });
}

// Moves every adoptable skill into the vault; an undecided or left-alone one stays where it is. The toast
// counts what the reply says happened, not what the matrix showed before the click.
export function adoptSkills(): Promise<void> {
    return busy(setupSkillsErrorAtom, async () => {
        const data = globalStore.get(setupSkillsAtom);
        if (data == null) {
            return;
        }
        const choices = globalStore.get(setupSkillKeepAtom);
        const sent = { keep: adoptKeep(data, choices), skip: adoptSkip(data, choices) };
        // a failed adopt may have moved some skills already, so the matrix is re-read either way
        try {
            const rtn = await RpcApi.AgentSyncAdoptCommand(TabRpcClient, { apply: true, ...sent });
            pushToast({ title: adoptResultText(rtn, sent), message: "", level: "info" });
            // a snapshot moved nothing, so every choice still stands; otherwise only "leave it" outlives the move
            if (!rtn.dryrun) {
                globalStore.set(
                    setupSkillKeepAtom,
                    Object.fromEntries(Object.entries(choices).filter(([, c]) => c === KEEP_LEAVE))
                );
            }
        } finally {
            await loadSkills();
        }
    });
}
