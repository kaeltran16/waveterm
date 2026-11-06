// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import { leadlessCardId } from "./cardgridlayout";
import {
    HISTORY_WINDOW_MS,
    historyEntries,
    runCardId,
    runItem,
    sessionLine,
    type HistoryEntry,
} from "./projecthistorymodel";
import type { Lineage, RunInfo } from "./runlineage";
import type { LiveSession } from "./sessionsarchivestore";

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const MIN = 60_000;
const DAY = 86_400_000;
const PATH = "C:\\Repo\\Arc";

function session(id: string, over: Partial<LiveSession> = {}): LiveSession {
    return {
        id,
        runtime: "claude",
        projectpath: PATH,
        projectname: "arc",
        branch: "main",
        task: `Session ${id}`,
        model: "opus",
        tokenstotal: 61_000,
        lastactivets: NOW - 10 * MIN,
        resumecommand: "",
        transcriptpath: `C:\\Users\\me\\.claude\\projects\\arc\\${id}.jsonl`,
        status: "done",
        startedts: NOW - 40 * MIN,
        durationms: 22 * MIN,
        events: [],
        live: false,
        needsAttention: false,
        ...over,
    };
}

function run(id: string, over: Partial<Run> = {}): Run {
    return {
        otype: "run",
        oid: id,
        version: 1,
        meta: {},
        id,
        goal: `Run ${id}`,
        workspaceid: "",
        projectpath: PATH,
        status: "done",
        phases: [],
        createdts: NOW - 5 * MIN,
        ...over,
    };
}

function dag(tasks: string[], over: Partial<TaskGroup> = {}): TaskGroup {
    return {
        otype: "dag",
        oid: "d",
        version: 1,
        meta: {},
        id: "d",
        runid: "r",
        channelid: "c",
        parallelism: 1,
        tasks: tasks.map((state, i) => ({ id: `t${i}`, state })),
        status: "done",
        failures: 0,
        createdts: 0,
        updatedts: 0,
        ...over,
    };
}

const keys = (list: HistoryEntry[]) => list.map((e) => e.key);

describe("historyEntries: sessions", () => {
    it("keeps ended, non-run sessions of the project inside 7 days, newest first", () => {
        const list = historyEntries(
            [
                session("old", { lastactivets: NOW - HISTORY_WINDOW_MS - MIN }),
                session("live", { live: true }),
                session("worker", { runid: "r1", channelid: "c1" }),
                session("other", { projectpath: "C:\\Repo\\Other" }),
                session("a", { lastactivets: NOW - 2 * DAY }),
                session("b", { lastactivets: NOW - MIN }),
            ],
            [],
            {},
            PATH,
            NOW,
            ""
        );
        expect(keys(list)).toEqual(["claude:b", "claude:a"]);
    });

    it("matches the project spelled with other case, slashes and a trailing slash", () => {
        const list = historyEntries(
            [session("x", { projectpath: "c:/repo/arc/" })],
            [],
            {},
            "C:\\Repo\\Arc\\",
            NOW,
            ""
        );
        expect(keys(list)).toEqual(["claude:x"]);
    });
});

describe("historyEntries: runs", () => {
    it("nests a run under the session that started it, matching the transcript path loosely", () => {
        const s = session("s");
        const r = run("r1", { origintranscript: s.transcriptpath.replace(/\\/g, "/").toUpperCase() });
        const list = historyEntries([s], [r], {}, PATH, NOW, "");
        expect(keys(list)).toEqual(["claude:s"]);
        const head = list[0];
        expect(head.kind === "session" && head.runs.map((x) => x.runId)).toEqual(["r1"]);
    });

    it("places a run whose origin is outside the window, live, unknown or empty top-level by its creation", () => {
        const old = session("old", { lastactivets: NOW - HISTORY_WINDOW_MS - DAY });
        const live = session("live", { live: true });
        const kept = session("kept", { lastactivets: NOW - 3 * DAY });
        const runs = [
            run("from-old", { origintranscript: old.transcriptpath, createdts: NOW - 1 * DAY }),
            run("from-live", { origintranscript: live.transcriptpath, createdts: NOW - 2 * DAY }),
            run("from-unknown", { origintranscript: "C:\\nowhere.jsonl", createdts: NOW - 4 * DAY }),
            run("cockpit", { createdts: NOW - MIN }),
        ];
        const list = historyEntries([old, live, kept], runs, {}, PATH, NOW, "");
        expect(keys(list)).toEqual(["run:cockpit", "run:from-old", "run:from-live", "claude:kept", "run:from-unknown"]);
    });

    it("drops child runs and runs older than the window", () => {
        const runs = [
            run("task", { taskid: "t1" }),
            run("stage", { stagerole: "verifier" }),
            run("lead-child", { parentleadoref: "run:x" }),
            run("old", { createdts: NOW - HISTORY_WINDOW_MS - MIN }),
            run("top"),
        ];
        expect(keys(historyEntries([], runs, {}, PATH, NOW, ""))).toEqual(["run:top"]);
    });

    it("orders a session's runs newest first", () => {
        const s = session("s");
        const runs = [
            run("early", { origintranscript: s.transcriptpath, createdts: NOW - 30 * MIN }),
            run("late", { origintranscript: s.transcriptpath, createdts: NOW - 15 * MIN }),
        ];
        const [head] = historyEntries([s], runs, {}, PATH, NOW, "");
        expect(head.kind === "session" && head.runs.map((x) => x.runId)).toEqual(["late", "early"]);
    });
});

describe("historyEntries: search", () => {
    const s1 = session("s1", { task: "Fix a.b parser" });
    const s2 = session("s2", { task: "Fix aXb parser" });
    const parent = session("parent", { task: "Plain work" });
    const runs = [
        run("nested-hit", { goal: "Ship the Widget", origintranscript: parent.transcriptpath }),
        run("nested-other", { goal: "Unrelated", origintranscript: parent.transcriptpath }),
        run("top", { goal: "Top-level widget run" }),
        run("top-miss", { goal: "Nothing here" }),
    ];

    it("matches literally, not as a regex", () => {
        expect(keys(historyEntries([s1, s2], [], {}, PATH, NOW, "a.b"))).toEqual(["claude:s1"]);
    });

    it("keeps a session whose run matches, with all its runs; a top-level run only on its own title", () => {
        const list = historyEntries([s1, s2, parent], runs, {}, PATH, NOW, "WIDGET");
        expect(keys(list)).toEqual(["run:top", "claude:parent"]);
        const p = list[1];
        expect(p.kind === "session" && p.runs.map((x) => x.runId).sort()).toEqual(["nested-hit", "nested-other"]);
    });

    it("an empty or blank query keeps everything", () => {
        expect(historyEntries([s1, s2, parent], runs, {}, PATH, NOW, "  ")).toHaveLength(5);
    });
});

describe("runItem", () => {
    it("titles a run by its goal's first line without initiative refs", () => {
        const r = run("r", { goal: "Ship it (effort:0c1f2e3d-4a5b-6c7d-8e9f-0a1b2c3d4e5f)\nmore detail" });
        expect(runItem(r).title).toBe("Ship it");
    });

    it("a landed run with a dag counts done tasks and says merged", () => {
        const item = runItem(run("r", { land: { state: "landed" } }), dag(["done", "done", "skipped"]));
        expect(item).toMatchObject({ line: "3/3 tasks · merged", warn: "", tone: "ok" });
    });

    it("a held land warns", () => {
        const item = runItem(run("r", { land: { state: "held" } }), dag(["done", "done"]));
        expect(item).toMatchObject({ line: "2/2 tasks", warn: " · land held", tone: "warn" });
    });

    it("a failed verification warns Final failed, over the land it held and the dag it cancelled", () => {
        const failed = dag(["done", "done"], { status: "cancelled", final: { state: "failed" } as FinalStage });
        const item = runItem(run("r", { land: { state: "held" } }), failed);
        expect(item).toMatchObject({ line: "2/2 tasks", warn: " · Final failed", tone: "warn" });
        const byEvidence = runItem(
            run("r", { evidence: { verification: { state: "failed" } } as RunEvidence }),
            dag(["done"])
        );
        expect(byEvidence).toMatchObject({ warn: " · Final failed", tone: "warn" });
    });

    it("a cancelled run is muted", () => {
        const item = runItem(run("r", { status: "cancelled" }), dag(["done", "pending", "pending"]));
        expect(item).toMatchObject({ line: "1/3 tasks", warn: " · cancelled", tone: "muted" });
    });

    it("a run with no dag says merged when landed, else its status", () => {
        expect(runItem(run("r", { land: { state: "landed" } }))).toMatchObject({ line: "merged", tone: "ok" });
        expect(runItem(run("r", { status: "executing" }))).toMatchObject({ line: "executing", warn: "" });
        expect(runItem(run("r", { status: "cancelled" }))).toMatchObject({
            line: "",
            warn: " · cancelled",
            tone: "muted",
        });
        expect(runItem(run("r", { status: "done", land: { state: "held" } }))).toMatchObject({
            line: "done",
            warn: " · land held",
        });
    });

    it("a cancelled run with a dag keeps its task count", () => {
        const item = runItem(run("r", { status: "cancelled" }), dag(["done", "done", "pending"]));
        expect(item).toMatchObject({ line: "2/3 tasks", warn: " · cancelled" });
    });
});

describe("runCardId", () => {
    const info = (runId: string): RunInfo => ({ runId, channelId: "c", title: runId, project: PATH });
    const lead = { id: "lead1", name: "lead", task: "", state: "working" } as AgentVM;

    it("a run in the lineage with its lead in the roster opens the lead's card", () => {
        const lineage: Lineage = { roles: { lead1: { kind: "lead", runId: "r1" } }, runs: { r1: info("r1") } };
        expect(runCardId(lineage, [lead], "r1")).toBe("lead1");
    });

    it("a run in the lineage with no lead in the roster opens its leadless card", () => {
        const lineage: Lineage = { roles: {}, runs: { r1: info("r1") } };
        expect(runCardId(lineage, [lead], "r1")).toBe(leadlessCardId("r1"));
    });

    it("a run not in the lineage has no card", () => {
        const lineage: Lineage = { roles: { lead1: { kind: "lead", runId: "r1" } }, runs: {} };
        expect(runCardId(lineage, [lead], "r1")).toBeUndefined();
    });
});

describe("sessionLine", () => {
    it("reads runtime, run time and tokens", () => {
        expect(sessionLine(session("s", { runtime: "claude", durationms: 22 * MIN, tokenstotal: 61_000 }))).toBe(
            "claude · 22m · 61k tokens"
        );
    });

    it("leaves out a run time it does not know", () => {
        expect(sessionLine(session("s", { runtime: "pi", durationms: 0, tokenstotal: 900 }))).toBe("pi · 900 tokens");
    });
});
