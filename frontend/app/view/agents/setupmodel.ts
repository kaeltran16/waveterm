// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure derivations behind the Setup surface's Instructions tab: each harness row's state, the header
// status, the save count, and the editor's conflict transitions. setupstore.ts feeds these the agentsync
// RPC results; setupinstructions.tsx renders them.

export type HarnessRowState = "in-sync" | "out-of-date" | "not-written" | "blank" | "not-set-up";

// "absent" covers a missing file and a file with no Arc region. "blank" means the shared doc is empty,
// so there is nothing to write, whatever the harness file holds.
export function harnessRowState(h: Pick<AgentSyncHarness, "present" | "steering">): HarnessRowState {
    if (!h.present) {
        return "not-set-up";
    }
    if (h.steering === "current") {
        return "in-sync";
    }
    if (h.steering === "stale") {
        return "out-of-date";
    }
    if (h.steering === "blank") {
        return "blank";
    }
    return "not-written";
}

export function harnessRowLabel(state: HarnessRowState): string {
    switch (state) {
        case "in-sync":
            return "In sync";
        case "out-of-date":
            return "Out of date";
        case "not-written":
            return "Not written yet";
        case "blank":
            return "Shared doc is empty";
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
            return "warn";
        default:
            return "none";
    }
}

// "Save to N harnesses": a save writes every present harness, whatever its state.
export function saveTargetCount(rows: Pick<AgentSyncHarness, "present">[]): number {
    return rows.filter((r) => r.present).length;
}

export interface HeaderStatus {
    text: string;
    tone: Tone;
}

type SteeringRow = Pick<AgentSyncHarness, "present" | "steering">;

function countStates(rows: SteeringRow[]): Record<HarnessRowState, number> {
    const n: Record<HarnessRowState, number> = {
        "in-sync": 0,
        "out-of-date": 0,
        "not-written": 0,
        blank: 0,
        "not-set-up": 0,
    };
    for (const r of rows) {
        n[harnessRowState(r)]++;
    }
    return n;
}

// Out of date warns: the harness follows an older doc. Not written yet does not: nothing is wrong
// with it, it has only not received the doc.
export function headerStatus(rows: SteeringRow[]): HeaderStatus {
    const n = countStates(rows);
    const present = rows.length - n["not-set-up"];
    if (present === 0) {
        return { text: "No harnesses set up", tone: "none" };
    }
    if (n.blank > 0) {
        return { text: "The shared doc is empty", tone: "none" };
    }
    if (n["in-sync"] === present) {
        return { text: `${present} ${present === 1 ? "harness" : "harnesses"} in sync`, tone: "ok" };
    }
    const parts = [];
    if (n["out-of-date"] > 0) {
        parts.push(`${n["out-of-date"]} out of date`);
    }
    if (n["not-written"] > 0) {
        parts.push(`${n["not-written"]} not written yet`);
    }
    return { text: parts.join(" · "), tone: n["out-of-date"] > 0 ? "warn" : "none" };
}

// Sync now has work to do: a present harness lacks the current doc, and the doc is not empty.
export function needsSync(rows: SteeringRow[]): boolean {
    const n = countStates(rows);
    return n.blank === 0 && n["out-of-date"] + n["not-written"] > 0;
}

export function lineCount(text: string): number {
    const t = text.replace(/\n+$/, "");
    return t === "" ? 0 : t.split("\n").length;
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

// lines of `from` that `against` lacks, in order, as a multiset
function linesMissing(from: string, against: string): string[] {
    const pool = new Map<string, number>();
    for (const l of against.split("\n")) {
        pool.set(l, (pool.get(l) ?? 0) + 1);
    }
    const out: string[] = [];
    for (const l of from.split("\n")) {
        const left = pool.get(l) ?? 0;
        if (left > 0) {
            pool.set(l, left - 1);
        } else {
            out.push(l);
        }
    }
    return out;
}

// What an outside edit did to the doc against what the editor loaded, listed in the conflict notice.
// Blank lines are left out: an empty entry in the list tells the user nothing.
export function diskChanges(base: string, disk: string): { added: string[]; dropped: string[] } {
    const shown = (l: string) => l.trim() !== "";
    return {
        added: linesMissing(disk, base).filter(shown),
        dropped: linesMissing(base, disk).filter(shown),
    };
}

// ---- editor: draft, mtime guard, conflict ----

// One editable file: what was read (base, mtime), what the user has typed (draft), whether the last
// save found the file changed on disk, and the file as read after that conflict (disk; null = not read).
// The shared doc uses it.
export interface DocEditor {
    base: string;
    mtime: number;
    draft: string;
    conflict: boolean;
    disk: string | null;
}

export const EMPTY_EDITOR: DocEditor = { base: "", mtime: 0, draft: "", conflict: false, disk: null };

export function isDirty(ed: DocEditor): boolean {
    return ed.draft !== ed.base;
}

// A background read. A clean editor takes the disk as is. A draft keeps its base and mtime, so an
// outside edit still surfaces as a conflict on save, unless the text on disk is unchanged and only its
// mtime moved.
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
    return { ...ed, draft: ed.base, conflict: false, disk: null };
}

// Reload after a conflict: the disk wins and the draft is lost.
export function editorReload(content: string, mtime: number): DocEditor {
    return { base: content, mtime, draft: content, conflict: false, disk: null };
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
    return { base: written, mtime: res.mtime, draft: ed.draft, conflict: false, disk: null };
}
