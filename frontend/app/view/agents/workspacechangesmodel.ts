// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: what the workspace pane's Changes tab draws from the rail's git read (railStateAtom), so the tab, the rail
// and the header chip count the same files.

import { fileTotals } from "./agentrailmodel";
import type { DiffLine, EditFile } from "./agentsviewmodel";
import type { GitChange } from "./gitstatus";
import type { RailGitState } from "./railstore";
import { SHORT_SHA } from "./runscards";

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
// dir is the parent directory path without a trailing slash; "" is the repo root. also marks a done worker's merge
// files that are not its own, listed after its own
export interface ChangesGroup {
    dir: string;
    count: string;
    files: ChangesFile[];
    also?: boolean;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;
const NEW_FILE_STATUSES = ["A", "?"];

// a removed row's number is the old side's, so only an added or context row can be the cited line
export function isCitedRow(row: DiffLine, cited: number | null | undefined): boolean {
    return cited != null && row.sign !== "-" && row.newNo === cited;
}

export function splitHunks(lines: DiffLine[], isNew: boolean): ChangesHunk[] {
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
// is pending. With own (a done worker's sealed files), its own files are grouped first and the rest after, as also.
export function changesGroups(
    files: GitChange[],
    patch: EditFile[] | null,
    o: { truncated: boolean; ignoreWs: boolean; own?: string[] }
): ChangesGroup[] {
    const entries = new Map((patch ?? []).map((e) => [e.path, e]));
    // the cap cuts at a whole file, so a file with no entry is past the cut only when it would follow the last entry;
    // one before it was left out by git itself (-w drops a whitespace-only file)
    const statuses = new Map(files.map((f) => [f.path, f.status]));
    const last = (patch ?? [])
        .map((e) => patchOrder(e.path, statuses.get(e.path)))
        .reduce((a, b) => (b > a ? b : a), "");
    const pastCut = (c: GitChange) => o.truncated && patchOrder(c.path, c.status) > last;
    const group = (list: GitChange[]): ChangesGroup[] => {
        const dirs = new Map<string, ChangesFile[]>();
        for (const change of list) {
            const dir = change.path.includes("/") ? change.path.slice(0, change.path.lastIndexOf("/")) : "";
            const inDir = dirs.get(dir) ?? [];
            inDir.push(
                changesFile(change, entries.get(change.path), patch, { pastCut: pastCut(change), ignoreWs: o.ignoreWs })
            );
            dirs.set(dir, inDir);
        }
        return [...dirs.entries()]
            .sort(([a], [b]) => byText(a, b))
            .map(([dir, inDir]) => ({
                dir,
                count: fileTotals(inDir.map((f) => f.change)).count,
                files: inDir.sort((a, b) => byText(a.name, b.name)),
            }));
    };
    if (o.own == null) {
        return group(files);
    }
    const own = new Set(o.own);
    return [
        ...group(files.filter((f) => own.has(f.path))),
        ...group(files.filter((f) => !own.has(f.path))).map((g) => ({ ...g, also: true })),
    ];
}

// a file absent from open is closed. stepOpened is the file a step opened, which the next step into another file
// closes; a file the user opens or closes by any means is theirs, so it is never the remembered one
export interface ChangesOpen {
    open: Record<string, boolean>;
    stepOpened: string | null;
}

export const NONE_OPEN: ChangesOpen = { open: {}, stepOpened: null };

export function isFileOpen(s: ChangesOpen, path: string): boolean {
    return s.open[path] ?? false;
}

export function anyFileOpen(s: ChangesOpen, paths: string[]): boolean {
    return paths.some((p) => isFileOpen(s, p));
}

function setOpen(s: ChangesOpen, paths: string[], value: boolean, forget: boolean): ChangesOpen {
    const open = { ...s.open };
    for (const p of paths) {
        open[p] = value;
    }
    return { open, stepOpened: forget ? null : s.stepOpened };
}

export function toggleFile(s: ChangesOpen, path: string): ChangesOpen {
    return setOpen(s, [path], !isFileOpen(s, path), s.stepOpened === path);
}

export function openFile(s: ChangesOpen, path: string): ChangesOpen {
    return setOpen(s, [path], true, s.stepOpened === path);
}

export function toggleFolder(s: ChangesOpen, paths: string[]): ChangesOpen {
    return setOpen(s, paths, !anyFileOpen(s, paths), s.stepOpened != null && paths.includes(s.stepOpened));
}

export function toggleAll(s: ChangesOpen, paths: string[]): ChangesOpen {
    return setOpen(s, paths, !anyFileOpen(s, paths), true);
}

export function stepInto(s: ChangesOpen, path: string): ChangesOpen {
    let next = s;
    if (s.stepOpened != null && s.stepOpened !== path) {
        next = setOpen(s, [s.stepOpened], false, true);
    }
    return isFileOpen(next, path) ? next : { open: { ...next.open, [path]: true }, stepOpened: path };
}

// a group's closed files run together as one list box; an open file breaks the run as its own card. Each file is one
// row whatever box it draws in, so a toggle animates the row in place instead of remounting it in another box
export type ChangesRow = { file: ChangesFile; open: boolean; runStart: boolean; runEnd: boolean };

export function changesRows(files: ChangesFile[], s: ChangesOpen): ChangesRow[] {
    const closed = (i: number) => i >= 0 && i < files.length && !isFileOpen(s, files[i].change.path);
    return files.map((file, i) => {
        const open = !closed(i);
        return { file, open, runStart: open || !closed(i - 1), runEnd: open || !closed(i + 1) };
    });
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

// the line under a finished row's summary: the commit its list was read from, set apart as commit, and why a sealed
// list has no diffs. taskId is the done worker's task; order is the plan's task ids, which the merge's tasks follow
export function finishedNote(
    rail: RailGitState,
    taskId: string,
    order: string[]
): { before: string; commit?: string; after: string } | undefined {
    if (rail.verified != null) {
        const { commit, round } = rail.verified;
        return {
            before: "The run's changes at ",
            commit: commit.slice(0, SHORT_SHA),
            after: `, the commit round ${round} verified.`,
        };
    }
    const merge = rail.merge;
    if (merge == null) {
        return undefined;
    }
    const commit = merge.commit.slice(0, SHORT_SHA);
    if (merge.gone) {
        return commit
            ? {
                  before: "The merge commit ",
                  commit,
                  after: ` is no longer in the repository, so these are the files ${taskId}'s run recorded, without their diffs.`,
              }
            : {
                  before: `${taskId}'s run recorded no merge commit, so these are the files it recorded, without their diffs.`,
                  after: "",
              };
    }
    if (merge.also.length === 0) {
        return { before: "From merge commit ", commit, after: "." };
    }
    const landed = order.filter((id) => id === taskId || merge.also.some((a) => a.id === id));
    return {
        before: "From merge commit ",
        commit,
        after: `, which landed ${landed.join(" → ")} together. ${taskId}'s own files first.`,
    };
}

// "N files +A −D · <branch>, <scope>": the scope is the base the list was read against. A finished row's list names
// its commit in the line under it (finishedNote), and the checkout's branch is not where it came from, so it has none.
export function changesLine(rail: RailGitState): { count: string; adds: number; dels: number; where: string } {
    if (rail.merge != null || rail.verified != null) {
        return { ...fileTotals(rail.changes?.files ?? []), where: "" };
    }
    const scope = rail.run
        ? "run's changes"
        : rail.edits
          ? "agent's edits"
          : rail.ref
            ? "since session start"
            : "uncommitted";
    return {
        ...fileTotals(rail.changes?.files ?? []),
        where: rail.branch ? `${rail.branch}, ${scope}` : scope,
    };
}
