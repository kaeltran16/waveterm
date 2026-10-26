// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { VerbRow } from "./actions/types";
import { MAX_IN_ALL, MAX_IN_SCOPE } from "./palette-groups";
import type { CommandRow, LaunchTarget } from "./palette-items";
import type { NeedsGroup, NeedsRow } from "./palette-needs";
import type { PaletteItem } from "./palette-rows";
import { initialNav, type NavState } from "./palette-scope";
import { asGoalRow, scopeGroups, widenRow, type ScopeGroupsInput, type ScopeRows } from "./palette-scopegroups";

const row = (key: string, kind: PaletteItem["kind"], title = key): PaletteItem => ({
    key,
    kind,
    search: title,
    title,
    verb: "Open",
    echo: "",
    run: () => {},
});

const rows = (over: Partial<ScopeRows> = {}): ScopeRows => ({
    theme: [row("theme:dark", "theme", "Dark"), row("theme:light", "theme", "Light")],
    goto: [row("goto:usage", "surface", "Usage")],
    commands: [{ ...row("toggle-rail", "command", "Toggle rail"), group: "View" } as CommandRow],
    start: [row("start:run", "start", "New run…")],
    agents: [row("agent:a1", "agent", "juno")],
    runs: [row("run:r1", "run", "ship the palette")],
    sessions: [],
    sessionHits: null,
    channels: [row("channel:c1", "channel", "#waveterm")],
    brief: [row("record:t1", "record", "a record")],
    notes: [row("note:n1", "note", "build steps"), row("note:n2", "note", "alpha")],
    notesInAll: [],
    launch: [],
    verbs: [],
    needs: { inScope: [], inAll: [] },
    ...over,
});

const noLaunch: LaunchTarget = {
    projectLaunch: null,
    targetChannel: null,
    launchGoal: "",
    targetLabel: "",
    launchLabel: "a project",
    unmatchedProject: false,
};

const nav = (over: Partial<NavState>): NavState => ({ ...initialNav("agent"), ...over });

function groupsAt(over: Partial<NavState>, input: Partial<ScopeGroupsInput> = {}) {
    const setNav = vi.fn();
    const out = scopeGroups(
        {
            nav: nav(over),
            surface: "agent",
            mru: [],
            rows: rows(),
            needsGrouped: [],
            verbByKey: new Map(),
            launch: noLaunch,
            actionGroups: () => [{ key: "act", label: "Actions", items: [] }],
            fileGroups: () => ({ groups: [{ key: "files", label: "Files", items: [] }], fileHighlight: "x" }),
            ...input,
        },
        { setNav }
    );
    return { ...out, setNav, shape: out.groups.map((g) => [g.label, g.items.map((it) => it.key)]) };
}

describe("scopeGroups", () => {
    it("hands an action level and the Files scope to their own builders", () => {
        const actions = groupsAt({
            actions: {
                thing: { key: "run:r1", title: "t", noun: "Run" },
                back: { scope: "all", query: "", sel: 0, asGoal: false },
                input: null,
            },
        });
        expect(actions.groups.map((g) => g.key)).toEqual(["act"]);
        expect(actions.cap).toBe(MAX_IN_SCOPE);
        const files = groupsAt({ scope: "files" });
        expect(files).toMatchObject({ fileHighlight: "x", cap: MAX_IN_SCOPE });
        expect(files.groups.map((g) => g.key)).toEqual(["files"]);
    });

    it("ranks the theme drill, and says when nothing matches", () => {
        expect(groupsAt({ drill: "theme", query: "light" }).shape).toEqual([["Theme", ["theme:light"]]]);
        expect(groupsAt({ drill: "theme", query: "zzz" }).groups[0]).toMatchObject({
            items: [],
            emptyText: "Nothing matches “zzz”.",
        });
    });

    it("caps All's mixed groups tighter than a scope", () => {
        const all = groupsAt({ scope: "all" });
        expect(all.cap).toBe(MAX_IN_ALL);
        expect(all.shape).toEqual([
            ["Start", ["start:run"]],
            ["Go to", ["goto:usage"]],
        ]);
    });

    it("offers a goal under a name match in All, and only the launch rows once chosen", () => {
        const launch = [row("launch:quick", "launch", "Quick")];
        const input = { rows: rows({ launch }), launch: { ...noLaunch, launchLabel: "#waveterm" } };
        const named = groupsAt({ scope: "all", query: "juno" }, input);
        expect(named.shape).toEqual([
            ["Agents", ["agent:a1"]],
            ["Or as a goal", ["as-goal"]],
        ]);
        expect(named.groups[1].items[0]).toMatchObject({ title: "Start “juno” as a goal", meta: "#waveterm" });
        const chosen = groupsAt({ scope: "all", query: "juno", asGoal: true }, input);
        expect(chosen.shape[0]).toEqual(["Start in #waveterm", ["launch:quick"]]);
    });

    it("groups Needs you by kind in server order, counting each group", () => {
        const needsRow = (key: string) => ({ item: { key } }) as NeedsRow;
        const needsGrouped: { group: NeedsGroup; rows: NeedsRow[] }[] = [
            { group: "asks", rows: [needsRow("b"), needsRow("a")] },
            { group: "blocked", rows: [needsRow("c")] },
        ];
        const inScope = ["b", "a", "c"].map((k) => row(`needs:${k}`, "needs", `item ${k}`));
        const out = groupsAt({ scope: "needs" }, { needsGrouped, rows: rows({ needs: { inScope, inAll: [] } }) });
        expect(out.shape).toEqual([
            ["Asks · 2", ["needs:b", "needs:a"]],
            ["Blocked · 1", ["needs:c"]],
        ]);
        expect(out.groups[0].asking).toBe(true);
        expect(groupsAt({ scope: "needs" }).groups[0]).toMatchObject({ items: [], emptyText: "No waiting items yet." });
    });

    it("lists Start then the command groups with nothing typed, and names a verb group by its action", () => {
        expect(groupsAt({ scope: "commands" }).shape).toEqual([
            ["Start", ["start:run"]],
            ["View", ["toggle-rail"]],
        ]);
        const verb = row("action:run:cancel:run:r1", "action", "Cancel run · ship");
        const verbByKey = new Map([[verb.key, { action: { label: "Cancel run" } } as VerbRow<any>]]);
        const out = groupsAt({ scope: "commands", query: "cancel" }, { rows: rows({ verbs: [verb] }), verbByKey });
        expect(out.shape).toEqual([["Actions · Cancel run", [verb.key]]]);
    });

    it("starts a project goal from Projects, or says the project matches none", () => {
        const launch = [row("launch:quick", "launch", "Quick")];
        const target = { ...noLaunch, projectLaunch: { token: "waveterm", goal: "fix" }, targetLabel: "waveterm" };
        const out = groupsAt({ scope: "projects", query: "waveterm fix" }, { rows: rows({ launch }), launch: target });
        expect(out.groups[0]).toMatchObject({ key: "launch", label: "Start in #waveterm", rich: true });
        const none = groupsAt(
            { scope: "projects", query: "nope fix" },
            { launch: { ...target, projectLaunch: { token: "nope", goal: "fix" } } }
        );
        expect(none.groups[0]).toMatchObject({ items: [], emptyText: "No project matches “nope”." });
    });

    it("lists records, notes in the store's order until typed, and one scope's own kind", () => {
        expect(groupsAt({ scope: "records" }).shape).toEqual([["Records", ["record:t1"]]]);
        expect(groupsAt({ scope: "notes" }).shape).toEqual([["Notes", ["note:n1", "note:n2"]]]);
        expect(groupsAt({ scope: "notes", query: "alpha" }).shape).toEqual([["Notes", ["note:n2"]]]);
        expect(groupsAt({ scope: "runs", query: "palette" }).shape).toEqual([["Runs", ["run:r1"]]]);
    });

    it("offers to widen a scope's text to All when nothing in it matches", () => {
        const out = groupsAt({ scope: "agents", query: "zzz" });
        expect(out.groups[0]).toMatchObject({ emptyText: "No agents match “zzz”." });
        expect(out.groups[0].items[0]).toMatchObject({ key: "widen", title: "Search everything for “zzz”" });
        out.groups[0].items[0].run();
        expect(out.setNav.mock.calls[0][0](nav({ scope: "agents", query: "zzz" })).scope).toBe("all");
    });

    it("sessions scope with a query keeps server order", () => {
        // neither title holds the query: the server matched what was said, so nothing is ranked or dropped here
        const sessionHits = [
            row("session:claude:s2", "session", "newer"),
            row("session:claude:s1", "session", "older"),
        ];
        const out = groupsAt(
            { scope: "sessions", query: "timeout" },
            { rows: rows({ sessions: [row("session:claude:s3", "session", "timeout title")], sessionHits }) }
        );
        expect(out.shape).toEqual([["Sessions", ["session:claude:s2", "session:claude:s1"]]]);
        const pending = groupsAt({ scope: "sessions", query: "timeout" }, { rows: rows({ sessionHits: null }) });
        expect(pending.groups[0]).toMatchObject({ items: [], emptyText: "Searching sessions…" });
    });

    it("sessions scope with an empty query lists the archive rows", () => {
        const archive = [row("session:claude:s1", "session", "refactor"), row("session:pi:s2", "session", "deploy")];
        const out = groupsAt(
            { scope: "sessions", query: "" },
            { rows: rows({ sessions: archive, sessionHits: null }) }
        );
        expect(out.shape).toEqual([["Sessions", ["session:claude:s1", "session:pi:s2"]]]);
    });
});

describe("widenRow and asGoalRow", () => {
    it("offers no widen row without text", () => {
        expect(widenRow("  ", { setNav: vi.fn() })).toBeNull();
        expect(widenRow(" zzz ", { setNav: vi.fn() })).toMatchObject({
            kind: "widen",
            verb: "Search",
            echo: "Widens to All, keeping “zzz”",
        });
    });

    it("expands the goal rows when chosen", () => {
        const setNav = vi.fn();
        const it = asGoalRow("fix it", "a project", { setNav });
        expect(it).toMatchObject({ kind: "as-goal", verb: "Choose", echo: "Shows the ways to start “fix it”" });
        it.run();
        expect(setNav.mock.calls[0][0](nav({})).asGoal).toBe(true);
    });
});
