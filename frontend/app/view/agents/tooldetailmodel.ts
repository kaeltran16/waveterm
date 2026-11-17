// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure parts of the tool panels (tooldetailbody.tsx): the read gutter, grep grouping and match marks, and which files
// draw as highlighted code.

import type { EditFile, GrepMatch } from "./agentsviewmodel";

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
