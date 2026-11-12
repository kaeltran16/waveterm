// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A run card's engine actions, whether clicked or keyed: one path, so a refusal always shows on the card.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { settingsChangePayload } from "../jarvis/runsettings";
import { dagActionRoute } from "../orchestrate/dagstore";
import { ACTION_LABEL, taskStamp, type CardError, type RowAction, type TaskRowVM } from "./leadcardmodel";
import type { RunInfo } from "./runlineage";

type ActionRun = Pick<RunInfo, "runId" | "channelId" | "dag" | "digest">;

// the one task row whose Tell input is open; a key or a click opens it
export const tellingRowAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

// the guidance typed under a failed review, per run and task (reviewGuideKey): shared by the row's Send back button
// and its keyed action, so a key sends what the box holds
export const reviewGuideAtom = atom<Record<string, string>>({}) as PrimitiveAtom<Record<string, string>>;
export const reviewGuideKey = (runId: string, taskId: string) => `${runId}:${taskId}`;

// the last refusal per run id; an action that starts clears its run's entry, and the card hides a task's once that
// task has moved on (cardErrorShown)
export const runCardErrorAtom = atom<Record<string, CardError>>({}) as PrimitiveAtom<Record<string, CardError>>;

function setRunError(runId: string, err: CardError | undefined) {
    globalStore.set(runCardErrorAtom, (prev) => {
        const { [runId]: _, ...rest } = prev;
        return err == null ? rest : { ...rest, [runId]: err };
    });
}

// runCardAction runs one engine action and shows its refusal on the run's card. A task action's refusal reads
// "<Label> t-4: <message>" and is stamped with the task as it stood when the action ran.
export async function runCardAction(
    runId: string,
    label: string,
    fn: () => Promise<unknown>,
    task?: { taskId: string; stamp: string }
): Promise<void> {
    setRunError(runId, undefined);
    try {
        await fn();
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setRunError(runId, task ? { msg: `${label}: ${msg}`, ...task } : { msg: `${label} failed: ${msg}` });
    }
}

// taskAction runs an action on one task; with no task (cancel, relaunch-lead) the refusal is the run's
function taskAction(run: ActionRun, taskId: string, action: string, fn: () => Promise<unknown>): Promise<void> {
    if (!taskId) {
        return runCardAction(run.runId, action, fn);
    }
    const label = ACTION_LABEL[action as keyof typeof ACTION_LABEL] ?? action;
    return runCardAction(run.runId, `${label} ${taskId}`, fn, { taskId, stamp: taskStamp(run, taskId) });
}

export function dagAction(run: ActionRun, taskId: string, action: string, notes?: string): Promise<void> {
    return taskAction(run, taskId, action, async () => {
        await RpcApi.DagActionCommand(TabRpcClient, {
            channelid: run.channelId,
            runid: run.runId,
            taskid: taskId,
            action,
            ...(notes ? { notes } : {}),
        });
        // the guidance was this round's; left in the box, a later round's keyed Send back would send it again
        if (action === "sendback") {
            const key = reviewGuideKey(run.runId, taskId);
            globalStore.set(reviewGuideAtom, ({ [key]: _, ...rest }) => rest);
        }
    });
}

// setRunParallelism is the Adjust panel's Save. SetRunSettings applies every dial it is sent, so the rest go as
// the dag holds them.
export function setRunParallelism(
    run: Pick<RunInfo, "runId" | "channelId" | "dag">,
    parallelism: number
): Promise<void> {
    return RpcApi.SetRunSettingsCommand(
        TabRpcClient,
        settingsChangePayload(run.channelId, run.runId, null, run.dag ?? null, { parallelism })
    );
}

// rowAction runs a task row's action, clicked or keyed. Tell opens the row's input; Continue is the DAG view's
// resolve (merge --continue), which lands a merge fixed in the project tree or re-runs its Verify.
export function rowAction(
    run: ActionRun,
    row: Pick<TaskRowVM, "key" | "taskId">,
    action: RowAction | string
): Promise<void> {
    if (action === "tell") {
        globalStore.set(tellingRowAtom, row.key);
        return Promise.resolve();
    }
    if (dagActionRoute(action) === "continue") {
        return taskAction(run, row.taskId, "resolve", () =>
            RpcApi.DagMergeContinueCommand(TabRpcClient, {
                channelid: run.channelId,
                runid: run.runId,
                taskid: row.taskId,
            })
        );
    }
    if (action === "sendback") {
        const notes = globalStore.get(reviewGuideAtom)[reviewGuideKey(run.runId, row.taskId)]?.trim();
        return dagAction(run, row.taskId, action, notes || undefined);
    }
    return dagAction(run, row.taskId, action);
}
