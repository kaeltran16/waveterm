// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { taskStripLabel } from "@/app/view/agents/runstrip";
import { describe, expect, it } from "vitest";
import type { DigestState } from "../orchestrate/dagdigest";
import type { TaskWorkerView } from "../orchestrate/taskcorrelate";
import type { LinkedGroupRead, RunSettingsDraft } from "./runsettings";
import {
    autonomousResolvedNote,
    configLine,
    configNote,
    doneBody,
    doneBodyHasDiff,
    finalStageEndable,
    finalStageRerunnable,
    launcherReading,
    orderedTasks,
    runGraphRef,
    sheetLead,
    sheetStatus,
    taskRow,
    taskSectionMeta,
    type SheetRead,
    type SheetRowInput,
} from "./runsheetmodel";

const NOW = 10_000_000;
const MIN = 60_000;

function run(over: Partial<Run> = {}): Run {
    return {
        oid: "r1",
        version: 1,
        id: "3457abcd",
        goal: "fix every finding",
        runtime: "pi",
        model: "deepseek-v4-flash",
        mode: "orchestrator",
        orchestration: "engine",
        status: "executing",
        phases: [],
        workspaceid: "ws",
        projectpath: "/repo",
        createdts: NOW - 18 * MIN,
        dagoref: "d1",
        meta: {},
        ...over,
    } as Run;
}

function group(states: string[], over: Partial<TaskGroup> = {}): TaskGroup {
    return {
        oid: "d1",
        version: 3,
        id: "d1",
        runid: "3457abcd",
        channelid: "c1",
        parallelism: 2,
        tasks: states.map((state, i) => ({ id: `t-${i + 1}`, label: `task ${i + 1}`, state })),
        status: "running",
        failures: 0,
        createdts: 1,
        updatedts: 1,
        ...over,
    } as TaskGroup;
}

function digest(over: Partial<DagStatusDigest> = {}, counts: Partial<DagStatusCounts> = {}): DagStatusDigest {
    return {
        dagversion: 3,
        health: "healthy",
        counts: {
            total: 4,
            done: 2,
            running: 2,
            stalled: 0,
            dependencywaiting: 1,
            attention: 0,
            recoveredretry: 0,
            mergeready: 0,
            ...counts,
        },
        next: { kind: "parallelism-wait", blockingtaskids: ["t-1", "t-2"] },
        tasks: [],
        durations: { elapsedms: 18 * MIN },
        report: { workerms: 31 * MIN, answered: 0, forwarded: 0 },
        shape: { tasks: 4, lanes: 4, longestchain: 1 },
        ...over,
    };
}

function fresh(d: DagStatusDigest, over: Partial<DigestState> = {}): DigestState {
    return { digest: d, loading: false, stale: false, lastUpdatedTs: NOW - 3_000, ...over };
}

function read(over: Partial<SheetRead> = {}): SheetRead {
    return {
        run: run(),
        nowMs: NOW,
        dag: {
            digest: fresh(digest()),
            group: group(["running", "running", "done", "done"]),
            groupRead: "ready",
        },
        userAsks: [],
        workerAsking: false,
        survivors: 0,
        ...over,
    };
}

function ask(over: Partial<DagAskItem> = {}): DagAskItem {
    return {
        taskid: "t-1",
        askid: "a1",
        owner: "user",
        questions: [],
        blockoref: "block:x",
        ts: NOW - 40_000,
        ...over,
    };
}

describe("runGraphRef", () => {
    it("reads the graph only from the orchestrator that owns it", () => {
        expect(runGraphRef(run())).toBe("d1");
        expect(runGraphRef(run({ dagoref: "" }))).toBeNull();
        // a task's worker run carries its parent's dagoref
        expect(runGraphRef(run({ mode: "quick" }))).toBeNull();
    });
});

describe("sheetStatus", () => {
    it("reads a healthy run as executing, with the meter and next line from the same read", () => {
        const s = sheetStatus(read());
        expect(s.verb).toBe("Executing");
        expect(s.sub).toBe("2 of 4 tasks done, 2 workers live");
        expect(s.meter).toEqual({ kind: "strip" });
        expect(s.next).toBe("waiting for a slot — task 1, task 2 still running");
        expect(s.meta.map((m) => m.text)).toEqual(["18m elapsed", "workers 31m", "updated 3s ago"]);
    });

    // the contradiction that started the redesign: every task finished, the run not yet
    it("says Landing when the graph is done and the run is still executing", () => {
        const s = sheetStatus(
            read({
                dag: {
                    digest: fresh(
                        digest(
                            { health: "done", next: { kind: "terminal", terminalstatus: "done" } },
                            { done: 4, running: 0 }
                        )
                    ),
                    group: group(["done", "done", "done", "done"], { status: "done" }),
                    groupRead: "ready",
                },
            })
        );
        expect(s.verb).toBe("Landing");
        expect(s.meter).toEqual({ kind: "strip" });
        expect(s.next).not.toMatch(/finished/);
    });

    it("counts a skipped task as finished, so Landing never sits over a strip one short", () => {
        const g = group(["done", "skipped", "done", "done"], { status: "done" });
        const s = sheetStatus(
            read({
                dag: {
                    digest: fresh(
                        digest({ next: { kind: "terminal", terminalstatus: "done" } }, { done: 3, running: 0 })
                    ),
                    group: g,
                    groupRead: "ready",
                },
            })
        );
        expect(s.verb).toBe("Landing");
        expect(s.meter).toEqual({ kind: "strip" });
        expect(taskStripLabel(g, undefined)).toBe("4 of 4 tasks done");
    });

    it("draws the strip for a finished or cancelled run with a graph, and no bar without one", () => {
        const dag = { digest: fresh(digest()), group: group(["done", "cancelled"]), groupRead: "ready" as const };
        expect(sheetStatus(read({ run: run({ status: "done" }), dag })).meter).toEqual({ kind: "strip" });
        expect(sheetStatus(read({ run: run({ status: "cancelled" }), dag })).meter).toEqual({ kind: "strip" });
        expect(sheetStatus(read({ run: run({ status: "cancelled" }), dag: null })).meter).toBeNull();
    });

    it("waits on you for a question that is yours, naming the task that asked", () => {
        const s = sheetStatus(read({ userAsks: [ask()] }));
        expect(s.verb).toBe("Waiting on you");
        expect(s.sub).toBe("task 1's worker asked a question 40s ago");
        expect(s.tone).toBe("warning");
    });

    // a lead-held question never reaches userAsks; the digest's lead-action next line is what reports it
    it("does not wait on you while the lead holds the question", () => {
        const s = sheetStatus(
            read({
                dag: {
                    digest: fresh(digest({ next: { kind: "lead-action", taskids: ["t-1"], actions: ["answer"] } })),
                    group: group(["running", "running", "done", "done"]),
                    groupRead: "ready",
                },
            })
        );
        expect(s.verb).toBe("Executing");
        expect(s.next).toMatch(/waiting on the lead/);
    });

    it("keeps executing while other work runs, and names how many tasks need you", () => {
        const s = sheetStatus(
            read({
                dag: {
                    digest: fresh(
                        digest(
                            {
                                health: "needs-you",
                                next: { kind: "human-action", taskids: ["t-1", "t-2"], actions: ["retry", "skip"] },
                            },
                            { attention: 2, mergeready: 1, running: 1 }
                        )
                    ),
                    group: group(["stalled", "blocked-merge", "done", "running"]),
                    groupRead: "ready",
                },
            })
        );
        expect(s.verb).toBe("Executing");
        expect(s.sub).toBe("1 of 4 done · 2 tasks need you");
        expect(s.meta.map((m) => m.text)).toContain("attention 2");
        expect(s.meta.map((m) => m.text)).toContain("merge 1");
    });

    it("waits on you when a decision is all that is left", () => {
        const s = sheetStatus(
            read({
                dag: {
                    digest: fresh(
                        digest({ next: { kind: "human-action", taskids: ["t-1"] } }, { attention: 1, running: 0 })
                    ),
                    group: group(["failed", "done", "done", "done"]),
                    groupRead: "ready",
                },
            })
        );
        expect(s.verb).toBe("Waiting on you");
        expect(s.sub).toBe("1 task needs you; nothing else is running");
    });

    it("says cleanup failed, not waiting on you, when only worktrees are left", () => {
        const s = sheetStatus(
            read({
                dag: {
                    digest: fresh(
                        digest(
                            {
                                health: "needs-you",
                                next: { kind: "human-action", taskids: ["t-2"], actions: ["retry-cleanup"] },
                                tasks: [{ taskid: "t-2", humanactions: ["retry-cleanup"] } as DagTaskDigest],
                            },
                            { attention: 1, running: 0 }
                        )
                    ),
                    group: group(["done", "done", "done", "done"]),
                    groupRead: "ready",
                },
            })
        );
        expect(s.verb).toBe("Cleanup failed");
        expect(s.sub).toBe("1 worktree could not be removed");
    });

    it("says the read failed, dates the held figures, and offers the retry", () => {
        const s = sheetStatus(
            read({
                dag: {
                    digest: fresh(digest(), { stale: true, error: "boom", lastUpdatedTs: NOW - 2 * MIN }),
                    group: group(["done", "done", "done", "running"]),
                    groupRead: "ready",
                },
            })
        );
        expect(s.verb).toBe("Status is stale");
        expect(s.sub).toBe("the last status read failed; these figures are 2m old");
        // the digest's own count, not the live group's three, and no per-task colours: the figures are old
        expect(s.meter).toEqual({ kind: "stale", done: 2, total: 4 });
        expect(s.retry).toBe(true);
        expect(s.next).toMatch(/^unknown/);
    });

    it("says refreshing rather than a fresh update while the next digest loads", () => {
        const s = sheetStatus(
            read({
                dag: {
                    digest: fresh(digest(), { stale: true, loading: true }),
                    group: group(["running"]),
                    groupRead: "ready",
                },
            })
        );
        expect(s.verb).toBe("Executing");
        expect(s.meta.map((m) => m.text)).toContain("refreshing");
    });

    it("refuses to guess when the task graph cannot be read", () => {
        for (const groupRead of ["error", "missing"] as const) {
            const s = sheetStatus(read({ dag: { digest: { loading: false, stale: false }, group: null, groupRead } }));
            expect(s.sub).toBe("the run is live, but its task graph could not be read");
            expect(s.meter).toBeNull();
            expect(s.retry).toBe(false);
        }
        const failedDigest = sheetStatus(
            read({
                dag: {
                    digest: { loading: false, stale: false, error: "boom" },
                    group: group(["running"]),
                    groupRead: "ready",
                },
            })
        );
        expect(failedDigest.meta.map((m) => m.text)).toContain("dag unavailable");
        expect(failedDigest.retry).toBe(true);
    });

    it("reads the graph without claiming health while the first digest loads", () => {
        const s = sheetStatus(
            read({ dag: { digest: { loading: true, stale: false }, group: null, groupRead: "loading" } })
        );
        expect(s.sub).toBe("reading the task graph…");
        expect(s.meter).toBeNull();
        expect(s.next).toBeNull();
    });

    it("plans until the lead submits, and names the lead when it asks", () => {
        const planning = sheetStatus(read({ run: run({ status: "planning", dagoref: "" }), dag: null }));
        expect(planning.verb).toBe("Planning");
        expect(planning.meta.map((m) => m.text)).toEqual(["18m elapsed", "no plan yet"]);
        const asking = sheetStatus(
            read({ run: run({ status: "planning", dagoref: "" }), dag: null, workerAsking: true })
        );
        expect(asking.verb).toBe("Waiting on you");
        expect(asking.sub).toBe("the lead asked you a question");
    });

    it("reads a quick run as one worker with no next line", () => {
        const s = sheetStatus(read({ run: run({ mode: "quick", dagoref: "", createdts: NOW - 6 * MIN }), dag: null }));
        expect(s.verb).toBe("Executing");
        expect(s.sub).toBe("one worker, no plan");
        expect(s.next).toBeNull();
        expect(s.meta.map((m) => m.text)).toEqual(["6m elapsed", "1 worker"]);
    });

    it("says what a done run delivered", () => {
        const s = sheetStatus(
            read({
                run: run({
                    status: "done",
                    completedts: NOW - 11 * MIN,
                    evidence: { durationms: 39 * MIN } as RunEvidence,
                }),
                dag: {
                    digest: fresh(
                        digest({
                            report: {
                                workerms: 77 * MIN,
                                commits: [
                                    { taskid: "t-1", commit: "a91c4f2" },
                                    { taskid: "t-2", commit: "7d0b18e" },
                                ],
                                answered: 0,
                                forwarded: 0,
                            },
                        })
                    ),
                    group: group(["done", "done", "done", "done"], { status: "done" }),
                    groupRead: "ready",
                },
            })
        );
        expect(s.verb).toBe("Done");
        expect(s.sub).toBe("4 tasks, 2 commits landed, 39m");
        expect(s.pulse).toBe(false);
        expect(s.meta.map((m) => m.text)).toEqual(["finished 11m ago", "workers 1h17m", "evidence sealed"]);
    });

    it("counts a cancelled run's survivors in the subtitle, so the count and the card cannot drift", () => {
        const s = sheetStatus(read({ run: run({ status: "cancelled", completedts: NOW - 30_000 }), survivors: 2 }));
        expect(s.verb).toBe("Cancelled");
        expect(s.sub).toBe("2 workers still running");
        expect(s.meta.map((m) => m.text)).toEqual(["cancelled 30s ago", "2 survivors"]);
        const clean = sheetStatus(read({ run: run({ status: "cancelled" }) }));
        expect(clean.sub).toBe("stopped after 2 of 4 tasks");
    });
});

describe("doneStatus", () => {
    const sealing = { text: "sealing evidence", tone: "muted" as const };

    it("says only that the run finished when it has no graph, no clock and no evidence", () => {
        expect(sheetStatus(read({ run: run({ status: "done" }), dag: null }))).toEqual({
            verb: "Done",
            sub: "the run finished",
            tone: "success",
            pulse: false,
            meter: null,
            meta: [sealing],
            next: null,
            retry: false,
        });
    });

    it("counts a graphless run's wall time from its evidence and seals it", () => {
        const s = sheetStatus(
            read({ run: run({ status: "done", evidence: { durationms: 39 * MIN } as RunEvidence }), dag: null })
        );
        expect(s.sub).toBe("39m");
        expect(s.meta).toEqual([{ text: "evidence sealed", tone: "success" }]);
    });

    it("draws the strip and falls back to launch-to-finish time when there is no evidence", () => {
        const s = sheetStatus(read({ run: run({ status: "done", completedts: NOW - 11 * MIN }) }));
        expect(s).toEqual({
            verb: "Done",
            sub: "4 tasks, 0 commits landed, 7m",
            tone: "success",
            pulse: false,
            meter: { kind: "strip" },
            meta: [{ text: "finished 11m ago", tone: "muted" }, { text: "workers 31m", tone: "muted" }, sealing],
            next: null,
            retry: false,
        });
    });

    it("leaves out the workers chip when the report holds no worker time", () => {
        const dag = {
            digest: fresh(digest({ report: { workerms: 0, answered: 0, forwarded: 0 } })),
            group: group(["done"]),
            groupRead: "ready" as const,
        };
        expect(sheetStatus(read({ run: run({ status: "done" }), dag })).meta).toEqual([sealing]);
    });
});

describe("cancelledStatus", () => {
    it("says it stopped before finishing, with no meta, when the run has no graph and no clock", () => {
        expect(sheetStatus(read({ run: run({ status: "cancelled" }), dag: null }))).toEqual({
            verb: "Cancelled",
            sub: "stopped before it finished",
            tone: "error",
            pulse: false,
            meter: null,
            meta: [],
            next: null,
            retry: false,
        });
    });

    it("names when a run with a graph was cancelled, and that the scheduler stopped", () => {
        expect(sheetStatus(read({ run: run({ status: "cancelled", completedts: NOW - 30_000 }) }))).toEqual({
            verb: "Cancelled",
            sub: "stopped after 2 of 4 tasks",
            tone: "error",
            pulse: false,
            meter: { kind: "strip" },
            meta: [{ text: "cancelled 30s ago", tone: "error" }],
            next: "nothing — the scheduler stopped dispatching",
            retry: false,
        });
    });
});

describe("undaggedStatus", () => {
    const muted = (text: string) => ({ text, tone: "muted" as const });
    const quiet = { meter: null, retry: false };
    const lead = (over: Partial<SheetRead> = {}) =>
        sheetStatus(read({ run: run({ status: "planning", dagoref: "" }), dag: null, ...over }));
    const quick = (over: Partial<SheetRead> = {}, status = "executing") =>
        sheetStatus(
            read({ run: run({ mode: "quick", dagoref: "", status, createdts: NOW - 6 * MIN }), dag: null, ...over })
        );

    it("pulses while an orchestrator's lead waits on the human", () => {
        expect(lead({ workerAsking: true })).toEqual({
            ...quiet,
            verb: "Waiting on you",
            sub: "the lead asked you a question",
            tone: "warning",
            pulse: true,
            meta: [muted("18m elapsed"), muted("no plan yet")],
            next: "the lead continues once you answer",
        });
    });

    it("pulses while an orchestrator's lead writes the plan", () => {
        expect(lead()).toEqual({
            ...quiet,
            verb: "Planning",
            sub: "the lead is writing the plan",
            tone: "muted",
            pulse: true,
            meta: [muted("18m elapsed"), muted("no plan yet")],
            next: "the engine dispatches the plan once the lead submits it",
        });
    });

    it("waits on the human for a quick run's worker, whatever stage the run is at", () => {
        for (const status of ["executing", "planning"]) {
            expect(quick({ workerAsking: true }, status)).toEqual({
                ...quiet,
                verb: "Waiting on you",
                sub: "the worker asked you a question",
                tone: "warning",
                pulse: true,
                meta: [muted("6m elapsed"), muted("1 worker")],
                next: null,
            });
        }
    });

    it("says a quick run's worker is starting while the run is planning", () => {
        expect(quick({}, "planning")).toEqual({
            ...quiet,
            verb: "Starting",
            sub: "the worker is starting",
            tone: "muted",
            pulse: true,
            meta: [muted("6m elapsed"), muted("1 worker")],
            next: null,
        });
    });

    it("pulses while a quick run's one worker executes", () => {
        expect(quick()).toEqual({
            ...quiet,
            verb: "Executing",
            sub: "one worker, no plan",
            tone: "success",
            pulse: true,
            meta: [muted("6m elapsed"), muted("1 worker")],
            next: null,
        });
    });
});

describe("daggedStatus", () => {
    const strip = { kind: "strip" } as const;
    const muted = (text: string) => ({ text, tone: "muted" as const });
    const warn = (text: string) => ({ text, tone: "warning" as const });
    const dag = (state: DigestState, g: TaskGroup | null, groupRead: LinkedGroupRead = "ready") => ({
        digest: state,
        group: g,
        groupRead,
    });
    const GRAPH = ["running", "running", "done", "done"];
    const live = (over: Partial<DagStatusDigest> = {}, counts: Partial<DagStatusCounts> = {}) =>
        dag(fresh(digest(over, counts)), group(GRAPH));
    // the chips every healthy read carries from the default digest
    const BASE_META = [muted("18m elapsed"), muted("workers 31m"), muted("updated 3s ago")];

    it("reads the task graph, on the run's own clock, until the first digest arrives", () => {
        const s = sheetStatus(read({ dag: dag({ loading: true, stale: false }, null, "loading") }));
        expect(s).toEqual({
            verb: "Executing",
            sub: "reading the task graph…",
            tone: "muted",
            pulse: true,
            meter: null,
            meta: [muted("18m elapsed")],
            next: null,
            retry: false,
        });
    });

    it("keeps reading the graph while a ready group's first digest loads", () => {
        const s = sheetStatus(read({ dag: dag({ loading: true, stale: false }, group(GRAPH)) }));
        expect(s.sub).toBe("reading the task graph…");
        expect(s.pulse).toBe(true);
        expect(s.retry).toBe(false);
    });

    it.each<[string, DigestState, TaskGroup | null, LinkedGroupRead, boolean]>([
        ["a group read that failed", { loading: false, stale: false }, null, "error", false],
        ["a group that is missing", { loading: false, stale: false }, null, "missing", false],
        ["a failed group read beside a held group and digest", fresh(digest()), group(GRAPH), "error", false],
        ["a failed group read while its digest loads", { loading: true, stale: false }, null, "error", false],
        [
            "a failed group read with a group held while its digest loads",
            { loading: true, stale: false },
            group(GRAPH),
            "error",
            false,
        ],
        ["a ready read with no group", fresh(digest()), null, "ready", false],
        ["a digest read that failed", { loading: false, stale: false, error: "boom" }, group(GRAPH), "ready", true],
    ])("refuses to guess for %s", (_name, state, g, groupRead, retry) => {
        const s = sheetStatus(read({ dag: dag(state, g, groupRead) }));
        expect(s).toEqual({
            verb: "Executing",
            sub: "the run is live, but its task graph could not be read",
            tone: "error",
            pulse: false,
            meter: null,
            meta: [muted("18m elapsed"), { text: "dag unavailable", tone: "error" }],
            next: "unknown",
            retry,
        });
    });

    it("reads elapsed time off the digest's own clock before the run's launch time", () => {
        const s = sheetStatus(read({ run: run({ createdts: NOW - 5 * MIN }), dag: live() }));
        expect(s.meta[0]).toEqual(muted("18m elapsed"));
    });

    it("falls back to the run's launch time when the digest carries no clock", () => {
        const g = group(GRAPH);
        for (const durations of [undefined, { elapsedms: 0 }]) {
            const s = sheetStatus(
                read({ run: run({ createdts: NOW - 5 * MIN }), dag: dag(fresh(digest({ durations })), g) })
            );
            expect(s.meta[0]).toEqual(muted("5m elapsed"));
        }
    });

    it("dates a failed refresh by the last good read and never presents it as current", () => {
        const s = sheetStatus(
            read({
                dag: dag(
                    fresh(digest(), { stale: true, error: "boom", lastUpdatedTs: NOW - 2 * MIN }),
                    group(["done", "done", "done", "running"])
                ),
            })
        );
        expect(s).toEqual({
            verb: "Status is stale",
            sub: "the last status read failed; these figures are 2m old",
            tone: "muted",
            pulse: false,
            meter: { kind: "stale", done: 2, total: 4 },
            meta: [warn("as of 2m ago"), warn("refresh failed")],
            next: "unknown — the engine's next move could not be read",
            retry: true,
        });
    });

    it("says the read failed without a date when no digest was ever confirmed current", () => {
        const s = sheetStatus(
            read({
                dag: dag(fresh(digest(), { stale: true, error: "boom", lastUpdatedTs: undefined }), group(GRAPH)),
            })
        );
        expect(s.verb).toBe("Status is stale");
        expect(s.sub).toBe("the last status read failed");
        expect(s.meta).toEqual([warn("refresh failed")]);
    });

    it("is stale only when a refresh both left the digest stale and failed, and none is in flight", () => {
        const verdict = (over: Partial<DigestState>) =>
            sheetStatus(read({ dag: dag(fresh(digest(), over), group(GRAPH)) }));
        expect(verdict({ error: "boom" }).verb).toBe("Executing");
        const staleOnly = verdict({ stale: true });
        expect(staleOnly.verb).toBe("Executing");
        expect(staleOnly.meta).toContainEqual(muted("refreshing"));
        expect(verdict({ stale: true, error: "boom", loading: true }).verb).toBe("Executing");
    });

    it("lists every report figure as a chip, with only an unverified run in warning", () => {
        const s = sheetStatus(
            read({
                dag: live(
                    {
                        report: {
                            workerms: 31 * MIN,
                            commits: [{ taskid: "t-1", commit: "a91c4f2" }],
                            answered: 2,
                            forwarded: 1,
                            unverified: true,
                        },
                    },
                    { attention: 1, mergeready: 3 }
                ),
            })
        );
        expect(s.meta).toEqual([
            muted("18m elapsed"),
            muted("workers 31m"),
            muted("landed 1"),
            muted("answered 2"),
            muted("forwarded 1"),
            warn("unverified"),
            warn("attention 1"),
            warn("merge 3"),
            muted("updated 3s ago"),
        ]);
    });

    it("leaves out the updated chip when no digest was ever confirmed current", () => {
        const s = sheetStatus(read({ dag: dag(fresh(digest(), { lastUpdatedTs: undefined }), group(GRAPH)) }));
        expect(s.meta).toEqual([muted("18m elapsed"), muted("workers 31m")]);
    });

    it("waits on you, pulsing, with the meter and the digest's next line, for a question that is yours", () => {
        const s = sheetStatus(read({ userAsks: [ask()] }));
        expect(s).toEqual({
            verb: "Waiting on you",
            sub: "task 1's worker asked a question 40s ago",
            tone: "warning",
            pulse: true,
            meter: strip,
            meta: BASE_META,
            next: "waiting for a slot — task 1, task 2 still running",
            retry: false,
        });
    });

    it("says the lead asked when the run's own worker is the one asking", () => {
        const s = sheetStatus(read({ workerAsking: true }));
        expect(s.verb).toBe("Waiting on you");
        expect(s.sub).toBe("the lead asked you a question");
        expect(s.pulse).toBe(true);
        expect(s.retry).toBe(false);
    });

    it("lands, pulsing and with nothing to retry, once the graph is done", () => {
        const s = sheetStatus(
            read({
                dag: dag(
                    fresh(
                        digest(
                            { health: "done", next: { kind: "terminal", terminalstatus: "done" } },
                            { done: 4, running: 0 }
                        )
                    ),
                    group(["done", "done", "done", "done"], { status: "done" })
                ),
            })
        );
        expect(s).toEqual({
            verb: "Landing",
            sub: "all 4 tasks done, nothing left to dispatch",
            tone: "warning",
            pulse: true,
            meter: strip,
            meta: BASE_META,
            next: "nothing to dispatch — the lead is finishing the run",
            retry: false,
        });
    });

    it("does not land for a terminal graph that did not finish done", () => {
        const s = sheetStatus(read({ dag: live({ next: { kind: "terminal", terminalstatus: "failed" } }) }));
        expect(s.verb).toBe("Executing");
        expect(s.next).toBe("finished (failed)");
    });

    it("does not land for a next step that is not terminal", () => {
        const s = sheetStatus(read({ dag: live({ next: { kind: "dispatch", terminalstatus: "done" } }) }));
        expect(s.verb).toBe("Executing");
        expect(s.next).toBe("dispatching next task");
    });

    it("counts only the tasks whose worktree is waiting on cleanup", () => {
        const s = sheetStatus(
            read({
                dag: dag(
                    fresh(
                        digest(
                            {
                                health: "needs-you",
                                next: { kind: "human-action", taskids: ["t-2", "t-3"], actions: ["retry-cleanup"] },
                                tasks: [
                                    { taskid: "t-1" } as DagTaskDigest,
                                    { taskid: "t-2", humanactions: ["retry-cleanup"] } as DagTaskDigest,
                                    { taskid: "t-3", humanactions: ["retry-cleanup"] } as DagTaskDigest,
                                ],
                            },
                            { attention: 2, running: 0 }
                        )
                    ),
                    group(["done", "done", "done", "done"])
                ),
            })
        );
        expect(s).toEqual({
            verb: "Cleanup failed",
            sub: "2 worktrees could not be removed",
            tone: "warning",
            pulse: false,
            meter: strip,
            meta: [muted("18m elapsed"), muted("workers 31m"), warn("attention 2"), muted("updated 3s ago")],
            next: "worktrees not removed: task 2, task 3 — wsh jarvis dag retry-cleanup",
            retry: false,
        });
    });

    describe("when a decision is waiting on the human", () => {
        const needing = (counts: Partial<DagStatusCounts>, taskids: string[]) =>
            sheetStatus(
                read({
                    dag: dag(
                        fresh(
                            digest(
                                { health: "needs-you", next: { kind: "human-action", taskids, actions: ["retry"] } },
                                counts
                            )
                        ),
                        group(["stalled", "failed", "done", "running"])
                    ),
                })
            );

        it("keeps executing while other work runs, pulsing, with nothing to retry", () => {
            expect(needing({ attention: 0, running: 1 }, ["t-1", "t-2"])).toEqual({
                verb: "Executing",
                sub: "1 of 4 done · 2 tasks need you",
                tone: "warning",
                pulse: true,
                meter: strip,
                meta: BASE_META,
                next: "waiting on you — retry: task 1, task 2",
                retry: false,
            });
        });

        it("waits on you when nothing else is running", () => {
            expect(needing({ attention: 1, running: 0 }, ["t-1"])).toEqual({
                verb: "Waiting on you",
                sub: "1 task needs you; nothing else is running",
                tone: "warning",
                pulse: true,
                meter: strip,
                meta: [...BASE_META.slice(0, 2), warn("attention 1"), BASE_META[2]],
                next: "waiting on you — retry: task 1",
                retry: false,
            });
        });

        it("counts the tasks that need you from the attention count, else from the next step's ids", () => {
            expect(needing({ attention: 3, running: 1 }, ["t-1"]).sub).toBe("1 of 4 done · 3 tasks need you");
            expect(needing({ attention: 0, running: 1 }, ["t-1", "t-2"]).sub).toBe("1 of 4 done · 2 tasks need you");
        });
    });

    it("executes, pulsing and with nothing to retry, and names the workers live only while some are", () => {
        const idle = sheetStatus(
            read({
                dag: dag(
                    fresh(digest({ next: { kind: "dispatch", taskids: ["t-3"] } }, { running: 0 })),
                    group(["done", "done", "pending", "pending"])
                ),
            })
        );
        expect(idle).toEqual({
            verb: "Executing",
            sub: "2 of 4 tasks done",
            tone: "success",
            pulse: true,
            meter: strip,
            meta: BASE_META,
            next: "dispatching task 3",
            retry: false,
        });
        const busy = sheetStatus(
            read({
                dag: dag(
                    fresh(digest({ next: { kind: "dispatch", taskids: ["t-3"] } }, { running: 1 })),
                    group(["done", "done", "running", "pending"])
                ),
            })
        );
        expect(busy.sub).toBe("2 of 4 tasks done, 1 worker live");
    });
});

describe("orderedTasks", () => {
    it("lifts exceptions above running work and keeps graph order within a bucket", () => {
        const g = group(["done", "running", "stalled", "pending", "running"]);
        const d = digest({ tasks: [{ taskid: "t-4", waitreason: "ask", mergestate: "", cleanupstate: "" }] });
        expect(orderedTasks(g, d).map((r) => r.task.id)).toEqual(["t-3", "t-4", "t-2", "t-5", "t-1"]);
    });
});

describe("launcherReading", () => {
    it("says nothing is running only when no run in the project is live", () => {
        expect(launcherReading([], NOW)).toEqual({ verb: "Nothing running", sub: "no run in this project yet" });
        expect(launcherReading([run({ status: "done", completedts: NOW - 120 * MIN })], NOW).sub).toBe(
            "last run ended 2h0m ago"
        );
        expect(launcherReading([run({ status: "done", completedts: NOW - MIN }), run()], NOW)).toEqual({
            verb: "New run",
            sub: "1 run still live in this project",
        });
    });
});

describe("taskSectionMeta", () => {
    it("prints the plan's shape, or why there is none", () => {
        expect(taskSectionMeta(run(), digest())).toBe("4 tasks · 4 lanes · longest chain 1");
        expect(taskSectionMeta(run({ dagoref: "" }), undefined)).toBe("not decided yet");
        expect(taskSectionMeta(run({ mode: "quick" }), undefined)).toBe("none — a quick run has no graph");
    });
});

function rowInput(task: Partial<TaskNode>, over: Partial<SheetRowInput> = {}): SheetRowInput {
    return {
        task: { id: "t-1", label: "fix the store layer", state: "running", ...task } as TaskNode,
        td: undefined,
        worker: { state: "pending" },
        briefs: new Map([
            ["t-1", { label: "fix the store layer", state: "running" }],
            ["t-2", { label: "fix the backend", state: "running" }],
        ]),
        lanes: [["t-1"], ["t-2"], ["t-3"]],
        durations: undefined,
        recovery: null,
        askOwner: null,
        nowMs: NOW,
        asOf: null,
        ...over,
    };
}

const dispatched = (activity: string): TaskWorkerView => ({
    state: "dispatched",
    tabId: "tab1",
    runId: "8a41ffff",
    agent: { id: "tab1", name: "w", task: "", state: "working", activity } as TaskWorkerView["agent"],
});

describe("taskRow", () => {
    it("spends a live row's second line on what the worker is doing now", () => {
        const r = taskRow(rowInput({ runid: "8a41ffff" }, { worker: dispatched("editing briefsheet.tsx") }));
        expect(r).toMatchObject({
            meta: "editing briefsheet.tsx",
            state: "running",
            stateTone: "success",
            action: "open-agent",
        });
    });

    // was two lines above the task ("Worker session unavailable", "Activity unavailable")
    it("puts a gone session in the state column and keeps the action that still works", () => {
        const r = taskRow(rowInput({ runid: "8a41ffff" }, { worker: { state: "unavailable", runId: "8a41ffff" } }));
        expect(r).toMatchObject({
            meta: "child run 8a41 · session closed, work continues",
            state: "no session",
            action: "open-child-run",
        });
    });

    it("prints a done task's lane, time and child run", () => {
        const r = taskRow(
            rowInput(
                { id: "t-3", state: "done", runid: "8a43ffff" },
                { worker: { state: "unavailable", runId: "8a43ffff" }, durations: [{ taskid: "t-3", runms: 14 * MIN }] }
            )
        );
        expect(r).toMatchObject({ meta: "lane 3 · 14m · child run 8a43", state: "done", action: "open-child-run" });
    });

    it("names what a queued task waits on", () => {
        const r = taskRow(
            rowInput(
                { id: "t-4", state: "pending" },
                {
                    td: {
                        taskid: "t-4",
                        waitreason: "dependency",
                        blockingtaskids: ["t-1", "t-2"],
                        mergestate: "",
                        cleanupstate: "",
                    },
                }
            )
        );
        expect(r).toMatchObject({
            meta: "waiting on fix the store layer, fix the backend",
            state: "queued",
            action: null,
        });
    });

    it("says who holds a task's question", () => {
        const td: DagTaskDigest = {
            taskid: "t-1",
            waitreason: "ask",
            askts: NOW - 40_000,
            mergestate: "",
            cleanupstate: "",
        };
        expect(taskRow(rowInput({}, { td, askOwner: "user" })).meta).toBe("asked you · idle 40s");
        expect(taskRow(rowInput({}, { td, askOwner: "lead" })).meta).toBe("asked the lead · idle 40s");
    });

    it("gives a failure one meta line from its recovery history", () => {
        const r = taskRow(
            rowInput({ state: "stalled", runid: "8a42ffff" }, { recovery: "Retried twice · test · now stalled" })
        );
        expect(r).toMatchObject({
            meta: "Retried twice · test · now stalled",
            stateTone: "error",
            action: "open-child-run",
        });
    });

    it("sends a blocked merge to the task in the graph, with the first line of git's refusal", () => {
        const r = taskRow(rowInput({ state: "blocked-merge", mergeerror: "CONFLICT in store.ts\nmore detail" }));
        expect(r).toMatchObject({ meta: "CONFLICT in store.ts", action: "open-dag-task" });
    });

    it("dates every figure and drops the tones on a stale row", () => {
        const r = taskRow(
            rowInput({ runid: "8a41ffff" }, { worker: dispatched("running tests"), asOf: "as of 2m ago" })
        );
        expect(r).toMatchObject({
            meta: "as of 2m ago · running tests",
            state: "running?",
            stateTone: "muted",
            metaTone: "muted",
        });
    });

    // the engine reaps the lane's worker before Verify starts, so a verifying task has no session by design
    it("reads a verifying task as running Verify once its worker is reaped", () => {
        const r = taskRow(
            rowInput({ state: "verifying", runid: "8a41ffff" }, { worker: { state: "unavailable", runId: "8a41ffff" } })
        );
        expect(r).toMatchObject({
            meta: "running Verify",
            state: "verifying",
            stateTone: "success",
            action: "open-dag-task",
        });
    });

    it("reads a question the lead holds as asked the lead", () => {
        const td: DagTaskDigest = {
            taskid: "t-1",
            waitreason: "lead-ask",
            askts: NOW - 40_000,
            mergestate: "",
            cleanupstate: "",
        };
        expect(taskRow(rowInput({}, { td, askOwner: null })).meta).toBe("asked the lead · idle 40s");
    });

    it("names the row by the task's label, and by its id when it has none", () => {
        expect(taskRow(rowInput({ state: "skipped" }))).toMatchObject({ taskId: "t-1", label: "fix the store layer" });
        expect(taskRow(rowInput({ state: "skipped", label: "" }))).toMatchObject({ taskId: "t-1", label: "t-1" });
    });

    it("says a running task with no child run yet is starting", () => {
        expect(taskRow(rowInput({ state: "running" }))).toEqual({
            taskId: "t-1",
            label: "fix the store layer",
            meta: "starting",
            metaTone: "muted",
            state: "running",
            stateTone: "success",
            action: null,
        });
    });

    it("prints a done task's own duration and only the parts it has", () => {
        const r = taskRow(
            rowInput(
                { id: "t-9", state: "done", runid: "8a43ffff" },
                {
                    worker: { state: "unavailable", runId: "8a43ffff" },
                    durations: [
                        { taskid: "t-1", runms: 5 * MIN },
                        { taskid: "t-9", runms: 14 * MIN },
                    ],
                }
            )
        );
        expect(r.meta).toBe("14m · child run 8a43");
        expect(taskRow(rowInput({ id: "t-2", state: "done" })).meta).toBe("lane 2");
    });

    it("shows a failed Verify's own first error line, not the merge's", () => {
        const r = taskRow(
            rowInput({ state: "verify-failed", verifyerror: "vet failed\nmore", mergeerror: "CONFLICT in store.ts" })
        );
        expect(r).toMatchObject({ meta: "vet failed", state: "verify-failed", action: "open-dag-task" });
    });
});

describe("configLine", () => {
    const draft = (over: Partial<RunSettingsDraft> = {}): RunSettingsDraft => ({
        parallelism: 2,
        workerRoute: null,
        reviewerPicks: false,
        reviewerRoute: null,
        lightReviewerRoute: null,
        autonomous: false,
        ...over,
    });

    it("prints the running configuration as one line", () => {
        expect(configLine(run(), draft(), false)).toBe(
            "engine · orchestrator · lead pi/deepseek-v4-flash · parallelism 2 · workers inherit the lead · asks you"
        );
    });

    it("names a set Light reviewers route beside the reviewers, and nothing for the default", () => {
        const haiku = { runtime: "claude", model: "haiku" } as RoutePin;
        expect(configLine(run(), draft({ lightReviewerRoute: haiku }), false)).toContain(
            "light reviewers claude · haiku"
        );
        expect(configLine(run(), draft(), false)).not.toContain("light reviewers");
    });

    it("says when a run's width is left to its submit", () => {
        expect(configLine(run(), draft({ parallelism: 0 }), false)).toContain("parallelism set at submit");
    });

    it("carries a refused value with not saved", () => {
        expect(configLine(run(), draft({ parallelism: 9 }), true)).toBe(
            "engine · orchestrator · parallelism 9 — not saved"
        );
    });

    it("names the Approvals setting for an orchestrator run only", () => {
        expect(configLine(run(), draft({ autonomous: true }), false)).toMatch(/ · autonomous$/);
        expect(configLine(run(), draft(), false)).toMatch(/ · asks you$/);
        const quick = run({ mode: "quick" });
        expect(configLine(quick, draft({ autonomous: true }), false)).not.toMatch(/autonomous|asks you/);
        expect(configLine(quick, draft(), false)).not.toMatch(/autonomous|asks you/);
    });
});

describe("autonomousResolvedNote", () => {
    const FROM_HERE = "It answers everything from here on; each call it makes goes in its report.";

    it("says what the lead does with the question it was handed back", () => {
        expect(autonomousResolvedNote("Spec review")).toEqual({
            title: "Spec review: the lead decided",
            body: `The lead approved its spec and is writing the plan. ${FROM_HERE}`,
        });
        expect(autonomousResolvedNote("Plan review")).toEqual({
            title: "Plan review: the lead decided",
            body: `The lead is carrying the plan review's findings into the tasks and going on. ${FROM_HERE}`,
        });
        expect(autonomousResolvedNote("Land")).toEqual({
            title: "Land: the lead decided",
            body: `The lead is deciding it as it would recommend. ${FROM_HERE}`,
        });
    });
});

describe("configNote", () => {
    it("leaves the slot to the printed line when the run is editable", () => {
        expect(configNote(run(), { kind: "editable" })).toBeNull();
    });

    it("states each fixed reason where the dials would be", () => {
        expect(configNote(run({ status: "done" }), { kind: "readonly", reason: "this run is done" })?.title).toBe(
            "Settings are fixed: this run is done."
        );
        const quick = configNote(run({ mode: "quick", runtime: "claude", model: "sonnet-4-6" }), {
            kind: "readonly",
            reason: "a quick run has no scheduler to reconfigure",
        });
        expect(quick?.body).toMatch(/fixed at launch: claude · sonnet-4-6/);
        // a finished quick run has no dock button to carry its configuration forward, so the note offers none
        const quickDone = configNote(run({ mode: "quick", status: "done" }), {
            kind: "readonly",
            reason: "this run is done",
        });
        expect(quickDone?.body).not.toMatch(/Save/);
    });

    describe("what a fixed run's note says beneath its title", () => {
        const readonly = { kind: "readonly", reason: "fixed" } as const;
        const body = (over: Partial<Run>) => configNote(run(over), readonly)?.body;
        const SAVE = "Save its configuration as this project's defaults to launch the next run the same way.";
        const LOWERING = "Lowering parallelism would not reach workers that are already running.";

        it("offers to save a finished orchestrator's configuration as the defaults", () => {
            expect(body({ status: "done" })).toBe(SAVE);
        });

        it("says lowering parallelism cannot reach a cancelled run's workers", () => {
            expect(body({ status: "cancelled" })).toBe(LOWERING);
            expect(body({ status: "cancelled", mode: "quick" })).toBe(LOWERING);
        });

        it("has nothing to add for an orchestrator that is neither done nor cancelled", () => {
            expect(body({ status: "executing" })).toBe("");
            expect(body({ status: "blocked" })).toBe("");
        });

        it("names a quick run's route, defaulting each half that was never set", () => {
            const lead =
                "Parallelism and a worker route only exist for an orchestrator. Its route was fixed at launch:";
            expect(body({ mode: "quick", runtime: "pi", model: "m1" })).toBe(`${lead} pi · m1.`);
            expect(body({ mode: "quick", runtime: "", model: "" })).toBe(`${lead} claude · default.`);
        });
    });

    it("says a plan that cannot be read offers no controls", () => {
        expect(configNote(run(), { kind: "unavailable", reason: "error" })?.title).toBe(
            "This run's plan could not be read."
        );
        expect(configNote(run(), { kind: "loading" })?.pulse).toBe(true);
    });
});

describe("finalStageEndable", () => {
    const group = (status: string, state?: string) =>
        ({ status, final: state == null ? undefined : { state, round: 1 } }) as unknown as TaskGroup;
    it("is true while the stage's commands or its verifier run", () => {
        for (const state of ["checking", "final", "verifying"]) {
            expect(finalStageEndable(group("finalizing", state))).toBe(true);
        }
    });
    it("is false with no stage, a stage not started, or one that ended", () => {
        expect(finalStageEndable(null)).toBe(false);
        expect(finalStageEndable(group("running"))).toBe(false);
        expect(finalStageEndable(group("finalizing", ""))).toBe(false);
        for (const state of ["passed", "unverified", "failed"]) {
            expect(finalStageEndable(group("done", state))).toBe(false);
        }
    });
    it("is false on a cancelled dag, whatever the stage last recorded", () => {
        expect(finalStageEndable(group("cancelled", "final"))).toBe(false);
    });
});

describe("finalStageRerunnable", () => {
    const group = (status: string, state?: string) =>
        ({ status, final: state == null ? undefined : { state, round: 1 } }) as unknown as TaskGroup;
    it("is true only for a failed stage", () => {
        expect(finalStageRerunnable(group("blocked", "failed"))).toBe(true);
        for (const state of ["", "checking", "final", "verifying", "passed", "unverified"]) {
            expect(finalStageRerunnable(group("finalizing", state))).toBe(false);
        }
        expect(finalStageRerunnable(group("running"))).toBe(false);
        expect(finalStageRerunnable(null)).toBe(false);
    });
    it("is false on a cancelled dag, whatever the stage last recorded", () => {
        expect(finalStageRerunnable(group("cancelled", "failed"))).toBe(false);
    });
});

describe("sheetLead", () => {
    const lead = { id: "lead", name: "lead", state: "working" } as AgentVM;
    const withLead = { phases: [{ kind: "orchestrate", state: "running", workerorefs: ["tab:lead"] }] };
    it("is a live orchestrator's lead", () => {
        expect(sheetLead(run(withLead), [lead])?.id).toBe("lead");
    });
    it("is none on a finished run or a quick run", () => {
        expect(sheetLead(run({ ...withLead, status: "done" }), [lead])).toBeUndefined();
        expect(sheetLead(run({ ...withLead, mode: "" }), [lead])).toBeUndefined();
    });
});

describe("doneBody", () => {
    it("is the filed report, else the sealed evidence, on a done run only", () => {
        expect(doneBody(run({ status: "done", report: "# Report" }))).toBe("report");
        expect(doneBody(run({ status: "done", report: "  " }))).toBe("evidence");
        expect(doneBody(run())).toBeNull();
    });
});

describe("doneBodyHasDiff", () => {
    it("offers the diff from a sealed evidence body", () => {
        expect(doneBodyHasDiff(run({ status: "done", evidence: {} as RunEvidence }))).toBe(true);
        expect(doneBodyHasDiff(run({ status: "done" }))).toBe(false);
    });
    it("offers it from a filed report", () => {
        expect(doneBodyHasDiff(run({ status: "done", report: "the lead's summary" }))).toBe(true);
    });
    it("offers none before the run is done", () => {
        expect(doneBodyHasDiff(run({ evidence: {} as RunEvidence }))).toBe(false);
    });
});
