// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Background shell tasks per agent, read from its transcript tail. Mirrors subagentsstore.ts: refresh
// on enter, scheduleShellTasks (debounced) on transcript activity, drop on leave. Standing by is not
// stored here: consumers derive it with isStandingBy from the agent's state and its entry.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { extractShellTasks, peekText, SHELL_TAIL_LINES, visibleShellTasks, type ShellTask } from "./shelltasks";

// per agent-id -> its running and failed shell tasks
export const shellTasksByIdAtom = atom<Record<string, ShellTask[]>>({}) as PrimitiveAtom<Record<string, ShellTask[]>>;

// transcript activity stops while an agent sits idle, so a running task's finish is only seen by polling
export const SHELL_POLL_MS = 5000;

const DEBOUNCE_MS = 4000; // same cadence as subagentsstore
const PEEK_TAIL_LINES = 80;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const loadSeq = new Map<string, number>();

function setList(id: string, list: ShellTask[] | null): void {
    const cur = globalStore.get(shellTasksByIdAtom);
    if (list == null || list.length === 0) {
        if (!(id in cur)) {
            return;
        }
        const { [id]: _, ...rest } = cur;
        globalStore.set(shellTasksByIdAtom, rest);
        return;
    }
    globalStore.set(shellTasksByIdAtom, { ...cur, [id]: list });
}

/** Tail the agent's transcript, project its shell tasks, and store them. Guarded so a superseding
 *  load (or a drop) discards a slower older result. */
export async function refreshShellTasks(id: string, transcriptPath: string | undefined): Promise<void> {
    const seq = (loadSeq.get(id) ?? 0) + 1;
    loadSeq.set(id, seq);
    if (!transcriptPath) {
        setList(id, null);
        return;
    }
    try {
        const tr = await RpcApi.GetAgentTranscriptCommand(TabRpcClient, {
            path: transcriptPath,
            maxlines: SHELL_TAIL_LINES,
        });
        if (loadSeq.get(id) !== seq) {
            return;
        }
        setList(id, visibleShellTasks(extractShellTasks(tr.lines ?? [])));
    } catch {
        if (loadSeq.get(id) === seq) {
            setList(id, null);
        }
    }
}

/** Debounced refresh, coalescing a burst of transcript activity into one load. */
export function scheduleShellTasks(id: string, transcriptPath: string | undefined): void {
    const existing = timers.get(id);
    if (existing) {
        clearTimeout(existing);
    }
    timers.set(
        id,
        setTimeout(() => {
            timers.delete(id);
            void refreshShellTasks(id, transcriptPath);
        }, DEBOUNCE_MS)
    );
}

/** Stop tracking an agent that left the rendered set: cancel pending work, invalidate in-flight
 *  loads, and drop its list. */
export function dropShellTasks(id: string): void {
    const existing = timers.get(id);
    if (existing) {
        clearTimeout(existing);
        timers.delete(id);
    }
    loadSeq.set(id, (loadSeq.get(id) ?? 0) + 1);
    setList(id, null);
}

/** Pure: the tracked agents whose stored tasks include a running one, the ones worth polling. */
export function shellTaskPollIds(trackedIds: string[], byId: Record<string, ShellTask[]>): string[] {
    return trackedIds.filter((id) => byId[id]?.some((t) => t.state === "running"));
}

/** The last lines of a task's output file, trimmed for the peek. A missing or unreadable file reads
 *  as no output rather than an error. */
export async function readShellTaskOutput(path: string): Promise<string[]> {
    try {
        const tr = await RpcApi.GetAgentTranscriptCommand(TabRpcClient, { path, maxlines: PEEK_TAIL_LINES });
        return peekText(tr.lines ?? []);
    } catch {
        return [];
    }
}
