// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Readable project label for display: the Projects-registry name if the cwd matches a registered
// path, else the leaf folder of the cwd. Never surfaces Claude's encoded hash dir name. Pure.

function leaf(cwd: string): string {
    const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
    return parts[parts.length - 1] ?? "";
}

function samePath(a: string, b: string): boolean {
    const norm = (p: string) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
    return norm(a) === norm(b);
}

export function projectLabel(cwd: string, projects: Record<string, { path?: string }>): string {
    if (!cwd) return "";
    for (const [name, pk] of Object.entries(projects ?? {})) {
        if (pk?.path && samePath(pk.path, cwd)) return name;
    }
    return leaf(cwd);
}
