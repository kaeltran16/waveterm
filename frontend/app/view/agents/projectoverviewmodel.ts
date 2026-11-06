// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// the header's change count, its adds and dels drawn beside it; null (no repo, not read yet) says nothing
export function changesLabel(stats: { files: number } | null): string {
    if (stats == null) {
        return "";
    }
    return stats.files === 0 ? "no uncommitted changes" : `${stats.files} ${stats.files === 1 ? "file" : "files"}`;
}

// the switcher offers the Overview only with one project scoped: "all" has no single project to show
export function overviewTarget(filter: string): string | null {
    return filter === "all" || filter === "" ? null : filter;
}
