// The plan-skill bench verdict (slim-superpowers spec, decision 9): joins the runs, their mutation scores and the
// blind review, prints one table and applies the rule.
// Usage: node scripts/bench/verdict.mjs --bench <dir> [--db <waveterm.db>] [--transcripts <dir>]
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { indexTranscripts, openStore, runRow } from "./runmetrics.mjs";

const PLAN = "plan";
const WRITING_PLANS = "writing-plans";
const ARMS = [PLAN, WRITING_PLANS];
const BLIND_WINS_NEEDED = 2;
const COST_ROLES = ["lead", "worker", "taskReviewer", "planReviewer", "verifier"];
const MUTATION_KINDS = ["go", "ts"];

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// killed + timed out over killed + timed out + survived, counts summed across files; invalid mutants are excluded
function pooledCounts(files) {
    const killed = sum(files.map((f) => f.killed + f.timedOut));
    return { killed, total: killed + sum(files.map((f) => f.survived)) };
}

export function pooledScore(files) {
    const { killed, total } = pooledCounts(files);
    return total ? killed / total : null;
}

// a Final round counts only when it failed: an optional round after a pass is not rework
const rework = (r) => r.reviewFails + r.verifyFails + r.finalFails;

// input: { blind: {pick: {winner}}, rows: {arm: [runRow]}, mutation: {arm: [mutation json]} }
export function decide({ blind, rows, mutation }) {
    const blindWins = Object.values(blind).filter((v) => v.winner === PLAN).length;
    const blindLosses = Object.values(blind).filter((v) => v.winner === WRITING_PLANS).length;
    const final = Object.fromEntries(ARMS.map((a) => [a, rows[a].filter((r) => r.finalRound1 === "passed").length]));
    const score = Object.fromEntries(ARMS.map((a) => [a, pooledScore(mutation[a])]));
    const work = Object.fromEntries(ARMS.map((a) => [a, sum(rows[a].map(rework))]));
    const skipped = ARMS.some((a) => score[a] == null);

    const terms = [
        { name: "blind", plan: blindWins, writingPlans: blindLosses, rule: `plan wins at least ${BLIND_WINS_NEEDED} picks`, held: blindWins >= BLIND_WINS_NEEDED },
        { name: "final", plan: final[PLAN], writingPlans: final[WRITING_PLANS], rule: "plan Final round 1 passes >= writing-plans'", held: final[PLAN] >= final[WRITING_PLANS] },
        {
            name: "mutation",
            plan: score[PLAN],
            writingPlans: score[WRITING_PLANS],
            rule: "plan pooled score >= writing-plans'",
            skipped,
            held: skipped || score[PLAN] >= score[WRITING_PLANS],
        },
        { name: "rework", plan: work[PLAN], writingPlans: work[WRITING_PLANS], rule: "plan rework <= writing-plans'", held: work[PLAN] <= work[WRITING_PLANS] },
    ];
    return { default: terms.every((t) => t.held) ? PLAN : WRITING_PLANS, terms };
}

const fmt = (x) => (x == null ? "-" : typeof x === "number" ? (Number.isInteger(x) ? String(x) : x.toFixed(2)) : String(x));

export function renderTable(runs) {
    const head = ["pick", "arm", "tasks", "width", "words", "prR", "asks", "revF", "verF", "final1", "fRnds", "min", ...COST_ROLES.map((r) => `$${r}`), "mutGo", "mutTs"];
    const lines = runs.map(({ pick, arm, row: r, go, ts }) => [
        pick,
        arm,
        r.tasks,
        r.width,
        r.planWords,
        r.planReviewRounds,
        r.asks,
        r.reviewFails,
        r.verifyFails,
        r.finalRound1,
        r.finalRounds,
        r.minutes,
        ...COST_ROLES.map((k) => r.cost[k].toFixed(0)),
        pooledScore([go]),
        pooledScore([ts]),
    ].map(fmt));
    const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
    const pad = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
    return [pad(head), ...lines.map(pad)].join("\n");
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const mutationPath = (bench, pick, arm, kind) => join(bench, "mutation", `${pick}-${arm}-${kind}.json`);

function stopIfMissing(missing) {
    if (missing.length) throw new Error(`missing input:\n  ${missing.join("\n  ")}`);
}

// reads every input, naming all that are missing; rowFor(runId) is the store boundary
export function loadBench(bench, rowFor) {
    const runsPath = join(bench, "runs.json");
    if (!existsSync(runsPath)) throw new Error(`missing input: ${runsPath}`);
    const runs = readJson(runsPath);
    const blindPath = join(bench, "results", "blind.json");
    const picks = [...new Set(runs.map((r) => r.pick))];

    const missing = [];
    for (const pick of picks) {
        for (const arm of ARMS) {
            if (!runs.some((r) => r.pick === pick && r.arm === arm)) missing.push(`run ${pick}-${arm} in ${runsPath}`);
            for (const kind of MUTATION_KINDS) {
                const p = mutationPath(bench, pick, arm, kind);
                if (!existsSync(p)) missing.push(p);
            }
        }
    }
    if (!existsSync(blindPath)) missing.push(blindPath);
    const blind = existsSync(blindPath) ? readJson(blindPath) : {};
    for (const pick of picks) if (existsSync(blindPath) && !blind[pick]) missing.push(`pick ${pick} in ${blindPath}`);

    // file problems stop before the store is read
    stopIfMissing(missing);

    const found = runs.map((r) => ({ ...r, row: rowFor(r.runId) }));
    for (const r of found) {
        if (!r.row) missing.push(`run ${r.runId} (${r.pick}-${r.arm}): no dag in the store`);
        else if (r.row.minutes == null) missing.push(`run ${r.runId} (${r.pick}-${r.arm}): not done`);
    }
    stopIfMissing(missing);

    const joined = found.map((r) => ({
        ...r,
        go: readJson(mutationPath(bench, r.pick, r.arm, "go")),
        ts: readJson(mutationPath(bench, r.pick, r.arm, "ts")),
    }));
    const of = (arm) => joined.filter((r) => r.arm === arm);
    return {
        blind,
        runs: joined,
        rows: Object.fromEntries(ARMS.map((a) => [a, of(a).map((r) => r.row)])),
        mutation: Object.fromEntries(ARMS.map((a) => [a, of(a).flatMap((r) => [r.go, r.ts])])),
    };
}

function printDecision({ default: choice, terms }) {
    console.log("");
    for (const t of terms) {
        const note = t.skipped ? "skipped (an arm has no mutants)" : t.held ? "held" : "FAILED";
        console.log(`${t.name.padEnd(9)} plan ${fmt(t.plan)}  writing-plans ${fmt(t.writingPlans)}  ${t.rule}: ${note}`);
    }
    console.log(`\ndefault plan skill: ${choice}`);
}

function main(argv) {
    const opt = (name) => {
        const i = argv.indexOf(name);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const bench = opt("--bench");
    if (!bench) throw new Error("usage: verdict.mjs --bench <dir> [--db <waveterm.db>] [--transcripts <dir>]");

    // a lazy store: a bench with a missing file stops before the store is opened
    let store;
    const rowFor = (id) => {
        store ??= {
            db: openStore(opt("--db") ?? join(process.env.LOCALAPPDATA ?? "", "dev.arc.app", "data", "db", "waveterm.db")),
            idx: indexTranscripts(opt("--transcripts") ?? join(homedir(), ".claude", "projects")),
        };
        return runRow(store.db, id, store.idx);
    };
    const input = loadBench(bench, rowFor);
    console.log(renderTable(input.runs));
    printDecision(decide(input));
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
    try {
        main(process.argv.slice(2));
    } catch (e) {
        console.error(`verdict: ${e.message}`);
        process.exit(1);
    }
}
