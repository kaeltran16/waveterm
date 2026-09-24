// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A run card's engine actions, whether clicked or keyed: one path, so a refusal always shows on the card.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { dagActionRoute } from "../orchestrate/dagstore";
import type { RowAction, TaskRowVM } from "./leadcardmodel";
import type { RunInfo } from "./runlineage";

// the one task row whose Tell input is open; a key or a click opens it
export const tellingRowAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

// the last refusal per run id; an action that starts clears its run's entry
export const runCardErrorAtom = atom<Record<string, string>>({}) as PrimitiveAtom<Record<string, string>>;

function setRunError(runId: string, msg: string | undefined) {
    globalStore.set(runCardErrorAtom, (prev) => {
        const { [runId]: _, ...rest } = prev;
        return msg == null ? rest : { ...rest, [runId]: msg };
    });
}

export async function runCardAction(runId: string, label: string, fn: () => Promise<unknown>): Promise<void> {
    setRunError(runId, undefined);
    try {
        await fn();
    } catch (e) {
        setRunError(runId, `${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}

export function dagAction(
    run: Pick<RunInfo, "runId" | "channelId">,
    taskId: string,
    action: string,
    notes?: string
): Promise<void> {
    return runCardAction(run.runId, `${action} ${taskId}`, () =>
        RpcApi.DagActionCommand(TabRpcClient, {
            channelid: run.channelId,
            runid: run.runId,
            taskid: taskId,
            action,
            ...(notes ? { notes } : {}),
        })
    );
}

// rowAction runs a task row's action, clicked or keyed. Tell opens the row's input; Continue is the DAG view's
// resolve (merge --continue), which lands a merge fixed in the project tree or re-runs its Verify.
export function rowAction(
    run: Pick<RunInfo, "runId" | "channelId">,
    row: Pick<TaskRowVM, "key" | "taskId">,
    action: RowAction | string
): Promise<void> {
    if (action === "tell") {
        globalStore.set(tellingRowAtom, row.key);
        return Promise.resolve();
    }
    if (dagActionRoute(action) === "continue") {
        return runCardAction(run.runId, `continue ${row.taskId}`, () =>
            RpcApi.DagMergeContinueCommand(TabRpcClient, {
                channelid: run.channelId,
                runid: run.runId,
                taskid: row.taskId,
            })
        );
    }
    return dagAction(run, row.taskId, action);
}
