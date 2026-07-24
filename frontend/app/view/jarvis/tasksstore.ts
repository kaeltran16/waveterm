// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Tasks surface (U2) state. Module-scope atoms so the selected dossier + loaded detail survive the
// surface unmount on nav-switch (only the agent surface stays mounted). Lives under view/jarvis/.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, type PrimitiveAtom } from "jotai";

export const taskListAtom = atom<SpaceSummary[]>([]) as PrimitiveAtom<SpaceSummary[]>;
export const selectedDossierIdAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const dossierDetailAtom = atom<DossierDetail | null>(null) as PrimitiveAtom<DossierDetail | null>;
export const tasksErrorAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

export function loadTaskList(): void {
    fireAndForget(async () => {
        try {
            const rtn = await RpcApi.ListTaskDossiersCommand(TabRpcClient);
            globalStore.set(taskListAtom, rtn?.dossiers ?? []);
        } catch (e) {
            globalStore.set(tasksErrorAtom, String(e));
        }
    });
}

export function selectDossier(id: string): void {
    globalStore.set(selectedDossierIdAtom, id);
    globalStore.set(dossierDetailAtom, null);
    void reloadDetail(id);
}

async function reloadDetail(id: string): Promise<void> {
    try {
        const detail = await RpcApi.GetDossierCommand(TabRpcClient, { dossierid: id });
        if (globalStore.get(selectedDossierIdAtom) === id) {
            globalStore.set(dossierDetailAtom, detail ?? null);
        }
    } catch (e) {
        globalStore.set(tasksErrorAtom, String(e));
    }
}

// appendDecision writes a human-authored decision, then reloads the open dossier detail so the new
// card appears. Errors surface into tasksErrorAtom (graceful degradation — never throws to the UI).
export function appendDecision(dossierId: string, summary: string, rationale: string, links: string[]): void {
    fireAndForget(async () => {
        try {
            await RpcApi.AppendDossierDecisionCommand(TabRpcClient, {
                dossierid: dossierId,
                summary,
                rationale,
                links,
            });
            await reloadDetail(dossierId);
        } catch (e) {
            globalStore.set(tasksErrorAtom, String(e));
        }
    });
}

// setDossierStatus transitions a dossier's status, then reloads detail + the list (the row may move
// group or drop out).
export function setDossierStatus(dossierId: string, status: string): void {
    fireAndForget(async () => {
        try {
            await RpcApi.SetDossierStatusCommand(TabRpcClient, { dossierid: dossierId, status });
            await reloadDetail(dossierId);
            loadTaskList();
        } catch (e) {
            globalStore.set(tasksErrorAtom, String(e));
        }
    });
}
