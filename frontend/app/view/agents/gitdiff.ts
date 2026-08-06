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

export interface Hunk {
    id: string;
    header: string; // the "@@ ... @@" line
    adds: number;
    dels: number;
    body: string; // raw "@@" block incl. trailing newline — appended to diffHeader to form a patch
}

export interface FileView {
    isDiff: boolean;
    lines: DiffLine[];
    adds: number;
    dels: number;
    hunkLabel: string;
    diffHeader: string; // raw diff/index/---/+++ lines before the first hunk (patch prefix)
    hunks: Hunk[];
    // git said the file changed but emitted no text for it. Its one sentence is not a diff line, so
    // rendering it as context put a line number beside a sentence.
    binary: boolean;
    // set for a rename, so a file whose content did not change can say why it has nothing to show
    renamedFrom?: string;
}

const HEADER_PREFIXES = ["diff ", "index ", "--- ", "+++ ", "new file", "deleted file", "similarity ", "rename ", "old mode", "new mode"];
const RENAME_FROM = "rename from ";
const BINARY_LINE = "Binary files ";
const BINARY_PATCH = "GIT binary patch";

export function parseUnifiedDiff(diff: string): FileView {
    const lines: DiffLine[] = [];
    let oldN = 0;
    let newN = 0;
    let adds = 0;
    let dels = 0;
    let hunkLabel = "";
    let binary = false;
    let renamedFrom: string | undefined;
    // raw patch reconstruction (parallel to the render model, off the untouched raw text)
    const headerLines: string[] = [];
    const hunks: Hunk[] = [];
    let cur: Hunk | null = null;
    let sawHunk = false;

    // git's output ends with a newline and split keeps the empty element after it; rendering that
    // element as a context line puts a blank row, numbered as if it were real, under every diff.
    // plainFileView drops the same artifact for untracked files.
    const rawLines = diff.split("\n");
    if (rawLines.length && rawLines[rawLines.length - 1] === "") {
        rawLines.pop();
    }

    for (const raw of rawLines) {
        // --- raw patch bookkeeping (keeps prefixes/headers, unlike the render model below) ---
        if (raw.startsWith("@@")) {
            cur = { id: `h${hunks.length}`, header: raw, adds: 0, dels: 0, body: raw + "\n" };
            hunks.push(cur);
            sawHunk = true;
        } else if (!sawHunk) {
            if (raw !== "") headerLines.push(raw);
        } else if (cur) {
            cur.body += raw + "\n";
            if (raw.startsWith("+")) cur.adds++;
            else if (raw.startsWith("-")) cur.dels++;
        }

        // --- render model (unchanged from before) ---
        if (raw.startsWith(BINARY_LINE) || raw === BINARY_PATCH) {
            binary = true;
            continue; // git's sentence is not a line of the file; the pane says so in its own words
        }
        if (HEADER_PREFIXES.some((p) => raw.startsWith(p))) {
            if (raw.startsWith(RENAME_FROM)) {
                renamedFrom = raw.slice(RENAME_FROM.length);
            }
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
    const diffHeader = headerLines.length ? headerLines.join("\n") + "\n" : "";
    return { isDiff: true, lines, adds, dels, hunkLabel, diffHeader, hunks, binary, renamedFrom };
}

// A new (untracked) file has no HEAD blob, so `git diff` emits nothing and the backend hands us the
// raw content. Render it as an all-additions diff — every line a green "+" — so a new file reads as
// the diff it morally is (matching git/GitHub), not as flat, undecorated text.
export function plainFileView(content: string): FileView {
    // split never drops anything, so a trailing newline leaves a phantom empty final element — drop it
    // so we neither render nor count a blank added line.
    const raw = content === "" ? [] : content.split("\n");
    if (raw.length && raw[raw.length - 1] === "") {
        raw.pop();
    }
    const lines: DiffLine[] = raw.map((text, i) => ({
        gOld: "",
        gNew: String(i + 1),
        sign: "+",
        text,
        kind: "add" as const,
    }));
    return {
        isDiff: true,
        lines,
        adds: lines.length,
        dels: 0,
        hunkLabel: "New file",
        diffHeader: "",
        hunks: [],
        binary: false,
    };
}

// Where a jump into the Code surface should land: the first added line's new-side number. A
// deletion-only hunk has no added line, so its first numbered line — the context line the hunk
// starts on — is the closest honest answer.
export function firstChangedLine(view: FileView): number | undefined {
    const line = view.lines.find((l) => l.kind === "add") ?? view.lines.find((l) => l.gNew !== "");
    if (line == null) {
        return undefined;
    }
    const n = parseInt(line.gNew, 10);
    return Number.isFinite(n) ? n : undefined;
}
