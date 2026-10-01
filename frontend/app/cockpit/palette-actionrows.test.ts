// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ThingAction, ThingEntry, ThingKindDef } from "./actions/types";
import { actionListGroups, verbGroupLabel, verbLeads } from "./palette-actionrows";

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
