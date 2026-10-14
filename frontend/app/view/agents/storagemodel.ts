// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Storage section's pure model: rows, stats, the Clear and Delete anyway confirms, and the labels around
// them, all derived from wavesrv's StorageReportData. storagesection.tsx only renders it. Copy follows the
// storage-report canvas (Page.dc.html).

import { fmtSize } from "@/app/cockpit/resmon";
import type { OpenTarget } from "@/app/view/jarvis/address";
import { formatAge } from "./agentsviewmodel";

type Group = "left" | "inuse" | "kept";
type Tone = "muted" | "success" | "accent" | "error";

export type StorageRowVM = {
    id: string;
    path: string;
    full: string;
    kind: string;
    owner: string;
    ownerMeta: string;
    run: OpenTarget | null;
    size: string;
    barPct: number;
    idle: string;
    loses: string;
    losesMuted: boolean;
    tag: { text: string; tone: Tone } | null;
    canDelete: boolean;
};

export type StorageSectionVM = { group: Group; title: string; meta: string; rows: StorageRowVM[] };

// a run of confirm text; strong marks a path or branch the dialog sets brighter
export type StorageText = { text: string; strong?: boolean };

export const EMPTY_LEFT_TEXT = "Nothing left over. Every folder here belongs to a live run or is kept on purpose.";
export const NOT_COUNTED_TEXT = "Not counted: build output of your own checkouts, such as src-tauri\\target.";
export const CLEAR_LEAD = "Deletes what no run needs and loses nothing:";
export const CLEAR_TAIL = "Live runs and kept items are never touched.";

const NO_VALUE = "—";
const PENDING = "…";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MINUTE = 60_000;
const HELD_TEXT = "Couldn’t clear: a process has it open. Close the terminal or editor in it, then clear again.";

const SECTIONS: { group: Group; title: string; meta: string }[] = [
    { group: "left", title: "Left over", meta: "its run finished, or no run owns it" },
    { group: "inuse", title: "In use", meta: "a run is working in it" },
    { group: "kept", title: "Kept on purpose", meta: "caches and history Arc reads" },
];

// Left over lists run trees, then legacy trees, branches and Final outputs
const LEFT_RANK: Record<string, number> = { runtree: 0, legacytree: 1, legacygroup: 1, branch: 2, finalout: 3 };
const GROUP_KINDS = new Set(["legacygroup", "finalout", "finalstores"]);
const TREE_KINDS = new Set(["runtree", "legacytree"]);

function plural(n: number, word: string, many = `${word}s`): string {
    return `${n} ${n === 1 ? word : many}`;
}

function sum(items: StorageItem[]): number {
    return items.reduce((total, it) => total + (it.size ?? 0), 0);
}

function base(p: string): string {
    return (p ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
}

// a run key's uuid shortened to 8, its suffix kept: "9e473bf8-e50f-…-t-2" reads "9e473bf8-t-2"
function shortKey(name: string): string {
    const m = UUID_RE.exec(name);
    return m ? name.slice(0, 8) + name.slice(m[0].length) : name;
}

function shortBranch(branch: string): string {
    return branch.startsWith("wave/") ? `wave/${shortKey(branch.slice("wave/".length))}` : branch;
}

function memberCount(it: StorageItem): number {
    return it.paths?.length || it.count || 0;
}

function pad2(n: number): string {
    return String(n).padStart(2, "0");
}

// a time today as HH:MM, an earlier one as MM-DD
function when(ts: number, now: number): string {
    const d = new Date(ts);
    if (d.toDateString() === new Date(now).toDateString()) {
        return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function shortPath(it: StorageItem): string {
    const name = base(it.path);
    switch (it.kind) {
        case "runtree":
            return `arc-wt\\${shortKey(name)}`;
        case "legacytree":
            return `.waveterm\\worktrees\\${shortKey(name)}`;
        case "legacygroup":
            return `.waveterm\\worktrees (${memberCount(it)})`;
        case "branch":
            return shortBranch(it.branch ?? "");
        case "finalout":
            if (base(it.paths?.[0] ?? "").startsWith("arc-final-out-")) {
                return `arc-final-out-* (${memberCount(it)})`;
            }
            return `${name}\\arc-final-* (${memberCount(it)})`;
        case "finalslot":
            return `arc-final\\${name}`;
        case "finalstores":
            return `arc-final\\stores-* (${memberCount(it)})`;
        case "finalshots":
            return `data\\final-shots (${it.count ?? 0})`;
        case "transcripts":
            return it.harness === "pi" ? ".pi" : ".claude\\projects";
    }
    return name;
}

function fullPath(it: StorageItem): string {
    return it.path || `${it.projectname}: refs/heads/${it.branch}`;
}

function treeRole(suffix: string): string {
    if (!suffix) {
        return "landing tree";
    }
    if (suffix === "-final") {
        return "final tree";
    }
    return /^-t-\d+$/.test(suffix) ? "lane tree" : "run tree";
}

function gitState(it: StorageItem): string {
    return `${it.hasgit ? "" : ", emptied"} · ${it.tracked ? "in git" : "not in git"}`;
}

function kindLine(it: StorageItem): string {
    switch (it.kind) {
        case "runtree":
            return treeRole(it.suffix ?? "") + gitState(it);
        case "legacytree":
            if (!it.hasgit) {
                return "old in-project tree" + gitState(it);
            }
            return `checkout, old in-project layout · ${it.dirty ? plural(it.dirty, "uncommitted file") : "clean"}`;
        case "legacygroup":
            return "old in-project trees, emptied · not in git";
        case "branch":
            if (it.runlandstate === "held" && it.runlanddismissed) {
                return "branch only · held land you dismissed";
            }
            return "branch only, no folder";
        case "finalout":
            return "Final outputs from hand-run Finals";
        case "finalslot":
            return `Final build slot ${it.slot ?? 0} · warm cargo target`;
        case "finalstores":
            return "dev-app stores of past Finals";
        case "finalshots":
            return `Final screenshots of ${it.count ?? 0} runs · kept 30 days`;
        case "transcripts":
            return it.harness === "pi" ? "pi sessions and config" : "Claude Code session transcripts";
    }
    return it.kind;
}

function owner(it: StorageItem): string {
    if (it.runid) {
        return it.runtitle || shortKey(it.runid);
    }
    switch (it.kind) {
        case "legacygroup":
            return plural(it.runcount ?? 0, "finished run");
        case "finalslot":
        case "finalstores":
        case "finalshots":
            return "Final stage";
        case "transcripts":
            return it.harness === "pi" ? "pi" : "Claude Code";
    }
    return "No run";
}

function runWhen(it: StorageItem, now: number): string {
    const at = when(it.runts ?? 0, now);
    if (it.runstatus === "cancelled") {
        return `cancelled ${at}`;
    }
    if (it.runstatus !== "done") {
        return it.runstatus ?? "";
    }
    if (it.runlandstate === "landed" || it.runlandstate === "held") {
        return `${it.runlandstate} ${at}`;
    }
    return `finished ${at}`;
}

function ownerMeta(it: StorageItem, now: number): string {
    switch (it.kind) {
        case "finalout":
            return "final-verify.mjs run by hand";
        case "finalslot":
            return "shared by every run’s Final";
        case "finalstores":
            return "dropped by the next Final on the slot";
        case "finalshots":
            return "swept at 30 days";
        case "transcripts":
            return "read by Usage and Sessions";
    }
    const parts = [it.projectname];
    if (it.kind === "legacygroup") {
        parts.push(`before ${when(it.runts ?? 0, now)}`);
    } else if (it.runid) {
        parts.push(runWhen(it, now));
    }
    return parts.filter(Boolean).join(" · ");
}

function loses(it: StorageItem): string {
    if (it.clearstate === "failed") {
        return it.clearheld ? HELD_TEXT : `Couldn’t clear: ${it.clearerror}`;
    }
    if (it.clearstate === "skipped") {
        return `Not cleared: ${it.clearerror || "it changed since the scan"}`;
    }
    if (it.group === "inuse") {
        return "The run’s work in progress";
    }
    switch (it.kind) {
        case "finalslot":
            return `The next Final on slot ${it.slot ?? 0} builds the app cold`;
        case "transcripts":
            return "Usage history and Sessions for those sessions";
        case "finalshots":
            return "Those runs’ Final steps stop opening their screenshots";
    }
    if (it.skip === "unreadable") {
        return "Unknown: its run or git state couldn’t be read";
    }
    const lost: string[] = [];
    if (it.onlycount) {
        lost.push(`${plural(it.onlycount, "commit")} only on ${shortBranch(it.branch ?? "")}`);
    }
    if (it.dirty) {
        lost.push(plural(it.dirty, "uncommitted file"));
    }
    if (lost.length > 0) {
        return lost.join(" and ");
    }
    return it.alsoon ? `Nothing: every commit is also on ${it.alsoon}` : "Nothing";
}

function tag(it: StorageItem): StorageRowVM["tag"] {
    switch (it.clearstate) {
        case "clearing":
            return { text: "Clearing…", tone: "accent" };
        case "cleared":
            return { text: "Cleared", tone: "success" };
        case "failed":
            return { text: it.clearheld ? "In use by a process" : "Couldn’t clear", tone: "error" };
        case "skipped":
            return { text: "Not cleared", tone: "muted" };
    }
    return it.group === "left" && it.skip ? { text: "Clear skips it", tone: "muted" } : null;
}

function ageLabel(ms: number): string {
    return ms < MINUTE ? "now" : formatAge(ms);
}

function idle(it: StorageItem, now: number): string {
    if (it.kind === "transcripts" || it.kind === "finalshots" || !it.modts) {
        return NO_VALUE;
    }
    const age = ageLabel(Math.max(0, now - it.modts));
    return GROUP_KINDS.has(it.kind) && memberCount(it) > 1 ? `${age}+` : age;
}

function jobRunning(r: StorageReportData): boolean {
    return !!r.scanning || !!r.clearing;
}

function rowVM(it: StorageItem, r: StorageReportData, maxSize: number, now: number): StorageRowVM {
    const isBranch = it.kind === "branch";
    const lost = loses(it);
    return {
        id: it.id,
        path: shortPath(it),
        full: fullPath(it),
        kind: kindLine(it),
        owner: owner(it),
        ownerMeta: ownerMeta(it, now),
        run: it.runid ? { kind: "run", runId: it.runid } : null,
        size: isBranch ? NO_VALUE : fmtSize(it.size),
        barPct: isBranch || maxSize <= 0 ? 0 : Math.max(1, Math.round((it.size / maxSize) * 100)),
        idle: idle(it, now),
        loses: lost,
        losesMuted: lost.startsWith("Nothing"),
        tag: tag(it),
        canDelete:
            it.group === "left" && (it.skip === "commits" || it.skip === "dirty") && !it.clearstate && !jobRunning(r),
    };
}

function sorted(group: Group, items: StorageItem[]): StorageItem[] {
    const newest = (a: StorageItem, b: StorageItem) => (b.modts ?? 0) - (a.modts ?? 0);
    const list = items.filter((it) => it.group === group);
    if (group === "kept") {
        return list.sort((a, b) => b.size - a.size);
    }
    if (group === "inuse") {
        return list.sort(newest);
    }
    return list.sort((a, b) => (LEFT_RANK[a.kind] ?? 9) - (LEFT_RANK[b.kind] ?? 9) || newest(a, b));
}

function clearableRows(r: StorageReportData): StorageItem[] {
    return sorted("left", r.items ?? []).filter((it) => it.clearable && it.clearstate !== "cleared");
}

export function storageSections(r: StorageReportData, now: number): StorageSectionVM[] {
    if (!r.scants) {
        return [];
    }
    const items = r.items ?? [];
    const maxSize = Math.max(0, ...items.map((it) => it.size ?? 0));
    return SECTIONS.map((s) => ({ ...s, rows: sorted(s.group, items).map((it) => rowVM(it, r, maxSize, now)) }));
}

export function storageStats(r: StorageReportData): { group: string; label: string; value: string; sub: string }[] {
    if (!r.scants) {
        const sub = r.scanning ? "scanning" : "not scanned yet";
        return SECTIONS.map((s) => ({ group: s.group, label: s.title, value: PENDING, sub }));
    }
    const of = (g: Group) => (r.items ?? []).filter((it) => it.group === g);
    const left = of("left");
    const inuse = of("inuse");
    const kept = of("kept");
    const liveRuns = new Set(inuse.map((it) => it.runid).filter(Boolean)).size;
    return [
        {
            group: "left",
            label: "Left over",
            value: fmtSize(sum(left)),
            sub: left.length ? plural(left.length, "item") : "nothing to clear",
        },
        {
            group: "inuse",
            label: "In use",
            value: fmtSize(sum(inuse)),
            sub: liveRuns ? plural(liveRuns, "live run") : "no live runs",
        },
        {
            group: "kept",
            label: "Kept on purpose",
            value: fmtSize(sum(kept)),
            sub: `${plural(kept.length, "item")} · caches and history`,
        },
    ];
}

function skipReason(it: StorageItem): string {
    if (it.skip === "commits") {
        return `${plural(it.onlycount ?? 0, "commit")} ${it.onlycount === 1 ? "is" : "are"} only on its branch.`;
    }
    if (it.skip === "dirty") {
        return `it has ${plural(it.dirty ?? 0, "uncommitted file")}.`;
    }
    return "its run or git state couldn’t be read.";
}

export function clearPlan(r: StorageReportData): {
    ids: string[];
    size: number;
    title: string;
    lead: string;
    lines: string[];
    skipped: { path: string; reason: string }[];
    tail: string;
} {
    const rows = clearableRows(r);
    const size = sum(rows);
    const count = (pred: (it: StorageItem) => boolean, members: boolean) =>
        rows.filter(pred).reduce((n, it) => n + (members ? memberCount(it) : 1), 0);
    const folders = count((it) => TREE_KINDS.has(it.kind), false) + count((it) => it.kind === "legacygroup", true);
    const branches = count((it) => it.kind === "branch", false);
    const outputs = count((it) => it.kind === "finalout", true);
    const lines = [
        folders > 0 ? plural(folders, "empty run folder") : "",
        branches > 0 ? `${plural(branches, "wave branch", "wave branches")} whose commits are on other branches` : "",
        outputs > 0 ? `${plural(outputs, "output folder")} of Finals run by hand` : "",
    ].filter(Boolean);
    const skipped = sorted("left", r.items ?? [])
        .filter((it) => it.skip && it.clearstate !== "cleared")
        .map((it) => ({ path: shortPath(it), reason: skipReason(it) }));
    return {
        ids: rows.map((it) => it.id),
        size,
        title: `Clear ${fmtSize(size)} left over?`,
        lead: CLEAR_LEAD,
        lines,
        skipped,
        tail: CLEAR_TAIL,
    };
}

export function deletePlan(item: StorageItem): {
    title: string;
    lead: StorageText[];
    path: string;
    size: string;
    branch: string;
    commits: StorageCommit[];
    dirty: number;
    dirtyLine: string | null;
    cta: string;
} {
    const hasFolder = item.kind !== "branch" && !!item.path;
    const branch = item.branch ? shortBranch(item.branch) : "";
    const path = shortPath(item);
    const size = fmtSize(item.size);
    const only = item.onlycount ?? 0;
    const dirty = item.dirty ?? 0;
    let title = `Delete ${branch}?`;
    let lead: StorageText[] = [{ text: "Deletes the branch " }, { text: branch, strong: true }];
    if (hasFolder) {
        const name = shortKey(base(item.path));
        title = branch ? `Delete ${name} and its branch?` : `Delete ${name}?`;
        lead = [{ text: "Deletes the checkout " }, { text: path, strong: true }, { text: ` (${size})` }];
        if (branch) {
            lead.push({ text: " and the branch " }, { text: branch, strong: true });
        }
    }
    lead.push({ text: "." });
    if (only > 0) {
        lead.push({
            text:
                only === 1
                    ? " This commit is on no other branch and is lost for good:"
                    : ` These ${only} commits are on no other branch and are lost for good:`,
        });
    }
    const lost = [only ? plural(only, "commit") : "", dirty ? plural(dirty, "uncommitted file") : ""].filter(Boolean);
    return {
        title,
        lead,
        path,
        size,
        branch,
        commits: item.onlycommits ?? [],
        dirty,
        dirtyLine: dirty
            ? `Its ${plural(dirty, "uncommitted file")} ${dirty === 1 ? "is" : "are"} lost for good.`
            : null,
        cta: lost.length ? `Delete and lose ${lost.join(" and ")}` : "Delete",
    };
}

export function clearButton(r: StorageReportData): { show: boolean; enabled: boolean; label: string } {
    if (r.clearing) {
        const total = r.cleartotal ?? 0;
        return {
            show: true,
            enabled: false,
            label: `Clearing ${Math.min((r.cleardone ?? 0) + 1, total)} of ${total}…`,
        };
    }
    const rows = clearableRows(r);
    const again = (r.lastclear?.failed ?? []).some((f) => rows.some((it) => it.id === f.id));
    return {
        show: rows.length > 0,
        enabled: !r.scanning,
        label: again ? "Clear again" : `Clear ${fmtSize(sum(rows))} left over`,
    };
}

export function rescanEnabled(r: StorageReportData): boolean {
    return !jobRunning(r);
}

export function scannedLabel(r: StorageReportData, now: number): string {
    if (r.scanning) {
        return "scanning…";
    }
    return r.scants ? `scanned ${when(r.scants, now)}` : "not scanned yet";
}

export function resultNotice(
    r: StorageReportData
): { text: string; failure: string | null; failureWhy: string | null } | null {
    const lc = r.lastclear;
    if (!lc || r.clearing) {
        return null;
    }
    const text = `Cleared ${plural(lc.cleared, "item")}, ${fmtSize(lc.freed)} freed.`;
    const failed = lc.failed ?? [];
    if (failed.length === 0) {
        return { text, failure: null, failureWhy: null };
    }
    let why = "the rows below say why.";
    if (failed.length === 1) {
        const f = failed[0];
        const row = (r.items ?? []).find((it) => it.id === f.id);
        const path = row ? shortPath(row) : f.path || f.id;
        why = f.held ? `a process still has ${path} open.` : `${path}: ${f.error}.`;
    }
    return { text, failure: `${failed.length} couldn’t be cleared`, failureWhy: why };
}

export function scanErrorText(e: StorageScanError): string {
    return `Couldn’t list the run trees of ${e.projectname}: ${e.error}. Its folders are left out until the project path is fixed.`;
}

export function navSummary(r: StorageReportData | null): { count: string; pill: string | null } {
    if (!r?.scants) {
        return { count: PENDING, pill: null };
    }
    const left = sum((r.items ?? []).filter((it) => it.group === "left"));
    return { count: fmtSize(sum(r.items ?? [])), pill: left > 0 ? `${fmtSize(left)} left over` : null };
}

export function shouldAutoScan(r: StorageReportData | null): boolean {
    return r != null && !r.scants && !jobRunning(r);
}

export function pollWanted(r: StorageReportData | null): boolean {
    return r != null && jobRunning(r);
}
