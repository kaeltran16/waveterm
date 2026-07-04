// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Files-surface motion helper: derives the stable guard-key for the no-cascade entrance guard
// (motiontokens.computeEntrances). The key changes iff the viewed worktree source changes, so
// switching source reseeds the file list silently while live git updates within a source animate.
import type { FilesSource } from "./filessurface";

export function sourceKey(source: FilesSource | null): string | undefined {
    if (!source) {
        return undefined;
    }
    return source.kind === "agent" ? `agent:${source.id}` : `project:${source.name}`;
}
