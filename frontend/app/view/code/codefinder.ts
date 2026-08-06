// frontend/app/view/code/codefinder.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: rank repo-relative paths against a query for the Code surface's file finder. Reuses the
// command palette's matcher rather than growing a second fuzzy implementation.

import { fuzzyScore } from "@/app/cockpit/palette-match";

export interface FinderMatch {
    path: string;
    score: number;
}

// a basename hit is almost always what you meant. fuzzyScore reports no matched span, so this
// cannot be a bonus applied to part of the full-path score — basename is scored separately and
// the better of the two wins.
const BASENAME_BONUS = 20;

export function rankPaths(query: string, paths: readonly string[], limit: number): FinderMatch[] {
    const q = query.trim();
    if (q === "") {
        return paths.slice(0, limit).map((path) => ({ path, score: 0 }));
    }
    const out: FinderMatch[] = [];
    for (const path of paths) {
        const slash = path.lastIndexOf("/");
        const base = slash === -1 ? path : path.slice(slash + 1);
        const baseScore = fuzzyScore(q, base);
        const pathScore = fuzzyScore(q, path);
        let score: number | null = null;
        if (baseScore != null) {
            score = baseScore + BASENAME_BONUS;
        }
        if (pathScore != null && (score == null || pathScore > score)) {
            score = pathScore;
        }
        if (score != null) {
            out.push({ path, score });
        }
    }
    out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return out.slice(0, limit);
}

export interface FinderQuery {
    text: string;
    line?: number;
}

// A trailing ":<digits>" is a line. Reusing the finder for this is why there is no second overlay
// and no Ctrl+G dialog. A trailing colon with nothing after it is someone mid-keystroke, so it
// stays part of the text.
const LINE_SUFFIX = /:(\d+)$/;

export function parseFinderQuery(raw: string): FinderQuery {
    const q = raw.trim();
    const m = LINE_SUFFIX.exec(q);
    if (m == null) {
        return { text: q };
    }
    return { text: q.slice(0, m.index), line: parseInt(m[1], 10) };
}
