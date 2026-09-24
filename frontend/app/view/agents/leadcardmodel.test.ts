// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import {
    buildLeadCard,
    foldOpen,
    isLeadDown,
    leadActivity,
    REVIEW_ACTIONS,
    reviewFindings,
    rowCardId,
    rowKey,
    rowKeyActions,
    runCost,
    stopSelector,
    waitLabel,
} from "./leadcardmodel";
import type { Lineage, RunInfo } from "./runlineage";

const NOW = 1_000_000;

function task(id: string, state: string, over: Partial<TaskNode> = {}): TaskNode {
    return { id, label: `Task ${id}`, state, ...over } as TaskNode;
}

function runInfo(tasks: TaskNode[], digest?: Partial<DagStatusDigest>): RunInfo {
    return {
        runId: "R",
        channelId: "C",
        title: "Session auth",
        project: "arc",
        dag: {
            oid: "D",
            runid: "R",
            parallelism: 3,
            status: "running",
            tasks,
            workerroute: { runtime: "claude", model: "claude-sonnet-4" },
        } as TaskGroup,
        digest: digest as DagStatusDigest | undefined,
    };
}

const lead = { id: "lead", name: "auth-lead", task: "", state: "working", model: "opus" } as AgentVM;

function input(run: RunInfo, workers: AgentVM[] = [], over: Partial<Parameters<typeof buildLeadCard>[0]> = {}) {
    const roles: Lineage["roles"] = { lead: { kind: "lead", runId: "R" } };
    for (const w of workers) {
        roles[w.id] = { kind: "worker", leadRunId: "R", taskId: w.task };
    }
    return {
        cardId: "lead",
        run,
        lead,
        roster: [lead, ...workers],
        lineage: { roles, runs: { R: run } },
        leadDown: false,
        now: NOW,
        ...over,
    };
}

function ev(kind: string, ts: number, detail?: object): RunEvent {
    return {
        id: `${kind}-${ts}`,
        runid: "R",
        channelid: "C",
        ts,
        kind,
        detail: detail ? JSON.stringify(detail) : undefined,
    };
}

describe("buildLeadCard", () => {
    it("splits tasks into live, waiting and done rows in plan order", () => {
        const w = {
            id: "w2",
            name: "t2",
            task: "t2",
            state: "working",
            activity: "editing store.ts",
            runId: "c2",
        } as AgentVM;
        const run = runInfo(
            [task("t1", "done"), task("t2", "running", { runid: "c2" }), task("t3", "pending", { deps: ["t2"] })],
            {
                lanes: [["t1", "t2"], ["t3"]],
            }
        );
        const vm = buildLeadCard(input(run, [w]));
        expect(vm.done.map((r) => r.taskId)).toEqual(["t1"]);
        expect(vm.rows.map((r) => r.taskId)).toEqual(["t2"]);
        expect(vm.waiting.map((r) => r.taskId)).toEqual(["t3"]);
        expect(vm.rows[0]).toMatchObject({
            key: rowKey("lead", "t2"),
            sub: "t2 · lane A · editing store.ts",
            actions: ["tell"],
            openId: "w2",
        });
        expect(vm.waiting[0].sub).toBe("t3 · waits on t2");
        expect(vm.waiting[0].waitOn).toBe("deps");
        expect(vm.done[0].openId).toBe("ended:R:t1");
        expect(vm.segs).toEqual(["ok", "run", "wait"]);
        expect(vm.progress).toEqual({ done: 1, total: 3 });
    });

    it("answers a worker's question you hold inline and counts it", () => {
        const w = {
            id: "w2",
            name: "t2",
            task: "t2",
            state: "asking",
            runId: "c2",
            ask: { questions: [{ question: "Keep the cookie?" }] },
        } as AgentVM;
        const run = runInfo([task("t2", "running", { runid: "c2" })], {
            tasks: [{ taskid: "t2", waitreason: "ask" } as DagTaskDigest],
        });
        const vm = buildLeadCard(input(run, [w]));
        expect(vm.rows[0]).toMatchObject({ inline: "ask", needsYou: true, tone: "ask", tag: "asking", worker: w });
        expect(vm.askCount).toBe(1);
        expect(vm.needsYou).toBe(true);
    });

    it("lead-held ask: not yours, offers Take over", () => {
        const w = {
            id: "w2",
            name: "t2",
            task: "t2",
            state: "asking",
            runId: "c2",
            ask: { questions: [{ question: "?" }] },
        } as AgentVM;
        const run = runInfo([task("t2", "running", { runid: "c2" })], {
            tasks: [{ taskid: "t2", waitreason: "lead-ask", askdeadline: NOW + 4 * 60_000 } as DagTaskDigest],
        });
        const vm = buildLeadCard(input(run, [w]));
        expect(vm.rows[0]).toMatchObject({ needsYou: false, tag: "→ lead · 4m left", actions: ["takeover"] });
        expect(vm.rows[0].inline).toBeUndefined();
        expect(vm.askCount).toBe(0);
    });

    it("a failed review is the lead's to judge unless the lead is down", () => {
        const run = runInfo([task("t7", "review-failed")]);
        const judged = buildLeadCard(input(run));
        expect(judged.rows[0]).toMatchObject({ inline: "review", needsYou: false, tag: "lead judging", tone: "err" });
        const down = buildLeadCard(input(run, [], { leadDown: true }));
        expect(down.rows[0]).toMatchObject({ needsYou: true, tag: "needs you" });
        expect(down.askCount).toBe(1);
    });

    it("a stalled task offers Retry and Skip only when nobody else judges it", () => {
        const run = runInfo([task("t9", "stalled")]);
        expect(buildLeadCard(input(run)).rows[0].actions).toEqual([]);
        expect(buildLeadCard(input(run, [], { lead: undefined, cardId: "run:R" })).rows[0].actions).toEqual([
            "retry",
            "skip",
        ]);
    });

    it("a blocked merge or failed Verify offers Continue only when nobody else fixes it", () => {
        for (const state of ["blocked-merge", "verify-failed"]) {
            const run = runInfo([task("t5", state)]);
            expect(buildLeadCard(input(run)).rows[0]).toMatchObject({ needsYou: false, actions: [] });
            const down = buildLeadCard(input(run, [], { leadDown: true })).rows[0];
            expect(down).toMatchObject({ needsYou: true, tag: "needs you", actions: ["resolve"] });
        }
    });

    it("reads a slot wait from the digest", () => {
        const run = runInfo([task("t4", "pending")], {
            tasks: [{ taskid: "t4", waitreason: "parallelism" } as DagTaskDigest],
        });
        expect(buildLeadCard(input(run)).waiting[0].sub).toBe("t4 · waiting for a slot");
        expect(buildLeadCard(input(run)).waiting[0].waitOn).toBe("slot");
    });

    it("is planning with no dag, and names lead and worker models in the settings line", () => {
        const planning = buildLeadCard(input({ runId: "R", channelId: "C", title: "t", project: "arc" }));
        expect(planning.planning).toBe(true);
        expect(planning.rows).toEqual([]);
        const vm = buildLeadCard(input(runInfo([])));
        expect(vm.settings).toBe("lead opus · workers sonnet · ×3");
        expect(buildLeadCard(input(runInfo([]), [], { lead: undefined })).settings).toBe(
            "no lead · workers sonnet · ×3"
        );
    });

    it("names the branch a run lands on when it has its own", () => {
        const run = { ...runInfo([]), runId: "0123456789abcdef", landPath: "/p/.waveterm/worktrees/0123456789abcdef" };
        expect(buildLeadCard(input(run)).settings).toBe("lead opus · workers sonnet · ×3 · lands on wave/01234567");
    });
});

describe("isLeadDown", () => {
    it("is down after a wake failure until a lead launches again", () => {
        expect(isLeadDown([])).toBe(false);
        expect(isLeadDown([ev("lead-wake-failed", 10)])).toBe(true);
        expect(isLeadDown([ev("lead-wake-failed", 10), ev("lead-launched", 20)])).toBe(false);
        expect(isLeadDown([ev("lead-launched", 5), ev("lead-wake-failed", 10)])).toBe(true);
    });
});

describe("reviewFindings", () => {
    const failed = (ts: number, taskid: string, round: number, note: string) =>
        ev("task-review-failed", ts, { taskid, note, round, final: round >= 2 });

    it("lists the current attempt's rounds oldest first", () => {
        expect(
            reviewFindings([failed(1, "t7", 1, "no logout event"), failed(2, "t7", 2, "raw id logged")], "t7")
        ).toEqual([
            { round: 1, note: "no logout event" },
            { round: 2, note: "raw id logged" },
        ]);
    });
    it("retry: drops rounds from before the retry reset the count", () => {
        const events = [failed(1, "t7", 1, "old a"), failed(2, "t7", 2, "old b"), failed(3, "t7", 1, "new a")];
        expect(reviewFindings(events, "t7")).toEqual([{ round: 1, note: "new a" }]);
    });
    it("keeps rounds past the cap after a send-back", () => {
        const events = [failed(1, "t7", 1, "a"), failed(2, "t7", 2, "b"), failed(3, "t7", 3, "c")];
        expect(reviewFindings(events, "t7").map((f) => f.round)).toEqual([1, 2, 3]);
    });
    it("a reviewer that fails to finish reuses the round before it; both rounds stay", () => {
        const events = [
            failed(1, "t7", 1, "no logout event"),
            ev("task-review-failed", 2, { taskid: "t7", note: "reviewer edited the tree", round: 1, final: true }),
        ];
        expect(reviewFindings(events, "t7")).toEqual([
            { round: 1, note: "no logout event" },
            { round: 2, note: "reviewer edited the tree" },
        ]);
    });
    it("a reviewer that fails on the first review is round 1", () => {
        const events = [ev("task-review-failed", 1, { taskid: "t7", note: "could not start", round: 0, final: true })];
        expect(reviewFindings(events, "t7")).toEqual([{ round: 1, note: "could not start" }]);
    });
    it("ignores other tasks, other kinds and unreadable details", () => {
        const events = [
            failed(1, "t1", 1, "x"),
            ev("task-review-passed", 2, { taskid: "t7" }),
            { ...ev("task-review-failed", 3), detail: "{not json" },
        ];
        expect(reviewFindings(events, "t7")).toEqual([]);
    });
});

describe("rowCardId", () => {
    it("reads the card back out of a row key, even a leadless card's", () => {
        expect(rowCardId(rowKey("lead", "t2"))).toBe("lead");
        expect(rowCardId(rowKey("run:R", "t-3"))).toBe("run:R");
    });
    it("returns a card id unchanged", () => {
        expect(rowCardId("lead")).toBe("lead");
    });
});

describe("foldOpen", () => {
    const rows = [{ key: rowKey("lead", "t1") }, { key: rowKey("lead", "t2") }];
    it("opens a closed fold while the cursor is on one of its rows", () => {
        expect(foldOpen(false, rows, rowKey("lead", "t2"))).toBe(true);
        expect(foldOpen(false, rows, "lead")).toBe(false);
        expect(foldOpen(false, rows, undefined)).toBe(false);
    });
    it("keeps a fold the user opened", () => {
        expect(foldOpen(true, rows, "lead")).toBe(true);
    });
});

describe("rowKeyActions", () => {
    it("numbers a failed review's choices as the card does", () => {
        expect(rowKeyActions({ inline: "review", actions: [] })).toEqual(REVIEW_ACTIONS.map(([a]) => a));
        expect(REVIEW_ACTIONS.map(([a]) => a)).toEqual(["approve", "sendback", "retry", "skip"]);
    });
    it("numbers a live row's own actions, Tell included: its key opens the input", () => {
        expect(rowKeyActions({ actions: ["retry", "skip"] })).toEqual(["retry", "skip"]);
        expect(rowKeyActions({ actions: ["tell"] })).toEqual(["tell"]);
    });
});

describe("waitLabel", () => {
    it("counts what the waiting rows wait on", () => {
        const w = (waitOn?: "deps" | "slot") => ({ waitOn });
        expect(waitLabel([w("deps"), w("slot"), w("deps"), w()])).toBe("4 waiting · 2 on dependencies · 1 for a slot");
        expect(waitLabel([w()])).toBe("1 waiting");
    });
});

describe("stopSelector", () => {
    it("finds a task row by its row key and a card by its agent id", () => {
        expect(stopSelector("row:L:t1")).toBe('[data-row-key="row:L:t1"]');
        expect(stopSelector("a1")).toBe('[data-agent-id="a1"]');
    });
});

describe("leadActivity", () => {
    const run = (status = "running", digest?: Partial<DagStatusDigest>) => {
        const r = runInfo([task("t1", "running"), task("t2", "running"), task("t3", "pending")], digest);
        r.dag!.status = status;
        return r;
    };
    it("says a lead at its prompt stands by while the engine runs its tasks", () => {
        const idle = { ...lead, state: "idle", atPrompt: true } as AgentVM;
        expect(leadActivity(run(), idle, false)).toBe("standing by · engine running 2 lanes");
        expect(leadActivity(run("running", { counts: { running: 1 } as DagStatusCounts }), idle, false)).toBe(
            "standing by · engine running 1 lane"
        );
    });
    it("shows what a busy lead is doing", () => {
        expect(leadActivity(run(), { ...lead, activity: "judging t-2" } as AgentVM, false)).toBe("judging t-2");
    });
    it("says who holds the run's judgment when there is no lead or it is down", () => {
        expect(leadActivity(run(), undefined, false)).toBe(
            "engine running · a lead starts at the first judgment event"
        );
        expect(leadActivity(run(), lead, true)).toBe("lead down · its events come to you");
    });
    it("names a finished run's end", () => {
        expect(leadActivity(run("done"), { ...lead, atPrompt: true } as AgentVM, false)).toBe("run done");
    });
});

describe("runCost", () => {
    it("joins the workers' time and tokens, leaving out what is unknown", () => {
        expect(runCost(6_120_000, 2_100_000)).toBe("1h42m worker · 2.1M tokens");
        expect(runCost(1_440_000, undefined)).toBe("24m worker");
        expect(runCost(undefined, 410_000)).toBe("410k tokens");
        expect(runCost(0, 0)).toBe("");
    });
});
