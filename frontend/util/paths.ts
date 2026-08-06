// frontend/util/paths.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Windows-only build: git reports repo-relative paths with forward slashes while a project root
// uses backslashes, so a raw `${root}/${rel}` join is mixed-separator. Normalizing the whole join
// to backslashes is what makes open::that (ShellExecute) resolve it and a copied absolute path a
// valid native Windows path.
export function joinRepoPath(root: string, rel: string): string {
    return `${root}/${rel}`.replace(/\/+/g, "\\").replace(/\\+/g, "\\");
}

// A repository path reaches the cockpit either from git (forward slashes) or from the config
// registry (backslashes), so equality has to ignore separator style — and NTFS ignores case.
// joinRepoPath cannot serve here: it builds one path for ShellExecute, it does not compare two.
// An empty path matches nothing, so a blank cwd can never claim a registered project.
export function sameRepoPath(a: string, b: string): boolean {
    if (!a || !b) {
        return false;
    }
    return normalizeRepoPath(a) === normalizeRepoPath(b);
}

function normalizeRepoPath(p: string): string {
    return p
        .replace(/[\\/]+/g, "/")
        .replace(/\/+$/, "")
        .toLowerCase();
}

// The directory name, used to label a repository that is not in the project registry — a worktree,
// which launchAgent creates and which the Code surface can still browse.
export function repoBasename(p: string): string {
    const segs = p.split(/[\\/]+/).filter((s) => s !== "");
    return segs.length === 0 ? "" : segs[segs.length - 1];
}
