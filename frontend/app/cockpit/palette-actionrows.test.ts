// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { CircleX, Square } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { verbRows, type ThingAction, type ThingEntry, type ThingKindDef } from "./actions/types";
import {
    actionDrillGroups,
    actionItem,
    actionListGroups,
    resolveActionRow,
    runThingAction,
    verbGroupLabel,
    verbItems,
    verbLeads,
} from "./palette-actionrows";
import { initialNav, type NavState } from "./palette-scope";

interface Job {
    live: boolean;
}

const action = (id: string, label: string, group: ThingAction<Job>["group"], applies: (j: Job) => boolean) => ({
    id,
    label,
    group,
    applies,
    run: () => {},
});

const JOB_KIND: ThingKindDef<Job> = {
    kind: "run",
    noun: "Run",
    // registry order deliberately mixes groups: the list must still read open, steer, stop
    actions: [
        action("job:cancel", "Cancel run", "stop", (j) => j.live),
        action("job:open", "Open in Jarvis", "open", () => true),
        action("job:resume", "Resume", "steer", (j) => !j.live),
        action("job:dag", "Open the DAG", "open", () => true),
        action("job:end", "End final stage", "stop", () => false),
    ],
    entries: () => [],
};

const entry = (live: boolean): ThingEntry<Job> => ({ key: "run:1", title: "fix flaky verify", thing: { live } });
const shape = (r: ReturnType<typeof actionListGroups<Job>>) =>
    r.groups.map((g) => [g.key, g.label, g.actions.map((a) => a.id)]);

describe("actionListGroups", () => {
    it("lists open, steer, stop in that order, dropping a section with nothing that applies", () => {
        const r = actionListGroups(JOB_KIND, entry(true), "");
        expect(shape(r)).toEqual([
            ["open", "Open", ["job:open", "job:dag"]],
            ["stop", "Stop", ["job:cancel"]],
        ]);
    });

    it("names what does not apply now on the Not now line", () => {
        expect(actionListGroups(JOB_KIND, entry(true), "").notNow).toBe("Not now: Resume, End final stage");
        expect(actionListGroups(JOB_KIND, entry(false), "").notNow).toBe("Not now: Cancel run, End final stage");
    });

    it("has no Not now line when everything applies", () => {
        const all: ThingKindDef<Job> = { ...JOB_KIND, actions: JOB_KIND.actions.slice(1, 2) };
        expect(actionListGroups(all, entry(true), "").notNow).toBeNull();
    });

    it("filters the actions by the query", () => {
        const r = actionListGroups(JOB_KIND, entry(true), "dag");
        expect(shape(r)).toEqual([["open", "Open", ["job:dag"]]]);
    });

    it("keeps the Not now line when the query filters everything out", () => {
        const r = actionListGroups(JOB_KIND, entry(true), "resume");
        expect(r.groups).toEqual([]);
        expect(r.notNow).toBe("Not now: Resume, End final stage");
    });
});

describe("resolveActionRow", () => {
    const plain = action("job:cancel", "Cancel run", "stop", () => true);

    it("names a plain action by its label, Enter by the label's first word", () => {
        expect(resolveActionRow(plain, entry(true))).toEqual({
            title: "Cancel run",
            verb: "Cancel",
            status: undefined,
            echo: "Cancel run: “fix flaky verify”",
        });
    });

    it("writes or picks first when the action takes a value", () => {
        const text: ThingAction<Job> = {
            ...plain,
            label: "Message the lead",
            input: { kind: "text", placeholder: "" },
        };
        expect(resolveActionRow(text, entry(true))).toMatchObject({
            title: "Message the lead…",
            verb: "Write",
            echo: "Takes the text here, for “fix flaky verify”",
        });
        const pick: ThingAction<Job> = {
            ...plain,
            label: "Stop a worker…",
            input: { kind: "pick", placeholder: "", options: () => [] },
        };
        expect(resolveActionRow(pick, entry(true))).toMatchObject({
            title: "Stop a worker…",
            verb: "Pick",
            echo: "Lists the choices, for “fix flaky verify”",
        });
    });

    it("lets a toggle read by the thing's current value", () => {
        const toggle: ThingAction<Job> = {
            ...plain,
            label: "Go autonomous",
            title: (j) => (j.live ? "Ask me again" : "Go autonomous"),
            verb: (j) => (j.live ? "Ask me" : "Go"),
            status: (j) => (j.live ? { label: "autonomous", tone: "accent" } : { label: "asks you", tone: "muted" }),
            echo: (j) => (j.live ? "asks again" : "answers everything"),
        };
        expect(resolveActionRow(toggle, entry(false))).toEqual({
            title: "Go autonomous",
            verb: "Go",
            status: { label: "asks you", tone: "muted" },
            echo: "answers everything",
        });
        expect(resolveActionRow(toggle, entry(true))).toEqual({
            title: "Ask me again",
            verb: "Ask me",
            status: { label: "autonomous", tone: "accent" },
            echo: "asks again",
        });
    });
});

describe("verbLeads", () => {
    it("matches when the query starts with the action's verb", () => {
        expect(verbLeads("cancel", "Cancel run")).toBe(true);
        expect(verbLeads("cancel flaky", "Cancel run")).toBe(true);
        expect(verbLeads("open dag", "Open the DAG")).toBe(true);
    });

    it("does not match a thing's name typed alone, so a name search is not buried in actions", () => {
        // a verb row's search text also holds the thing's title, which "flaky" would match
        expect(verbLeads("flaky", "Focus the cockpit on it")).toBe(false);
        expect(verbLeads("flaky", "Open in Jarvis")).toBe(false);
    });

    it("never matches an empty query", () => {
        expect(verbLeads("  ", "Cancel run")).toBe(false);
    });
});

describe("verbGroupLabel", () => {
    const row = (label: string) => ({ action: { label } });

    it("names the action when every row is the same one", () => {
        expect(verbGroupLabel([row("Cancel run"), row("Cancel run")])).toBe("Actions · Cancel run");
    });

    it("is plain Actions when the rows mix actions", () => {
        expect(verbGroupLabel([row("Cancel run"), row("Resume")])).toBe("Actions");
    });
});

describe("action rows", () => {
    const cancel = JOB_KIND.actions[0];
    const t = { def: JOB_KIND, entry: entry(true) };
    const deps = () => ({ model: {} as AgentsViewModel, close: vi.fn(), setPaletteError: vi.fn() });
    const drilled = (over: Partial<NavState["actions"]> = {}, query = ""): NavState => ({
        ...initialNav("agent"),
        query,
        actions: {
            thing: { key: "run:1", title: "fix flaky verify", noun: "Run" },
            back: { scope: "all", query: "", sel: 0, asGoal: false },
            input: null,
            ...over,
        },
    });

    it("reads an action row as resolveActionRow says, and Enter starts it", () => {
        const start = vi.fn();
        const row = actionItem(t, cancel, start);
        expect(row).toMatchObject({
            key: "act:job:cancel",
            kind: "action",
            search: "Cancel run",
            icon: Square,
            title: "Cancel run",
            verb: "Cancel",
            echo: "Cancel run: “fix flaky verify”",
        });
        row.run();
        expect(start).toHaveBeenCalledWith(t, cancel);
        expect(actionItem(t, { ...cancel, destructive: true }, start)).toMatchObject({ icon: CircleX, danger: true });
    });

    it("closes after an action succeeds, and stays open on the error when it fails", async () => {
        const ok = deps();
        runThingAction(t, { ...cancel, run: async () => {} }, ok);
        await vi.waitFor(() => expect(ok.close).toHaveBeenCalled());
        const bad = deps();
        runThingAction(t, { ...cancel, run: async () => Promise.reject(new Error("gone")) }, bad);
        await vi.waitFor(() => expect(bad.setPaletteError).toHaveBeenLastCalledWith("Cancel run failed: gone"));
        expect(bad.close).not.toHaveBeenCalled();
    });

    it("lists verb rows only when the query leads with the verb, borrowing the thing's meta", () => {
        const all = verbRows(JOB_KIND, [entry(true)]).map((v) => ({ def: JOB_KIND, v }));
        const meta = new Map([["run:1", "#waveterm"]]);
        expect(verbItems(all, "flaky", meta, vi.fn()).items).toEqual([]);
        expect(verbItems(all, "", meta, vi.fn()).items).toEqual([]);
        const { items, byKey } = verbItems(all, "cancel", meta, vi.fn());
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            key: "action:job:cancel:run:1",
            search: "Cancel run fix flaky verify",
            title: "Cancel run · fix flaky verify",
            meta: "#waveterm",
        });
        expect(byKey.get(items[0].key)?.action).toBe(cancel);
    });

    it("drills into a thing's action list, its last group carrying the Not now line", () => {
        const groups = actionDrillGroups(drilled(), new Map([["run:1", t]]), vi.fn(), deps());
        expect(groups.map((g) => [g.key, g.label, g.items.map((it) => it.key)])).toEqual([
            ["act:open", "Open", ["act:job:open", "act:job:dag"]],
            ["act:stop", "Stop", ["act:job:cancel"]],
        ]);
        expect(groups[1].note).toBe("Not now: Resume, End final stage");
    });

    it("says when nothing matches, and when the thing is gone", () => {
        const none = actionDrillGroups(drilled({}, "zzz"), new Map([["run:1", t]]), vi.fn(), deps());
        expect(none).toEqual([
            {
                key: "empty",
                label: "Actions",
                items: [],
                emptyText: "No actions match “zzz”.",
                note: "Not now: Resume, End final stage",
            },
        ]);
        expect(actionDrillGroups(drilled(), new Map(), vi.fn(), deps())).toEqual([
            { key: "empty", label: "Run", items: [], emptyText: "It is no longer listed." },
        ]);
    });

    it("lists a pick action's options, and picking one runs the action with its value", async () => {
        const run = vi.fn();
        const pick: ThingAction<Job> = {
            ...cancel,
            id: "job:stop-worker",
            label: "Stop a worker…",
            input: { kind: "pick", placeholder: "", options: () => [{ value: "w1", label: "worker one" }] },
            run,
        };
        const def = { ...JOB_KIND, actions: [pick] };
        const d = deps();
        const nav = drilled({ input: { actionId: pick.id, label: "Stop a worker" } });
        const [group] = actionDrillGroups(nav, new Map([["run:1", { def, entry: entry(true) }]]), vi.fn(), d);
        expect(group).toMatchObject({ key: "pick", label: "Stop a worker" });
        expect(group.items[0]).toMatchObject({
            key: "opt:w1",
            title: "worker one",
            icon: undefined,
            verb: "Pick",
            echo: "Stop a worker: worker one",
        });
        group.items[0].run();
        await vi.waitFor(() => expect(d.close).toHaveBeenCalled());
        expect(run.mock.calls[0][2]).toBe("w1");
        const empty = actionDrillGroups(
            { ...nav, query: "zzz" },
            new Map([["run:1", { def, entry: entry(true) }]]),
            vi.fn(),
            d
        );
        expect(empty[0]).toMatchObject({ items: [], emptyText: "Nothing matches “zzz”." });
    });

    it("takes a text action's value from the query, and an empty field sends nothing", async () => {
        const run = vi.fn();
        const text: ThingAction<Job> = {
            ...cancel,
            id: "job:msg",
            label: "Message the lead",
            input: { kind: "text", placeholder: "Say something…" },
            run,
        };
        const def = { ...JOB_KIND, actions: [text] };
        const targets = new Map([["run:1", { def, entry: entry(true) }]]);
        const d = deps();
        const at = (query: string) =>
            actionDrillGroups(
                drilled({ input: { actionId: text.id, label: "Message the lead" } }, query),
                targets,
                vi.fn(),
                d
            );
        const [blank] = at("");
        expect(blank.items[0]).toMatchObject({
            key: "submit",
            title: "Say something…",
            verb: "Send",
            echo: "Type it here, then Enter sends it",
        });
        blank.items[0].run();
        expect(run).not.toHaveBeenCalled();
        const [typed] = at("hello");
        expect(typed).toMatchObject({ key: "text", label: "Message the lead" });
        expect(typed.items[0]).toMatchObject({ title: "hello", hl: "", echo: "Message the lead: “hello”" });
        typed.items[0].run();
        await vi.waitFor(() => expect(d.close).toHaveBeenCalled());
        expect(run.mock.calls[0][2]).toBe("hello");
    });
});
