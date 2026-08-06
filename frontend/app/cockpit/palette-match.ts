// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Hand-rolled fuzzy matcher for the command palette. Case-insensitive subsequence
// scoring that rewards contiguous runs and word-boundary starts and penalizes gaps.

const CONTIGUOUS_BONUS = 5;
const WORD_BOUNDARY_BONUS = 3;
const MATCH_POINT = 1;
const MAX_GAP_PENALTY = 3;

// The score a single matched character can normally earn: the match itself plus the contiguity bonus.
// palette-groups.ts uses this as the reference when deciding whether a query matched densely enough
// to be a name the user is typing rather than prose that happens to be a subsequence.
export const SCORE_PER_CHAR = MATCH_POINT + CONTIGUOUS_BONUS;

export interface FuzzyMatch {
    score: number;
    positions: number[]; // indices into `text` that matched, ascending
}

function isWordChar(ch: string): boolean {
    return /[a-z0-9]/.test(ch);
}

/**
 * Case-insensitive subsequence match. Returns the score (higher = better) and the matched indices,
 * or null when the query chars do not all appear in order within `text`. Empty query -> score 0.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
    const q = query.trim().toLowerCase();
    if (q === "") {
        return { score: 0, positions: [] };
    }
    const t = text.toLowerCase();
    const positions: number[] = [];
    let score = 0;
    let ti = 0;
    let prevMatch = -2; // sentinel: no previous match, and not adjacent to index 0
    for (const ch of q) {
        let found = -1;
        for (let j = ti; j < t.length; j++) {
            if (t[j] === ch) {
                found = j;
                break;
            }
        }
        if (found === -1) {
            return null;
        }
        score += MATCH_POINT;
        if (found === prevMatch + 1) {
            score += CONTIGUOUS_BONUS;
        }
        if (found === 0 || !isWordChar(t[found - 1])) {
            score += WORD_BOUNDARY_BONUS;
        }
        if (prevMatch >= 0) {
            const gap = found - (prevMatch + 1);
            if (gap > 0) {
                score -= Math.min(gap, MAX_GAP_PENALTY);
            }
        }
        positions.push(found);
        prevMatch = found;
        ti = found + 1;
    }
    return { score, positions };
}

/**
 * Case-insensitive subsequence match. Returns a score (higher = better), or null
 * when the query chars do not all appear in order within `text`. Empty query -> 0.
 */
export function fuzzyScore(query: string, text: string): number | null {
    return fuzzyMatch(query, text)?.score ?? null;
}

/**
 * Splits `text` into contiguous runs, each flagged as matched or not, so a row can bold what the
 * user typed without emitting one element per character.
 */
export function highlightRuns(text: string, positions: number[]): { text: string; hit: boolean }[] {
    const hits = new Set(positions);
    const runs: { text: string; hit: boolean }[] = [];
    for (let i = 0; i < text.length; i++) {
        const hit = hits.has(i);
        const last = runs[runs.length - 1];
        if (last != null && last.hit === hit) {
            last.text += text[i];
        } else {
            runs.push({ text: text[i], hit });
        }
    }
    return runs;
}

/**
 * Ranks searchable items by fuzzyScore(query, item.search) descending, dropping
 * non-matches. Empty/whitespace query -> passthrough in natural (input) order.
 * Array.prototype.sort is stable, so ties keep their input order.
 */
export function rankPaletteItems<T extends { search: string }>(items: T[], query: string): T[] {
    if (query.trim() === "") {
        return items;
    }
    const scored: { item: T; score: number }[] = [];
    for (const item of items) {
        const score = fuzzyScore(query, item.search);
        if (score != null) {
            scored.push({ item, score });
        }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.item);
}
