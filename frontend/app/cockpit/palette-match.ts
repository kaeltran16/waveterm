// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Hand-rolled fuzzy matcher for the command palette. Case-insensitive subsequence
// scoring that rewards contiguous runs and word-boundary starts and penalizes gaps.

const CONTIGUOUS_BONUS = 5;
const WORD_BOUNDARY_BONUS = 3;
const MATCH_POINT = 1;
const MAX_GAP_PENALTY = 3;

function isWordChar(ch: string): boolean {
    return /[a-z0-9]/.test(ch);
}

/**
 * Case-insensitive subsequence match. Returns a score (higher = better), or null
 * when the query chars do not all appear in order within `text`. Empty query -> 0.
 */
export function fuzzyScore(query: string, text: string): number | null {
    const q = query.trim().toLowerCase();
    if (q === "") {
        return 0;
    }
    const t = text.toLowerCase();
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
        prevMatch = found;
        ti = found + 1;
    }
    return score;
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
