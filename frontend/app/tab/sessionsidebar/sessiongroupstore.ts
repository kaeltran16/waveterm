// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, type PrimitiveAtom } from "jotai";

// cwd -> resolved service label, filled asynchronously from GetSessionGroupCommand
export const sessionGroupLabelAtom = atom(new Map<string, string>()) as PrimitiveAtom<Map<string, string>>;

const inflight = new Set<string>();

export function ensureSessionGroupLabels(cwds: string[]) {
    const cur = globalStore.get(sessionGroupLabelAtom);
    const todo = cwds.filter((cwd) => cwd && !cur.has(cwd) && !inflight.has(cwd));
    if (todo.length === 0) {
        return;
    }
    for (const cwd of todo) {
        inflight.add(cwd);
        fireAndForget(async () => {
            try {
                const res = await RpcApi.GetSessionGroupCommand(TabRpcClient, { cwd });
                const next = new Map(globalStore.get(sessionGroupLabelAtom));
                next.set(cwd, res.label);
                globalStore.set(sessionGroupLabelAtom, next);
            } finally {
                inflight.delete(cwd);
            }
        });
    }
}
