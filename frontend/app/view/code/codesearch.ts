// frontend/app/view/code/codesearch.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: shape a flat list of grep matches into what the results pane draws. git's order is kept
// rather than sorted — it walks the index, so its order is already the repository's own.

export interface SearchGroup {
    path: string;
    matches: GitGrepMatch[];
}

export function groupMatches(matches: readonly GitGrepMatch[]): SearchGroup[] {
    const out: SearchGroup[] = [];
    const byPath = new Map<string, SearchGroup>();
    for (const match of matches) {
        let group = byPath.get(match.path);
        if (group == null) {
            group = { path: match.path, matches: [] };
            byPath.set(match.path, group);
            out.push(group); // first appearance fixes the file's position
        }
        group.matches.push(match);
    }
    return out;
}

export function summarize(groups: readonly SearchGroup[], truncated: boolean): string {
    if (groups.length === 0) {
        return "No matches";
    }
    const files = groups.length;
    const total = groups.reduce((n, g) => n + g.matches.length, 0);
    const head = `${total} ${total === 1 ? "match" : "matches"} in ${files} ${files === 1 ? "file" : "files"}`;
    return truncated ? `${head} (truncated)` : head;
}
