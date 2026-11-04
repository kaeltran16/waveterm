// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { applyAgentOrder, mergeOrder, type AgentVM } from "./agentsviewmodel";
import {
    cardBody,
    cardHasContent,
    cockpitCounts,
    dismissKey,
    gridNotice,
    orderIds,
    plural,
    prunedBackgrounded,
    railSelectTarget,
    rosterLoadPhase,
    splitRecentlyIdle,
    toggleInSet,
} from "./cockpitsurfacemodel";
import type { Lineage } from "./runlineage";
import type { ShellTask } from "./shelltasks";

function agent(over: Partial<AgentVM>): AgentVM {
    return { id: "t1", name: "claude", task: "", state: "working", ...over };
}

describe("dismissKey", () => {
    it("keys a dismissal by id and idle episode", () => {
        expect(dismissKey({ id: "t1", idleSince: 500 })).toBe("t1:500");
    });
    it("uses an empty episode suffix when idleSince is absent", () => {
        expect(dismissKey({ id: "t1", idleSince: undefined })).toBe("t1:");
    });
});

describe("rosterLoadPhase", () => {
    it("is loading, never empty, while an empty roster has not been read yet", () => {
        expect(rosterLoadPhase(false, 0)).toBe("loading");
    });
    it("is empty once the roster has been read and holds no agents", () => {
        expect(rosterLoadPhase(true, 0)).toBe("empty");
    });
    it("is ready whenever there are agents to show, read or not", () => {
        expect(rosterLoadPhase(false, 2)).toBe("ready");
        expect(rosterLoadPhase(true, 1)).toBe("ready");
    });
});

describe("splitRecentlyIdle", () => {
    const now = 100_000;
    it("routes within-grace, non-dismissed idle agents to recently and the rest to parked", () => {
        // isRecentlyIdle uses agentsviewmodel's IDLE_GRACE_MS; fresh idleSince = recent, old = parked.
        const fresh = agent({ id: "fresh", state: "idle", idleSince: now - 1000 });
        const old = agent({ id: "old", state: "idle", idleSince: now - 10 * 60_000 });
        const { recently, parked } = splitRecentlyIdle([fresh, old], now, new Set());
        expect(recently.map((a) => a.id)).toEqual(["fresh"]);
        expect(parked.map((a) => a.id)).toEqual(["old"]);
    });
    it("moves a dismissed-but-recent agent to parked (dismissal wins)", () => {
        const fresh = agent({ id: "fresh", state: "idle", idleSince: now - 1000 });
        const dismissed = new Set([dismissKey(fresh)]);
        const { recently, parked } = splitRecentlyIdle([fresh], now, dismissed);
        expect(recently).toEqual([]);
        expect(parked.map((a) => a.id)).toEqual(["fresh"]);
    });
    it("keeps an agent standing by past the grace window and parks one that is not", () => {
        const standing = agent({ id: "standing", state: "idle", idleSince: now - 6 * 60_000 });
        const done = agent({ id: "done", state: "idle", idleSince: now - 6 * 60_000 });
        const shellTasks: Record<string, ShellTask[]> = {
            standing: [{ id: "b1", kind: "shell", description: "dev server" }],
            done: [],
        };
        const { recently, parked } = splitRecentlyIdle([standing, done], now, new Set(), shellTasks);
        expect(recently.map((a) => a.id)).toEqual(["standing"]);
        expect(parked.map((a) => a.id)).toEqual(["done"]);
    });
    it("still parks a dismissed agent that is standing by", () => {
        const standing = agent({ id: "standing", state: "idle", idleSince: now - 6 * 60_000 });
        const shellTasks: Record<string, ShellTask[]> = {
            standing: [{ id: "b1", kind: "shell", description: "dev server" }],
        };
        const { recently } = splitRecentlyIdle([standing], now, new Set([dismissKey(standing)]), shellTasks);
        expect(recently).toEqual([]);
    });
});

describe("toggleInSet", () => {
    it("adds an absent id", () => {
        expect([...toggleInSet(new Set(["a"]), "b")].sort()).toEqual(["a", "b"]);
    });
    it("removes a present id", () => {
        expect([...toggleInSet(new Set(["a", "b"]), "a")]).toEqual(["b"]);
    });
    it("does not mutate the input set", () => {
        const input = new Set(["a"]);
        toggleInSet(input, "b");
        expect([...input]).toEqual(["a"]);
    });
});

describe("cardHasContent", () => {
    it("hides a just-launched agent that has reported nothing yet", () => {
        expect(cardHasContent(agent({ state: "working" }), false)).toBe(false);
    });
    it("hides an idle agent that never produced a transcript entry", () => {
        expect(cardHasContent(agent({ state: "idle" }), false)).toBe(false);
    });
    it("shows an agent once its transcript has entries", () => {
        expect(cardHasContent(agent({ state: "idle" }), true)).toBe(true);
    });
    it("shows seeded previous info before the live stream arrives", () => {
        expect(cardHasContent(agent({ previousInfo: [{ kind: "message", text: "hi" }] }), false)).toBe(true);
    });
    it("shows a working agent with a live activity line", () => {
        expect(cardHasContent(agent({ state: "working", activity: "reading a.ts" }), false)).toBe(true);
    });
    it("ignores an idle reason, which the card never renders", () => {
        expect(cardHasContent(agent({ state: "idle", activity: "done" }), false)).toBe(false);
    });
    it("always shows an asking agent", () => {
        expect(cardHasContent(agent({ state: "asking" }), false)).toBe(true);
    });
});

describe("cardBody", () => {
    it("is waiting for a booting agent, even with entries", () => {
        expect(cardBody(agent({ booting: true }), true)).toBe("waiting");
    });
    it("is waiting when there are no entries and no ask", () => {
        expect(cardBody(agent({ state: "idle" }), false)).toBe("waiting");
    });
    it("is feed for an asking agent", () => {
        expect(cardBody(agent({ state: "asking" }), false)).toBe("feed");
    });
    it("is feed once there are entries", () => {
        expect(cardBody(agent({ state: "idle" }), true)).toBe("feed");
    });
});

describe("cockpitCounts", () => {
    const roster = [
        agent({ id: "a", project: "demo", state: "asking" }),
        agent({ id: "b", project: "demo", state: "idle" }),
        agent({ id: "c", project: "other" }),
    ];
    const asking = (a: AgentVM) => a.state === "asking";
    it("counts the whole roster unscoped", () => {
        expect(cockpitCounts(roster, "all", asking)).toEqual({ agents: 3, projects: 2, needsYou: 1 });
    });
    it("counts only the scoped project", () => {
        expect(cockpitCounts(roster, "other", asking)).toEqual({ agents: 1, projects: 1, needsYou: 0 });
    });
    it("counts an agent with no transcript", () => {
        expect(cockpitCounts([agent({ id: "boot", project: "demo", booting: true })], "all", asking).agents).toBe(1);
    });
});

describe("gridNotice", () => {
    const base = {
        seeded: true,
        rosterCount: 2,
        scopedCount: 2,
        shownCards: 0,
        parked: 0,
        backgrounded: 0,
        projectFilter: "all",
    };
    it("is loading before the roster is read", () => {
        expect(gridNotice({ ...base, seeded: false, rosterCount: 0, scopedCount: 0 }).kind).toBe("loading");
    });
    it("is the empty roster once read with no agents", () => {
        expect(gridNotice({ ...base, rosterCount: 0, scopedCount: 0 }).kind).toBe("empty-roster");
    });
    it("names a scope with no agents", () => {
        expect(gridNotice({ ...base, scopedCount: 0, projectFilter: "demo" })).toEqual({
            kind: "empty-scope",
            project: "demo",
        });
    });
    it("counts the parked agents when all are parked", () => {
        expect(gridNotice({ ...base, parked: 2 })).toEqual({ kind: "nothing-live", idle: 2, backgrounded: 0 });
    });
    it("counts the backgrounded agents when all are backgrounded", () => {
        expect(gridNotice({ ...base, backgrounded: 2 })).toEqual({ kind: "nothing-live", idle: 0, backgrounded: 2 });
    });
    it("is none while cards show", () => {
        expect(gridNotice({ ...base, shownCards: 1, parked: 1 }).kind).toBe("none");
    });
});

describe("plural", () => {
    it("is singular for one and plural otherwise", () => {
        expect(plural(1, "agent")).toBe("1 agent");
        expect(plural(0, "agent")).toBe("0 agents");
        expect(plural(2, "project")).toBe("2 projects");
    });
});

describe("prunedBackgrounded", () => {
    const noLineage: Lineage = { roles: {}, runs: {} };
    it("drops an agent that finished", () => {
        const next = prunedBackgrounded(new Set(["t1"]), [agent({ id: "t1", state: "idle" })], noLineage);
        expect([...next]).toEqual([]);
    });
    it("drops an agent that is asking", () => {
        const next = prunedBackgrounded(new Set(["t1"]), [agent({ id: "t1", state: "asking" })], noLineage);
        expect([...next]).toEqual([]);
    });
    it("drops a just-finished agent added to the set after it stopped working", () => {
        // the b key or the context menu can add a recently-idle card's id; the next prune must drop it
        const added = new Set(["t1", "w"]);
        const roster = [agent({ id: "t1", state: "idle" }), agent({ id: "w", state: "working" })];
        expect([...prunedBackgrounded(added, roster, noLineage)]).toEqual(["w"]);
    });
    it("drops a booting agent", () => {
        const next = prunedBackgrounded(new Set(["t1"]), [agent({ id: "t1", booting: true })], noLineage);
        expect([...next]).toEqual([]);
    });
    it("drops an agent that left the roster", () => {
        expect([...prunedBackgrounded(new Set(["gone"]), [], noLineage)]).toEqual([]);
    });
    it("keeps a run lead's id", () => {
        const lineage: Lineage = { roles: { lead: { kind: "lead", runId: "r1" } }, runs: {} };
        const ids = new Set(["lead"]);
        const next = prunedBackgrounded(ids, [agent({ id: "lead", state: "idle" })], lineage);
        expect([...next]).toEqual(["lead"]);
    });
    it("returns the same set when unchanged", () => {
        const ids = new Set(["t1"]);
        expect(prunedBackgrounded(ids, [agent({ id: "t1", state: "working" })], noLineage)).toBe(ids);
    });
});

describe("railSelectTarget", () => {
    const where = {
        onGrid: new Set(["g"]),
        backgrounded: new Set(["b"]),
        parked: new Set(["p"]),
    };
    it("cursors a card on the grid", () => {
        expect(railSelectTarget("g", where)).toBe("grid");
    });
    it("restores a backgrounded agent", () => {
        expect(railSelectTarget("b", where)).toBe("restore");
    });
    it("opens a parked idle agent's terminal", () => {
        expect(railSelectTarget("p", where)).toBe("terminal");
    });
    it("opens anything else in the Agent surface", () => {
        expect(railSelectTarget("x", where)).toBe("agent");
    });
});

describe("orderIds", () => {
    it("orderIds keeps a backgrounded id's slot", () => {
        const order = mergeOrder(
            ["a", "b", "c"],
            orderIds([agent({ id: "a" }), agent({ id: "c" })], [agent({ id: "b" })])
        );
        expect(order).toEqual(["a", "b", "c"]);
        const restored = applyAgentOrder(order, [agent({ id: "a" }), agent({ id: "c" }), agent({ id: "b" })]);
        expect(restored.map((a) => a.id)).toEqual(["a", "b", "c"]);
    });
});
