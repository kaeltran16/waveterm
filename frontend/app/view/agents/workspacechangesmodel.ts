// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: what the workspace pane's Changes tab draws from the rail's git read (railStateAtom), so the tab, the rail
// and the header chip count the same files.

import { fileTotals } from "./agentrailmodel";
import type { DiffLine, EditFile } from "./agentsviewmodel";
import type { GitChange } from "./gitstatus";
import type { RailGitState } from "./railstore";

export type ChangesView = "loading" | "failed" | "norepo" | "clean" | "files";

export function changesView(rail: RailGitState | null): ChangesView {
    if (rail == null) {
        return "loading";
    }
    if (rail.failure != null) {
        return "failed";
    }
    if (!rail.isRepo || rail.changes == null) {
        return "norepo";
    }
    return rail.changes.files.length === 0 ? "clean" : "files";
}

export type ChangesBody = "loading" | "hunks" | "binary" | "whitespace" | "toolarge" | "empty";
// label null: a new file's hunk, which draws no label row
export interface ChangesHunk {
    label: string | null;
    newStart: number;
    rows: DiffLine[];
}
export interface ChangesFile {
    change: GitChange;
    name: string;
    letter: string;
    isNew: boolean;
    body: ChangesBody;
    hunks: ChangesHunk[];
}
// dir is the parent directory path without a trailing slash; "" is the repo root
export interface ChangesGroup {
    dir: string;
    count: string;
    files: ChangesFile[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;
const NEW_FILE_STATUSES = ["A", "?"];

function splitHunks(lines: DiffLine[], isNew: boolean): ChangesHunk[] {
    const hunks: ChangesHunk[] = [];
    for (const line of lines) {
        if (line.hunk) {
            const m = HUNK_HEAD.exec(line.text);
            const newStart = Number(m?.[2] ?? 0);
            const context = (m?.[3] ?? "").trim();
            const lineNo = newStart === 0 ? Number(m?.[1] ?? 0) : newStart;
            hunks.push({ label: isNew ? null : context || `line ${lineNo}`, newStart, rows: [] });
        } else {
            // a new file's rows are plain numbered code: no sign, so DiffRow adds no tint
            const row = isNew ? { sign: "" as const, text: line.text, newNo: line.newNo } : line;
            hunks[hunks.length - 1]?.rows.push(row);
        }
    }
    return hunks;
}

function bodyOf(
    entry: EditFile | undefined,
    hunks: ChangesHunk[],
    o: { pastCut: boolean; ignoreWs: boolean }
): ChangesBody {
    if (entry?.binary) {
        return "binary";
    }
    if (hunks.length > 0) {
        return "hunks";
    }
    if (entry == null && o.pastCut) {
        return "toolarge";
    }
    return o.ignoreWs ? "whitespace" : "empty";
}

function changesFile(
    change: GitChange,
    entry: EditFile | undefined,
    patch: EditFile[] | null,
    o: { pastCut: boolean; ignoreWs: boolean }
): ChangesFile {
    const isNew = NEW_FILE_STATUSES.includes(change.status);
    const hunks = entry ? splitHunks(entry.lines, isNew) : [];
    return {
        change,
        name: change.path.slice(change.path.lastIndexOf("/") + 1),
        letter: isNew ? "A" : change.status,
        isNew,
        body: patch == null ? "loading" : bodyOf(entry, hunks, o),
        hunks,
    };
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// where a file sits in the patch: git writes the tracked diff by path, then the untracked files by path
const patchOrder = (path: string, status: string | undefined) => `${status === "?" ? 1 : 0}:${path}`;

// root files first, then one group per parent directory by path, files by name; patch is null while the first read
// is pending
export function changesGroups(
    files: GitChange[],
    patch: EditFile[] | null,
    o: { truncated: boolean; ignoreWs: boolean }
): ChangesGroup[] {
    const entries = new Map((patch ?? []).map((e) => [e.path, e]));
    // the cap cuts at a whole file, so a file with no entry is past the cut only when it would follow the last entry;
    // one before it was left out by git itself (-w drops a whitespace-only file)
    const statuses = new Map(files.map((f) => [f.path, f.status]));
    const last = (patch ?? [])
        .map((e) => patchOrder(e.path, statuses.get(e.path)))
        .reduce((a, b) => (b > a ? b : a), "");
    const pastCut = (c: GitChange) => o.truncated && patchOrder(c.path, c.status) > last;
    const dirs = new Map<string, ChangesFile[]>();
    for (const change of files) {
        const dir = change.path.includes("/") ? change.path.slice(0, change.path.lastIndexOf("/")) : "";
        const list = dirs.get(dir) ?? [];
        list.push(
            changesFile(change, entries.get(change.path), patch, { pastCut: pastCut(change), ignoreWs: o.ignoreWs })
        );
        dirs.set(dir, list);
    }
    return [...dirs.entries()]
        .sort(([a], [b]) => byText(a, b))
        .map(([dir, list]) => ({
            dir,
            count: fileTotals(list.map((f) => f.change)).count,
            files: list.sort((a, b) => byText(a.name, b.name)),
        }));
}

// a new file starts closed, any other open; the toggled flag flips that
export function fileOpen(f: Pick<ChangesFile, "isNew">, toggled: boolean): boolean {
    return f.isNew === toggled;
}

// every hunk of every file in display order, closed files included, so the counter's total holds as files toggle
export function hunkWalk(groups: ChangesGroup[]): { path: string; hunk: number }[] {
    return groups.flatMap((g) => g.files.flatMap((f) => f.hunks.map((_, hunk) => ({ path: f.change.path, hunk }))));
}

// 1-based, 0 = none yet; wraps at both ends
export function stepHunk(at: number, total: number, dir: "next" | "previous"): number {
    if (total === 0) {
        return 0;
    }
    if (dir === "next") {
        return at >= total ? 1 : at + 1;
    }
    return at <= 1 ? total : at - 1;
}

// "N files +A −D · <branch>, <scope>": the scope is the base the list was read against
export function changesLine(rail: RailGitState): { count: string; adds: number; dels: number; where: string } {
    const scope = rail.edits ? "agent's edits" : rail.ref ? "since session start" : "uncommitted";
    return {
        ...fileTotals(rail.changes?.files ?? []),
        where: rail.branch ? `${rail.branch}, ${scope}` : scope,
    };
}
