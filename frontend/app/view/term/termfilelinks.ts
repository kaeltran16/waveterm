// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// syntactic file-path detection for one terminal row; nothing is stat'ed, so a false
// positive is left to the peek card's missing state.

export interface FileLinkMatch {
    start: number;
    end: number;
    path: string;
    line: number | null;
    col: number | null;
}

// a run of characters that are neither whitespace nor wrapping punctuation (quotes,
// backticks, brackets) nor characters a windows file name can't hold.
const TokenRe = /[^\s()[\]{}<>"'`|]+/g;
const UrlRe = /[a-z][a-z0-9+.-]*:\/\/\S*/gi;
const TrailingPunctRe = /[.,:;]+$/;
// tools like claude code shorten a long path in the middle with it, so no such file exists
const Elision = "…";
const LineColSuffixRe = /:(\d+)(?::(\d+))?$/;
const SeparatorRe = /[/\\]/;
// an extension starts with a letter, so "and/or" and "1.2.3" stay plain text.
const LastSegmentExtRe = /\.[a-z][a-z0-9]*$/i;
const BareNameRe = /^[\w.-]*\w\.[a-z][a-z0-9]+$/i;
// a path rooted at a drive, /, ~/, ./ or ../ is a path even with no extension.
const AnchoredRe = /^(?:[a-z]:[/\\]|~[/\\]|\.{1,2}[/\\]|\/)/i;
// two segments, so a lone slash command like "/compact" stays plain text.
const MinAnchoredSegments = 2;
// a shell prompt's cwd at a row's start: PowerShell "PS <path>>", POSIX "<user>@<host>:<path>$" or "#"
const PowerShellPromptRe = /^PS [^>]+>/;
const PosixPromptRe = /^[\w.-]+@[\w.-]+:[^\s$#]+[$#]/;
const HttpMethodRe = /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE)$/;
const HttpStatusRe = /^[1-5]\d\d$/;
const ExtensionlessNames = new Set([
    "Makefile",
    "Dockerfile",
    "Containerfile",
    "Jenkinsfile",
    "Gemfile",
    "Rakefile",
    "Procfile",
    "Vagrantfile",
    "LICENSE",
    "CODEOWNERS",
]);

function isFilePath(path: string): boolean {
    const segments = path.split(SeparatorRe);
    const last = segments[segments.length - 1];
    if (ExtensionlessNames.has(last)) {
        return true;
    }
    if (segments.length === 1) {
        return BareNameRe.test(path);
    }
    if (AnchoredRe.test(path) && segments.filter(Boolean).length >= MinAnchoredSegments) {
        return true;
    }
    return LastSegmentExtRe.test(last);
}

// a route in a server log reads as a rooted extensionless path, so one beside a method or status is not a file
function isHttpRoute(path: string, prev: string | undefined, next: string | undefined): boolean {
    const last = path.split(SeparatorRe).pop() ?? "";
    if (!AnchoredRe.test(path) || LastSegmentExtRe.test(last) || ExtensionlessNames.has(last)) {
        return false;
    }
    return (prev != null && HttpMethodRe.test(prev)) || (next != null && HttpStatusRe.test(next));
}

function urlSpans(text: string): Array<[number, number]> {
    return Array.from(text.matchAll(UrlRe), (m) => [m.index, m.index + m[0].length] as [number, number]);
}

function promptSpans(text: string): Array<[number, number]> {
    const m = PowerShellPromptRe.exec(text) ?? PosixPromptRe.exec(text);
    return m ? [[m.index, m.index + m[0].length]] : [];
}

export function findFileLinks(text: string): FileLinkMatch[] {
    const skipped = [...urlSpans(text), ...promptSpans(text)];
    const tokens = Array.from(text.matchAll(TokenRe), (m) => ({ start: m.index, raw: m[0] }));
    const matches: FileLinkMatch[] = [];
    tokens.forEach(({ start, raw }, i) => {
        if (skipped.some(([ss, se]) => start < se && start + raw.length > ss)) {
            return;
        }
        const token = raw.replace(TrailingPunctRe, "");
        if (token.includes(Elision)) {
            return;
        }
        const suffix = LineColSuffixRe.exec(token);
        const path = suffix ? token.slice(0, suffix.index) : token;
        if (!isFilePath(path) || isHttpRoute(path, tokens[i - 1]?.raw, tokens[i + 1]?.raw)) {
            return;
        }
        matches.push({
            start,
            end: start + token.length,
            path,
            line: suffix ? Number(suffix[1]) : null,
            col: suffix?.[2] ? Number(suffix[2]) : null,
        });
    });
    return matches;
}

export type LinkRange = { start: { x: number; y: number }; end: { x: number; y: number } };

// one buffer row of a logical line: its text and, per UTF-16 unit of it, the cell that unit starts in
export type WrappedRow = { text: string; cells: number[] };

// Matches the logical line a soft wrap split over rows, and maps each match back to a range that can span rows, as
// xterm's web-links addon does. Only matches that touch row `target` (an index into rows) are returned; firstLine is
// the 0-based buffer row of rows[0]. Ranges are xterm's: 1-based and end-inclusive, where match offsets are 0-based and
// end-exclusive.
export function findWrappedFileLinks(
    rows: WrappedRow[],
    target: number,
    firstLine = 0
): { match: FileLinkMatch; range: LinkRange }[] {
    const offsets: number[] = [];
    let total = 0;
    for (const row of rows) {
        offsets.push(total);
        total += row.text.length;
    }
    // the row holding offset i of the joined text
    const rowOf = (i: number) => {
        let r = rows.length - 1;
        while (r > 0 && offsets[r] > i) {
            r--;
        }
        return r;
    };
    const out: { match: FileLinkMatch; range: LinkRange }[] = [];
    for (const match of findFileLinks(rows.map((r) => r.text).join(""))) {
        const startRow = rowOf(match.start);
        const endRow = rowOf(match.end - 1);
        if (target < startRow || target > endRow) {
            continue;
        }
        const { cells } = rows[endRow];
        const last = match.end - 1 - offsets[endRow];
        // the cell after the last unit, which is the last unit's 1-based inclusive end
        const endX = last + 1 < cells.length ? cells[last + 1] : cells[last] + 1;
        out.push({
            match,
            range: {
                start: { x: rows[startRow].cells[match.start - offsets[startRow]] + 1, y: firstLine + startRow + 1 },
                end: { x: endX, y: firstLine + endRow + 1 },
            },
        });
    }
    return out;
}

// mirrors the web-link rule: cmd on mac, ctrl elsewhere.
export function isPeekModifier(e: { ctrlKey: boolean; metaKey: boolean }, mac: boolean): boolean {
    return mac ? e.metaKey : e.ctrlKey;
}
