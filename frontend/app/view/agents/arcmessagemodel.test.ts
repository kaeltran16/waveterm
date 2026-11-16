// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentEntry } from "./agentsviewmodel";
import { arcMessageOf } from "./arcmessage";
import {
    brainstormLineView,
    briefView,
    builderCountsOf,
    finalRoundOf,
    judgeResultOf,
    LEAD_ASK_DEADLINE_MS,
    planPassedInGap,
    WAIT_FOLD_MIN_MS,
    waitedSummary,
    wakeEvents,
    wakeParts,
    type PaneActionKind,
} from "./arcmessagemodel";
import { brainstormLine, settleLine, type BrainstormAction, type BrainstormFile } from "./brainstormmodel";
import type { RunRole } from "./runlineage";

// inputs follow the shapes of the engine's format strings (pkg/orchestrate/queue.go, wake.go)
const status = (t: string) => `wsh jarvis dag status ${t}`;
const one = (text: string) => {
    const parts = wakeParts(text);
    expect(parts).toHaveLength(1);
    return parts[0];
};

describe("wakeParts: each wake phrase", () => {
    it("plan review failed: round, last, findings split on their numbering with the lens kept", () => {
        const p = one(
            "wake: plan review failed in round 1: [Second pass] 1) Task 3 changes writeLaunchPrompt. 2) Task 4 renames the prompt. Passed: Full review. Revise the plan (put spec changes to the human) and run `wsh jarvis dag submit` again."
        );
        expect(p).toMatchObject({ kind: "plan-review-failed", round: 1, last: false });
        expect(p.findings).toHaveLength(2);
        expect(p.findings?.map((f) => f.lens)).toEqual(["Second pass", "Second pass"]);
        expect(p.findings?.[1].text.startsWith("Task 4")).toBe(true);

        const last = one(
            "wake: plan review failed in round 2, the last: [Full review] a single block. Put it to the human; as one ask"
        );
        expect(last).toMatchObject({ round: 2, last: true });
        expect(last.findings).toHaveLength(1);
    });

    it("the plan reviewer did not finish: round and reason", () => {
        expect(
            one(
                "wake: the plan reviewer did not finish in round 1 (it exited). Run `wsh jarvis dag submit` again to review the plan once more."
            )
        ).toMatchObject({ kind: "plan-reviewer-lost", round: 1, reason: "it exited" });
    });

    it("never started: the task and its minutes", () => {
        expect(
            one("wake: task t-5 never started: no worker process 5m after spawn. wsh jarvis dag retry t-5")
        ).toMatchObject({
            kind: "never-started",
            taskId: "t-5",
            minutes: 5,
        });
    });

    it("merge conflict: the lane's last task and its files, or none", () => {
        expect(
            one(`wake: merge conflict landing lane ending at task t-6 in frontend/a.tsx, pkg/b.go. ${status("t-6")}`)
        ).toMatchObject({ kind: "merge-conflict", taskId: "t-6", files: ["frontend/a.tsx", "pkg/b.go"] });
        expect(
            one(`wake: merge conflict landing lane ending at task t-6. git status, then ${status("t-6")}`)
        ).toMatchObject({
            taskId: "t-6",
            files: [],
        });
    });

    it("may be stuck: the task and the reason", () => {
        expect(
            one(
                `wake: task t-4 may be stuck: the same test has failed for 14 minutes. Tell it (\`wsh jarvis dag tell t-4 "…"\`), retry, escalate, or let it run. ${status("t-4")}`
            )
        ).toMatchObject({ kind: "may-be-stuck", taskId: "t-4", reason: "the same test has failed for 14 minutes" });
    });

    it("failed: the task, its kind, retry spent and the failure line", () => {
        const p = one(`wake: task t-7 failed (tests): FAIL boardsdraw.test.ts, retry spent. ${status("t-7")}`);
        expect(p).toMatchObject({ kind: "task-failed", taskId: "t-7", failKind: "tests", retrySpent: true });
        expect(p.items).toEqual(["FAIL boardsdraw.test.ts"]);
        // the engine's detail lines under it join its body
        const multi = one(
            `wake: task t-7 failed (tests), retry spent. ${status("t-7")}\n› erases a stroke\nexpected 2, received 3`
        );
        expect(multi.items).toEqual(["› erases a stroke", "expected 2, received 3"]);
    });

    it("hung, worker idle, worker exited: the task", () => {
        expect(one(`wake: task t-2 hung: silent 12m, process alive, no ask pending. ${status("t-2")}`)).toMatchObject({
            kind: "task-hung",
            taskId: "t-2",
            minutes: 12,
        });
        expect(
            one(
                `wake: task t-2's worker ended its turn without completing and is idle; its complete may not have landed. ${status("t-2")}`
            )
        ).toMatchObject({ kind: "worker-idle", taskId: "t-2" });
        expect(
            one(`wake: task t-2's worker is idle after its last turn failed: API error 529. ${status("t-2")}`)
        ).toMatchObject({
            kind: "worker-idle",
            taskId: "t-2",
            reason: "API error 529",
        });
        expect(one(`wake: task t-3's worker exited without reporting complete. ${status("t-3")}`)).toMatchObject({
            kind: "worker-exited",
            taskId: "t-3",
        });
    });

    it("final stage failed: round, last and one defect per detail line", () => {
        const p = one(
            "wake: the final stage failed on the merged result in round 1. Write a fix plan and run `wsh jarvis dag submit --round --plan <fix plan>`. Put it to the human if the fix is a product call:\nboards-draw · step 4: the arrow stays\n- boards-surface · step 2: text runs under the toolbar"
        );
        expect(p).toMatchObject({ kind: "final-failed", round: 1, last: false });
        expect(p.of).toBeUndefined();
        expect(p.sha).toBeUndefined();
        expect(p.items).toHaveLength(2);
        expect(p.items?.[1].startsWith("boards-surface")).toBe(true);
        expect(finalRoundOf(p)).toEqual({ round: 1 });

        const last = one(
            "wake: the final stage failed on the merged result in round 2, the last. Put it to the human:\nonly one"
        );
        expect(finalRoundOf(last)).toEqual({ round: 2, of: 2 });
        expect(last.items).toHaveLength(1);
    });

    it("final stage failed: the engine's total and commit", () => {
        const p = one(
            "wake: the final stage failed on the merged result 3a7f1c2 in round 1 of 3. Write a fix plan:\nboards-draw · step 4: the arrow stays"
        );
        expect(p).toMatchObject({ kind: "final-failed", round: 1, of: 3, sha: "3a7f1c2", last: false });
        expect(p.items).toHaveLength(1);
        expect(finalRoundOf(p)).toEqual({ round: 1, of: 3 });

        const last = one(
            "wake: the final stage failed on the merged result 3a7f1c2 in round 3 of 3, the last. Put it to the human:\nonly one"
        );
        expect(last).toMatchObject({ kind: "final-failed", round: 3, of: 3, last: true });
        expect(finalRoundOf(last)).toEqual({ round: 3, of: 3 });

        const noSha = one("wake: the final stage failed on the merged result in round 1 of 3. Write a fix plan:\nx");
        expect(noSha).toMatchObject({ kind: "final-failed", round: 1, of: 3 });
        expect(noSha.sha).toBeUndefined();
    });

    it("final step killed, run finished, questions waiting", () => {
        expect(
            one(
                "wake: a step of the final stage was killed from outside in round 2, before it judged anything. Write no fix plan:\nkilled"
            )
        ).toMatchObject({
            kind: "final-killed",
            round: 2,
        });
        expect(one("wake: run finished. wsh jarvis dag status").kind).toBe("run-finished");
        expect(one("wake: 1 question waiting. wsh jarvis dag asks")).toMatchObject({ kind: "questions", count: 1 });
        expect(one("wake: 3 questions waiting. wsh jarvis dag asks")).toMatchObject({ count: 3 });
    });

    it("Verify failed, review failed, passed with a note, engine stuck", () => {
        expect(
            one(`wake: Verify failed after merging task t-3 (exit 1): FAIL a.test.ts. ${status("t-3")}`)
        ).toMatchObject({
            kind: "verify-failed",
            taskId: "t-3",
            reason: "exit 1",
            items: ["FAIL a.test.ts"],
        });
        expect(one(`wake: review failed for task t-4: returns input on n = 0. ${status("t-4")}`)).toMatchObject({
            kind: "review-failed",
            taskId: "t-4",
            reason: "returns input on n = 0",
        });
        expect(
            one(`wake: task t-2 passed review with a note for later tasks: import add. ${status("t-2")}`)
        ).toMatchObject({
            kind: "review-note",
            taskId: "t-2",
            items: ["import add"],
        });
        expect(
            one(
                "wake: the engine is stuck: the tick holds the lock. It will not recover by itself: put it to the human"
            )
        ).toMatchObject({
            kind: "engine-stuck",
            reason: "the tick holds the lock",
        });
    });

    it("approvals turned autonomous and back", () => {
        expect(one("wake: approvals for this run are now autonomous and the human is away. rules").kind).toBe(
            "autonomous-on"
        );
        expect(one("wake: approvals for this run are back to Ask me: from your next decision").kind).toBe(
            "autonomous-off"
        );
    });

    it("an unknown wake falls back with its whole text", () => {
        expect(one("wake: something the engine says now")).toEqual({
            kind: "unknown",
            text: "wake: something the engine says now",
        });
    });

    it("a composed wake yields one part per line, its sections parts of their own", () => {
        const parts = wakeParts(
            [
                `wake: task t-5 never started: no worker process 5m after spawn. wsh jarvis dag retry t-5`,
                `wake: task t-3's worker exited without reporting complete. ${status("t-3")}`,
                "wake: 1 question waiting. wsh jarvis dag asks",
                "Unverified:",
                "t-1 test order",
                "Since your last wake:",
                "t-2 landed",
                "t-4 landed",
            ].join("\n")
        );
        expect(parts.map((p) => p.kind)).toEqual(["never-started", "worker-exited", "questions", "caveats", "quiet"]);
        expect(parts[3].items).toEqual(["t-1 test order"]);
        expect(parts[4].items).toHaveLength(2);
    });
});

const ev = (kind: string, ts: number, detail: object): RunEvent => ({
    id: `${kind}-${ts}`,
    runid: "r-1",
    channelid: "ch",
    ts,
    kind,
    detail: JSON.stringify(detail),
});
const LEAD: RunRole = { kind: "lead", runId: "r-1" };
const T = 1_000_000;

describe("wakeEvents", () => {
    it("a question wake names the asking task and its deadline from the child-ask event", () => {
        const part = one("wake: 1 question waiting. wsh jarvis dag asks");
        const got = wakeEvents(part, [ev("child-ask", T, { taskid: "t-4", question: "dots?" })], T + 6_000);
        expect(got.ask).toEqual({ taskId: "t-4", question: "dots?", deadlineMs: LEAD_ASK_DEADLINE_MS - 6_000 });
    });

    it("a run-finished wake carries a passed Final from its final-ended event, never a failed one", () => {
        const part = one("wake: run finished. wsh jarvis dag status");
        expect(wakeEvents(part, [ev("final-ended", T, { round: 1, outcome: "passed" })], T + 1).finalPassed).toEqual({
            round: 1,
        });
        expect(
            wakeEvents(part, [ev("final-ended", T, { round: 1, outcome: "failed" })], T + 1).finalPassed
        ).toBeUndefined();
        // an event after the wake is not what the wake was about
        expect(
            wakeEvents(part, [ev("final-ended", T + 5, { round: 1, outcome: "passed" })], T).finalPassed
        ).toBeUndefined();
    });
});

describe("waitedSummary", () => {
    const events = [
        ev("task-merged", T - 30 * 60_000, { taskid: "t-14" }),
        ev("task-merged", T - 20 * 60_000, { taskid: "t-15" }),
        ev("final-ended", T - 5 * 60_000, { round: 2, outcome: "failed" }),
        // before the gap
        ev("task-merged", T - 50 * 60_000, { taskid: "t-1" }),
    ];

    it("folds only at or above WAIT_FOLD_MIN_MS, in a lead's transcript", () => {
        expect(waitedSummary(LEAD, T, WAIT_FOLD_MIN_MS - 1, events)).toBeNull();
        expect(waitedSummary(LEAD, T, WAIT_FOLD_MIN_MS, events)).not.toBeNull();
        expect(waitedSummary({ kind: "worker", leadRunId: "r-1", taskId: "t-2" }, T, 38 * 60_000, events)).toBeNull();
        expect(waitedSummary(undefined, T, 38 * 60_000, events)).toBeNull();
    });

    it("summarises the run's events in the gap only", () => {
        const s = waitedSummary(LEAD, T, 38 * 60_000, events)!;
        expect(s).toMatchObject({ gapMs: 38 * 60_000, landed: 2, finalRuns: 1, failed: 0 });
        expect(s.events.map((e) => e.kind)).toEqual(["task-merged", "task-merged", "final-ended"]);
        expect(waitedSummary(LEAD, T, 2 * 60_000, events)!.events).toHaveLength(0);
    });

    it("a plan review that passed in the gap, with the tasks spawned after it", () => {
        const gap = [
            ev("plan-reviewed", T - 60_000, { state: "passed", round: 2 }),
            ev("task-spawned", T - 50_000, { taskid: "t-1" }),
            ev("task-spawned", T - 40_000, { taskid: "t-2" }),
        ];
        expect(planPassedInGap(LEAD, T, 120_000, gap)).toEqual({ round: 2, tasks: 2 });
        expect(
            planPassedInGap(LEAD, T, 120_000, [ev("plan-reviewed", T - 60_000, { state: "failed", round: 1 })])
        ).toBeNull();
    });
});

describe("briefView by role", () => {
    const run = {
        goal: "Goal: add modules\nmore",
        planSkill: "arc:plan",
        autonomous: true,
        tasks: [{ id: "t-2", label: "subtract module" }],
    };

    it("a lead's brief: the run's goal line, plan skill and autonomy; its own first line until the run loads", () => {
        expect(briefView(LEAD, "Lead the run", run)).toEqual({
            role: "lead",
            goal: "Goal: add modules",
            planSkill: "arc:plan",
            autonomous: true,
        });
        expect(briefView(LEAD, "\nLead the run\nmore")).toMatchObject({ goal: "Lead the run", autonomous: false });
    });

    it("a worker's brief: its task and the task's label", () => {
        expect(briefView({ kind: "worker", leadRunId: "r-1", taskId: "t-2" }, "x", run)).toEqual({
            role: "worker",
            taskId: "t-2",
            label: "subtract module",
        });
        expect(briefView({ kind: "worker", leadRunId: "r-1", taskId: "t-9" }, "x", run)).toEqual({
            role: "worker",
            taskId: "t-9",
        });
    });

    it("a stage agent's brief: its stage", () => {
        expect(briefView({ kind: "stage", leadRunId: "r-1", stageRole: "plan-reviewer" }, "x")).toEqual({
            role: "stage",
            stageRole: "plan-reviewer",
        });
    });
});

const brainstormFile = (over: Partial<BrainstormFile> = {}): BrainstormFile => ({
    v: 1,
    title: "Memory",
    spec: "docs/spec.md",
    question: null,
    working: null,
    parts: [
        { id: "approach", title: "Approach", state: "guess", body: "x" },
        { id: "scope", title: "Scope", state: "guess", body: "y" },
    ],
    history: [],
    done: false,
    check: null,
    run: null,
    ...over,
});

const user = (text: string): AgentEntry => ({ kind: "user", text });

describe("brainstorm lines", () => {
    // every pane action's line as the pane builds it, and the kind it reads back as
    const actions: [BrainstormAction, PaneActionKind][] = [
        [{ kind: "guess" }, "guess"],
        [{ kind: "skip" }, "skip"],
        [{ kind: "confirm-all" }, "confirm-all"],
        [{ kind: "keep-all" }, "keep-all"],
        [{ kind: "edit", part: "scope", text: "drop the cap" }, "edit"],
        [{ kind: "check" }, "check"],
        [{ kind: "builder-answer", text: "yes, say so" }, "builder-answer"],
        [{ kind: "builder-decide" }, "builder-decide"],
        [{ kind: "approved" }, "approved"],
        [{ kind: "keep-talking" }, "keep-talking"],
        [{ kind: "run", runId: "d508bb65" }, "run"],
    ];

    it.each(actions)("%o classifies as a pane action", (action, kind) => {
        const line = brainstormLine(action)!;
        expect(arcMessageOf(user(line), false)?.kind).toBe("brainstorm");
        const view = brainstormLineView(line);
        expect(view.kind).toBe("pane");
        expect(view.kind === "pane" && view.actions.map((a) => a.kind)).toEqual([kind]);
    });

    it("an edit carries its part, a run its id", () => {
        const edit = brainstormLineView(brainstormLine({ kind: "edit", part: "scope", text: "drop the cap" })!);
        expect(edit.kind === "pane" && edit.actions[0]).toMatchObject({ part: "scope", text: "drop the cap" });
        const run = brainstormLineView(brainstormLine({ kind: "run", runId: "d508bb65" })!);
        expect(run.kind === "pane" && run.actions[0].text).toBe("d508bb65");
    });

    it("a typed answer is plain text, so it stays the human's bubble", () => {
        const line = brainstormLine({ kind: "answer", text: "One Final at a time" })!;
        expect(arcMessageOf(user(line), false)).toBeNull();
    });

    it("settle has no line of its own; the picks' settle line classifies with its count", () => {
        expect(brainstormLine({ kind: "settle" })).toBeNull();
        const line = settleLine(brainstormFile(), { approach: "confirm", scope: "confirm" })!;
        const view = brainstormLineView(line);
        expect(view.kind === "pane" && view.actions[0]).toMatchObject({ kind: "settle", count: 2 });
    });

    it("a line sent with picks waiting reads as both", () => {
        const line = `${settleLine(brainstormFile(), { approach: "confirm" })}; then: ${brainstormLine({ kind: "check" })}`;
        const view = brainstormLineView(line);
        expect(view.kind === "pane" && view.actions.map((a) => [a.kind, a.count])).toEqual([
            ["settle", 1],
            ["check", undefined],
        ]);
    });

    it("the judge's and the builder check's lines", () => {
        expect(brainstormLineView("brainstorm: judged C:/p/.superpowers/brainstorm/mem/judge.json")).toEqual({
            kind: "judged",
            path: "C:/p/.superpowers/brainstorm/mem/judge.json",
        });
        expect(brainstormLineView("brainstorm: judge failed: the judge ended without its result.")).toEqual({
            kind: "judge-failed",
            reason: "the judge ended without its result.",
        });
        expect(brainstormLineView("brainstorm: builder questions C:/p/builder-check.md")).toEqual({
            kind: "builder",
            path: "C:/p/builder-check.md",
        });
        expect(brainstormLineView("brainstorm: something new").kind).toBe("unknown");
    });

    it("the judge's record: the pick, the kept options and the dropped ones with reasons", () => {
        const f = brainstormFile({
            question: {
                n: 3,
                text: "How?",
                part: "approach",
                options: [
                    { label: "One Final at a time", detail: "one queue", pick: true },
                    { label: "Memory gate", detail: "second" },
                ],
                judge: { kind: "weighed", added: [], dropped: [{ name: "Sonnet workers", reason: "quality" }] },
            },
        });
        expect(judgeResultOf(f)).toEqual({
            n: 3,
            pick: "One Final at a time",
            kept: [
                { name: "One Final at a time", detail: "one queue", pick: true },
                { name: "Memory gate", detail: "second", pick: false },
            ],
            dropped: [{ name: "Sonnet workers", reason: "quality" }],
        });
        // answered: the history entry keeps the record and the pick
        const answered = brainstormFile({
            history: [
                {
                    kind: "question",
                    n: 2,
                    q: "Which?",
                    a: "B",
                    into: [],
                    options: [
                        { label: "A", detail: "" },
                        { label: "B", detail: "" },
                    ],
                    picked: 1,
                    judge: { kind: "weighed", added: [], dropped: [] },
                },
            ],
        });
        expect(judgeResultOf(answered)).toMatchObject({ n: 2, pick: "B" });
        expect(judgeResultOf(brainstormFile())).toBeNull();
    });

    it("the builder check's counts", () => {
        const f = brainstormFile({
            check: { yours: [{ q: "banner?" }], calls: [{ text: "minor" }], answered: ["a", "b"] },
        });
        expect(builderCountsOf(f)).toEqual({ answered: 2, calls: 1, yours: 1, total: 4 });
        expect(builderCountsOf(brainstormFile())).toBeNull();
    });
});
