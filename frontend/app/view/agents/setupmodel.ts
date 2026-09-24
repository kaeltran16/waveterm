// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure derivations behind the Setup surface's Instructions tab: each harness row's state, the first-run
// offer, the save count, and the editor's conflict transitions. setupstore.ts feeds these the agentsync
// RPC results; setupsurface.tsx renders them.

export type SetupSelection = "shared" | string; // "shared" is the one doc every harness gets; else a runtime
export const SHARED = "shared";

export type HarnessRowState = "in-sync" | "out-of-date" | "own-rules" | "memory-only" | "no-file" | "not-set-up";

export type HarnessDoc = Pick<
    CommandAgentSyncHarnessReadRtnData,
    "present" | "own" | "shared" | "memory" | "state" | "mtime" | "carried"
>;

// A harness row joins the status list (order, label, present) with that harness's file read.
export interface HarnessRow {
    runtime: string;
    label: string;
    present: boolean;
    path: string;
    doc: HarnessDoc | null; // null while the file read is outstanding
}

export function harnessRows(
    harnesses: AgentSyncHarness[],
    docs: Record<string, CommandAgentSyncHarnessReadRtnData>
): HarnessRow[] {
    return harnesses.map((h) => ({
        runtime: h.runtime,
        label: h.label,
        present: h.present,
        path: docs[h.runtime]?.path ?? "",
        doc: docs[h.runtime] ?? null,
    }));
}

// The spec's state table. Out of date outranks own rules because it is the one a save fixes; own rules
// outrank in sync because a region can be current while the harness still holds rules nobody else gets.
// A file with no region yet is out of date once a shared doc exists (the next save writes one into it).
export function harnessRowState(present: boolean, doc: HarnessDoc | null, sharedEmpty: boolean): HarnessRowState {
    if (!present) {
        return "not-set-up";
    }
    if (doc == null) {
        return "no-file";
    }
    if (doc.state === "stale") {
        return "out-of-date";
    }
    if (doc.carried > 0) {
        return "own-rules";
    }
    if (doc.state === "current") {
        return "in-sync";
    }
    if (doc.memory !== "") {
        return "memory-only";
    }
    // the backend reports an unreadable file as mtime 0, so no mtime means no file
    if (doc.mtime === 0 || sharedEmpty) {
        return "no-file";
    }
    return "out-of-date";
}

export function harnessRowLabel(state: HarnessRowState, carried: number): string {
    switch (state) {
        case "in-sync":
            return "In sync";
        case "out-of-date":
            return "Out of date";
        case "own-rules":
            return `Has ${carried} own ${carried === 1 ? "line" : "lines"}`;
        case "memory-only":
            return "Old memory only";
        case "no-file":
            return "No file yet";
        case "not-set-up":
            return "Not set up";
    }
}

export type Tone = "ok" | "warn" | "none";

export function harnessRowTone(state: HarnessRowState): Tone {
    switch (state) {
        case "in-sync":
            return "ok";
        case "out-of-date":
        case "own-rules":
        case "memory-only":
            return "warn";
        default:
            return "none";
    }
}

// "Save to N harnesses": a save projects into every present harness, whatever its state.
export function saveTargetCount(rows: Pick<HarnessRow, "present">[]): number {
    return rows.filter((r) => r.present).length;
}

// The "Saving writes to" rail note: what else that harness's file holds besides the shared block.
export function saveTargetNote(doc: HarnessDoc | null): string {
    if (doc == null) {
        return "";
    }
    const own = doc.carried > 0 ? `${doc.carried} own ${doc.carried === 1 ? "line" : "lines"}` : "";
    if (doc.memory === "") {
        return own || "no own rules";
    }
    return own ? `${own} + old memory` : "+ old memory";
}

// First run: there is nothing shared yet, and the user has not opened an empty page instead.
export function isFirstRun(savedShared: string, freshStart: boolean): boolean {
    return savedShared.trim() === "" && !freshStart;
}

export interface FirstRunOffer {
    runtime: string;
    label: string;
    path: string;
    lines: number;
    own: string;
}

// The harness whose own rules the shared doc should start from: the one with the most, the earlier row
// on a tie, or null when no present harness holds any.
export function firstRunOffer(rows: HarnessRow[]): FirstRunOffer | null {
    let best: FirstRunOffer | null = null;
    for (const r of rows) {
        const lines = r.present ? (r.doc?.carried ?? 0) : 0;
        if (lines > 0 && (best == null || lines > best.lines)) {
            best = { runtime: r.runtime, label: r.label, path: r.path, lines, own: r.doc!.own };
        }
    }
    return best;
}

export interface MemoryNotice {
    runtime: string;
    label: string;
    bytes: number;
}

export function memoryNotices(rows: HarnessRow[]): MemoryNotice[] {
    return rows
        .filter((r) => r.present && (r.doc?.memory ?? "") !== "")
        .map((r) => ({ runtime: r.runtime, label: r.label, bytes: new TextEncoder().encode(r.doc!.memory).length }));
}

const KB = 1024;

export function formatSize(bytes: number): string {
    return bytes < KB ? `${bytes} B` : `${Math.round(bytes / KB)} KB`;
}

export interface HeaderStatus {
    text: string;
    tone: Tone;
}

export function headerStatus(rows: HarnessRow[], firstRun: boolean): HeaderStatus {
    const present = rows.filter((r) => r.present);
    const n = present.length;
    if (n === 0) {
        return { text: "No harnesses set up", tone: "none" };
    }
    if (firstRun) {
        const without = present.filter((r) => (r.doc?.carried ?? 0) === 0).length;
        if (without === 0) {
            return { text: `Each harness keeps its own rules`, tone: "warn" };
        }
        return { text: `${without} of ${n} harnesses get none of your rules`, tone: "warn" };
    }
    const behind = present.filter((r) => r.doc?.state !== "current").length;
    if (behind === 0) {
        return { text: `${n} ${n === 1 ? "harness" : "harnesses"} in sync`, tone: "ok" };
    }
    return { text: `${behind} of ${n} harnesses out of date`, tone: "warn" };
}

// The read-only shared zone's status line on a harness page.
export function sharedZoneStatus(doc: HarnessDoc): { text: string; tone: Tone } {
    if (doc.state === "current") {
        const n = lineCount(doc.shared);
        return { text: `Same as shared · ${n} ${n === 1 ? "line" : "lines"}`, tone: "ok" };
    }
    if (doc.state === "stale") {
        return { text: "Out of date: save the shared doc to update", tone: "warn" };
    }
    return { text: "Not in this file yet: save the shared doc to add it", tone: "none" };
}

export function lineCount(text: string): number {
    const t = text.replace(/\n+$/, "");
    return t === "" ? 0 : t.split("\n").length;
}

// The first lines of a block for a collapsed preview, and how many it leaves out.
export function previewLines(text: string, max: number): { lines: string[]; more: number } {
    const all = text.replace(/\n+$/, "").split("\n");
    if (all.length === 1 && all[0] === "") {
        return { lines: [], more: 0 };
    }
    return { lines: all.slice(0, max), more: Math.max(0, all.length - max) };
}

// "N lines changed": lines the draft adds or drops against what was loaded, as a multiset so a moved
// line does not count and an insertion does not shift every line after it.
export function changedLineCount(base: string, draft: string): number {
    if (base === draft) {
        return 0;
    }
    const pool = new Map<string, number>();
    for (const l of base.split("\n")) {
        pool.set(l, (pool.get(l) ?? 0) + 1);
    }
    let added = 0;
    for (const l of draft.split("\n")) {
        const left = pool.get(l) ?? 0;
        if (left > 0) {
            pool.set(l, left - 1);
        } else {
            added++;
        }
    }
    let removed = 0;
    for (const left of pool.values()) {
        removed += left;
    }
    return Math.max(added, removed, 1);
}

// ---- editor: draft, mtime guard, conflict ----

// One editable file: what was read (base, mtime), what the user has typed (draft), and whether the last
// save found the file changed on disk. The shared doc and a harness's own zone both use it.
export interface DocEditor {
    base: string;
    mtime: number;
    draft: string;
    conflict: boolean;
}

export const EMPTY_EDITOR: DocEditor = { base: "", mtime: 0, draft: "", conflict: false };

export function isDirty(ed: DocEditor): boolean {
    return ed.draft !== ed.base;
}

// A background read. A clean editor takes the disk as is. A draft keeps its base and mtime, so an
// outside edit still surfaces as a conflict on save, unless the edited text itself is unchanged on disk:
// a shared save rewrites every harness file (new mtime, same own zone), and that must not read as one.
export function editorLoaded(ed: DocEditor, content: string, mtime: number): DocEditor {
    if (!isDirty(ed)) {
        return editorReload(content, mtime);
    }
    return content === ed.base ? { ...ed, mtime } : ed;
}

export function editorTyped(ed: DocEditor, draft: string): DocEditor {
    return { ...ed, draft };
}

export function editorDiscard(ed: DocEditor): DocEditor {
    return { ...ed, draft: ed.base, conflict: false };
}

// Reload after a conflict: the disk wins and the draft is lost.
export function editorReload(content: string, mtime: number): DocEditor {
    return { base: content, mtime, draft: content, conflict: false };
}

// The baseMtime a save sends. Overwrite sends 0, which the backend reads as "skip the check".
export function saveBaseMtime(ed: DocEditor, overwrite: boolean): number {
    return overwrite ? 0 : ed.mtime;
}

// The result of writing `written`. A conflict keeps the draft and the old mtime, so a plain save
// conflicts again until the user picks Reload or Overwrite. Typing that landed while the write was in
// flight stays a draft.
export function editorSaved(ed: DocEditor, written: string, res: { mtime: number; conflict: boolean }): DocEditor {
    if (res.conflict) {
        return { ...ed, conflict: true };
    }
    return { base: written, mtime: res.mtime, draft: ed.draft, conflict: false };
}

// "Codex, OpenCode and Pi"
export function joinLabels(labels: string[]): string {
    if (labels.length <= 1) {
        return labels[0] ?? "";
    }
    return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
