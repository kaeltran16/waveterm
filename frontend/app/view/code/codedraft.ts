// frontend/app/view/code/codedraft.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: unsaved edits and the decision of whether saving one is safe. No React, no IO.
//
// A draft pins the disk state it was based on. That is the whole point: this repo's working tree is
// shared with running agents, so between reading a file and saving it someone else may have rewritten
// it. Comparing the pinned base against a fresh stat is what turns a silent clobber into a refusal.

export interface FileBase {
    text: string;
    size: number;
    modtime: number;
}

export interface Draft {
    text: string;
    base: FileBase;
}

// keyed by absolute path: repo-relative keys would collide across projects, and drafts outlive the
// project switch that would make a relative key ambiguous
export type Drafts = ReadonlyMap<string, Draft>;

// what a fresh stat says about a file we hold a draft for
export interface StatLike {
    notfound?: boolean;
    size?: number;
    modtime?: number;
}

export type Conflict = "none" | "missing" | "changed";

export function conflictOf(base: FileBase, latest: StatLike | null): Conflict {
    if (latest == null || latest.notfound) {
        return "missing";
    }
    // size and mtime together: mtime alone misses a same-second rewrite of different length, size
    // alone misses an equal-length edit. Neither is a hash, and this is not a security boundary —
    // it is here to catch an agent that wrote the file while it sat open.
    if ((latest.size ?? 0) !== base.size || (latest.modtime ?? 0) !== base.modtime) {
        return "changed";
    }
    return "none";
}

export function conflictMessage(c: Conflict): string {
    if (c === "missing") {
        return "The file is gone from disk. Your edits are still here — copy them out before leaving.";
    }
    return "The file changed on disk since you opened it (another agent, probably). Refusing to overwrite — reload to see theirs, and your edits are still here until you do.";
}

// Setting the text back to what is on disk clears the draft rather than storing a no-op one, so
// "dirty" always means "differs from disk" and undoing your way back marks the file clean.
export function nextDrafts(drafts: Drafts, key: string, base: FileBase, text: string): Map<string, Draft> {
    const out = new Map(drafts);
    if (text === base.text) {
        out.delete(key);
    } else {
        out.set(key, { text, base });
    }
    return out;
}

export function withoutDraft(drafts: Drafts, key: string): Map<string, Draft> {
    const out = new Map(drafts);
    out.delete(key);
    return out;
}
