// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Which groups the palette shows for where it stands: an action level, a drill, or one scope. Takes the rows
// palette-items already built and only picks, ranks and groups them.

import type { SurfaceKey } from "@/app/store/keybindings/types";
import type { VerbRow } from "./actions/types";
import { verbGroupLabel } from "./palette-actionrows";
import { commandGroups } from "./palette-commands";
import { mergeRanked } from "./palette-entities";
import type { FileScopeGroups } from "./palette-files";
import {
    assembleAllGroups,
    assembleScopeGroups,
    groupByKind,
    MAX_IN_ALL,
    MAX_IN_SCOPE,
    type GroupKind,
    type PaletteGroup,
} from "./palette-groups";
import { notesFor, type CommandRow, type LaunchTarget, type PaletteDeps } from "./palette-items";
import { rankPaletteItems } from "./palette-match";
import { MAX_RECENT, recentItems, sortByMru } from "./palette-mru";
import { NEEDS_GROUP_LABELS, type NeedsGroup, type NeedsRow } from "./palette-needs";
import type { PaletteItem } from "./palette-rows";
import { DRILL_LABELS, pickScope, scopeDef, type NavState, type ScopeId } from "./palette-scope";

// the kinds each narrowed scope lists, in the order its groups show
const SCOPE_KINDS: Partial<Record<ScopeId, GroupKind[]>> = {
    goto: ["surface"],
    agents: ["agent"],
    runs: ["run"],
    sessions: ["session"],
    records: ["record", "effort"],
    projects: ["channel"],
};

export interface ScopeRows {
    theme: PaletteItem[];
    goto: PaletteItem[];
    commands: CommandRow[];
    start: PaletteItem[];
    agents: PaletteItem[];
    runs: PaletteItem[];
    sessions: PaletteItem[];
    channels: PaletteItem[];
    brief: PaletteItem[];
    notes: PaletteItem[];
    notesInAll: PaletteItem[];
    launch: PaletteItem[];
    verbs: PaletteItem[];
    needs: { inScope: PaletteItem[]; inAll: PaletteItem[] };
}

export interface ScopeGroupsInput {
    nav: NavState;
    surface: SurfaceKey;
    mru: string[];
    rows: ScopeRows;
    needsGrouped: { group: NeedsGroup; rows: NeedsRow[] }[];
    verbByKey: Map<string, VerbRow<any>>;
    launch: LaunchTarget;
    // built only when the palette stands there: each reads more than the rows above
    actionGroups: () => PaletteGroup<PaletteItem>[];
    fileGroups: () => FileScopeGroups;
}

export interface ScopeGroups extends FileScopeGroups {
    cap: number;
}

export function widenRow(query: string, { setNav }: Pick<PaletteDeps, "setNav">): PaletteItem | null {
    const q = query.trim();
    return q === ""
        ? null
        : {
              key: "widen",
              kind: "widen",
              search: "",
              title: `Search everything for “${q}”`,
              verb: "Search",
              echo: `Widens to All, keeping “${q}”`,
              run: () => setNav((s) => pickScope(s, "all")),
          };
}

export function asGoalRow(query: string, launchLabel: string, { setNav }: Pick<PaletteDeps, "setNav">): PaletteItem {
    const q = query.trim();
    return {
        key: "as-goal",
        kind: "as-goal",
        search: "",
        title: `Start “${q}” as a goal`,
        meta: launchLabel,
        verb: "Choose",
        echo: `Shows the ways to start “${q}”`,
        run: () => setNav((s) => ({ ...s, asGoal: true })),
    };
}

export function scopeGroups(input: ScopeGroupsInput, deps: Pick<PaletteDeps, "setNav">): ScopeGroups {
    const { nav, mru, rows, launch } = input;
    const q = nav.query.trim();
    if (nav.actions != null) {
        return { groups: input.actionGroups(), cap: MAX_IN_SCOPE };
    }
    if (nav.drill != null) {
        const hits = rankPaletteItems(rows.theme, nav.query);
        return {
            groups: [
                {
                    key: nav.drill,
                    label: DRILL_LABELS[nav.drill],
                    items: hits,
                    ...(hits.length === 0
                        ? { emptyText: q === "" ? "Nothing to pick." : `Nothing matches “${q}”.` }
                        : {}),
                },
            ],
            cap: MAX_IN_SCOPE,
        };
    }
    if (nav.scope === "all") {
        const pool = sortByMru(
            [
                ...rows.goto,
                ...rows.start,
                ...rows.agents,
                ...rows.runs,
                ...rows.sessions,
                ...rows.channels,
                ...rows.commands,
                // last, so a tie with the thing's own row keeps the thing first
                ...rows.verbs,
            ],
            mru
        );
        // mergeRanked interleaves by score without re-ranking either side, so the brief rows keep
        // briefpalette's order (archived last) while the merged head is still the best match overall
        // notes join the ranking but not the pool: they are never listed under Recent
        const ranked = mergeRanked(nav.query, rankPaletteItems([...pool, ...rows.notesInAll], nav.query), rows.brief);
        const groups = assembleAllGroups({
            query: nav.query,
            ranked,
            recent: recentItems([...pool, ...rows.brief], mru, MAX_RECENT),
            goto: rows.goto,
            launch: rows.launch,
            asGoalItem: rows.launch.length > 0 ? asGoalRow(nav.query, launch.launchLabel, deps) : null,
            asGoal: nav.asGoal,
            projectLabel: launch.launchLabel,
            needs: rows.needs.inAll,
            start: rows.start,
        });
        return { groups, cap: MAX_IN_ALL };
    }
    if (nav.scope === "files") {
        return { ...input.fileGroups(), cap: MAX_IN_SCOPE };
    }
    return { groups: narrowedGroups(input, deps), cap: MAX_IN_SCOPE };
}

// one scope other than All and Files
function narrowedGroups(input: ScopeGroupsInput, deps: Pick<PaletteDeps, "setNav">): PaletteGroup<PaletteItem>[] {
    const { nav, surface, rows, needsGrouped, verbByKey, launch } = input;
    const q = nav.query.trim();
    const widenItem = widenRow(nav.query, deps);
    const narrowed = (items: PaletteItem[], order: GroupKind[]) => {
        const def = scopeDef(nav.scope);
        return assembleScopeGroups({
            rows: items,
            order,
            label: def.label,
            noun: def.noun,
            query: nav.query,
            widenItem,
        });
    };
    if (nav.scope === "needs") {
        // server order within each group, filtered rather than re-ranked: what waited longest stays first
        const hits = new Set(rankPaletteItems(rows.needs.inScope, nav.query).map((it) => it.key));
        const byKey = new Map(rows.needs.inScope.map((it) => [it.key, it]));
        const groups = needsGrouped
            .map((g) => {
                const items = g.rows.map((r) => byKey.get(`needs:${r.item.key}`)!).filter((it) => hits.has(it.key));
                return {
                    key: `needs:${g.group}`,
                    label: `${NEEDS_GROUP_LABELS[g.group]} · ${items.length}`,
                    asking: g.group === "asks",
                    items,
                };
            })
            .filter((g) => g.items.length > 0);
        return groups.length > 0 ? groups : narrowed([], ["needs"]);
    }
    if (nav.scope === "commands") {
        if (q === "") {
            return [{ key: "start", label: "Start", items: rows.start }, ...commandGroups(rows.commands, surface)];
        }
        const hits = rankPaletteItems([...rows.start, ...rows.verbs, ...rows.commands], nav.query);
        return hits.length > 0
            ? groupByKind(hits, ["start", "action", "command"]).map((g) =>
                  g.key === "action" ? { ...g, label: verbGroupLabel(g.items.map((it) => verbByKey.get(it.key)!)) } : g
              )
            : narrowed([], ["command"]);
    }
    if (nav.scope === "projects" && launch.projectLaunch != null) {
        return rows.launch.length > 0
            ? [{ key: "launch", label: `Start in #${launch.targetLabel}`, rich: true, items: rows.launch }]
            : [
                  {
                      key: "empty",
                      label: "Projects",
                      items: [],
                      emptyText: `No project matches “${launch.projectLaunch.token}”.`,
                  },
              ];
    }
    if (nav.scope === "records") {
        return narrowed(rows.brief, SCOPE_KINDS.records);
    }
    if (nav.scope === "notes") {
        // never empty: the "New note" row closes it, in the palette
        return [{ key: "note", label: scopeDef("notes").label, items: notesFor(rows.notes, nav.query) }];
    }
    const pools: Partial<Record<ScopeId, PaletteItem[]>> = {
        goto: rows.goto,
        agents: rows.agents,
        runs: rows.runs,
        sessions: rows.sessions,
        projects: rows.channels,
    };
    return narrowed(rankPaletteItems(pools[nav.scope] ?? [], nav.query), SCOPE_KINDS[nav.scope] ?? []);
}
