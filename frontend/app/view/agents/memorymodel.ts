// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure derivations behind the Setup surface's Memory tab: the rows that wait for the user, each row's state
// and buttons, and the lines of what Arc did this week. memorystore.ts feeds these the memhygiene RPC results;
// setupmemory.tsx renders them.

import { fmtClock } from "./runcompletion";
import type { Tone } from "./setupmodel";

export interface StatusText {
    text: string;
    tone: Tone;
}

function count(n: number, one: string, many = `${one}s`): string {
    return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function kb(bytes: number): string {
    return bytes === 0 ? "0" : (bytes / 1000).toFixed(1);
}

function basename(path: string): string {
    const parts = path.split(/[\\/]/).filter((s) => s !== "");
    return parts[parts.length - 1] ?? "";
}

function monthDay(ts: number): string {
    return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// "today", "yesterday" or "Oct 12", by calendar day in local time.
function dayName(ts: number, now: number): string {
    const day = new Date(ts).toDateString();
    if (day === new Date(now).toDateString()) {
        return "today";
    }
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return day === yesterday.toDateString() ? "yesterday" : monthDay(ts);
}

// the shared folder is named for the git toplevel's slug (every non-alphanumeric char becomes "-",
// agentobserve.SlugifyCwd), so the project path's ancestor with that slug names the repo. a folder set
// by autoMemoryDirectory matches no ancestor and falls back to its own name.
function repoName(path: string, folder: string): string {
    const folderParts = folder.split(/[\\/]/).filter((s) => s !== "");
    const last = folderParts[folderParts.length - 1] ?? "";
    const slugDir = (last.toLowerCase() === "memory" ? folderParts[folderParts.length - 2] : last) ?? "";
    const segs = path.replace(/[\\/]+$/, "").split(/[\\/]/);
    for (let i = segs.length; i > 0; i--) {
        const slug = segs
            .slice(0, i)
            .join("/")
            .replace(/[^A-Za-z0-9]/g, "-");
        if (slug.toLowerCase() === slugDir.toLowerCase()) {
            return segs[i - 1];
        }
    }
    return slugDir;
}

function sharedRepo(p: MemHygieneProject): string {
    return repoName(p.path, p.formershared || p.folder);
}

function sameFolder(a: string, b: string): boolean {
    const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return a !== "" && norm(a) === norm(b);
}

// an undecided change: open, or found changed on disk and waiting on a fresh check. memhygiene.Pending
// in pkg/memhygiene/split.go mirrors it.
function isPending(c: MemChange): boolean {
    return c.status !== "applied" && c.status !== "kept";
}

// a project sharing a folder with other registered projects gets the split, not ordinary changes.
function isSplit(p: MemHygieneProject): boolean {
    return (p.sharedwith?.length ?? 0) > 0;
}

function settingsChange(p: MemHygieneProject): MemChange | undefined {
    return p.changes.find((c) => c.kind === "settings");
}

export type KindTone = "remove" | "add" | "edit";

export function kindTone(kind: string): KindTone {
    switch (kind) {
        case "delete":
        case "remove-shared":
            return "remove";
        case "move-here":
        case "copy-here":
        case "add-to-index":
        case "move-to-doc":
            return "add";
        default:
            return "edit";
    }
}

export function kindLabel(p: MemHygieneProject, change: MemChange): string {
    switch (change.kind) {
        case "delete":
            return "Delete";
        case "trim":
            return "Trim";
        case "merge":
            return "Merge";
        case "move-to-doc":
            return `Move to ${basename(change.op.docpath) || "AGENTS.md"}`;
        case "add-to-index":
            return "Add to index";
        case "move-here":
            return "Move here";
        case "copy-here":
            return "Copy here";
        case "remove-shared":
            return `Remove from ${sharedRepo(p)}`;
        case "settings":
            return "Settings";
        default:
            return change.kind;
    }
}

// a diff's file named by its role, a MEMORY.md in the shared (or former
// shared) folder is the repo's, one in the own folder the project's; anything else goes by its name.
export function diffLabel(p: MemHygieneProject, path: string): string {
    const name = basename(path);
    if (name !== "MEMORY.md") {
        return name;
    }
    const dir = path.replace(/[\\/][^\\/]*$/, "");
    if (sameFolder(p.formershared || (isSplit(p) ? p.folder : ""), dir)) {
        return `${sharedRepo(p)}’s MEMORY.md`;
    }
    if (sameFolder(p.ownfolder, dir)) {
        return `${p.project}’s MEMORY.md`;
    }
    return name;
}

// ---- the one-page tab: what waits for the user, and what Arc did this week ----

// what Arc applies after each check without asking. mirrors routineKind in pkg/memhygiene/auto.go.
export const ROUTINE_KINDS: readonly string[] = ["trim", "delete", "merge", "add-to-index"];

// the check interval: each check's line lasts until the next check's
export const DID_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type RowKind = "split" | "cleanup" | "doc" | "failed";

export interface WaitingRow {
    key: string;
    kind: RowKind;
    project: string;
    changeId: string; // a doc move's change; "" otherwise
    chip: string;
    title: string;
    sub: string;
}

// <kind>/<project>, or doc/<project>/<changeId> for a doc move: data-memory-row and the scenario select by it
export function rowKey(kind: RowKind, project: string, changeId = ""): string {
    return kind === "doc" ? `doc/${project}/${changeId}` : `${kind}/${project}`;
}

function andList(names: string[]): string {
    return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function memCount(changes: MemChange[]): number {
    return changes.reduce((n, c) => n + (c.op.memories?.length ?? 0), 0);
}

// "today at 09:40", or "on Nov 20 at 09:07"
function whenAt(ts: number, now: number): string {
    const day = dayName(ts, now);
    return `${day === "today" || day === "yesterday" ? day : `on ${day}`} at ${fmtClock(ts)}`;
}

function sharedMoves(p: MemHygieneProject): MemChange[] {
    return p.changes.filter((c) => c.group === "shared" && (c.kind === "move-here" || c.kind === "copy-here"));
}

// a split waits while its switch-over is undecided; a kept one (Keep sharing) or a switched one doesn't
function pendingSplit(p: MemHygieneProject): boolean {
    const s = settingsChange(p);
    return isSplit(p) && s != null && isPending(s);
}

function openRemovals(p: MemHygieneProject): MemChange[] {
    return p.changes.filter((c) => c.kind === "remove-shared" && c.status === "open");
}

function docName(c: MemChange): string {
    return basename(c.op.docpath) || "AGENTS.md";
}

export interface SplitCounts {
    comeOver: number;
    move: number;
    copy: number;
    stay: number;
    leftOut: number;
    here: number;
    total: number;
    changed: number;
}

// memories, not changes: memories on one index line come over together. a left-out (kept) memory stays.
export function splitCounts(p: MemHygieneProject): SplitCounts {
    const moves = sharedMoves(p);
    const coming = moves.filter((c) => c.status !== "kept");
    const move = memCount(coming.filter((c) => c.kind === "move-here"));
    const copy = memCount(coming.filter((c) => c.kind === "copy-here"));
    // memories counts the shared folder at the last check, so a move applied before it already left it
    const movedBeforeCheck = memCount(
        moves.filter((c) => c.kind === "move-here" && c.status === "applied" && c.decidedat < p.checkedat)
    );
    return {
        comeOver: move + copy,
        move,
        copy,
        stay: Math.max(0, p.memories + movedBeforeCheck - move - copy),
        leftOut: memCount(moves.filter((c) => c.status === "kept")),
        here: memCount(moves.filter((c) => c.status === "applied")),
        total: move + copy,
        changed: memCount(moves.filter((c) => c.status === "conflict")),
    };
}

function splitSub(p: MemHygieneProject): string {
    const n = splitCounts(p);
    const stay = `${n.stay} stay in ${sharedRepo(p)}’s`;
    return n.leftOut > 0
        ? `${n.comeOver} come over · ${n.leftOut} left out · ${stay}`
        : `${n.comeOver} come over: ${n.move} move, ${n.copy} copy · ${stay}`;
}

function cleanupTook(p: MemHygieneProject): string {
    return p.switchedat ? `${p.project} took them on ${monthDay(p.switchedat)}` : `${p.project} took them`;
}

// one row per decision, in the order splits, cleanups, doc moves, failed checks. Waiting in
// pkg/memhygiene/rows.go counts by the same rule: a pending split not kept sharing, a project with open
// remove-shared changes, an open move-to-doc, a project whose last check failed.
export function waitingRows(projects: MemHygieneProject[]): WaitingRow[] {
    const row = (kind: RowKind, p: MemHygieneProject, chip: string, title: string, sub: string, changeId = "") => ({
        key: rowKey(kind, p.project, changeId),
        kind,
        project: p.project,
        changeId,
        chip,
        title,
        sub,
    });
    return [
        ...projects
            .filter(pendingSplit)
            .map((p) => row("split", p, "Own memory", `Give ${p.project} its own memory`, splitSub(p))),
        ...projects
            .filter((p) => openRemovals(p).length > 0)
            .map((p) =>
                row(
                    "cleanup",
                    p,
                    "Clear",
                    `Clear ${count(memCount(openRemovals(p)), "memory", "memories")} no project loads from ${sharedRepo(p)}’s memory`,
                    cleanupTook(p)
                )
            ),
        ...projects.flatMap((p) =>
            p.changes
                .filter((c) => c.kind === "move-to-doc" && c.status === "open")
                .map((c) =>
                    row(
                        "doc",
                        p,
                        kindLabel(p, c),
                        c.title,
                        `${p.project} · edits ${docName(c)} in your working tree`,
                        c.id
                    )
                )
        ),
        ...projects
            .filter((p) => p.lasterror)
            .map((p) =>
                row(
                    "failed",
                    p,
                    "Check failed",
                    `${p.project}’s last check failed`,
                    [p.lasterror, p.checkedat ? `checked ${monthDay(p.checkedat)} at ${fmtClock(p.checkedat)}` : ""]
                        .filter((s) => s !== "")
                        .join(" · ")
                )
            ),
    ];
}

// a memhygiene:<project> address opens the project's first row; a project with nothing waiting opens none
export function firstRowKey(projects: MemHygieneProject[], project: string): string | null {
    return waitingRows(projects).find((r) => r.project === project)?.key ?? null;
}

export function waitingStatus(projects: MemHygieneProject[]): StatusText {
    const rows = waitingRows(projects);
    if (rows.length === 0) {
        return { text: "Nothing waits for you", tone: "ok" };
    }
    const failed = rows.filter((r) => r.kind === "failed").length;
    const tail = failed > 0 ? ` · ${count(failed, "check")} failed` : "";
    return { text: `${rows.length} waiting for you${tail}`, tone: "warn" };
}

export function emptyText(projects: MemHygieneProject[]): string {
    const next = projects.map((p) => p.nextcheckat).filter((t) => t > 0);
    if (next.length === 0) {
        return "Nothing waits for you.";
    }
    const day = new Date(Math.min(...next)).toLocaleDateString("en-US", {
        weekday: "long",
        month: "short",
        day: "numeric",
    });
    return `Nothing waits for you. The next check runs ${day}.`;
}

// the changes a row's keep button keeps: Keep sharing keeps the switch-over, Keep them each open removal
export function keepIds(p: MemHygieneProject, row: WaitingRow): string[] {
    switch (row.kind) {
        case "split":
            return [settingsChange(p)?.id].filter((id) => id != null);
        case "cleanup":
            return openRemovals(p).map((c) => c.id);
        case "doc":
            return [row.changeId];
        default:
            return [];
    }
}

export interface SplitListGroup {
    label: string;
    count: number; // memories, left-out ones included
    changes: MemChange[];
}

export function splitList(p: MemHygieneProject): SplitListGroup[] {
    const moves = sharedMoves(p);
    return [
        { label: "Move here", kind: "move-here" },
        { label: "Copy here", kind: "copy-here" },
    ]
        .map(({ label, kind }) => {
            const changes = moves.filter((c) => c.kind === kind);
            return { label, count: memCount(changes), changes };
        })
        .filter((g) => g.changes.length > 0);
}

export type SplitStateKind = "open" | "applying" | "partial" | "changed" | "newer" | "failed";

export interface SplitState {
    state: SplitStateKind;
    tag: string; // beside the row's sub-line
    text: string;
    undo: string; // "" = no Undo
    next: string; // "Check now", "Try again" or ""
}

function memoriesText(n: number): { n: string; them: string; were: string; have: string } {
    return n === 1
        ? { n: "1 memory", them: "it", were: "was", have: "has" }
        : { n: `${n.toLocaleString("en-US")} memories`, them: "them", were: "were", have: "have" };
}

// changed comes from stored conflicts, so it survives a restart; newer and failed only from the last Apply's
// result, and only while no check has run since it
export function splitState(p: MemHygieneProject, applying: boolean, result: MemRowResult | null): SplitState {
    const n = splitCounts(p);
    const of = `${n.here} of ${n.total}`;
    const repo = sharedRepo(p);
    const stopped = (state: SplitStateKind, text: string, next: string): SplitState => ({
        state,
        tag: `${of} here`,
        text,
        undo: n.here > 0 ? `Undo the ${n.here}` : "",
        next,
    });
    if (applying) {
        return {
            state: "applying",
            tag: "Applying",
            text: `Bringing over ${of}, then switching over…`,
            undo: "",
            next: "",
        };
    }
    const r = result?.project.checkedat === p.checkedat ? result : null;
    if (r?.stop === "failed") {
        const verb = p.changes.find((c) => c.title === r.failed)?.kind === "copy-here" ? "copy" : "move";
        const stay = n.here > 0 ? `; the ${n.here} already here stay` : "";
        return stopped(
            "failed",
            `Stopped at ${n.here + 1} of ${n.total}. “${r.failed}” did not ${verb}: ${r.error.replace(/\.$/, "")}. ` +
                `${p.project} is not switched over${stay}.`,
            "Try again"
        );
    }
    if (r?.stop === "newer") {
        const m = memoriesText(r.newer);
        return stopped(
            "newer",
            `${of} already here, not switched over. ${m.n} ${m.were} written to ${repo}’s memory after the check ` +
                `and ${m.have} no sort yet; switching now would leave ${m.them} out of ${p.project}’s sessions. ` +
                "Check again, then Apply switches over.",
            "Check now"
        );
    }
    if (n.changed > 0) {
        const m = memoriesText(n.changed);
        const those = n.changed === 1 ? "it" : `those ${n.changed}`;
        return stopped(
            "changed",
            `${of} already here. ${m.n} changed on disk after the ${monthDay(p.checkedat)} check, so Arc left ` +
                `${m.them} in ${repo}’s memory and has not switched over. Check again to sort ${those}; Apply then ` +
                `brings ${m.them} over and switches.`,
            "Check now"
        );
    }
    if (n.here > 0) {
        return stopped("partial", "", "");
    }
    return { state: "open", tag: "", text: "", undo: "", next: "" };
}

export interface RowButton {
    label: string;
    disabled: boolean;
}

export interface RowButtons {
    // the row's main button, which a runs: an apply, or a check where only a fresh check can go on
    primary: (RowButton & { action: "apply" | "check" }) | null;
    keep: RowButton | null; // x
    undo: (RowButton & { batchId: string }) | null; // a split's "Undo the N", which undoes its batch
}

export interface RowContext {
    applying: boolean; // this row's Apply is in flight
    busy: boolean; // another decision is in flight
    result: MemRowResult | null; // the project's last row Apply
}

// the buttons an opened row shows, and whether each can be pressed now: the buttons and the keys both read this
export function rowButtons(p: MemHygieneProject, row: WaitingRow, ctx: RowContext): RowButtons {
    const held = ctx.busy || ctx.applying;
    const btn = (label: string) => ({ label, disabled: held });
    const apply = (label: string) => ({ ...btn(label), action: "apply" as const });
    const check = { label: "Check now", disabled: held || p.checking, action: "check" as const };
    switch (row.kind) {
        case "split": {
            const st = splitState(p, ctx.applying, ctx.result);
            if (st.state === "applying") {
                return { primary: null, keep: null, undo: null };
            }
            const batch = p.batches?.find((b) => b.kind === "split");
            const undo = st.undo !== "" && batch != null ? { ...btn(st.undo), batchId: batch.id } : null;
            if (st.state === "open" || st.state === "partial") {
                return { primary: apply("Apply and switch over"), keep: btn("Keep sharing"), undo };
            }
            return { primary: st.next === "Try again" ? apply(st.next) : check, keep: null, undo };
        }
        case "cleanup":
            return {
                primary: apply(`Clear ${memCount(openRemovals(p)).toLocaleString("en-US")}`),
                keep: btn("Keep them"),
                undo: null,
            };
        case "doc":
            // the chip is the move's own label: "Move to CLAUDE.md"
            return { primary: apply(row.chip), keep: btn("Keep"), undo: null };
        default:
            return { primary: check, keep: null, undo: null };
    }
}

export interface CleanupDetail {
    count: number; // memories
    opened: string; // the sub-line once opened
    body: string;
    changes: MemChange[];
}

// only open removals: a kept one was left out, and one changed on disk is the next check's
export function cleanupDetail(p: MemHygieneProject, projects: MemHygieneProject[]): CleanupDetail {
    const changes = openRemovals(p);
    const loaders = projects
        .filter((q) => q.project !== p.project && sameFolder(q.folder, p.formershared))
        .map((q) => q.project);
    const repo = sharedRepo(p);
    const which =
        loaders.length === 0
            ? "which no project loads any more"
            : `which ${andList(loaders)} load${loaders.length === 1 ? "s" : ""}`;
    return {
        count: memCount(changes),
        opened: `${cleanupTook(p)}; no other project loads them`,
        body: `These stay in ${p.project}’s own memory. Clearing them only takes them out of ${repo}’s, ${which}.`,
        changes,
    };
}

export interface DidLine {
    key: string; // <project>/<batchId>: data-memory-line selects by it
    project: string;
    batch: MemBatch;
    title: string;
    text: string;
    applied: MemChange[]; // the batch's changes still applied, in apply order
    refusal: string; // why Undo is refused; "" = it isn't
}

const KIND_NOUN: Record<string, [string, string]> = {
    trim: ["trim", "trims"],
    delete: ["delete", "deletes"],
    merge: ["merge", "merges"],
    "add-to-index": ["index add", "index adds"],
};

function kindCount(n: number, kind: string): string {
    const [one, many] = KIND_NOUN[kind] ?? [kind, kind];
    return count(n, one, many);
}

// most first; a tie in routine-kind order
function byKind(changes: MemChange[]): string {
    const counts = new Map<string, number>();
    for (const c of changes) {
        counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
    }
    const rank = (k: string) => (ROUTINE_KINDS.includes(k) ? ROUTINE_KINDS.indexOf(k) : ROUTINE_KINDS.length);
    return [...counts]
        .sort(([a, n], [b, m]) => m - n || rank(a) - rank(b))
        .map(([k, n]) => kindCount(n, k))
        .join(", ");
}

function skipReason(s: MemSkip): string {
    switch (s.reason) {
        case "changed":
            return "changed after the check";
        case "overlap":
            return "another change Arc made touched its memory";
        default:
            return `its apply failed (${s.error})`;
    }
}

// one phrase per kind and reason, in the order first skipped
function skipsText(skipped: MemSkip[]): string[] {
    const groups = new Map<string, { kind: string; n: number; reason: string }>();
    for (const s of skipped) {
        const key = `${s.kind}\u0000${s.reason}`;
        const g = groups.get(key) ?? { kind: s.kind, n: 0, reason: skipReason(s) };
        g.n++;
        groups.set(key, g);
    }
    return [...groups.values()].map((g) => `${kindCount(g.n, g.kind)} skipped: ${g.reason}`);
}

function didText(p: MemHygieneProject, b: MemBatch, applied: MemChange[], now: number): string {
    switch (b.kind) {
        case "split": {
            const leftOut = splitCounts(p).leftOut;
            const left = leftOut > 0 ? `, ${leftOut} left out in ${sharedRepo(p)}’s` : "";
            const day = dayName(b.at, now);
            return `Own memory since ${day} at ${fmtClock(b.at)} · ${memCount(applied.filter((c) => c.group === "shared"))} came over${left} · switched over`;
        }
        case "cleanup":
            return `Cleared ${count(memCount(applied), "memory", "memories")} no project loads ${whenAt(b.at, now)}`;
        case "doc":
            return `Moved to ${docName(applied[0])} ${whenAt(b.at, now)} · ${applied[0].title}`;
        default:
            return [
                `${count(applied.length, "change")} ${whenAt(b.at, now)}`,
                byKind(applied),
                ...skipsText(b.skipped ?? []),
            ].join(" · ");
    }
}

function refusalText(p: MemHygieneProject, b: MemBatch): string {
    const block = b.undoblock;
    if (block == null) {
        return "";
    }
    const m = memoriesText(block.memories);
    return (
        `Can’t undo yet. Clearing ${sharedRepo(p)}’s memory on ${monthDay(block.at)} removed ${m.n} this split ` +
        `brought over; undoing the split now would leave ${p.project}’s sessions without ${m.them}. ` +
        "Undo that cleanup first."
    );
}

// one line per batch applied this week, newest first across projects. a split shows once it switched over;
// a batch with nothing still applied shows nothing.
export function didLines(projects: MemHygieneProject[], now: number): DidLine[] {
    const lines: DidLine[] = [];
    for (const p of projects) {
        for (const b of p.batches ?? []) {
            if (b.at < now - DID_WINDOW_MS || (b.kind === "split" && settingsChange(p)?.status !== "applied")) {
                continue;
            }
            const applied = (b.changeids ?? [])
                .map((id) => p.changes.find((c) => c.id === id))
                .filter((c) => c?.status === "applied");
            if (applied.length === 0) {
                continue;
            }
            lines.push({
                key: `${p.project}/${b.id}`,
                project: p.project,
                batch: b,
                title: b.kind === "cleanup" ? `${sharedRepo(p)}’s memory` : p.project,
                text: didText(p, b, applied, now),
                applied,
                refusal: refusalText(p, b),
            });
        }
    }
    return lines.sort((a, b) => b.batch.at - a.batch.at);
}

export interface Digest {
    changes: MemChange[];
    undoEach: boolean; // a split undoes only as a whole
    index: string; // a routine batch's index, after and before; "" otherwise
    undoAll: string;
}

export function digest(line: DidLine): Digest {
    const b = line.batch;
    const ix = (s: MemIndexStats) => `${count(s.lines, "line")}, ${kb(s.bytes)} KB`;
    return {
        changes: line.applied,
        undoEach: b.kind !== "split",
        index:
            b.kind === "routine"
                ? `${line.project}’s MEMORY.md: ${ix(b.indexafter)} after these, from ${ix(b.indexbefore)}`
                : "",
        undoAll: `Undo all ${line.applied.length}`,
    };
}

// j and k walk the waiting rows, then the did lines, in the order the list draws them
export function selectionOrder(projects: MemHygieneProject[], now: number): string[] {
    return [...waitingRows(projects).map((r) => r.key), ...didLines(projects, now).map((l) => l.key)];
}

// the key delta places from current, stopping at either end; from nothing, or from a key gone, the first
export function stepSelection(order: string[], current: string | null, delta: number): string | null {
    if (order.length === 0) {
        return null;
    }
    const i = order.indexOf(current ?? "");
    return order[i < 0 ? 0 : Math.max(0, Math.min(order.length - 1, i + delta))];
}

// a waiting row and the did line its apply leaves are one thing changing sections: the list row morphs between
// them (moment 17) and the detail follows it
export function rowMorphKey(row: WaitingRow): string {
    return row.kind === "doc" ? `doc:${row.changeId}` : `${row.kind}:${row.project}`;
}

export function lineMorphKey(line: DidLine): string {
    return line.batch.kind === "doc" ? `doc:${line.batch.changeids?.[0] ?? ""}` : `${line.batch.kind}:${line.project}`;
}

const ROW_KINDS: readonly string[] = ["split", "cleanup", "doc", "failed"];

// a rowKey's morph key, for a row no longer listed; null for a did-line key
function rowKeyMorph(key: string): string | null {
    const [kind, ...rest] = key.split("/");
    if (!ROW_KINDS.includes(kind) || rest.length === 0) {
        return null;
    }
    return kind === "doc" ? `doc:${rest[rest.length - 1]}` : `${kind}:${rest.join("/")}`;
}

// what the detail shows: the stored key while listed; an applied row's did line; else the first in list order
export function resolveSelection(projects: MemHygieneProject[], now: number, stored: string | null): string | null {
    const order = selectionOrder(projects, now);
    if (stored != null && order.includes(stored)) {
        return stored;
    }
    const morph = stored == null ? null : rowKeyMorph(stored);
    const line = morph == null ? undefined : didLines(projects, now).find((l) => lineMorphKey(l) === morph);
    return line?.key ?? order[0] ?? null;
}
