// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { depText, leadRouteText, planGateView, planLayers, workerRouteText } from "./plangate";

function task(id: string, deps: string[] = [], label?: string): TaskNode {
    return { id, label: label ?? id, deps, state: "pending", runspec: {} } as TaskNode;
}

function group(tasks: TaskNode[], parallelism = 3): TaskGroup {
    return { tasks, parallelism } as TaskGroup;
}

// the sweep from the design: three roots, three dependents, two joins, one gate row
const SWEEP = [
    task("idempotency-key", [], "Idempotency key on retry"),
    task("signature-order", [], "Signature verify order"),
    task("retry-budget", [], "Retry budget per endpoint"),
    task("backoff-jitter", ["idempotency-key"], "Backoff jitter"),
    task("double-ack", ["signature-order"], "Drop the double-ack path"),
    task("endpoint-caps", ["retry-budget"], "Per-endpoint caps"),
    task("replay-tool", ["backoff-jitter", "double-ack"], "Replay tool for ops"),
    task("metrics", ["endpoint-caps"], "Retry metrics"),
    task("runbook", ["replay-tool", "metrics"], "Runbook + docs"),
];

describe("planLayers", () => {
    it("counts the waves the engine will run, not the tasks", () => {
        expect(planLayers(SWEEP)).toBe(4);
    });

    it("is 1 for a flat plan and 0 for an empty one", () => {
        expect(planLayers([task("a"), task("b"), task("c")])).toBe(1);
        expect(planLayers([])).toBe(0);
    });

    it("counts the longest path, not the shortest", () => {
        // c depends on both a root and a depth-1 task; its layer is the deeper one
        expect(planLayers([task("a"), task("b", ["a"]), task("c", ["a", "b"])])).toBe(3);
    });

    it("terminates on a cycle rather than hanging", () => {
        expect(planLayers([task("a", ["b"]), task("b", ["a"])])).toBe(1);
    });

    it("ignores a dependency on a task that is not in the plan", () => {
        expect(planLayers([task("a", ["ghost"])])).toBe(1);
    });
});

describe("depText", () => {
    it("says what a row waits for, by id", () => {
        expect(depText(task("x"))).toBe("no deps");
        expect(depText(task("x", ["a"]))).toBe("after a");
        expect(depText(task("x", ["a", "b"]))).toBe("after a, b");
    });
});

describe("planGateView", () => {
    it("numbers rows in dependency order so the plan reads top to bottom", () => {
        // submitted leaf-first: read in submission order, row 1 would depend on row 3
        const shuffled = [task("ship", ["build"]), task("build", ["plan"]), task("plan")];
        const view = planGateView(group(shuffled));
        expect(view.rows.map((r) => r.id)).toEqual(["plan", "build", "ship"]);
        expect(view.rows.map((r) => r.n)).toEqual([1, 2, 3]);
    });

    it("keeps the lead's own order within one layer", () => {
        const view = planGateView(group([task("zeta"), task("alpha"), task("mid", ["zeta"])]));
        expect(view.rows.map((r) => r.id)).toEqual(["zeta", "alpha", "mid"]);
    });

    it("states the plan's shape and the width it will run at", () => {
        const view = planGateView(group(SWEEP, 3));
        expect(view.shape).toBe("9 tasks · 4 layers");
        expect(view.width).toBe("parallelism 3 · 16 max");
    });

    it("singularises a one-task, one-layer plan", () => {
        expect(planGateView(group([task("only")], 1)).shape).toBe("1 task · 1 layer");
    });

    it("falls back to the id when the lead submitted no label", () => {
        const view = planGateView(group([{ id: "t-0", label: "", deps: [] } as TaskNode]));
        expect(view.rows[0].label).toBe("t-0");
    });

    it("never claims a width above the engine's ceiling", () => {
        expect(planGateView(group([task("a")], 99)).width).toBe("parallelism 8 · 16 max");
    });
});

describe("leadRouteText", () => {
    it("prefers the exact model over the tier, as the router does", () => {
        expect(leadRouteText({ runtime: "claude", tier: "capable", model: "opus-4.6" } as Run)).toBe(
            "lead claude · opus-4.6"
        );
        expect(leadRouteText({ runtime: "claude", tier: "capable" } as Run)).toBe("lead claude · capable");
    });

    it("says unavailable rather than inventing a runtime", () => {
        expect(leadRouteText({} as Run)).toBe("lead unavailable");
    });
});

describe("workerRouteText", () => {
    const run = { runtime: "claude", tier: "capable" } as Run;

    it("inherits from the lead when no worker route is pinned", () => {
        expect(workerRouteText(run, { mergerequired: true } as TaskGroup)).toBe(
            "workers same as lead · managed worktrees"
        );
    });

    it("names a pinned worker route", () => {
        const g = { mergerequired: true, workerroute: { runtime: "codex", tier: "fast" } } as TaskGroup;
        expect(workerRouteText(run, g)).toBe("workers codex · fast · managed worktrees");
    });

    it("never promises worktree isolation a non-git project does not have", () => {
        expect(workerRouteText(run, { mergerequired: false } as TaskGroup)).toBe(
            "workers same as lead · in the project directory"
        );
    });
});
