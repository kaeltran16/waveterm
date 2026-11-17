// Blind pairwise review for the plan-skill bench: judges each pick's two finished arms against its spec
// without knowing which arm is which.
//
//   node scripts/bench/blindreview.mjs --bench <dir> --settings <claude settings.json>
//
// The diffs are written as blind/<pick>-X.diff and -Y.diff in a random order; the key that says which arm is
// which goes to results/blind-key.json and is read back only after every verdict is in.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ARMS = ["plan", "writing-plans"];
const SIDES = ["X", "Y"];
const MODEL = "claude-opus-5-5";
const CACHE_TTL = "5m";
const MAX_DIFF_BYTES = 512 * 1024 * 1024;
// the plan's form would reveal the skill that wrote it
const HIDDEN_PATHS = ["docs/superpowers/plans/", ".superpowers/"];
// the session variables of the Claude Code that runs this script: left in, the judge would join its session
// and run on its login instead of the API key the settings file supplies
const SESSION_VARS = [
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_PLUGIN_DIRS",
    "CLAUDE_CODE_EXECPATH",
];
const PROMPT_FILE = join(dirname(fileURLToPath(import.meta.url)), "blindreview-prompt.md");

export function armDiff(cwd, base, branch) {
    const excludes = HIDDEN_PATHS.map((p) => `:(exclude)${p}`);
    return execFileSync("git", ["diff", "--no-color", "--no-ext-diff", `${base}..${branch}`, "--", ".", ...excludes], {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_DIFF_BYTES,
    });
}

export function claudeEnv(env) {
    const out = { ...env };
    for (const name of SESSION_VARS) delete out[name];
    out.CLAUDE_CODE_PROMPT_CACHE_TTL = CACHE_TTL;
    return out;
}

export function buildPrompt(spec, diffs) {
    const sections = diffs.map(({ label, diff }) => `# Diff ${label}\n\n${diff}`);
    const parts = { SPEC: spec, DIFFS: sections.join("\n\n") };
    return readFileSync(PROMPT_FILE, "utf8").replace(/\{\{(SPEC|DIFFS)\}\}/g, (_, name) => parts[name]);
}

// the verdict is the last line; a model may fence it, so a fence line is not the last line
export function parseVerdict(reply, pick, order) {
    const lines = reply.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("```"));
    const last = lines.at(-1) ?? "";
    let verdict;
    try {
        verdict = JSON.parse(last);
    } catch {
        throw new Error(`blindreview: ${pick} (${order} order): last line is not a JSON verdict: ${JSON.stringify(last.slice(0, 200))}`);
    }
    if (![...SIDES, "tie"].includes(verdict?.winner)) {
        throw new Error(`blindreview: ${pick} (${order} order): winner must be "X", "Y" or "tie", got ${JSON.stringify(verdict?.winner)}`);
    }
    return { winner: verdict.winner, why: String(verdict.why ?? "") };
}

// an arm wins only when both orders pick it
export function combineOrders(first, second, key) {
    if (first !== second || first === "tie") return "tie";
    return key[first];
}

// run(prompt) -> the judge's reply text
export async function judgePick(pick, spec, diffs, run) {
    const shown = (labels) => labels.map((label) => ({ label, diff: diffs[label] }));
    const first = parseVerdict(await run(buildPrompt(spec, shown(["X", "Y"]))), pick, "first");
    const second = parseVerdict(await run(buildPrompt(spec, shown(["Y", "X"]))), pick, "second");
    return { first, second };
}

export function claudeRunner(settings, cwd) {
    return (prompt) =>
        new Promise((done, fail) => {
            const args = ["-p", "--model", MODEL, "--tools", "", "--settings", settings];
            const child = spawn("claude", args, { cwd, env: claudeEnv(process.env), stdio: ["pipe", "pipe", "pipe"] });
            let out = "";
            let err = "";
            child.stdout.on("data", (d) => (out += d));
            child.stderr.on("data", (d) => (err += d));
            child.on("error", fail);
            child.on("close", (code) =>
                code === 0 ? done(out) : fail(new Error(`blindreview: claude exited ${code}: ${err.trim().slice(0, 500)}`)),
            );
            child.stdin.end(prompt);
        });
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
};

function groupPicks(runs) {
    const picks = {};
    for (const row of runs) (picks[row.pick] ??= {})[row.arm] = row;
    for (const [pick, arms] of Object.entries(picks)) {
        const missing = ARMS.filter((arm) => !arms[arm]);
        if (missing.length) throw new Error(`blindreview: ${pick}: no runs.json row for arm ${missing.join(", ")}`);
    }
    return picks;
}

// rng() < 0.5 puts the plan arm on X
export async function reviewBench({ bench, run, rng = Math.random, log = () => {} }) {
    const picks = groupPicks(readJson(join(bench, "runs.json")));
    const keyPath = join(bench, "results", "blind-key.json");
    const key = {};
    const diffsByPick = {};
    for (const [pick, arms] of Object.entries(picks)) {
        const [x, y] = rng() < 0.5 ? ARMS : [...ARMS].reverse();
        key[pick] = { X: x, Y: y };
        diffsByPick[pick] = {};
        for (const side of SIDES) {
            const row = arms[key[pick][side]];
            const diff = armDiff(row.worktree, row.base, row.branch);
            diffsByPick[pick][side] = diff;
            mkdirSync(join(bench, "blind"), { recursive: true });
            writeFileSync(join(bench, "blind", `${pick}-${side}.diff`), diff);
        }
    }
    writeJson(keyPath, key);

    const verdicts = {};
    for (const pick of Object.keys(picks)) {
        const spec = readFileSync(join(bench, "specs", `${pick}.md`), "utf8");
        verdicts[pick] = await judgePick(pick, spec, diffsByPick[pick], run);
        for (const order of ["first", "second"]) log(`${pick} ${order}: ${verdicts[pick][order].winner}: ${verdicts[pick][order].why}`);
    }

    const sealed = readJson(keyPath);
    const result = {};
    for (const [pick, { first, second }] of Object.entries(verdicts)) {
        result[pick] = { first: first.winner, second: second.winner, winner: combineOrders(first.winner, second.winner, sealed[pick]) };
    }
    writeJson(join(bench, "results", "blind.json"), result);
    return result;
}

function option(argv, name) {
    const at = argv.indexOf(name);
    const value = at < 0 ? undefined : argv[at + 1];
    if (!value) throw new Error(`blindreview: ${name} <value> is required`);
    return value;
}

async function main(argv) {
    const bench = resolve(option(argv, "--bench"));
    const settings = resolve(option(argv, "--settings"));
    const result = await reviewBench({ bench, run: claudeRunner(settings, bench), log: console.log });
    for (const [pick, r] of Object.entries(result)) console.log(`${pick}: ${r.winner} (first ${r.first}, second ${r.second})`);
}

// run as a script, not when the test imports it; Windows may differ in the drive letter's case
const self = fileURLToPath(import.meta.url).toLowerCase();
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === self) {
    main(process.argv.slice(2)).catch((e) => {
        console.error(e.message);
        process.exit(1);
    });
}
