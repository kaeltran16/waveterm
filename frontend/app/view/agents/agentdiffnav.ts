// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SurfaceKey } from "./agents";

export interface DiffNavIntent {
    focusId: string;
    surface: SurfaceKey;
    select: { cwd: string; path: string } | null;
}

export function diffNavIntent(agentId: string, cwd: string | null | undefined, path?: string): DiffNavIntent {
    return {
        focusId: agentId,
        surface: "files",
        select: cwd && path ? { cwd, path } : null,
    };
}
