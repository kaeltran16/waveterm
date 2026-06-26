// frontend/app/view/agents/gitdiff.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: turn `git diff HEAD -- <path>` output (or untracked file content) into the Files render
// model — old/new gutter line numbers + a sign column, faithful to the handoff diff list. No React.

export type DiffLineKind = "add" | "del" | "ctx" | "hunk";

export interface DiffLine {
    gOld: string; // old line number, or ""
    gNew: string; // new line number, or ""
    sign: string; // "+" | "−" | ""
    text: string;
    kind: DiffLineKind;
}

export interface FileView {
    isDiff: boolean;
    lines: DiffLine[];
    adds: number;
    dels: number;
    hunkLabel: string;
}

const HEADER_PREFIXES = ["diff ", "index ", "--- ", "+++ ", "new file", "deleted file", "similarity ", "rename ", "old mode", "new mode"];

export function parseUnifiedDiff(diff: string): FileView {
    const lines: DiffLine[] = [];
    let oldN = 0;
    let newN = 0;
    let adds = 0;
    let dels = 0;
    let hunkLabel = "";
    for (const raw of diff.split("\n")) {
        if (HEADER_PREFIXES.some((p) => raw.startsWith(p))) {
            continue;
        }
        if (raw.startsWith("@@")) {
            const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
            if (m) {
                oldN = parseInt(m[1], 10);
                newN = parseInt(m[2], 10);
                if (!hunkLabel) {
                    hunkLabel = raw;
                }
            }
            lines.push({ gOld: "", gNew: "", sign: "", text: raw, kind: "hunk" });
            continue;
        }
        if (raw.startsWith("\\")) {
            continue; // "\ No newline at end of file"
        }
        if (raw.startsWith("+")) {
            lines.push({ gOld: "", gNew: String(newN), sign: "+", text: raw.slice(1), kind: "add" });
            newN++;
            adds++;
            continue;
        }
        if (raw.startsWith("-")) {
            lines.push({ gOld: String(oldN), gNew: "", sign: "−", text: raw.slice(1), kind: "del" });
            oldN++;
            dels++;
            continue;
        }
        lines.push({ gOld: String(oldN), gNew: String(newN), sign: "", text: raw.startsWith(" ") ? raw.slice(1) : raw, kind: "ctx" });
        oldN++;
        newN++;
    }
    return { isDiff: true, lines, adds, dels, hunkLabel };
}

export function plainFileView(content: string): FileView {
    const lines: DiffLine[] = content.split("\n").map((text, i) => ({
        gOld: "",
        gNew: String(i + 1),
        sign: "",
        text,
        kind: "ctx" as const,
    }));
    return { isDiff: false, lines, adds: 0, dels: 0, hunkLabel: "" };
}
