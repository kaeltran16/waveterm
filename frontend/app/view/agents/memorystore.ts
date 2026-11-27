// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Setup surface's Memory tab: its atoms and the memhygiene RPCs. Module-level atoms because the
// Setup surface unmounts on a switch, and the selection and a row Apply in flight must survive one (the
// memhygiene address also writes them before it switches here).

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, type PrimitiveAtom } from "jotai";
import {
    didLines,
    firstRowKey,
    keepIds,
    resolveSelection,
    rowButtons,
    rowKey,
    selectionOrder,
    stepSelection,
    waitingRows,
    type RowContext,
    type RowKind,
    type WaitingRow,
} from "./memorymodel";

// list and check read state files and return at once; decide copies backups and writes files, so it
// gets more room before a stalled backend is reported
const READ_TIMEOUT_MS = 5000;
const DECIDE_TIMEOUT_MS = 15000;

type MemVerdict = "apply" | "keep" | "undo" | "reopen";

// null = not read yet
export const memoryProjectsAtom = atom<MemHygieneProject[] | null>(null) as PrimitiveAtom<MemHygieneProject[] | null>;
export const memoryErrorAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
// a verdict, check start or undo in flight: the buttons wait for it
export const memoryBusyAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

// an update event can start a list while an earlier one is still in flight. a list lands when it started
// after the last one that landed, so a split Apply's progress shows each step rather than only the last.
let startedSeq = 0;
let landedSeq = 0;

export async function loadMemory(): Promise<void> {
    const seq = ++startedSeq;
    try {
        const rtn = await RpcApi.ListMemoryHygieneCommand(TabRpcClient, { timeout: READ_TIMEOUT_MS });
        if (seq > landedSeq) {
            landedSeq = seq;
            globalStore.set(memoryProjectsAtom, rtn.projects ?? []);
        }
    } catch (e) {
        globalStore.set(memoryErrorAtom, `Could not read memory checks: ${errText(e)}`);
    }
}

// every state write publishes memhygiene:update with no payload, so the tab re-lists while it is open
export function subscribeMemory(): () => void {
    return waveEventSubscribeSingle({
        eventType: "memhygiene:update",
        handler: () => fireAndForget(loadMemory),
    });
}

async function busy(fn: () => Promise<void>): Promise<void> {
    globalStore.set(memoryBusyAtom, true);
    globalStore.set(memoryErrorAtom, null);
    try {
        await fn();
    } catch (e) {
        globalStore.set(memoryErrorAtom, errText(e));
    } finally {
        globalStore.set(memoryBusyAtom, false);
    }
}

// the check runs in the background and returns at once; re-list so "Checking…" shows without waiting
// on the update event
export function checkMemory(project: string): Promise<void> {
    return busy(async () => {
        try {
            await RpcApi.CheckMemoryHygieneCommand(TabRpcClient, { project }, { timeout: READ_TIMEOUT_MS });
        } catch (e) {
            throw new Error(`Could not start the check of ${project}: ${errText(e)}`);
        }
        await loadMemory();
    });
}

async function decideOne(project: string, changeId: string, verdict: MemVerdict): Promise<MemHygieneProject> {
    let updated: MemHygieneProject;
    try {
        updated = await RpcApi.DecideMemoryChangeCommand(
            TabRpcClient,
            { project, changeid: changeId, verdict },
            { timeout: DECIDE_TIMEOUT_MS }
        );
    } catch (e) {
        throw new Error(`Could not ${verdict} the change in ${project}: ${errText(e)}`);
    }
    replaceProject(updated);
    return updated;
}

function replaceProject(updated: MemHygieneProject | null): void {
    const projects = globalStore.get(memoryProjectsAtom);
    if (updated != null && projects != null) {
        // a list started before the decision would land older state over it
        landedSeq = startedSeq;
        globalStore.set(
            memoryProjectsAtom,
            projects.map((p) => (p.project === updated.project ? updated : p))
        );
    }
}

// a split's Apply copies every memory and an undo restores them, change by change, past the 5 s default
const ROW_TIMEOUT_MS = 10 * 60 * 1000;

// the selected row (rowKey) or did line (<project>/<batchId>); what the detail shows is resolveSelection's
export const memorySelectedAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
// row keys whose Apply is in flight
export const memoryApplyingAtom = atom<string[]>([]) as PrimitiveAtom<string[]>;
// each project's last row Apply result: the newer and failed stops live only here
export const memoryRowResultsAtom = atom<Record<string, MemRowResult>>({}) as PrimitiveAtom<
    Record<string, MemRowResult>
>;
// the did line whose Undo was refused, showing why
export const memoryRefusedAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

function dropRowResult(project: string): void {
    const { [project]: _, ...rest } = globalStore.get(memoryRowResultsAtom);
    globalStore.set(memoryRowResultsAtom, rest);
}

// the tab re-lists on each memhygiene:update while this runs, which is how its progress shows
export async function applyMemoryRow(project: string, row: RowKind, changeId = ""): Promise<void> {
    const key = rowKey(row, project, changeId);
    if (globalStore.get(memoryApplyingAtom).includes(key)) {
        return;
    }
    globalStore.set(memoryApplyingAtom, [...globalStore.get(memoryApplyingAtom), key]);
    globalStore.set(memoryErrorAtom, null);
    dropRowResult(project);
    try {
        const res = await RpcApi.ApplyMemoryRowCommand(
            TabRpcClient,
            { project, row, changeid: changeId },
            { timeout: ROW_TIMEOUT_MS }
        );
        globalStore.set(memoryRowResultsAtom, { ...globalStore.get(memoryRowResultsAtom), [project]: res });
        replaceProject(res.project);
    } catch (e) {
        const what = row === "doc" ? "the move into the repo doc" : `the ${row}`;
        globalStore.set(memoryErrorAtom, `Could not apply ${what} in ${project}: ${errText(e)}`);
    } finally {
        globalStore.set(
            memoryApplyingAtom,
            globalStore.get(memoryApplyingAtom).filter((k) => k !== key)
        );
    }
}

// changeId "" undoes the whole batch. a stop from before it no longer describes the row.
export function undoMemoryBatch(project: string, batchId: string, changeId = ""): Promise<void> {
    return busy(async () => {
        let updated: MemHygieneProject;
        try {
            updated = await RpcApi.UndoMemoryBatchCommand(
                TabRpcClient,
                { project, batchid: batchId, changeid: changeId },
                { timeout: ROW_TIMEOUT_MS }
            );
        } catch (e) {
            throw new Error(
                `Could not undo ${changeId === "" ? "the batch" : "the change"} in ${project}: ${errText(e)}`
            );
        }
        dropRowResult(project);
        replaceProject(updated);
    });
}

// Leave out and Bring back are keep and reopen on one move, copy or removal
export function leaveOutMemory(project: string, changeId: string): Promise<void> {
    return busy(async () => void (await decideOne(project, changeId, "keep")));
}

export function bringBackMemory(project: string, changeId: string): Promise<void> {
    return busy(async () => void (await decideOne(project, changeId, "reopen")));
}

// Keep sharing, Keep them, or Keep on a doc move
export function keepMemoryRow(row: WaitingRow): Promise<void> {
    return busy(async () => {
        const p = globalStore.get(memoryProjectsAtom)?.find((x) => x.project === row.project);
        if (p == null) {
            throw new Error(`Could not keep ${row.project}: it is no longer listed`);
        }
        for (const id of keepIds(p, row)) {
            await decideOne(row.project, id, "keep");
        }
    });
}

// ---- the selection, and the buttons the keys press ----

function projects(): MemHygieneProject[] {
    return globalStore.get(memoryProjectsAtom) ?? [];
}

// the row or line the detail shows, which the keys act on
export function shownMemoryKey(): string | null {
    return resolveSelection(projects(), Date.now(), globalStore.get(memorySelectedAtom));
}

// a memhygiene:<project> address: that project's first waiting row
export function landMemoryProject(listed: MemHygieneProject[], project: string): void {
    globalStore.set(memorySelectedAtom, firstRowKey(listed, project));
    globalStore.set(memoryRefusedAtom, null);
}

// a refusal answers an Undo on the line it shows on, so moving off that line dismisses it
export function selectMemory(key: string): void {
    globalStore.set(memorySelectedAtom, key);
    if (globalStore.get(memoryRefusedAtom) !== key) {
        globalStore.set(memoryRefusedAtom, null);
    }
}

export function stepMemorySelection(delta: number): boolean {
    const next = stepSelection(selectionOrder(projects(), Date.now()), shownMemoryKey(), delta);
    if (next == null) {
        return false;
    }
    selectMemory(next);
    return true;
}

function memoryRowContext(row: WaitingRow, p: MemHygieneProject): RowContext {
    return {
        applying: globalStore.get(memoryApplyingAtom).includes(row.key),
        busy: globalStore.get(memoryBusyAtom),
        result: globalStore.get(memoryRowResultsAtom)[p.project] ?? null,
    };
}

// a button of a row: what clicking it and its key do
export function runRowButton(row: WaitingRow, which: "primary" | "keep" | "undo"): void {
    const p = projects().find((x) => x.project === row.project);
    const b = p == null ? null : rowButtons(p, row, memoryRowContext(row, p));
    if (b == null) {
        return;
    }
    if (which === "keep") {
        fireAndForget(() => keepMemoryRow(row));
    } else if (which === "undo" && b.undo != null) {
        fireAndForget(() => undoMemoryBatch(row.project, b.undo.batchId));
    } else if (which === "primary" && b.primary?.action === "check") {
        fireAndForget(() => checkMemory(row.project));
    } else if (which === "primary") {
        fireAndForget(() => applyMemoryRow(row.project, row.kind, row.changeId));
    }
}

// a and x: the shown row's button, and nothing (the key passes) while there is none or it is disabled
export function pressMemoryRow(which: "primary" | "keep"): boolean {
    const shown = shownMemoryKey();
    const row = waitingRows(projects()).find((r) => r.key === shown);
    const p = projects().find((x) => x.project === row?.project);
    if (row == null || p == null) {
        return false;
    }
    const b = rowButtons(p, row, memoryRowContext(row, p))[which];
    if (b == null || b.disabled) {
        return false;
    }
    runRowButton(row, which);
    return true;
}

// a did line's Undo, by click or u: a split the model refuses shows why instead of undoing
export function undoMemoryLine(key: string): boolean {
    const line = didLines(projects(), Date.now()).find((l) => l.key === key);
    if (line == null || globalStore.get(memoryBusyAtom)) {
        return false;
    }
    if (line.refusal !== "") {
        globalStore.set(memoryRefusedAtom, key);
        return true;
    }
    globalStore.set(memoryRefusedAtom, null);
    fireAndForget(() => undoMemoryBatch(line.project, line.batch.id));
    return true;
}
