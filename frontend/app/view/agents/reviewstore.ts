// frontend/app/view/agents/reviewstore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Staged Accept/Reject review state for the Files "Review" mode. Decisions are pure frontend
// state (nothing touches the tree until apply()), so undo is free. Pure derivations are exported
// for unit testing; atoms + apply() live alongside.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { parseUnifiedDiff, type Hunk } from "./gitdiff";
import { reloadChanges } from "./filesstore";
import { parseGitChanges } from "./gitstatus";

export type Decision = "accept" | "reject";
export type FileVerdict = "accept" | "reject" | "partial" | "pending";

export interface ReviewFile {
    path: string;
    status: string; // porcelain status, e.g. " M", "??", "A "
    isNew: boolean;
    adds: number;
    dels: number;
    diffHeader: string;
    hunks: Hunk[];
}

export interface ReviewModel {
    cwd: string;
    files: ReviewFile[];
}

export type Decisions = Record<string, Decision>;

export function hunkKey(path: string, hunkId: string): string {
    return path + ":" + hunkId;
}

export function fileDecision(f: ReviewFile, d: Decisions): FileVerdict {
    const ds = f.hunks.map((h) => d[hunkKey(f.path, h.id)] ?? null);
    if (ds.every((x) => x === "accept")) return "accept";
    if (ds.every((x) => x === "reject")) return "reject";
    if (ds.every((x) => x === null)) return "pending";
    return "partial";
}

export interface Progress {
    total: number;
    accepted: number;
    rejected: number;
    reviewed: number;
    pending: number;
}

export function progressOf(files: ReviewFile[], d: Decisions): Progress {
    let total = 0, accepted = 0, rejected = 0;
    for (const f of files) {
        for (const h of f.hunks) {
            total++;
            const v = d[hunkKey(f.path, h.id)];
            if (v === "accept") accepted++;
            else if (v === "reject") rejected++;
        }
    }
    const reviewed = accepted + rejected;
    return { total, accepted, rejected, reviewed, pending: total - reviewed };
}

export interface RevertOp {
    path: string;
    status: string;
    patch: string; // "" => whole-file revert; else reverse-apply this patch
}

// Groups rejected hunks per file into backend revert ops. Untracked or fully-rejected tracked
// files -> whole-file (empty patch); partially-rejected tracked files -> a combined patch of just
// the rejected hunks (header + their bodies).
export function rejectedPatchPlan(files: ReviewFile[], d: Decisions): RevertOp[] {
    const ops: RevertOp[] = [];
    for (const f of files) {
        const rejected = f.hunks.filter((h) => d[hunkKey(f.path, h.id)] === "reject");
        if (rejected.length === 0) continue;
        const allRejected = rejected.length === f.hunks.length;
        if (f.isNew || allRejected) {
            ops.push({ path: f.path, status: f.status, patch: "" });
        } else {
            ops.push({ path: f.path, status: f.status, patch: f.diffHeader + rejected.map((h) => h.body).join("") });
        }
    }
    return ops;
}

// --- atoms (UI state) ---
export const reviewModelAtom = atom<ReviewModel | null>(null) as PrimitiveAtom<ReviewModel | null>;
export const decisionsAtom = atom<Decisions>({}) as PrimitiveAtom<Decisions>;
export const historyAtom = atom<string[]>([]) as PrimitiveAtom<string[]>;
export const reviewSelectedAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const appliedAtom = atom<{ accepted: number; rejected: number; failures: string[] } | null>(
    null
) as PrimitiveAtom<{ accepted: number; rejected: number; failures: string[] } | null>;

export function decide(key: string, val: Decision): void {
    globalStore.set(decisionsAtom, { ...globalStore.get(decisionsAtom), [key]: val });
    globalStore.set(historyAtom, [...globalStore.get(historyAtom), key]);
}

export function decideMany(keys: string[], val: Decision): void {
    const d = { ...globalStore.get(decisionsAtom) };
    const h = globalStore.get(historyAtom).slice();
    for (const k of keys) {
        if (!d[k]) h.push(k);
        d[k] = val;
    }
    globalStore.set(decisionsAtom, d);
    globalStore.set(historyAtom, h);
}

export function undoKey(key: string): void {
    const d = { ...globalStore.get(decisionsAtom) };
    delete d[key];
    globalStore.set(decisionsAtom, d);
    globalStore.set(historyAtom, globalStore.get(historyAtom).filter((x) => x !== key));
}

export function undoFile(f: ReviewFile): void {
    const keys = f.hunks.map((h) => hunkKey(f.path, h.id));
    const d = { ...globalStore.get(decisionsAtom) };
    keys.forEach((k) => delete d[k]);
    globalStore.set(decisionsAtom, d);
    globalStore.set(historyAtom, globalStore.get(historyAtom).filter((x) => !keys.includes(x)));
}

export function undoLast(): void {
    const h = globalStore.get(historyAtom).slice();
    const k = h.pop();
    if (!k) return;
    const d = { ...globalStore.get(decisionsAtom) };
    if (!h.includes(k)) delete d[k];
    globalStore.set(decisionsAtom, d);
    globalStore.set(historyAtom, h);
}

export function resetReview(): void {
    globalStore.set(decisionsAtom, {});
    globalStore.set(historyAtom, []);
    globalStore.set(appliedAtom, null);
}

const loadGuard = { token: "" };

// Build the full review model for a worktree: changes + every file's diff (so all hunks are known
// for progress + apply). Untracked files become one synthetic whole-file hunk (id "file").
export async function loadReview(cwd: string | null): Promise<void> {
    const token = cwd ?? "";
    loadGuard.token = token;
    globalStore.set(reviewModelAtom, null);
    resetReview();
    if (!cwd) return;
    const ch = await RpcApi.GitChangesCommand(TabRpcClient, { cwd });
    if (loadGuard.token !== token || !ch.isrepo) {
        if (loadGuard.token === token) globalStore.set(reviewModelAtom, { cwd, files: [] });
        return;
    }
    const changes = parseGitChanges(ch.statusz, ch.numstat);
    const files: ReviewFile[] = [];
    for (const c of changes.files) {
        const d = await RpcApi.GitDiffCommand(TabRpcClient, { cwd, path: c.path });
        if (loadGuard.token !== token) return;
        if (d.untracked) {
            files.push({
                path: c.path, status: c.status, isNew: true,
                adds: d.content.split("\n").length, dels: 0, diffHeader: "",
                hunks: [{ id: "file", header: "@@ new file @@", adds: 0, dels: 0, body: "" }],
            });
        } else {
            const v = parseUnifiedDiff(d.diff);
            files.push({
                path: c.path, status: c.status, isNew: false,
                adds: v.adds, dels: v.dels, diffHeader: v.diffHeader, hunks: v.hunks,
            });
        }
    }
    if (loadGuard.token !== token) return;
    globalStore.set(reviewModelAtom, { cwd, files });
    globalStore.set(reviewSelectedAtom, files[0]?.path ?? null);
}

// Apply: reverse every rejected op; accepted changes are left in the tree. Collects per-file
// failures (stale patch etc.) without aborting the batch, then reloads Files state to reflect
// reality and shows the applied summary.
export async function applyReview(): Promise<void> {
    const model = globalStore.get(reviewModelAtom);
    if (!model) return;
    const d = globalStore.get(decisionsAtom);
    const prog = progressOf(model.files, d);
    if (prog.pending > 0) return; // gated
    const ops = rejectedPatchPlan(model.files, d);
    const failures: string[] = [];
    for (const op of ops) {
        try {
            await RpcApi.GitRevertCommand(TabRpcClient, { cwd: model.cwd, path: op.path, status: op.status, patch: op.patch });
        } catch {
            failures.push(op.path);
        }
    }
    globalStore.set(appliedAtom, { accepted: prog.accepted, rejected: prog.rejected, failures });
    void reloadChanges(model.cwd); // refresh Browse-mode state (reuses the surface's live token)
}
