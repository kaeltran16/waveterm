// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure pieces of the palette's actions: a thing's action list (→ on a row) and the rule for when a verb
// row ("Cancel run · <run>") counts as matching what was typed.

import {
    ACTION_GROUPS,
    actionsFor,
    type ActionGroup,
    type ThingAction,
    type ThingEntry,
    type ThingKindDef,
} from "./actions/types";
import { meetsNameFloor } from "./palette-groups";
import { rankPaletteItems } from "./palette-match";

const GROUP_LABELS: Record<ActionGroup, string> = { open: "Open", steer: "Steer", stop: "Stop" };

// A thing's actions as palette sections. What does not apply now is named, unfiltered, so a missing
// action reads as unavailable rather than nonexistent.
export function actionListGroups<T>(
    def: ThingKindDef<T>,
    entry: ThingEntry<T>,
    query: string
): { groups: { key: string; label: string; actions: ThingAction<T>[] }[]; notNow: string | null } {
    const list = actionsFor(def.actions, entry.thing);
    const groups = ACTION_GROUPS.map((g) => ({
        key: g,
        label: GROUP_LABELS[g],
        actions: rankPaletteItems(
            list.available[g].map((action) => ({ search: action.label, action })),
            query
        ).map((r) => r.action),
    })).filter((g) => g.actions.length > 0);
    const notNow = list.notNow.length > 0 ? `Not now: ${list.notNow.map((a) => a.label).join(", ")}` : null;
    return { groups, notNow };
}

// A verb row's search text is its label plus the thing's title, so the title alone would match it too,
// and typing a run's name would list every action on that run beside the run itself. A verb row counts
// only when the query's first word is the verb.
export function verbLeads(query: string, label: string): boolean {
    const first = query.trim().split(/\s+/, 1)[0];
    return first !== "" && meetsNameFloor(first, label);
}

// "Actions · Cancel run" when every row is the same action, as typing a verb usually leaves them
export function verbGroupLabel(rows: { action: { label: string } }[]): string {
    const labels = new Set(rows.map((r) => r.action.label));
    return labels.size === 1 ? `Actions · ${[...labels][0]}` : "Actions";
}
