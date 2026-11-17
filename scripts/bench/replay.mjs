// Replay harness for the plan-skill bench (spec 2026-11-16-slim-superpowers-design, Decisions 8 and 9): starts one
// orchestrator run per plan skill for a pinned pick, each in its own worktree of the main checkout at the pick's
// base, with run:planskill flipped in the packaged app's settings only until the run records it.
// Must run from an Arc terminal: wsh needs its RPC environment.
// Usage: node scripts/bench/replay.mjs start --bench <dir> --pick <id> | status --bench <dir> | cleanup --bench <dir>
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const ARMS = ["plan", "writing-plans"];
const PLAN_SKILL_KEY = "run:planskill";
const PICK_FIELDS = ["id", "originalRun", "base", "specCommit", "specPath"];
const PICKS_FILE = fileURLToPath(new URL("./plan-skill-picks.json", import.meta.url));
const LOCALAPPDATA = process.env.LOCALAPPDATA || "";
// the packaged app's local layer, which overrides the vault's settings
const SETTINGS_PATH = join(LOCALAPPDATA, "dev.arc.app", "config", "settings.json");
const WAVESRV_PATH = join(LOCALAPPDATA, "Arc", "bin", "wavesrv.x64.exe");
const ROUTE = ["--runtime", "claude", "--model", "opus", "--worker-runtime", "claude", "--worker-model", "opus", "--reviewer-runtime", "claude", "--reviewer-model", "opus"];
const PARALLELISM = "3";

function sh(cmd, args, cwd) {
    const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
    if (r.error) throw new Error(`${cmd} ${args.join(" ")}: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}: ${(r.stderr || r.stdout).trim()}`);
    return r.stdout;
}

function readSettings(path) {
    if (!existsSync(path)) return {};
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
        throw new Error(`${path}: ${e.message}`);
    }
}

const writeSettings = (path, obj) => writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");

// sets run:planskill to arm while fn runs, then puts the key back as it was (absent stays absent); the file is
// re-read at restore so a key the app wrote meanwhile survives
export function withPlanSkill(settingsPath, arm, fn) {
    const existed = existsSync(settingsPath);
    const before = readSettings(settingsPath);
    const had = PLAN_SKILL_KEY in before;
    const prior = before[PLAN_SKILL_KEY];
    writeSettings(settingsPath, { ...before, [PLAN_SKILL_KEY]: arm });
    try {
        return fn();
    } finally {
        const now = readSettings(settingsPath);
        if (had) now[PLAN_SKILL_KEY] = prior;
        else delete now[PLAN_SKILL_KEY];
        if (!existed && Object.keys(now).length === 0) unlinkSync(settingsPath);
        else writeSettings(settingsPath, now);
    }
}

export function startArgs({ goal, worktree, spec, prototype }) {
    const args = ["runs", "start", goal, "--mode", "orchestrator", "--project", worktree, "--spec", spec];
    if (prototype) args.push("--prototype", prototype);
    return [...args, ...ROUTE, "--autonomous", "--parallelism", PARALLELISM, "--json"];
}

export function arcBuild(path) {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function loadPicks(path = PICKS_FILE) {
    return JSON.parse(readFileSync(path, "utf8"));
}

function findPick(picks, id) {
    const pick = picks.find((p) => p.id === id);
    if (!pick) throw new Error(`unknown pick ${JSON.stringify(id)}; known: ${picks.map((p) => p.id).join(", ")}`);
    const missing = PICK_FIELDS.filter((f) => typeof pick[f] !== "string" || pick[f] === "");
    // prototype is pinned explicitly: null for a pick without one
    if (!("prototype" in pick) || (pick.prototype !== null && (typeof pick.prototype !== "string" || pick.prototype === ""))) {
        missing.push("prototype");
    }
    if (missing.length) throw new Error(`pick ${id} is missing ${missing.join(", ")}`);
    return pick;
}

const runsFile = (bench) => join(bench, "runs.json");
const readRows = (bench) => (existsSync(runsFile(bench)) ? JSON.parse(readFileSync(runsFile(bench), "utf8")) : []);

function appendRow(bench, row) {
    writeFileSync(runsFile(bench), JSON.stringify([...readRows(bench), row], null, 2));
}

function specTitle(text, pickId) {
    const m = text.match(/^# +(.+?)\s*$/m);
    if (!m) throw new Error(`spec for pick ${pickId} has no H1 to name the goal`);
    return m[1];
}

// a lead that finds the feature on main otherwise takes the spec for shipped work and lands nothing (a08ba9b8)
export function replayGoal(title, base) {
    return (
        `Build ${title}. This is a plan-skill benchmark replay from base ${base}: the spec shipped on main later, ` +
        `and this run rebuilds it from that base. Build it in this tree as if it had not shipped; do not stop ` +
        `because main has it, and do not read main, other branches or other worktrees for its code.`
    );
}

function parseJson(text, what) {
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error(`${what} did not print JSON (${e.message}): ${text.trim()}`);
    }
}

function startArm({ bench, pick, arm, main, specText, goal, build, settingsPath, run }) {
    const branch = `bench/${pick.id}-${arm}`;
    const worktree = join(bench, "wt", `${pick.id}-${arm}`);
    run("git", ["worktree", "add", "-b", branch, worktree, pick.base], main);
    // the main checkout's current junction script, not the older copy at the pick's base
    run(process.execPath, [join(main, "scripts", "worktree-junctions.mjs"), "prepare"], worktree);
    // the engine commits the spec into the run's branch at submit, so it must sit inside the repository
    const specFile = join(worktree, pick.specPath);
    mkdirSync(dirname(specFile), { recursive: true });
    writeFileSync(specFile, specText);
    const prototype = pick.prototype ? join(main, pick.prototype) : null;
    const startedTs = Date.now();
    const out = withPlanSkill(settingsPath, arm, () => run("wsh", startArgs({ goal, worktree, spec: specFile, prototype }), worktree));
    const runId = parseJson(out, "wsh runs start").id;
    const shown = parseJson(run("wsh", ["runs", "show", runId, "--json"]), `wsh runs show ${runId}`);
    const recorded = shown.run?.planskill ?? "";
    if (recorded !== arm) {
        let cancelled = "cancelled";
        try {
            run("wsh", ["runs", "cancel", runId, "--yes"]);
        } catch (e) {
            cancelled = `not cancelled (${e.message}); cancel it by hand`;
        }
        throw new Error(`run ${runId} recorded plan skill ${JSON.stringify(recorded)}, not the arm ${JSON.stringify(arm)}; ${cancelled}`);
    }
    appendRow(bench, { pick: pick.id, arm, runId, base: pick.base, branch, worktree, spec: specFile, arcBuild: build, startedTs });
    return runId;
}

export function start({ bench, pickId, picks = loadPicks(), main, settingsPath = SETTINGS_PATH, wavesrvPath = WAVESRV_PATH, run = sh }) {
    const pick = findPick(picks, pickId);
    const build = arcBuild(wavesrvPath);
    const first = readRows(bench)[0];
    if (first && first.arcBuild !== build) {
        throw new Error(`installed Arc build ${build} (${wavesrvPath}) differs from the first run's ${first.arcBuild}; the bench compares one build`);
    }
    mkdirSync(join(bench, "specs"), { recursive: true });
    const specText = run("git", ["show", `${pick.specCommit}:${pick.specPath}`], main);
    // the judges' copy; each run gets its own inside its worktree
    writeFileSync(join(bench, "specs", `${pick.id}.md`), specText);
    const goal = replayGoal(specTitle(specText, pick.id), pick.base);
    return ARMS.map((arm) => startArm({ bench, pick, arm, main, specText, goal, build, settingsPath, run }));
}

export function status({ bench, run = sh }) {
    return readRows(bench).map((r) => {
        let state;
        try {
            state = parseJson(run("wsh", ["runs", "show", r.runId, "--json"]), `wsh runs show ${r.runId}`).run?.status ?? "?";
        } catch (e) {
            state = `error: ${e.message}`;
        }
        return `${r.pick}  ${r.arm}  ${r.runId}  ${state}`;
    });
}

export function cleanup({ bench, main, run = sh }) {
    const failed = [];
    for (const r of readRows(bench)) {
        if (!existsSync(r.worktree)) {
            console.log(`${r.worktree}: already gone`);
            continue;
        }
        try {
            // the task unlinks the junctions before removing the tree, and keeps an unmerged branch
            run("task", ["worktree:cleanup", "--", r.worktree], main);
        } catch (e) {
            failed.push(`${r.worktree}: ${e.message}`);
        }
    }
    if (failed.length) throw new Error(`cleanup failed for:\n${failed.join("\n")}`);
}

// the first entry of `git worktree list` is always the main checkout
function mainCheckout() {
    const first = sh("git", ["worktree", "list", "--porcelain"], dirname(PICKS_FILE)).split("\n")[0];
    return resolve(first.replace(/^worktree /, ""));
}

function runCli(argv) {
    const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { bench: { type: "string" }, pick: { type: "string" } } });
    const [cmd] = positionals;
    if (!values.bench || !["start", "status", "cleanup"].includes(cmd) || (cmd === "start" && !values.pick)) {
        console.error("usage: node scripts/bench/replay.mjs start --bench <dir> --pick <id> | status --bench <dir> | cleanup --bench <dir>");
        process.exitCode = 2;
        return;
    }
    const bench = resolve(values.bench);
    if (cmd === "start") {
        const ids = start({ bench, pickId: values.pick, main: mainCheckout() });
        console.log(`started ${ids.map((id, i) => `${ARMS[i]} ${id}`).join(", ")}`);
    } else if (cmd === "status") {
        for (const line of status({ bench })) console.log(line);
    } else {
        cleanup({ bench, main: mainCheckout() });
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        runCli(process.argv.slice(2));
    } catch (e) {
        console.error(e.message);
        process.exitCode = 1;
    }
}
