// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: extract the agent session's start time from raw transcript JSONL lines. Both Claude records
// and Codex records ({timestamp, type, payload}) carry a top-level ISO "timestamp"; the head of the
// transcript is the session start. Returns unix seconds, or null. No React, no Wave imports.
export function sessionStartTs(lines: string[]): number | null {
    for (const line of lines) {
        const t = line.trim();
        if (!t) {
            continue;
        }
        let obj: any;
        try {
            obj = JSON.parse(t);
        } catch {
            continue;
        }
        if (typeof obj?.timestamp === "string") {
            const ms = Date.parse(obj.timestamp);
            if (!Number.isNaN(ms)) {
                return Math.floor(ms / 1000);
            }
        }
    }
    return null;
}
