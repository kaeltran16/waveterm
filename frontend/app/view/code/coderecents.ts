// frontend/app/view/code/coderecents.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: the picker's Recent list, most recent first. It is how a directory reached by path, or a
// worktree, stays one click away without being registered.

import { sameRepoPath } from "@/util/paths";
import type { CodeProject } from "./codestore";

export const MAX_RECENTS = 8;

export function pushRecent(list: readonly CodeProject[], p: CodeProject): CodeProject[] {
    return [p, ...pruneRecent(list, p.path)].slice(0, MAX_RECENTS);
}

export function pruneRecent(list: readonly CodeProject[], path: string): CodeProject[] {
    return list.filter((r) => !sameRepoPath(r.path, path));
}

// every selection is recorded, so a registered project would otherwise show up twice
export function pickerRecents(list: readonly CodeProject[], shown: readonly string[]): CodeProject[] {
    return list.filter((r) => !shown.some((path) => sameRepoPath(path, r.path)));
}
