// Mutation score of the TS lines a tree added since a base commit, for the plan-skill bench.
// Stryker runs through npx with a config written to a temp dir, so the tree's package.json and lockfile never change.
// Writes the bench's shared mutation JSON (see docs/superpowers/plans/2026-11-17-plan-skill-bench.md).
// Usage: node scripts/bench/tsmutate.mjs --dir <tree> --base <sha> --out <file>
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// the vitest runner's peer dependency on core is an exact version, so both move together
const STRYKER_VERSION = "10.1.1";
// core rewrites the tsconfig's out-of-project paths for its sandbox by importing typescript, which it cannot resolve from
// the npx cache (npx skips a package the tree already has); this repo's tsconfig has none, so the rewrite is skipped by
// naming a file that does not exist
const NO_TSCONFIG = "tsmutate-skip-tsconfig-rewrite.json";
const TOOL = "stryker";
const TS_FILE = /\.tsx?$/;
const TEST_FILE = /\.(test|spec)\.tsx?$/;
// the generated files AGENTS.md lists: `task generate` writes them, nobody's tests target them
const GENERATED = new Set([
    "frontend/app/store/wshclientapi.ts",
    "frontend/app/store/services.ts",
    "frontend/types/gotypes.d.ts",
    "frontend/types/waveevent.d.ts",
]);
// junctions into the main checkout (worktree-junctions.mjs) that Stryker's sandbox copy would otherwise walk
const SANDBOX_IGNORE = ["src-tauri/target", "dist", ".superpowers"];
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const NEW_FILE = /^\+\+\+ (?:b\/(.*)|\/dev\/null)$/;
const STATUS = {
    Killed: "killed",
    Timeout: "timedOut",
    Survived: "survived",
    NoCoverage: "survived",
    CompileError: "invalid",
    RuntimeError: "invalid",
};

function git(cwd, args) {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) {
        throw new Error(`git ${args.join(" ")} in ${cwd} failed: ${(r.stderr || r.stdout).trim()}`);
    }
    return r.stdout;
}

function mutable(path) {
    return TS_FILE.test(path) && !TEST_FILE.test(path) && !GENERATED.has(path);
}

// Stryker `mutate` entries (`path:start-end`, 1-based, inclusive) for the lines base..HEAD added or changed
export function mutateRanges(dir, base) {
    const diff = git(dir, ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--unified=0", `${base}..HEAD`, "--", "*.ts", "*.tsx"]);
    const ranges = [];
    let path = null;
    for (const line of diff.split("\n")) {
        const file = NEW_FILE.exec(line);
        if (file) {
            path = file[1] && mutable(file[1]) ? file[1] : null;
            continue;
        }
        const hunk = path && HUNK.exec(line);
        if (!hunk) continue;
        const start = Number(hunk[1]);
        const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
        // a pure deletion leaves no new line to mutate
        if (count > 0) ranges.push(`${path}:${start}-${start + count - 1}`);
    }
    return ranges;
}

function reportPath(dir, file) {
    return (isAbsolute(file) ? relative(dir, file) : file).replaceAll("\\", "/");
}

function tally() {
    return { killed: 0, timedOut: 0, survived: 0, invalid: 0 };
}

function score({ killed, timedOut, survived }) {
    const total = killed + timedOut + survived;
    return total === 0 ? null : (killed + timedOut) / total;
}

function result({ base, head }, totals, files, survivors) {
    return { tool: TOOL, base, head, ...totals, score: score(totals), files, survivors };
}

// a Stryker mutation-testing-report JSON in the bench's shared mutation shape
export function toMutationJson(report, { base, head, dir = "." }) {
    const totals = tally();
    const files = [];
    const survivors = [];
    for (const [file, { mutants = [] }] of Object.entries(report.files ?? {})) {
        const path = reportPath(dir, file);
        const counts = tally();
        for (const m of mutants) {
            const key = STATUS[m.status];
            if (!key) continue;
            counts[key]++;
            totals[key]++;
            if (key === "survived") {
                survivors.push({ path, line: m.location?.start?.line ?? null, op: [m.mutatorName, m.replacement].filter(Boolean).join(": ") });
            }
        }
        files.push({ path, killed: counts.killed, timedOut: counts.timedOut, survived: counts.survived });
    }
    return result({ base, head }, totals, files, survivors);
}

export function strykerArgs(configPath) {
    return ["-y", "-p", `@stryker-mutator/core@${STRYKER_VERSION}`, "-p", `@stryker-mutator/vitest-runner@${STRYKER_VERSION}`, "stryker", "run", configPath];
}

// runs Stryker in dir on the given ranges and returns its parsed JSON report
function runStryker(dir, ranges) {
    const tmp = mkdtempSync(join(tmpdir(), "tsmutate-"));
    try {
        const reportFile = join(tmp, "mutation.json");
        const config = {
            testRunner: "vitest",
            mutate: ranges,
            coverageAnalysis: "perTest",
            reporters: ["json", "progress"],
            jsonReporter: { fileName: reportFile },
            ignorePatterns: SANDBOX_IGNORE,
            tsconfigFile: NO_TSCONFIG,
        };
        const configPath = join(tmp, "stryker.config.json");
        writeFileSync(configPath, JSON.stringify(config, null, 2));
        // npx is npx.cmd on windows, which node only spawns through a shell, given as one command line
        const r =
            process.platform === "win32"
                ? spawnSync(["npx", ...strykerArgs(`"${configPath}"`)].join(" "), { cwd: dir, stdio: "inherit", shell: true })
                : spawnSync("npx", strykerArgs(configPath), { cwd: dir, stdio: "inherit" });
        if (r.error) throw new Error(`starting npx stryker in ${dir} failed: ${r.error.message}`);
        if (r.status !== 0) throw new Error(`stryker in ${dir} exited ${r.status}`);
        return JSON.parse(readFileSync(reportFile, "utf8"));
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

export function run({ dir, base: ref, out }, stryker = runStryker) {
    const base = git(dir, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
    const head = git(dir, ["rev-parse", "HEAD"]).trim();
    const ranges = mutateRanges(dir, base);
    const json = ranges.length === 0 ? result({ base, head }, tally(), [], []) : toMutationJson(stryker(dir, ranges), { base, head, dir });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(json, null, 2) + "\n");
    return json;
}

function parseArgs(argv) {
    const opts = {};
    for (let i = 0; i < argv.length; i += 2) {
        const flag = argv[i];
        if (!["--dir", "--base", "--out"].includes(flag) || argv[i + 1] === undefined) {
            throw new Error(`unexpected argument ${flag}; usage: tsmutate.mjs --dir <tree> --base <sha> --out <file>`);
        }
        opts[flag.slice(2)] = argv[i + 1];
    }
    for (const k of ["dir", "base", "out"]) {
        if (!opts[k]) throw new Error(`missing --${k}; usage: tsmutate.mjs --dir <tree> --base <sha> --out <file>`);
    }
    return { dir: resolve(opts.dir), base: opts.base, out: resolve(opts.out) };
}

const self = fileURLToPath(import.meta.url).toLowerCase();
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === self) {
    try {
        const json = run(parseArgs(process.argv.slice(2)));
        console.log(`score ${json.score} (killed ${json.killed}, timedOut ${json.timedOut}, survived ${json.survived}, invalid ${json.invalid})`);
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}
