// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { normProjectPath } from "./channelderive";

// the header's change count, its adds and dels drawn beside it; null (no repo, not read yet) says nothing
export function changesLabel(stats: { files: number } | null): string {
    if (stats == null) {
        return "";
    }
    return stats.files === 0 ? "no uncommitted changes" : `${stats.files} ${stats.files === 1 ? "file" : "files"}`;
}

// one folder spelled two ways (registry, usage scan, sessions archive): slashes, trailing slash and case differ on
// a case-blind file system; an empty side is no folder, so it never matches
export function samePath(a: string, b: string): boolean {
    if (!a || !b) {
        return false;
    }
    return normProjectPath(a).toLowerCase() === normProjectPath(b).toLowerCase();
}
