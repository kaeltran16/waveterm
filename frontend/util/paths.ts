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
