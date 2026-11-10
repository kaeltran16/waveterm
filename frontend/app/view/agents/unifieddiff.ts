// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure parser for `git diff` / `git show` output into the edit view's EditFile shape. Hunk bodies are
// read by the counts in their @@ header, so an empty context line and a following commit header are
// told apart; text outside a file's hunks (commit headers, stats) is skipped.

import type { DiffLine, EditFile } from "./agentsviewmodel";
import { stripAnsi } from "./testoutput";

const FILE_HEADER = /^diff --git a\/(.*?) b\/(.*)$/;
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

function hunkCount(s: string | undefined): number {
    return s == null ? 1 : Number(s);
}

export function parseUnifiedDiff(output: string): EditFile[] | null {
    const lines = stripAnsi(output).split(/\r?\n/);
    const files: EditFile[] = [];
    let file: EditFile | null = null;
    // lines still owed by the open hunk, old side and new side
    let oldLeft = 0;
    let newLeft = 0;
    for (const raw of lines) {
        if (oldLeft > 0 || newLeft > 0) {
            const sign = raw[0];
            if (sign === "\\") {
                continue;
            }
            let line: DiffLine;
            if (sign === "+") {
                newLeft--;
                file.adds++;
                line = { sign: "+", text: raw.slice(1) };
            } else if (sign === "-") {
                oldLeft--;
                file.dels++;
                line = { sign: "-", text: raw.slice(1) };
            } else {
                // a context line, or an empty one whose leading space was trimmed
                oldLeft--;
                newLeft--;
                line = { sign: "", text: raw.slice(1) };
            }
            file.lines.push(line);
            continue;
        }
        const head = FILE_HEADER.exec(raw);
        if (head) {
            file = { path: head[2], badge: "M", adds: 0, dels: 0, lines: [] };
            files.push(file);
            continue;
        }
        if (file == null) {
            continue;
        }
        if (raw.startsWith("new file mode")) {
            file.badge = "A";
            continue;
        }
        if (raw.startsWith("rename to ")) {
            file.path = raw.slice("rename to ".length);
            continue;
        }
        const hunk = HUNK_HEADER.exec(raw);
        if (hunk) {
            oldLeft = hunkCount(hunk[1]);
            newLeft = hunkCount(hunk[2]);
            file.lines.push({ sign: "", text: raw, hunk: true });
        }
    }
    return files.length > 0 ? files : null;
}

// keeps the first `max` lines across the files (counts untouched) so a huge diff never renders unbounded
export function capDiffLines(files: EditFile[], max: number): { files: EditFile[]; hidden: number } {
    let left = max;
    let hidden = 0;
    const capped = files.map((f) => {
        const keep = Math.min(left, f.lines.length);
        left -= keep;
        hidden += f.lines.length - keep;
        return keep === f.lines.length ? f : { ...f, lines: f.lines.slice(0, keep) };
    });
    return { files: capped, hidden };
}
