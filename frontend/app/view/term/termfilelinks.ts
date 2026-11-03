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
const LineColSuffixRe = /:(\d+)(?::(\d+))?$/;
const SeparatorRe = /[/\\]/;
// an extension starts with a letter, so "and/or" and "1.2.3" stay plain text.
const LastSegmentExtRe = /\.[a-z][a-z0-9]*$/i;
const BareNameRe = /^[\w.-]*\w\.[a-z][a-z0-9]+$/i;

function isFilePath(path: string): boolean {
    if (SeparatorRe.test(path)) {
        return LastSegmentExtRe.test(path.split(SeparatorRe).pop());
    }
    return BareNameRe.test(path);
}

function urlSpans(text: string): Array<[number, number]> {
    return Array.from(text.matchAll(UrlRe), (m) => [m.index, m.index + m[0].length] as [number, number]);
}

export function findFileLinks(text: string): FileLinkMatch[] {
    const urls = urlSpans(text);
    const matches: FileLinkMatch[] = [];
    for (const m of text.matchAll(TokenRe)) {
        const start = m.index;
        if (urls.some(([us, ue]) => start < ue && start + m[0].length > us)) {
            continue;
        }
        const token = m[0].replace(TrailingPunctRe, "");
        const suffix = LineColSuffixRe.exec(token);
        const path = suffix ? token.slice(0, suffix.index) : token;
        if (!isFilePath(path)) {
            continue;
        }
        matches.push({
            start,
            end: start + token.length,
            path,
            line: suffix ? Number(suffix[1]) : null,
            col: suffix?.[2] ? Number(suffix[2]) : null,
        });
    }
    return matches;
}

// xterm buffer ranges are 1-based and end-inclusive; match offsets are 0-based and end-exclusive.
export function fileLinkRange(
    match: FileLinkMatch,
    bufferLine: number
): { start: { x: number; y: number }; end: { x: number; y: number } } {
    const y = bufferLine + 1;
    return { start: { x: match.start + 1, y }, end: { x: match.end, y } };
}

// mirrors the web-link rule: cmd on mac, ctrl elsewhere.
export function isPeekModifier(e: { ctrlKey: boolean; metaKey: boolean }, mac: boolean): boolean {
    return mac ? e.metaKey : e.ctrlKey;
}
