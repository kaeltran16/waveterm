// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The record *list* and its error channel. Module-scope atoms so they survive the surface unmount on
// nav-switch (only the agent surface stays mounted). A record's own detail lives in jarvissubjectstore's
// recordDetailAtom, and every write to a record goes through recordactions.ts. Lives under view/jarvis/.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, type PrimitiveAtom } from "jotai";

// null until the first load lands: "no records yet" and "the list has not arrived" are different states,
// and the boot-time subject restore has to tell them apart. Matches channelsAtom.
export const taskListAtom = atom<SpaceSummary[] | null>(null) as PrimitiveAtom<SpaceSummary[] | null>;
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
