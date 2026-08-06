// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure group assembly for the command palette's default scope, and the rule that decides what the
// typed text *is*. A query that names something the cockpit already has (a surface, an agent, a
// session, a focused task) leads with that and Enter navigates; a query that names nothing is a goal,
// so the launch block leads and Enter dispatches. Before this module the launch block always led,
// which meant typing "usage" and pressing Enter spawned a worker on the letters "usage".

import { SCORE_PER_CHAR, fuzzyScore } from "./palette-match";

export type GroupKind =
    | "recent"
    | "launch"
    | "ask-jarvis"
    | "act-on"
    | "focus-task"
    | "command"
    | "agent"
    | "session"
    | "channel";

export interface GroupableItem {
    key: string;
    kind: GroupKind;
    search: string; // matched text; "" for launch/ask rows, which are never ranked
}

export interface PaletteGroup<T> {
    kind: GroupKind;
    items: T[];
}

// Ranked kinds, in the order they are shown below any lead group.
export const GROUP_ORDER: GroupKind[] = ["focus-task", "command", "agent", "session"];

// Groups whose rows render as rich fast-dispatch cards rather than plain list rows. A type predicate,
// not a plain boolean: the renderer's other branch indexes a Record keyed on the *plain* kinds, and
// this repo compiles with strict off — without narrowing, that lookup degrades to `any` and a kind
// added later with no label would render a blank heading instead of failing the typecheck.
export type RichGroupKind = "launch" | "ask-jarvis" | "act-on";

const RICH_KINDS = new Set<GroupKind>(["launch", "ask-jarvis", "act-on"]);

export function isRichGroup(kind: GroupKind): kind is RichGroupKind {
    return RICH_KINDS.has(kind);
}

// How dense a match has to be before it counts as a name rather than prose. fuzzyScore is a permissive
// subsequence match with no floor, so a long goal will often match *something* inside a long session
// task; gating on "matched at all" would make fast-dispatch fire or not fire unpredictably. The
// reference is SCORE_PER_CHAR per character of the trimmed query — "usage" against "Go to Usage"
// scores 28 against a reference of 30, while a scattered prose match scores near zero or below. The
// reference is not a hard maximum (a query containing spaces can pick up extra word-boundary bonuses),
// which is harmless because this is a floor test.
export const MIN_MATCH_DENSITY = 0.5;

export function isConfidentMatch(query: string, ranked: GroupableItem[]): boolean {
    const q = query.trim();
    if (q === "" || ranked.length === 0) {
        return false;
    }
    // ranked is best-first, so the head carries the best score in the pool.
    const best = fuzzyScore(q, ranked[0].search);
    if (best == null) {
        return false;
    }
    return best >= q.length * SCORE_PER_CHAR * MIN_MATCH_DENSITY;
}

export interface DefaultGroupsInput<T extends GroupableItem> {
    query: string;
    ranked: T[]; // focus tasks + commands + agents + sessions, already ranked best-first
    launchItems: T[]; // [] when there is no goal or no active channel
    askItems: T[]; // [] when there is no goal
    recent: T[]; // most-recently-used rows, resolved against the current pool
}

export function assembleDefaultGroups<T extends GroupableItem>(input: DefaultGroupsInput<T>): PaletteGroup<T>[] {
    const { query, ranked, launchItems, askItems, recent } = input;
    const showRecent = query.trim() === "" && recent.length > 0;
    // A row shown under Recent is not repeated in its own group below.
    const recentKeys = new Set(showRecent ? recent.map((it) => it.key) : []);
    const rest = showRecent ? ranked.filter((it) => !recentKeys.has(it.key)) : ranked;

    const rankedGroups = GROUP_ORDER.map((kind) => ({
        kind,
        items: rest.filter((it) => it.kind === kind),
    })).filter((g) => g.items.length > 0);

    const groups: PaletteGroup<T>[] = [];
    if (showRecent) {
        groups.push({ kind: "recent", items: recent });
    }
    if (isConfidentMatch(query, ranked)) {
        groups.push(...rankedGroups);
        const actOn = [...launchItems, ...askItems];
        if (actOn.length > 0) {
            groups.push({ kind: "act-on", items: actOn });
        }
        return groups;
    }
    if (launchItems.length > 0) {
        groups.push({ kind: "launch", items: launchItems });
    }
    if (askItems.length > 0) {
        groups.push({ kind: "ask-jarvis", items: askItems });
    }
    groups.push(...rankedGroups);
    return groups;
}

// A silently truncated list reads as a complete one, so a capped group renders its own overflow count.
export const MAX_PER_GROUP = 20;

export interface CappedGroup<T> {
    kind: GroupKind;
    items: T[];
    overflow: number;
}

export function capGroups<T>(groups: PaletteGroup<T>[]): CappedGroup<T>[] {
    return groups.map((g) => ({
        kind: g.kind,
        items: g.items.slice(0, MAX_PER_GROUP),
        overflow: Math.max(0, g.items.length - MAX_PER_GROUP),
    }));
}
