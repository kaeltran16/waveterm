// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The palette's actions: a thing's action list (→ on a row), how one action's row reads, the rule for when a
// verb row ("Cancel run · <run>") counts as matching what was typed, and the rows built from them.

import { ArrowUpRight, CircleX, SlidersHorizontal, Square, type LucideIcon } from "lucide-react";
import {
    ACTION_GROUPS,
    actionsFor,
    type ActionGroup,
    type ThingAction,
    type ThingEntry,
    type ThingKindDef,
    type VerbRow,
} from "./actions/types";
import { errorText, runPaletteAction } from "./palette-action";
import { meetsNameFloor, type PaletteGroup } from "./palette-groups";
import type { PaletteDeps } from "./palette-items";
import { rankPaletteItems } from "./palette-match";
import type { PaletteItem, StatusTone } from "./palette-rows";
import type { NavState } from "./palette-scope";

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

// the input level's chip and placeholder add their own "…"
export const bareLabel = (a: ThingAction<any>) => a.label.replace(/…$/, "");

export interface ActionRowView {
    title: string;
    verb: string; // what Enter does, shown on the selected row
    status?: { label: string; tone: StatusTone };
    echo: string; // the footer line
}

// How an action's row reads for one thing. An action that does not say otherwise is named by its label,
// Enter's verb is "Write" or "Pick" when it takes a value, else the label's own first word.
export function resolveActionRow<T>(action: ThingAction<T>, entry: ThingEntry<T>): ActionRowView {
    const { thing } = entry;
    const bare = bareLabel(action);
    let verb = action.label.split(" ", 1)[0];
    let echo = `${bare}: “${entry.title}”`;
    if (action.input?.kind === "pick") {
        verb = "Pick";
        echo = `Lists the choices, for “${entry.title}”`;
    } else if (action.input?.kind === "text") {
        verb = "Write";
        echo = `Takes the text here, for “${entry.title}”`;
    }
    return {
        title: action.title?.(thing) ?? (action.input?.kind === "text" ? `${bare}…` : action.label),
        verb: action.verb?.(thing) ?? verb,
        status: action.status?.(thing),
        echo: action.echo?.(thing) ?? echo,
    };
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

// a thing the palette can act on: its kind's definition and its current entry
export interface ActionTarget {
    def: ThingKindDef<any>;
    entry: ThingEntry<any>;
}

// what Enter on an action row does: run it, or open its input level first; owned by the palette, which
// knows where the selection is
export type StartAction = (t: ActionTarget, action: ThingAction<any>) => void;

type ActionDeps = Pick<PaletteDeps, "model" | "close" | "setPaletteError">;

const ACTION_ICONS: Record<ActionGroup, LucideIcon> = { open: ArrowUpRight, steer: SlidersHorizontal, stop: Square };

function actionIcon(a: ThingAction<any>): LucideIcon {
    return a.destructive ? CircleX : ACTION_ICONS[a.group];
}

// a failure keeps the palette open on the error, as a launch does; success closes
export function runThingAction(
    t: ActionTarget,
    action: ThingAction<any>,
    { model, close, setPaletteError }: ActionDeps,
    value?: string
) {
    setPaletteError(undefined);
    void runPaletteAction(async () => action.run(t.entry.thing, { model }, value)).then((result) => {
        if ("error" in result) {
            setPaletteError(`${bareLabel(action)} failed: ${errorText(result.error)}`);
            return;
        }
        close();
    });
}

export function actionItem(
    t: ActionTarget,
    action: ThingAction<any>,
    start: StartAction,
    over: Partial<PaletteItem> = {}
): PaletteItem {
    return {
        key: `act:${action.id}`,
        kind: "action",
        search: action.label,
        icon: actionIcon(action),
        danger: action.destructive,
        ...resolveActionRow(action, t.entry),
        run: () => start(t, action),
        ...over,
    };
}

// "cancel" lists Cancel run once per cancellable run; a thing's name alone lists no verb rows. A verb row
// borrows its thing's meta (a run's project), so two runs with one goal stay apart.
export function verbItems(
    allVerbs: { def: ThingKindDef<any>; v: VerbRow<any> }[],
    query: string,
    thingMeta: Map<string, string | undefined>,
    start: StartAction
): { items: PaletteItem[]; byKey: Map<string, VerbRow<any>> } {
    const q = query.trim();
    const verbLabels = new Set(
        q === "" ? [] : [...new Set(allVerbs.map(({ v }) => v.action.label))].filter((l) => verbLeads(q, l))
    );
    const verbHits = allVerbs.filter(({ v }) => verbLabels.has(v.action.label));
    return {
        byKey: new Map<string, VerbRow<any>>(verbHits.map(({ v }) => [v.key, v])),
        items: verbHits.map(({ def, v }) =>
            actionItem({ def, entry: v.entry }, v.action, start, {
                key: v.key,
                search: v.search,
                title: `${v.action.title?.(v.entry.thing) ?? v.action.label} · ${v.entry.title}`,
                meta: thingMeta.get(v.entry.key),
            })
        ),
    };
}

// → on a thing's row: its action list, or the input level of the action picked there
export function actionDrillGroups(
    nav: NavState,
    targetByKey: Map<string, ActionTarget>,
    start: StartAction,
    deps: ActionDeps
): PaletteGroup<PaletteItem>[] {
    const q = nav.query.trim();
    const { thing, input } = nav.actions!;
    const t = targetByKey.get(thing.key);
    if (t == null) {
        return [{ key: "empty", label: thing.noun, items: [], emptyText: "It is no longer listed." }];
    }
    const action = input != null ? t.def.actions.find((a) => a.id === input.actionId) : undefined;
    if (action?.input?.kind === "pick") {
        const options = action.input.options(t.entry.thing).map((o) =>
            actionItem(t, action, start, {
                key: `opt:${o.value}`,
                search: o.label,
                title: o.label,
                icon: undefined,
                verb: "Pick",
                echo: `${bareLabel(action)}: ${o.label}`,
                run: () => runThingAction(t, action, deps, o.value),
            })
        );
        const hits = rankPaletteItems(options, nav.query);
        return [
            {
                key: "pick",
                label: bareLabel(action),
                items: hits,
                ...(hits.length === 0 ? { emptyText: q === "" ? "Nothing to pick." : `Nothing matches “${q}”.` } : {}),
            },
        ];
    }
    if (action?.input?.kind === "text") {
        const text = nav.query;
        const submit = actionItem(t, action, start, {
            key: "submit",
            search: "",
            title: q === "" ? action.input.placeholder : text,
            hl: "",
            verb: "Send",
            echo: q === "" ? "Type it here, then Enter sends it" : `${bareLabel(action)}: “${q}”`,
            // an empty field has nothing to send, so Enter stays put
            run: q === "" ? () => {} : () => runThingAction(t, action, deps, text),
        });
        return [{ key: "text", label: bareLabel(action), items: [submit] }];
    }
    const { groups: sections, notNow } = actionListGroups(t.def, t.entry, nav.query);
    const out: PaletteGroup<PaletteItem>[] = sections.map((g) => ({
        key: `act:${g.key}`,
        label: g.label,
        items: g.actions.map((a) => actionItem(t, a, start)),
    }));
    if (out.length === 0) {
        out.push({
            key: "empty",
            label: "Actions",
            items: [],
            emptyText: q === "" ? "Nothing applies right now." : `No actions match “${q}”.`,
        });
    }
    if (notNow != null) {
        out[out.length - 1] = { ...out[out.length - 1], note: notNow };
    }
    return out;
}
