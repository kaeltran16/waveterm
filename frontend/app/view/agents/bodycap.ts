// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The one cap on an inline tool body (bash output, read, grep, diff, ask options, recorded output, wsh fallback): a
// count of whole lines, so a body never ends on a half-clipped line, and the rest is reported as "N more lines". The
// modal draws the body uncapped.

import type { EditFile } from "./agentsviewmodel";
import type { GrepGroup } from "./tooldetailmodel";

export const BODY_LINES_MAX = 20;

export function moreLinesLabel(hidden: number): string {
    return `${hidden} more ${hidden === 1 ? "line" : "lines"}`;
}

export function capLines<T>(lines: T[], max = BODY_LINES_MAX): { lines: T[]; hidden: number } {
    return lines.length <= max ? { lines, hidden: 0 } : { lines: lines.slice(0, max), hidden: lines.length - max };
}

export function capText(text: string, max = BODY_LINES_MAX): { text: string; hidden: number } {
    const all = text.replace(/\n+$/, "").split("\n");
    const { lines, hidden } = capLines(all, max);
    return hidden === 0 ? { text, hidden } : { text: lines.join("\n"), hidden };
}

// items of several lines each (a test failure and its message): whole items while their lines fit, the first always
export function capWeighted<T>(
    items: T[],
    linesOf: (item: T) => number,
    max = BODY_LINES_MAX
): { items: T[]; hidden: number } {
    let used = 0;
    let keep = 0;
    while (keep < items.length && (keep === 0 || used + linesOf(items[keep]) <= max)) {
        used += linesOf(items[keep]);
        keep++;
    }
    return { items: items.slice(0, keep), hidden: items.length - keep };
}

// groups each under a header line (a grep file, a diff file): the header costs a line, and a group none of whose lines
// would fit is dropped whole rather than left as a bare header. hidden counts the content lines cut.
export function capGroups<G, L>(
    groups: G[],
    linesOf: (g: G) => L[],
    withLines: (g: G, lines: L[]) => G,
    headed: (g: G) => boolean,
    max: number
): { groups: G[]; hidden: number } {
    let left = max;
    let hidden = 0;
    const kept: G[] = [];
    for (const g of groups) {
        const lines = linesOf(g);
        if (left <= 0) {
            hidden += lines.length;
            continue;
        }
        const room = left - (headed(g) ? 1 : 0);
        const keep = Math.max(0, Math.min(room, lines.length));
        hidden += lines.length - keep;
        if (keep === 0 && lines.length > 0) {
            left = 0;
            continue;
        }
        left = room - keep;
        kept.push(keep === lines.length ? g : withLines(g, lines.slice(0, keep)));
    }
    return { groups: hidden === 0 ? groups : kept, hidden };
}

export function capGrepGroups(groups: GrepGroup[], max = BODY_LINES_MAX): { groups: GrepGroup[]; hidden: number } {
    return capGroups(
        groups,
        (g) => g.lines,
        (g, lines) => ({ ...g, lines }),
        (g) => g.file !== "",
        max
    );
}

// a diff's lines across its files; each file keeps its own +/- counts
export function capDiffFiles(files: EditFile[], max = BODY_LINES_MAX): { files: EditFile[]; hidden: number } {
    const { groups, hidden } = capGroups(
        files,
        (f) => f.lines,
        (f, lines) => ({ ...f, lines }),
        () => true,
        max
    );
    return { files: groups, hidden };
}
