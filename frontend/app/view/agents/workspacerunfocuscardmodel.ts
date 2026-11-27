// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: which parts the Graph's Focus centre card shows for its task: the live step, the open question or when it
// starts, and Open agent / Open changes with the diff stat.

import type { DiffStats } from "./agentsviewmodel";

const NOT_STARTED = new Set(["pending", "ready"]);

export interface FocusCardInput {
    task: TaskNode;
    // the task's unmet deps
    waitsOn: string[];
    // the run has finished
    finished: boolean;
    ask?: DagAskItem;
    // the worker run's sealed evidence; a running worker has none
    evidence?: RunEvidence;
    // the live worker's own changes so far, standing in until its evidence seals
    live?: DiffStats;
}

export interface FocusCardView {
    // the question is open, which draws the warning border
    asked: boolean;
    // the worker's latest step shows
    step: boolean;
    question: string | null;
    // "Starts once t-3 and t-4 merge."
    starts: string | null;
    // the actions row, Open agent always in it; null with no worker to open
    actions: {
        // Open changes' file: the first evidence file, "" for the live worker's whole diff, null for no Open changes
        changes: string | null;
        diff: { files: string; adds: number; dels: number } | null;
    } | null;
}

function joinIds(ids: string[]): string {
    return ids.length < 2 ? ids.join("") : `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`;
}

function startsLine(waitsOn: string[], finished: boolean): string {
    if (finished) {
        return "Never started.";
    }
    if (waitsOn.length === 0) {
        return "Starts once a worker is free.";
    }
    return `Starts once ${joinIds(waitsOn)} ${waitsOn.length === 1 ? "merges" : "merge"}.`;
}

const fileCount = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

function actionsOf(
    task: TaskNode,
    evidence: RunEvidence | undefined,
    live: DiffStats | undefined
): FocusCardView["actions"] {
    // a task not dispatched has no agent to open
    if (!task.runid) {
        return null;
    }
    const files = evidence?.files ?? [];
    if (files.length > 0) {
        return {
            changes: files[0].path,
            diff: { files: fileCount(files.length), adds: evidence.addtotal, dels: evidence.deltotal },
        };
    }
    if (live != null && live.files > 0) {
        return { changes: "", diff: { files: fileCount(live.files), adds: live.adds, dels: live.dels } };
    }
    return { changes: null, diff: null };
}

export function focusCardView({ task, waitsOn, finished, ask, evidence, live }: FocusCardInput): FocusCardView {
    const waiting = NOT_STARTED.has(task.state);
    return {
        asked: ask != null,
        step: ask == null && task.state === "running" && !!task.runid,
        question: ask?.questions?.[0]?.question ?? null,
        starts: waiting ? startsLine(waitsOn, finished) : null,
        actions: waiting ? null : actionsOf(task, evidence, live),
    };
}
