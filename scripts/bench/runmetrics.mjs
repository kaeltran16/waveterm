// Per-run numbers for the plan-skill bench and the real-run comparison (slim-superpowers spec, decisions 8-9),
// read from the packaged store and the ~/.claude/projects transcripts.
// Usage: node scripts/bench/runmetrics.mjs <runId>... [--json]
//        node scripts/bench/runmetrics.mjs --since <YYYY-MM-DD> [--json]
//        either with [--db <waveterm.db>] [--transcripts <dir>]
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const PLAN_SKILL = "plan";
const WRITING_PLANS = "writing-plans";
const ROLES = ["lead", "worker", "taskReviewer", "planReviewer", "verifier"];
const GOAL_ROLES = [
    ["You are the worker", "worker"],
    ["You are the reviewer for task", "taskReviewer"],
    ["You are the plan reviewer", "planReviewer"],
    ["You are the final verifier", "verifier"],
];
// list prices per MTok: input, output, cache read, 5m cache write, 1h cache write
const PRICES = {
    opus: { i: 4, o: 20, r: 0.2, w5: 5, w1: 8 },
    sonnet: { i: 2, o: 10, r: 0.2, w5: 2.5, w1: 4 },
    haiku: { i: 1, o: 5, r: 0.1, w5: 1.25, w1: 2 },
};

const decoder = new TextDecoder();
// the data column comes back as a blob
const parse = (v) => JSON.parse(typeof v === "string" ? v : decoder.decode(v));

export function openStore(path) {
    return new DatabaseSync(path, { readOnly: true });
}

// session id -> transcript path, over every project dir
export function indexTranscripts(dir) {
    const idx = new Map();
    for (const d of readdirSync(dir)) {
        let files;
        try {
            files = readdirSync(join(dir, d));
        } catch {
            continue; // a loose file beside the project dirs
        }
        for (const f of files) if (f.endsWith(".jsonl")) idx.set(f.slice(0, -".jsonl".length), join(dir, d, f));
    }
    return idx;
}

// EffectivePlanSkill (pkg/jarvis/planskill.go): an empty stored value predates the setting and was writing-plans
const effectivePlanSkill = (stored) => (stored === PLAN_SKILL || stored === WRITING_PLANS ? stored : WRITING_PLANS);

const family = (model = "") => (model.includes("sonnet") ? "sonnet" : model.includes("haiku") ? "haiku" : "opus");

// list-price estimate of one session, its subagents included; a message is logged once per content block, so
// usage is counted once per message id
function sessionCost(file) {
    const files = [file];
    const sub = join(file.slice(0, -".jsonl".length), "subagents");
    if (existsSync(sub)) for (const f of readdirSync(sub)) if (f.endsWith(".jsonl")) files.push(join(sub, f));
    const seen = new Set();
    let usd = 0;
    for (const f of files) {
        for (const line of readFileSync(f, "utf8").split("\n")) {
            if (!line.includes('"usage"')) continue;
            let x;
            try {
                x = JSON.parse(line);
            } catch {
                continue; // a line cut off by a live session's write
            }
            const m = x.message;
            if (!m?.usage || m.role !== "assistant") continue;
            const id = m.id || x.uuid;
            if (seen.has(id)) continue;
            seen.add(id);
            const u = m.usage;
            const p = PRICES[family(m.model)];
            const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
            const w5 = (u.cache_creation_input_tokens ?? 0) - w1;
            usd += ((u.input_tokens ?? 0) * p.i + w5 * p.w5 + w1 * p.w1 + (u.cache_read_input_tokens ?? 0) * p.r + (u.output_tokens ?? 0) * p.o) / 1e6;
        }
    }
    return usd;
}

const costOf = (sessionId, idx) => {
    const f = idx.get(sessionId);
    return f ? sessionCost(f) : 0;
};

const roleOf = (goal = "") => GOAL_ROLES.find(([prefix]) => goal.startsWith(prefix))?.[1] ?? null;

const words = (s) => (s || "").split(/\s+/).filter(Boolean).length;

// a plan passed in with --plan skips the lead's plan skill: its goal is the writing-plans title, or the plan
// already existed at the run's base commit
function leadWrotePlan(run, dag) {
    if (/Implementation Plan/.test((run.goal || "").split("\n")[0])) return false;
    if (!dag.planpath || !run.basecommit) return true;
    const cwd = run.projectpath && existsSync(run.projectpath) ? run.projectpath : process.cwd();
    try {
        execFileSync("git", ["cat-file", "-e", `${run.basecommit}:${dag.planpath}`], { cwd, stdio: "ignore" });
        return false;
    } catch {
        return true;
    }
}

// the most tasks running at once; a task runs from its spawn to its done or failure
function width(events) {
    const closes = new Set(["task-done", "task-failed"]);
    const spans = events
        .filter((e) => e.kind === "task-spawned" || closes.has(e.kind))
        .sort((a, b) => a.ts - b.ts || (closes.has(b.kind) ? 1 : 0) - (closes.has(a.kind) ? 1 : 0));
    const running = new Set();
    let most = 0;
    for (const e of spans) {
        if (closes.has(e.kind)) running.delete(e.data.taskid);
        else running.add(e.data.taskid);
        most = Math.max(most, running.size);
    }
    return most;
}

const all = new WeakMap();
// every run and dag, read once per store
function load(db) {
    if (!all.has(db)) {
        all.set(db, {
            runs: db.prepare("select data from db_run").all().map((x) => parse(x.data)),
            dags: db.prepare("select data from db_dag").all().map((x) => parse(x.data)),
        });
    }
    return all.get(db);
}

export function runRow(db, runId, transcriptIndex) {
    const { runs, dags } = load(db);
    const run = runs.find((r) => r.oid === runId);
    const dag = run && dags.find((d) => d.runid === runId);
    if (!dag) return null;
    const events = db
        .prepare("select ts, kind, data from db_runevent where runid = ?")
        .all(runId)
        .map((e) => ({ ts: e.ts, kind: e.kind, data: e.data ? parse(e.data) : {} }));
    const count = (kind) => events.filter((e) => e.kind === kind).length;
    const ended = events.filter((e) => e.kind === "final-ended");

    const cost = Object.fromEntries(ROLES.map((r) => [r, 0]));
    for (const sid of run.leadsessionids?.length ? run.leadsessionids : [run.sessionid]) cost.lead += costOf(sid, transcriptIndex);
    // the lead run carries the dag's oref too; any other child without a known goal is not priced
    for (const kid of runs) {
        if (kid.dagoref !== dag.oid || kid.oid === runId) continue;
        const role = roleOf(kid.goal);
        if (role) cost[role] += costOf(kid.sessionid, transcriptIndex);
    }

    return {
        runId,
        planSkill: effectivePlanSkill(run.planskill),
        leadWrotePlan: leadWrotePlan(run, dag),
        tasks: dag.tasks.length,
        width: width(events),
        planWords: words(dag.preamble) + dag.tasks.reduce((s, t) => s + words(t.description), 0),
        planReviewRounds: dag.planreview?.round ?? null,
        asks: count("child-ask"),
        reviewFails: count("task-review-failed"),
        verifyFails: count("task-verify-failed"),
        finalRound1: ended.find((e) => (e.data.round ?? 1) === 1)?.data.outcome ?? null,
        finalRounds: ended.length ? Math.max(...ended.map((e) => e.data.round ?? 1)) : null,
        minutes: run.completedts ? Math.round((run.completedts - run.createdts) / 60000) : null,
        cost,
        totalCost: ROLES.reduce((s, r) => s + cost[r], 0),
    };
}

const median = (xs) => {
    const a = xs.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y);
    return a.length ? a[Math.floor(a.length / 2)] : null;
};

function summarize(rows) {
    const final1 = rows.filter((r) => r.finalRound1 != null);
    return {
        n: rows.length,
        tasks: median(rows.map((r) => r.tasks)),
        words: median(rows.map((r) => r.planWords)),
        wordsPerTask: median(rows.map((r) => r.planWords / r.tasks)),
        planReviewRounds: median(rows.map((r) => r.planReviewRounds)),
        asksPerTask: median(rows.map((r) => r.asks / r.tasks)),
        reviewFailsPerTask: median(rows.map((r) => r.reviewFails / r.tasks)),
        final1Passed: `${final1.filter((r) => r.finalRound1 === "passed").length}/${final1.length}`,
        extraFinalRounds: rows.filter((r) => r.finalRounds > 1).length,
        minutes: median(rows.map((r) => r.minutes)),
        costPerRun: median(rows.map((r) => r.totalCost)),
        leadCost: median(rows.map((r) => r.cost.lead)),
        workerCostPerTask: median(rows.map((r) => r.cost.worker / r.tasks)),
    };
}

// the real-run comparison: lead-written, done, dag-backed orchestrator runs created since sinceMs, by plan skill
export function compare(db, sinceMs, transcriptIndex) {
    const rows = load(db)
        .runs.filter((r) => r.mode === "orchestrator" && r.status === "done" && r.createdts >= sinceMs)
        .sort((a, b) => a.createdts - b.createdts)
        .map((r) => runRow(db, r.oid, transcriptIndex))
        .filter((r) => r && r.leadWrotePlan);
    const groups = {};
    for (const skill of [WRITING_PLANS, PLAN_SKILL]) {
        const g = rows.filter((r) => r.planSkill === skill);
        groups[skill] = { rows: g, medians: g.length ? summarize(g) : null };
    }
    return groups;
}

const fmt = (x) => (x == null ? "-" : typeof x === "number" ? (Number.isInteger(x) ? String(x) : x.toFixed(1)) : String(x));

function printRows(rows) {
    const head = ["id      ", "skill        ", "leadPlan", "tasks", "width", "words", "prR", "asks", "revF", "verF", "final1    ", "fRnds", " min"];
    console.log([...head, ...["$lead", "$work", "$trev", "$prev", " $ver"], "$total"].join(" "));
    for (const r of rows) {
        console.log(
            [
                r.runId.slice(0, 8).padEnd(8),
                r.planSkill.padEnd(13),
                String(r.leadWrotePlan).padEnd(8),
                ...[r.tasks, r.width, r.planWords].map((x) => fmt(x).padStart(5)),
                fmt(r.planReviewRounds).padStart(3),
                ...[r.asks, r.reviewFails, r.verifyFails].map((x) => fmt(x).padStart(4)),
                fmt(r.finalRound1).padEnd(10),
                fmt(r.finalRounds).padStart(5),
                fmt(r.minutes).padStart(4),
                ...ROLES.map((k) => r.cost[k].toFixed(0).padStart(5)),
                r.totalCost.toFixed(0).padStart(6),
            ].join(" "),
        );
    }
}

function main(argv) {
    const opt = (name) => {
        const i = argv.indexOf(name);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const valued = new Set(["--db", "--transcripts", "--since"]);
    const ids = argv.filter((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1]));
    const since = opt("--since");
    if (!since && !ids.length) throw new Error("usage: runmetrics.mjs <runId>... [--json] | --since <YYYY-MM-DD> [--json]");
    const sinceMs = since && Date.parse(since);
    if (since && !Number.isFinite(sinceMs)) throw new Error(`--since ${since} is not a date (YYYY-MM-DD)`);

    const db = openStore(opt("--db") ?? join(process.env.LOCALAPPDATA ?? "", "dev.arc.app", "data", "db", "waveterm.db"));
    const idx = indexTranscripts(opt("--transcripts") ?? join(homedir(), ".claude", "projects"));
    const json = argv.includes("--json");

    if (since) {
        const groups = compare(db, sinceMs, idx);
        if (json) return console.log(JSON.stringify(groups, null, 2));
        printRows(Object.values(groups).flatMap((g) => g.rows));
        console.log("\nmedians, lead-written plans only (passed-in plan files skip the plan skill):");
        for (const [skill, g] of Object.entries(groups)) {
            if (!g.medians) {
                console.log(skill.padEnd(14), "none");
                continue;
            }
            console.log(skill.padEnd(14), Object.entries(g.medians).map(([k, v]) => `${k} ${fmt(v)}`).join("  "));
        }
        return;
    }

    const rows = ids.map((id) => {
        const r = runRow(db, id, idx);
        if (!r) throw new Error(`run ${id} has no dag in the store (unknown id, or a bounded run with no plan)`);
        return r;
    });
    if (json) console.log(JSON.stringify(rows, null, 2));
    else printRows(rows);
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
    try {
        main(process.argv.slice(2));
    } catch (e) {
        console.error(`runmetrics: ${e.message}`);
        process.exit(1);
    }
}
