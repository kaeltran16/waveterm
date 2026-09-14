// frontend/app/view/code/codepathinput.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: the checks on a typed project path that need no IO. notfound and notdir come from the stat
// the store makes, and are only worded here.

export type PathError = "empty" | "relative" | "notfound" | "notdir";

// a drive root, a UNC share or a POSIX root; "C:repos" is relative to that drive's cwd
const ABSOLUTE_RE = /^(?:[a-z]:[\\/]|[\\/])/i;

export function cleanPathInput(raw: string): string {
    const trimmed = raw.trim();
    const unquoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
    return unquoted ? trimmed.slice(1, -1).trim() : trimmed;
}

export function validatePathInput(raw: string): PathError | null {
    const path = cleanPathInput(raw);
    if (path === "") {
        return "empty";
    }
    // there is no cwd to resolve a relative path against
    return ABSOLUTE_RE.test(path) ? null : "relative";
}

// isdir is the only positive answer; an absent flag is not taken as a directory
export function statPathError(info: { notfound?: boolean; isdir?: boolean } | null): PathError | null {
    if (info == null || info.notfound) {
        return "notfound";
    }
    return info.isdir ? null : "notdir";
}

export function pathErrorMessage(e: PathError, path: string): string {
    switch (e) {
        case "empty":
            return "Enter a directory path";
        case "relative":
            return "Enter an absolute path";
        case "notfound":
            return `No such directory: ${path}`;
        case "notdir":
            return "That is a file, not a directory";
    }
}
