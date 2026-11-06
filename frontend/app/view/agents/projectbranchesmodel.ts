// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: the project Overview's Branches region, from one GitHistoryCommand reply to what it draws. The rows
// are the Diff history's own (historyrows.ts), so both surfaces classify refs and hang the uncommitted row
// off HEAD the same way.

import { buildRows, type HistoryRow } from "./historyrows";

export const BRANCH_ROWS = 10;
export const BRANCH_ROW_H = 28;
export const BRANCH_MAX_LANES = 4;

export type BranchesState =
    | { kind: "loading" }
    | { kind: "norepo" }
    | { kind: "empty" }
    | { kind: "failed"; reason: string }
    | { kind: "rows"; rows: HistoryRow[] };

// reply null = the read is still in flight. A repository with no commits is empty even with files to
// commit: there is no HEAD for the uncommitted row to hang off.
export function branchesState(
    reply: CommandGitHistoryRtnData | null,
    changedFiles: number,
    now: number
): BranchesState {
    if (reply == null) {
        return { kind: "loading" };
    }
    if (!reply.isrepo) {
        return { kind: "norepo" };
    }
    if (reply.failure) {
        const stderr = reply.failure.stderr?.trim();
        return { kind: "failed", reason: stderr || `git exited with code ${reply.failure.exitcode}` };
    }
    const commits = reply.commits ?? [];
    if (commits.length === 0) {
        return { kind: "empty" };
    }
    return { kind: "rows", rows: buildRows(commits, { head: reply.head, dirtyFileCount: changedFiles, now }) };
}

export function authorInitial(author: string): string {
    const first = author.trim().charAt(0);
    return first ? first.toUpperCase() : "?";
}
