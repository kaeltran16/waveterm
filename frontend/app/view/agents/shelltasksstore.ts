// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Background shell tasks per agent, read from its transcript tail. Mirrors subagentsstore.ts: refresh
// on enter and when the agent turns idle, scheduleShellTasks (debounced) on transcript activity, drop on
// leave. Standing by is not stored here: consumers derive it with isStandingBy from the agent's state and
// its entry. Also holds which task's output peek is open.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import type { AgentVM } from "./agentsviewmodel";
import { extractShellTasks, outputTail, SHELL_TAIL_LINES, type ShellTask } from "./shelltasks";

export interface ShellTaskPeekRef {
    parentId: string;
    taskId: string;
}

// per agent-id -> its running shell tasks
export const shellTasksByIdAtom = atom<Record<string, ShellTask[]>>({}) as PrimitiveAtom<Record<string, ShellTask[]>>;

// per agent-id -> when its last completed shell-task read started, success or failure. A finish held
// since the agent turned idle waits for a read that started at or after it (shellReadPending)
export const shellReadAtByIdAtom = atom<Record<string, number>>({}) as PrimitiveAtom<Record<string, number>>;

// the task whose output peek is open beside the tree; an atom, not row state, so Esc in the keybinding
// registry can close it
export const shellTaskPeekAtom = atom<ShellTaskPeekRef | null>(null) as PrimitiveAtom<ShellTaskPeekRef | null>;

// transcript activity stops while an agent sits idle, so a running task's finish is only seen by polling
export const SHELL_POLL_MS = 5000;

const DEBOUNCE_MS = 4000; // same cadence as subagentsstore
const OUTPUT_TAIL_LINES = 1000;
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
 *  load (or a drop) discards a slower older result. A failed read keeps the last known list, so an
 *  absent entry always means no running tasks and never reads as a task finishing. */
export async function refreshShellTasks(id: string, transcriptPath: string | undefined): Promise<void> {
    const seq = (loadSeq.get(id) ?? 0) + 1;
    loadSeq.set(id, seq);
    const startedAt = Date.now();
    if (!transcriptPath) {
        setList(id, null);
        setReadAt(id, startedAt);
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
        setList(id, extractShellTasks(tr.lines ?? []));
        setReadAt(id, startedAt);
    } catch {
        // keep the last known list: the next poll or transcript activity retries. The read still
        // completed, so a held finish is released and decided on that list
        if (loadSeq.get(id) === seq) {
            setReadAt(id, startedAt);
        }
    }
}

function setReadAt(id: string, startedAt: number | null): void {
    const cur = globalStore.get(shellReadAtByIdAtom);
    if (startedAt == null) {
        if (id in cur) {
            const { [id]: _, ...rest } = cur;
            globalStore.set(shellReadAtByIdAtom, rest);
        }
        return;
    }
    globalStore.set(shellReadAtByIdAtom, { ...cur, [id]: startedAt });
}

/** Pure: whether an idle agent still waits on a shell-task read that started at or after it turned idle.
 *  An agent never read (none tracks it) or with no idleSince waits on nothing, so a finish is never held
 *  by a read that will not come. */
export function shellReadPending(agent: Pick<AgentVM, "state" | "idleSince">, readAt: number | undefined): boolean {
    return agent.state === "idle" && agent.idleSince != null && readAt != null && readAt < agent.idleSince;
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
    setReadAt(id, null);
    if (globalStore.get(shellTaskPeekAtom)?.parentId === id) {
        globalStore.set(shellTaskPeekAtom, null);
    }
}

/** Pure: the tracked agents with a stored (running) task, the ones worth polling. */
export function shellTaskPollIds(trackedIds: string[], byId: Record<string, ShellTask[]>): string[] {
    return trackedIds.filter((id) => (byId[id]?.length ?? 0) > 0);
}

/** The last lines of a task's output file, trimmed for the output peek. A missing or unreadable file
 *  reads as no output rather than an error. */
export async function readShellTaskOutput(path: string): Promise<string[]> {
    try {
        const tr = await RpcApi.GetAgentTranscriptCommand(TabRpcClient, { path, maxlines: OUTPUT_TAIL_LINES });
        return outputTail(tr.lines ?? []);
    } catch {
        return [];
    }
}
