// frontend/app/view/agents/gitstatus.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: join `git status --porcelain=v1 -z` with `git diff --numstat HEAD` into the Files render
// model. No React, no Wave imports. Fixture-tested.

export interface GitChange {
    path: string;
    status: string; // "M" | "A" | "D" | "?" | "R" | "C" ...
    adds: number;
    dels: number;
}

export interface GitChanges {
    files: GitChange[];
    adds: number; // totals
    dels: number;
}

// porcelain -z: NUL-separated entries "XY path"; rename/copy entries carry an extra NUL old-path.
function parseStatusZ(statusZ: string): { path: string; status: string }[] {
    const out: { path: string; status: string }[] = [];
    const parts = statusZ.split("\0");
    for (let i = 0; i < parts.length; i++) {
        const entry = parts[i];
        if (!entry) {
            continue;
        }
        const xy = entry.slice(0, 2);
        const path = entry.slice(3);
        const status = xy.includes("?") ? "?" : (xy.trim()[0] ?? "?");
        if (xy[0] === "R" || xy[0] === "C") {
            i++; // the next field is the rename/copy source path — consume + ignore it
        }
        out.push({ path, status });
    }
    return out;
}

function parseNumstat(numstat: string): Map<string, { adds: number; dels: number }> {
    const m = new Map<string, { adds: number; dels: number }>();
    for (const line of numstat.split("\n")) {
        if (!line.trim()) {
            continue;
        }
        const cols = line.split("\t");
        const a = cols[0];
        const d = cols[1];
        const path = cols.slice(2).join("\t");
        if (!path) {
            continue;
        }
        m.set(path, {
            adds: a === "-" ? 0 : parseInt(a, 10) || 0,
            dels: d === "-" ? 0 : parseInt(d, 10) || 0,
        });
    }
    return m;
}

export function parseGitChanges(statusZ: string, numstat: string): GitChanges {
    const stat = parseNumstat(numstat);
    const files: GitChange[] = [];
    let adds = 0;
    let dels = 0;
    for (const { path, status } of parseStatusZ(statusZ)) {
        const n = stat.get(path) ?? { adds: 0, dels: 0 };
        files.push({ path, status, adds: n.adds, dels: n.dels });
        adds += n.adds;
        dels += n.dels;
    }
    return { files, adds, dels };
}

// Tailwind text-color per git status — shared by the Files surface and the Agent details rail.
export const STATUS_COLOR: Record<string, string> = {
    A: "text-success",
    M: "text-accent",
    R: "text-accent",
    C: "text-accent",
    D: "text-error",
    "?": "text-ink-mid",
};

export const statusColor = (s: string): string => STATUS_COLOR[s] ?? "text-ink-mid";

// Pure: cap a changed-file list for a narrow surface (the 296px rail). Returns the first `cap`
// files and the count hidden behind a "+N more" affordance.
export function capFiles(files: GitChange[], cap: number): { shown: GitChange[]; more: number } {
    if (files.length <= cap) {
        return { shown: files, more: 0 };
    }
    return { shown: files.slice(0, cap), more: files.length - cap };
}
