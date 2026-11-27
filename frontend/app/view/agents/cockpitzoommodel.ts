// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure decisions behind the Cockpit's zoomed view: the tabs a zoom adds to the session's workspace pane and the one it
// shows, the pane's [ / ] step, and how a Run tab draws a run's wait (its dot, where its waiting row sits, its note).

import { isLiveRun, waitNote, type CockpitSession, type RunWait } from "./cockpitsessionmodel";
import { tabKey, tabWaiting, type WaitInput, type WorkspaceState, type WorkspaceTab } from "./workspacemodel";

export interface ZoomTabs {
    tabs: WorkspaceTab[];
    // the tab to activate, null to leave the pane's choice
    activate: string | null;
}

// the run a zoom shows first: the one that waits, else the newest live, else the newest (runs are newest first)
function defaultRun(runs: Run[], waits: Record<string, RunWait | null>): Run | undefined {
    return runs.find((r) => waits[r.id] != null) ?? runs.find(isLiveRun) ?? runs[0];
}

// 1-based, as the Initiative tab's open counts chunks; undefined when the initiative is not loaded or lost the chunk
function chunkIndex(efforts: ReadonlyMap<string, Effort>, ref: RunEffortRef): number | undefined {
    const n = (efforts.get(`effort:${ref.effortoid}`)?.chunks ?? []).findIndex((c) => c.label === ref.chunklabel);
    return n < 0 ? undefined : n + 1;
}

// A Run tab per listed run and an Initiative tab per initiative those runs work on, its open chunk the default run's
// when that run is in it, else its newest run's. A chunk the tab already has open stays. efforts is the cached
// initiative detail, keyed by oref.
export function zoomTabs(
    session: CockpitSession,
    waits: Record<string, RunWait | null>,
    efforts: ReadonlyMap<string, Effort>,
    ws: WorkspaceState
): ZoomTabs {
    const runs = session.runs;
    const first = defaultRun(runs, waits);
    const tabs: WorkspaceTab[] = runs.map((r) => ({ kind: "run", runId: r.id, view: "tasks" }));
    const chunkRun = new Map<string, Run>();
    for (const r of first != null ? [first, ...runs] : runs) {
        if (r.effortref?.effortoid && !chunkRun.has(r.effortref.effortoid)) {
            chunkRun.set(r.effortref.effortoid, r);
        }
    }
    for (const [effortId, r] of chunkRun) {
        const held = ws.tabs.find((t) => t.kind === "initiative" && t.effortId === effortId);
        const kept = held?.kind === "initiative" && held.open !== undefined;
        tabs.push(
            kept
                ? { kind: "initiative", effortId }
                : { kind: "initiative", effortId, open: chunkIndex(efforts, r.effortref!) }
        );
    }
    const runKeys = new Set(runs.map((r) => tabKey({ kind: "run", runId: r.id, view: "tasks" })));
    const activate = first == null || runKeys.has(ws.active ?? "") ? null : `run:${first.id}`;
    return { tabs: runs.length > 0 ? tabs : [], activate };
}

// the pane's [ / ]: the next tab's key, wrapping; null with no tab to step to
export function stepTab(ws: WorkspaceState, delta: number): string | null {
    const n = ws.tabs.length;
    if (n === 0) {
        return null;
    }
    const at = ws.tabs.findIndex((t) => tabKey(t) === ws.active);
    const from = at < 0 ? (delta > 0 ? -1 : 0) : at;
    return tabKey(ws.tabs[(((from + delta) % n) + n) % n]);
}

// waiting: something waits on you; held: a run's wait its conductor has; unseen: joined behind and not shown yet. A
// run with a wait follows the wait; one without keeps today's rule (its asks that are yours)
export type TabDot = "waiting" | "held" | "unseen";

export function runTabDot(wait: RunWait | null, userAsks: number, unseen: boolean): TabDot | null {
    if (wait != null) {
        return wait.owner === "you" ? "waiting" : "held";
    }
    return userAsks > 0 ? "waiting" : unseen ? "unseen" : null;
}

// what a tab adds to the collapsed strip's waiting-on-you count: a run's wait counts only once it is yours, and then at
// least once; any other tab keeps today's count
export function tabNeeds(tab: WorkspaceTab, wait: RunWait | null, input: WaitInput): number {
    const asks = tabWaiting(tab, input);
    if (tab.kind !== "run" || wait == null) {
        return asks;
    }
    return wait.owner === "you" ? Math.max(1, asks) : 0;
}

// The Tasks view's row a wait's card sits under: the Final, Plan review or its task, else "top", above the rows.
// rowIds are the rows the view draws: "planreview", the task ids and "final".
export function waitAnchor(item: AttentionItem | undefined, wait: RunWait, rowIds: string[]): string {
    const row =
        wait.short === "Final failed" ? "final" : wait.short === "Plan to approve" ? "planreview" : item?.taskid;
    return row && rowIds.includes(row) ? row : "top";
}

// the note around its minutes left, so the count can roll while the rest stays still
export function noteParts(wait: RunWait): { before: string; minutes: number | null; after: string } {
    const note = waitNote(wait);
    const at = wait.minutesLeft == null ? -1 : note.lastIndexOf(` ${wait.minutesLeft} min`);
    if (at < 0) {
        return { before: note, minutes: null, after: "" };
    }
    const end = at + 1 + String(wait.minutesLeft).length;
    return { before: note.slice(0, at + 1), minutes: wait.minutesLeft, after: note.slice(end) };
}
