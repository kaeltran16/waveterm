import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compare, indexTranscripts, openStore, runRow } from "./runmetrics.mjs";

const MIN = 60000;
const PLAN_AT_BASE = "docs/superpowers/plans/passed-in.md";
const LEAD_PLAN = "docs/superpowers/plans/lead-written.md";

let root, db, idx, repo, base;

function git(...args) {
    return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" }).trim();
}

function buildStore(path) {
    const w = new DatabaseSync(path);
    w.exec(`
        CREATE TABLE db_run (oid varchar(36) PRIMARY KEY, version int NOT NULL, data json NOT NULL);
        CREATE TABLE db_dag (oid varchar(36) PRIMARY KEY, version int NOT NULL, data json NOT NULL);
        CREATE TABLE db_runevent (oid varchar(36) PRIMARY KEY, runid varchar(36) NOT NULL, channelid varchar(36) NOT NULL,
            ts int NOT NULL, kind varchar(32) NOT NULL, phaseidx int, data json NOT NULL);`);
    // the store keeps data as a blob, which is what the module must decode
    const blob = (o) => Buffer.from(JSON.stringify(o));
    const run = (o) => w.prepare("insert into db_run values (?, 1, ?)").run(o.oid, blob(o));
    const dag = (o) => w.prepare("insert into db_dag values (?, 1, ?)").run(o.oid, blob(o));
    let n = 0;
    const ev = (runid, ts, kind, data) => w.prepare("insert into db_runevent values (?, ?, 'c', ?, ?, null, ?)").run(`e${n++}`, runid, ts, kind, blob(data));
    return { w, run, dag, ev };
}

function usageLine(id, model, usage) {
    return JSON.stringify({ type: "assistant", uuid: `u-${id}`, message: { id, role: "assistant", model, usage: { input_tokens: 0, output_tokens: 0, ...usage } } });
}

function transcript(dir, sid, lines, subagents) {
    writeFileSync(join(dir, `${sid}.jsonl`), lines.join("\n") + "\n");
    if (!subagents) return;
    mkdirSync(join(dir, sid, "subagents"), { recursive: true });
    writeFileSync(join(dir, sid, "subagents", "agent-a.jsonl"), subagents.join("\n") + "\n");
}

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "runmetrics-"));
    repo = join(root, "repo");
    mkdirSync(join(repo, "docs/superpowers/plans"), { recursive: true });
    writeFileSync(join(repo, PLAN_AT_BASE), "# plan\n");
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    base = git("rev-parse", "HEAD");

    const s = buildStore(join(root, "waveterm.db"));
    const lead = (oid, extra) => ({ oid, mode: "orchestrator", status: "done", goal: "Build the thing.", planskill: "", basecommit: base, projectpath: repo, createdts: 1000 * MIN, completedts: 1030 * MIN, dagoref: `dag-${oid}`, sessionid: `${oid}-s`, ...extra });
    const dag = (runid, extra) => ({ oid: `dag-${runid}`, runid, planpath: LEAD_PLAN, preamble: "one two three", tasks: [{ description: "a b" }], planreview: { round: 1 }, ...extra });

    // r1: the fully populated run
    s.run(lead("r1", { leadsessionids: ["L1", "L2"] }));
    s.dag(dag("r1", { tasks: [{ description: "a b" }, { description: "c d e" }, { description: "" }, { description: "f" }], planreview: { round: 2 } }));
    const kid = (oid, goal) => s.run({ oid, dagoref: "dag-r1", goal, sessionid: `${oid}-s`, status: "done" });
    kid("w1", "You are the worker for task 1 of the plan");
    kid("w2", "You are the worker for task 2 of the plan");
    kid("tr1", "You are the reviewer for task 1");
    kid("pr1", "You are the plan reviewer for the plan");
    kid("fv1", "You are the final verifier for the run");
    s.ev("r1", 100, "task-spawned", { taskid: "t-1" });
    s.ev("r1", 200, "task-spawned", { taskid: "t-2" });
    s.ev("r1", 250, "task-spawned", { taskid: "t-3" });
    s.ev("r1", 300, "task-done", { taskid: "t-1" });
    s.ev("r1", 400, "task-done", { taskid: "t-2" });
    s.ev("r1", 410, "task-done", { taskid: "t-3" });
    s.ev("r1", 500, "task-spawned", { taskid: "t-4" });
    s.ev("r1", 600, "task-done", { taskid: "t-4" });
    s.ev("r1", 610, "child-ask", { askid: "a1" });
    s.ev("r1", 620, "child-ask", { askid: "a2" });
    s.ev("r1", 630, "task-review-failed", { taskid: "t-1" });
    s.ev("r1", 640, "task-verify-failed", { taskid: "t-2" });
    s.ev("r1", 700, "final-step", { round: 1, step: "final", ok: true });
    s.ev("r1", 710, "final-ended", { round: 1, outcome: "failed" });
    s.ev("r1", 800, "final-ended", { round: 2, outcome: "passed" });

    // r2: a bounded run, no dag
    s.run(lead("r2", { dagoref: undefined }));
    // r3: a dag but no final stage reached
    s.run(lead("r3", { planskill: "plan" }));
    s.dag(dag("r3"));
    s.ev("r3", 100, "task-spawned", { taskid: "t-1" });

    // --since population: r1 (writing-plans, empty stored), r3 (plan) qualify; the rest do not
    s.run(lead("p1", { goal: "# Thing Implementation Plan\n\nmore" }));
    s.dag(dag("p1"));
    s.run(lead("p2", { planskill: "plan" }));
    s.dag(dag("p2", { planpath: PLAN_AT_BASE }));
    s.run(lead("old", { createdts: 1 * MIN }));
    s.dag(dag("old"));
    s.run(lead("live", { status: "executing" }));
    s.dag(dag("live"));
    s.run({ ...lead("chat"), mode: "chat" });
    s.dag(dag("chat"));
    s.w.close();

    const tx = join(root, "projects");
    const proj = join(tx, "C--proj");
    mkdirSync(proj, { recursive: true });
    const opus = "claude-opus-5-5";
    // lead: $4 input in L1 (its duplicate line counted once), $1 output in its subagent, $8 1h cache write in L2
    transcript(proj, "L1", [usageLine("m1", opus, { input_tokens: 1e6 }), usageLine("m1", opus, { input_tokens: 1e6 }), JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })], [usageLine("m2", opus, { output_tokens: 50000 })]);
    transcript(proj, "L2", [usageLine("m3", opus, { cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_1h_input_tokens: 1e6 } })]);
    // workers: sonnet $2 input + $0.2 cache read, and $5 of 5m cache writes on opus
    transcript(proj, "w1-s", [usageLine("m4", "claude-sonnet-5-5", { input_tokens: 1e6, cache_read_input_tokens: 1e6 })]);
    transcript(proj, "w2-s", [usageLine("m5", opus, { cache_creation_input_tokens: 1e6 })]);
    // task reviewer: haiku $5 output
    transcript(proj, "tr1-s", [usageLine("m6", "claude-haiku-5-5", { output_tokens: 1e6 })]);
    // plan reviewer: opus $20 output
    transcript(proj, "pr1-s", [usageLine("m7", opus, { output_tokens: 1e6 })]);
    // verifier: opus 0.05M of 1h cache writes, $0.4
    transcript(proj, "fv1-s", [usageLine("m8", opus, { cache_creation_input_tokens: 50000, cache_creation: { ephemeral_1h_input_tokens: 50000 } })]);

    db = openStore(join(root, "waveterm.db"));
    idx = indexTranscripts(tx);
});

afterAll(() => {
    db?.close();
    rmSync(root, { recursive: true, force: true });
});

describe("runRow", () => {
    it("returns the counts, width, Final outcome and plan size the events and dag imply", () => {
        const r = runRow(db, "r1", idx);
        expect(r).toMatchObject({
            runId: "r1",
            planSkill: "writing-plans",
            leadWrotePlan: true,
            tasks: 4,
            width: 3,
            planWords: 9,
            planReviewRounds: 2,
            asks: 2,
            reviewFails: 1,
            verifyFails: 1,
            finalRound1: "failed",
            finalRounds: 2,
            minutes: 30,
        });
    });

    it("prices each role from its sessions and subagents, a duplicated message id once", () => {
        const { cost, totalCost } = runRow(db, "r1", idx);
        expect(cost.lead).toBeCloseTo(13);
        expect(cost.worker).toBeCloseTo(7.2);
        expect(cost.taskReviewer).toBeCloseTo(5);
        expect(cost.planReviewer).toBeCloseTo(20);
        expect(cost.verifier).toBeCloseTo(0.4);
        expect(totalCost).toBeCloseTo(45.6);
    });

    it("returns null for a run with no dag", () => {
        expect(runRow(db, "r2", idx)).toBeNull();
    });

    it("has no Final outcome when no final-ended event was recorded", () => {
        const r = runRow(db, "r3", idx);
        expect(r.finalRound1).toBeNull();
        expect(r.finalRounds).toBeNull();
        expect(r.planSkill).toBe("plan");
    });

    it("marks a plan passed in with --plan as not lead-written", () => {
        expect(runRow(db, "p1", idx).leadWrotePlan).toBe(false);
        expect(runRow(db, "p2", idx).leadWrotePlan).toBe(false);
    });
});

describe("compare", () => {
    it("groups lead-written done orchestrator runs since the date by effective plan skill", () => {
        const groups = compare(db, 500 * MIN, idx);
        expect(groups["writing-plans"].rows.map((r) => r.runId)).toEqual(["r1"]);
        expect(groups.plan.rows.map((r) => r.runId)).toEqual(["r3"]);
    });
});
