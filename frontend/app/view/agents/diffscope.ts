// frontend/app/view/agents/diffscope.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: the Diff surface's subject — which repository, and which range within it. Scope used to be a
// conclusion that four separate variables happened to imply, which is why the surface could display it
// and nothing could set it. Here it is one value, and every question the surface and its three git
// stores ask about scope is answered by a function in this file.

import type { CompareForm } from "./diffcontent";
import type { GitChanges } from "./gitstatus";
import type { HistoryFilters } from "./historyquery";

// A project's path comes from the config registry and a run's directory and base commit were captured
// when the run started, so both answer synchronously. An agent's directory is read from its live
// transcript and can fail, so an agent origin carries only its id and the loader resolves the rest.
export type DiffOrigin =
    | { kind: "agent"; id: string }
    | { kind: "project"; name: string; path: string }
    | { kind: "run"; runId: string; cwd: string; baseCommit: string };

export interface DiffRepo {
    origin: DiffOrigin;
    label: string;
}

export type DiffRange =
    | { kind: "working" }
    | { kind: "session"; agentId: string }
    | { kind: "run"; runId: string; baseCommit: string }
    // `from` is the range comparison interrupted. Escape restores it instead of guessing, which is
    // also what lets the old compareAnchorAtom and its invalidation effect go away. `form` is which
    // range form the aggregate uses: merge-base (what head introduced) or tip-to-tip (the full
    // difference). It lives here rather than beside the surface so rangeKey covers it and changing it
    // drops the stale read - a file list built one way beside a pane read the other is the failure.
    | { kind: "compare"; base: string; head: string; form: CompareForm; from: DiffRange };

export interface DiffScope {
    repo: DiffRepo;
    range: DiffRange;
}

// What the range strip draws. `available: false` means the chip is rendered disabled and explains
// itself; a range that can never apply is absent from the list entirely.
export interface RangeOption {
    range: DiffRange;
    label: string;
    detail: string;
    available: boolean;
    reason?: string;
}

// The history pane's divider label and the name of what its synthetic top row counts. Owned here
// rather than in githistorystore because it is derived from the range and nothing else.
export interface LoadHistoryOpts {
    anchor?: string;
    anchorLabel?: string;
    rowLabel?: string;
}

export function originKey(o: DiffOrigin): string {
    switch (o.kind) {
        case "agent":
            return `agent:${o.id}`;
        case "project":
            return `project:${o.name}`;
        case "run":
            return `run:${o.runId}`;
    }
}

export function rangeKey(r: DiffRange): string {
    switch (r.kind) {
        case "working":
            return "working";
        case "session":
            return `session:${r.agentId}`;
        case "run":
            return `run:${r.runId}:${r.baseCommit}`;
        case "compare":
            return `compare:${r.base}..${r.head}:${r.form}`;
    }
}

// Identifies the subject a change-list read belongs to. Stale reads are dropped by comparing this,
// and a deep link names the scope it wants with it, so both sides speak one vocabulary.
export function scopeKey(scope: DiffScope): string {
    return `${originKey(scope.repo.origin)}|${rangeKey(scope.range)}`;
}

// Deliberately range-free. git's commit list depends on the directory and the filters; the range only
// labels a divider and the synthetic top row, both of which are derived from an atom. Folding the
// range in here would blank the list and scroll to the top on every range change.
export function historyKey(cwd: string, f: HistoryFilters): string {
    return `${cwd}|${f.author}|${f.path}|${f.text}`;
}

export function originCwd(o: DiffOrigin): string | null {
    switch (o.kind) {
        case "project":
            return o.path || null;
        case "run":
            return o.cwd || null;
        case "agent":
            return null;
    }
}

export function defaultRangeFor(o: DiffOrigin): DiffRange {
    switch (o.kind) {
        case "agent":
            return { kind: "session", agentId: o.id };
        case "project":
            return { kind: "working" };
        case "run":
            return { kind: "run", runId: o.runId, baseCommit: o.baseCommit };
    }
}

export interface RangeCtx {
    // null when the agent's transcript has not yielded a session start yet
    sessionStartTs: number | null;
    // the commit the backend resolved for the active session range; "" when that range is not active
    sessionRef: string;
}

export function availableRanges(scope: DiffScope, ctx: RangeCtx): RangeOption[] {
    const out: RangeOption[] = [{ range: { kind: "working" }, label: "Working tree", detail: "", available: true }];
    const origin = scope.repo.origin;
    if (origin.kind === "agent") {
        out.push({
            range: { kind: "session", agentId: origin.id },
            label: "Since session start",
            detail: scope.range.kind === "session" ? shortSha(ctx.sessionRef) : "",
            available: ctx.sessionStartTs != null,
            reason: ctx.sessionStartTs == null ? "no session-start commit recorded yet" : undefined,
        });
    }
    if (origin.kind === "run") {
        out.push({
            range: { kind: "run", runId: origin.runId, baseCommit: origin.baseCommit },
            label: "This run",
            detail: shortSha(origin.baseCommit),
            available: true,
        });
    }
    out.push({
        range: currentCompareRange(scope.range),
        label: "Compare",
        detail: "",
        available: true,
    });
    return out;
}

// Re-entering comparison offers the pair last used, and never nests: comparing while comparing keeps
// the range that comparison originally interrupted.
function currentCompareRange(active: DiffRange): DiffRange {
    if (active.kind === "compare") {
        return active;
    }
    return { kind: "compare", base: "", head: "", form: "mergebase", from: active };
}

export function historyOptsFor(range: DiffRange, resolvedRef: string): LoadHistoryOpts {
    switch (range.kind) {
        case "session":
            return resolvedRef
                ? { anchor: resolvedRef, anchorLabel: "session start", rowLabel: "Since session start" }
                : {};
        case "run":
            return range.baseCommit
                ? { anchor: range.baseCommit, anchorLabel: "run base", rowLabel: "Run changes" }
                : {};
        case "working":
        case "compare":
            return {};
    }
}

export interface SummaryFacts {
    branch: string;
    ref: string;
    files: number;
    adds: number;
    dels: number;
}

// The quiet line under the subject bar. A string, rendered in a span — deliberately not a control,
// because the button that used to hold this text was the only way into comparison and read as a
// status line.
export function rangeSummary(range: DiffRange, f: SummaryFacts): string {
    const counts = `${f.files} ${f.files === 1 ? "file" : "files"} · +${f.adds} −${f.dels}`;
    switch (range.kind) {
        case "compare":
            return `${range.base} … ${range.head} · ${range.form === "tips" ? "tip to tip" : "since merge base"} · ${counts}`;
        case "run":
            return `${shortSha(range.baseCommit)} … HEAD · ${counts}`;
        case "session":
            return `worktree against ${shortSha(f.ref)} · ${counts}`;
        case "working":
            return `uncommitted work against HEAD on ${f.branch || "—"} · ${counts}`;
    }
}

// What the surface has on hand when it draws the summary. Two change lists, because comparison has
// its own store: the surface reads compare's, so the line has to read compare's too.
export interface SummaryInput {
    range: DiffRange;
    branch: string;
    ref: string;
    changes: GitChanges | null;
    compareChanges: GitChanges | null;
}

// Picks the change list the panes are showing and phrases it. Fed from the history store in every
// mode, the line printed the working tree's totals under the compare's ref names.
export function summaryLine(input: SummaryInput): string {
    const src = input.range.kind === "compare" ? input.compareChanges : input.changes;
    return rangeSummary(input.range, {
        branch: input.branch,
        ref: input.ref,
        files: src?.files.length ?? 0,
        adds: src?.adds ?? 0,
        dels: src?.dels ?? 0,
    });
}

function shortSha(sha: string): string {
    return sha ? sha.slice(0, 7) : "";
}
