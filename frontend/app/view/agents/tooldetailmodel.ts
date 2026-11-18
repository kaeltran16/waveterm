// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure parts of the tool panels (tooldetailbody.tsx): the read gutter, grep grouping and match marks, and which files
// draw as highlighted code.

import type { ActionDetail, EditFile, GrepMatch } from "./agentsviewmodel";

export interface GutterLine {
    no?: number;
    text: string;
}

// cat -n's "<spaces>N<tab>" or Claude's "N→"
const LINE_NO_PREFIX = /^\s*(\d+)(?:\t|→)(.*)$/;

// a snippet whose every line carries a line-number prefix, split into numbers and text; null when any line lacks one,
// so the snippet draws as it came
export function parseLineGutter(snippet: string): GutterLine[] | null {
    const lines = snippet.replace(/\n$/, "").split("\n");
    const out: GutterLine[] = [];
    for (const ln of lines) {
        const m = LINE_NO_PREFIX.exec(ln);
        if (m == null) {
            return null;
        }
        out.push({ no: Number(m[1]), text: m[2] });
    }
    return out;
}

// the one file a read or a write/edit body shows, which the Rendered view opens beside the transcript rather than in the
// full-view modal; null for output with no file, or an edit of several
export function fullViewFile(detail: ActionDetail | undefined): { path: string; line: number | null } | null {
    if (detail?.kind === "read") {
        return detail.path ? { path: detail.path, line: parseLineGutter(detail.snippet)?.[0]?.no ?? null } : null;
    }
    if (detail?.kind === "edit" && detail.files.length === 1) {
        return { path: detail.files[0].path, line: null };
    }
    return null;
}

// a new file's lines as a file preview: a git diff's own numbers when it has them, else counted from 1
export function newFileLines(file: EditFile): GutterLine[] {
    return file.lines.filter((l) => !l.hunk).map((l, i) => ({ no: l.newNo ?? i + 1, text: l.text }));
}

export interface GrepLine {
    line?: number;
    code: string;
    // [start, end) of each match in code
    ranges: [number, number][];
}

export interface GrepGroup {
    // "" for lines that carry no location (a files-only result)
    file: string;
    lines: GrepLine[];
}

const LOC_LINE = /^(.*):(\d+)$/;

function matchRanges(code: string, re: RegExp | null): [number, number][] {
    if (re == null) {
        return [];
    }
    const ranges: [number, number][] = [];
    for (const m of code.matchAll(re)) {
        if (m[0] !== "") {
            ranges.push([m.index, m.index + m[0].length]);
        }
    }
    return ranges;
}

// ripgrep's pattern as a JS regex; null when JS cannot read it, so nothing is marked rather than the wrong thing
function patternRegex(pattern: string | undefined, ignoreCase: boolean | undefined): RegExp | null {
    if (!pattern) {
        return null;
    }
    try {
        return new RegExp(pattern, ignoreCase ? "gi" : "g");
    } catch {
        return null;
    }
}

// matches grouped under their file, files in order of first appearance, each line with its match ranges
export function groupGrepMatches(matches: GrepMatch[], pattern?: string, ignoreCase?: boolean): GrepGroup[] {
    const re = patternRegex(pattern, ignoreCase);
    const groups = new Map<string, GrepGroup>();
    for (const { loc, code } of matches) {
        const m = LOC_LINE.exec(loc);
        const file = m ? m[1] : loc;
        let group = groups.get(file);
        if (group == null) {
            group = { file, lines: [] };
            groups.set(file, group);
        }
        group.lines.push({ line: m ? Number(m[2]) : undefined, code, ranges: matchRanges(code, re) });
    }
    return [...groups.values()];
}

const PATH_SEP = /[\\/]/g;

function separatorIndexes(path: string): number[] {
    return [...path.matchAll(PATH_SEP)].map((m) => m.index);
}

// how many leading segments a path can drop and still keep its file name
export function pathSegmentsDroppable(path: string): number {
    return separatorIndexes(path).length;
}

// a path with its first `drop` segments cut whole, so a narrow header starts at a segment rather than mid-word
export function pathTail(path: string, drop: number): string {
    const seps = separatorIndexes(path);
    if (drop <= 0 || seps.length === 0) {
        return path;
    }
    return "…" + path.slice(seps[Math.min(drop, seps.length) - 1]);
}

// extensions the feed's tokenizer reads as code; anything else (.output, .log, .txt, none) draws as plain text
const CODE_EXTENSIONS = new Set(
    "ts tsx js jsx mjs cjs go rs py java kt c h cc cpp hpp cs rb php swift lua sh bash ps1 sql css scss html xml json yaml yml toml zig".split(
        " "
    )
);

export function isCodePath(path: string): boolean {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    return dot > 0 && CODE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
