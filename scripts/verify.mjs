// Verify for this repo's engine plans. At each merge the engine sets ARC_VERIFY_CHANGED to a file listing the
// paths the merge changed; this tests only what those paths can break. Unset (the final stage, or a human), it
// runs everything the patterns name. A failed Go test that passes when rerun alone is flaky: the run passes, and
// the test is appended to the file ARC_VERIFY_FLAKY names, so the engine reports it instead of a clean pass.
//
// usage: node scripts/verify.mjs <go package pattern>...

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// a change to one of these can move any test's outcome
const FRONTEND_CONFIG = new Set(["package.json", "package-lock.json", "vitest.config.ts", "tsconfig.json"]);
const TS_FILE = /\.(ts|tsx)$/;
const JS_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
// the module's Go packages live under these; a path elsewhere cannot change what a Go test sees
const GO_DIRS = /^(pkg|cmd|db)\//;
// a package with at least this many top-level tests is split across processes: here those take 2.6 to 110 s, and
// below it all but one run in seconds
export const SHARD_MIN_TESTS = 100;
// pkg/orchestrate took ~100 s in one process, 37-52 s in 4, and 33 s in 6
export const SHARDS = 4;
const TOP_LEVEL_TEST = /^func (Test[A-Z0-9_]\w*)\s*\(/gm;
const LISTED_TEST = /^(Test|Example|Fuzz)\w*$/;

// needsGoGraph reports whether a Go package can hold one of the paths: listing the module's graph takes tens of
// seconds, and a merge of docs or frontend files cannot reach a Go test.
export function needsGoGraph(changed) {
    return changed.some((p) => p.endsWith(".go") || GO_DIRS.test(p));
}

// readChangedFile reads the engine's list, or returns null when it cannot, so Verify runs unscoped, never fails.
export function readChangedFile(path) {
    try {
        return readChanged(readFileSync(path, "utf8"));
    } catch (e) {
        console.error(`verify: could not read the changed-path list ${path}: ${e.message}; running everything`);
        return null;
    }
}

export function readChanged(text) {
    return text
        .split("\n")
        .map((l) => l.replace(/\r$/, "").trim().replace(/\\/g, "/"))
        .filter(Boolean);
}

export function planVerify(changed, graph, universe, modulePath) {
    const plan = { goAll: false, goPkgs: [], vitest: "none", tsc: false };
    const changedPkgs = new Set();
    const related = [];
    const pkgs = new Set(graph.map((p) => p.importPath));
    for (const path of changed) {
        if (path === "go.mod" || path === "go.sum") {
            plan.goAll = true;
            continue;
        }
        if (!path.endsWith(".go")) {
            // an embedded file (a migration, a default config, a script wsh ships) changes the package holding it
            const owner = owningPackage(path, pkgs, modulePath);
            if (owner) {
                changedPkgs.add(owner);
            }
        }
        if (path.endsWith(".go")) {
            const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
            changedPkgs.add(dir ? `${modulePath}/${dir}` : modulePath);
        } else if (FRONTEND_CONFIG.has(path)) {
            plan.tsc = true;
            plan.vitest = "all";
        } else if (JS_FILE.test(path)) {
            plan.tsc ||= TS_FILE.test(path);
            related.push(path);
        }
    }
    if (plan.vitest !== "all" && related.length > 0) {
        plan.vitest = related;
    }
    if (!plan.goAll) {
        // deps are transitive, so one pass finds every package a change reaches; test imports are direct only,
        // so they are matched against that reached set
        const reached = new Set(graph.filter((p) => changedPkgs.has(p.importPath) || p.deps.some((d) => changedPkgs.has(d))).map((p) => p.importPath));
        plan.goPkgs = graph
            .filter((p) => universe.has(p.importPath) && (reached.has(p.importPath) || p.testImports.some((i) => reached.has(i))))
            .map((p) => p.importPath);
    }
    return plan;
}

// owningPackage is the Go package in the nearest directory above path, never the module root, which would
// claim every file in the repo.
function owningPackage(path, pkgs, modulePath) {
    let dir = path.slice(0, Math.max(path.lastIndexOf("/"), 0));
    while (dir) {
        if (pkgs.has(`${modulePath}/${dir}`)) {
            return `${modulePath}/${dir}`;
        }
        dir = dir.slice(0, Math.max(dir.lastIndexOf("/"), 0));
    }
    return null;
}

export function countTopLevelTests(source) {
    return [...source.matchAll(TOP_LEVEL_TEST)].filter((m) => m[1] !== "TestMain").length;
}

export function dealShards(names, n) {
    const shards = Array.from({ length: Math.min(n, names.length) }, () => []);
    names.forEach((name, i) => shards[i % shards.length].push(name));
    return shards;
}

export function runPattern(names) {
    return `^(${names.join("|")})$`;
}

export function goSummary(pkg, ok, seconds) {
    return `${ok ? "ok  " : "FAIL"}\t${pkg}\t${seconds.toFixed(3)}s`;
}

// a top-level test's failure; a subtest's line is indented, and rerunning its parent reruns it
const FAILED_TEST = /^--- FAIL: (\S+) \(/gm;
// a failure that stopped the process, so the tests after it never ran and a rerun of the named ones proves nothing
const PROCESS_DIED = /^panic: |^\*\*\* Test killed|test timed out after/m;
const PACKAGE_RESULT = /^(ok\s*|FAIL)\t(\S+)/;

// rerunnableTests names the failed tests of one package's output when rerunning them alone can settle a flake, or
// returns null: a build error, a panic or a timeout names no test to rerun, or stopped the tests after it.
export function rerunnableTests(output) {
    if (PROCESS_DIED.test(output)) {
        return null;
    }
    const names = [...output.matchAll(FAILED_TEST)].map((m) => m[1]);
    return names.length > 0 ? names : null;
}

// packageResults splits go test's output into each package's lines, ending at its ok or FAIL line.
export function packageResults(output) {
    const results = [];
    let lines = [];
    for (const line of output.split("\n")) {
        lines.push(line);
        const m = line.match(PACKAGE_RESULT);
        if (m) {
            results.push({ pkg: m[2], ok: m[1].trim() === "ok", output: lines.join("\n") });
            lines = [];
        }
    }
    return results;
}

// partitionPackages splits the packages into those whose tests are dealt across SHARDS processes and those run by
// one plain go test. a package go list could not resolve has no dir; go test reports why.
export function partitionPackages(pkgs, countOf) {
    const sharded = pkgs.filter((p) => p.dir && countOf(p.dir) >= SHARD_MIN_TESTS);
    const plain = pkgs.filter((p) => !sharded.includes(p));
    return { sharded, plain };
}

// goTestEnv turns cgo on for go test: the store's tests need sqlite, and without a C compiler on PATH go falls back
// to cgo off and every one of them panics. On Windows the compiler is zig, the same one the Taskfile builds wavesrv
// with; a CC the caller set wins.
export function goTestEnv(env, platform, arch) {
    if (platform !== "win32" || env.CC) {
        return env;
    }
    const target = arch === "arm64" ? "aarch64-windows-gnu" : "x86_64-windows-gnu";
    return { ...env, CGO_ENABLED: "1", CC: `zig cc -target ${target}` };
}

function run(cmd, args, env = process.env) {
    console.log(`verify: ${cmd} ${args.join(" ")}`);
    const r = spawnSync(cmd, args, { stdio: "inherit", env });
    if (r.error) {
        console.error(`verify: could not run ${cmd}: ${r.error.message}`);
        process.exit(1);
    }
    if (r.status !== 0) {
        process.exit(r.status ?? 1);
    }
}

function goList(args) {
    const r = spawnSync("go", ["list", "-e", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) {
        console.error(`verify: go list ${args.join(" ")} failed:\n${r.stderr}`);
        process.exit(1);
    }
    return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

function goGraph() {
    const sep = "\t";
    const fmt = `{{.ImportPath}}${sep}{{join .Deps " "}}${sep}{{join .TestImports " "}} {{join .XTestImports " "}}`;
    return goList(["-f", fmt, "./..."]).map((line) => {
        const [importPath, deps = "", tests = ""] = line.split(sep);
        return { importPath, deps: deps.split(" ").filter(Boolean), testImports: tests.split(" ").filter(Boolean) };
    });
}

function goPackages(args) {
    return goList(["-f", "{{.ImportPath}}\t{{.Dir}}", ...args]).map((line) => {
        const [importPath, dir = ""] = line.split("\t");
        return { importPath, dir };
    });
}

function testSource(dir) {
    return readdirSync(dir)
        .filter((f) => f.endsWith("_test.go"))
        .map((f) => readFileSync(join(dir, f), "utf8"))
        .join("\n");
}

// goTest runs the packages like go test, except that a package with many tests is built once and its tests are
// dealt across SHARDS processes; go test runs one package's tests in one process however many cores are idle.
async function goTest(args) {
    const env = goTestEnv(process.env, process.platform, process.arch);
    const { sharded, plain } = partitionPackages(goPackages(args), (dir) => countTopLevelTests(testSource(dir)));
    const flaky = [];
    let failed = plain.length > 0 && !goTestPlain(plain.map((p) => p.importPath), env, flaky);
    if (!failed && sharded.length > 0) {
        const tmp = mkdtempSync(join(tmpdir(), "arc-verify-"));
        try {
            for (const [i, pkg] of sharded.entries()) {
                const bin = join(tmp, `${i}.test${process.platform === "win32" ? ".exe" : ""}`);
                failed = !(await runSharded(pkg, bin, env, flaky)) || failed;
            }
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    }
    if (flaky.length > 0) {
        console.log(`verify: flaky, failed and then passed when rerun alone: ${flaky.join(", ")}`);
    }
    if (failed) {
        process.exit(1);
    }
    reportFlaky(flaky, process.env);
}

// reportFlaky appends each flaky test, one per line, to the file the engine names in ARC_VERIFY_FLAKY, so the run
// names them among what it did not verify instead of reading as a clean pass. A human's run has no file to write.
export function reportFlaky(flaky, env) {
    const file = env.ARC_VERIFY_FLAKY;
    if (!file || flaky.length === 0) {
        return;
    }
    appendFileSync(file, flaky.map((name) => `${name}\n`).join(""));
}

const OUTPUT_MAX = 256 * 1024 * 1024;

// rerunAlone reruns a package's failed tests once, in one process. Passing alone, they failed on what another test
// left behind or on load, so they are reported as flaky rather than failing the merge and costing a fix round;
// failing again, the failure is real.
function rerunAlone(pkg, names, flaky, spawnRerun) {
    if (names == null) {
        return false;
    }
    console.log(`verify: rerunning ${names.join(", ")} of ${pkg} alone`);
    const r = spawnRerun(runPattern(names));
    process.stdout.write(r.stdout ?? "");
    process.stderr.write(r.stderr ?? "");
    if (r.error || r.status !== 0) {
        return false;
    }
    flaky.push(...names.map((n) => `${pkg} ${n}`));
    return true;
}

function goTestPlain(pkgs, env, flaky) {
    console.log(`verify: go test ${pkgs.join(" ")}`);
    const r = spawnSync("go", ["test", ...pkgs], { env, encoding: "utf8", maxBuffer: OUTPUT_MAX });
    if (r.error) {
        console.error(`verify: could not run go: ${r.error.message}`);
        return false;
    }
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    if (r.status === 0) {
        return true;
    }
    const failures = packageResults(r.stdout).filter((p) => !p.ok);
    return (
        failures.length > 0 &&
        failures.every((p) =>
            rerunAlone(p.pkg, rerunnableTests(p.output), flaky, (pattern) =>
                spawnSync("go", ["test", "-count=1", "-run", pattern, p.pkg], {
                    env,
                    encoding: "utf8",
                    maxBuffer: OUTPUT_MAX,
                })
            )
        )
    );
}

async function runSharded(pkg, bin, env, flaky) {
    console.log(`verify: go test -c -o ${bin} ${pkg.importPath}, then ${SHARDS} processes`);
    const start = Date.now();
    const built = spawnSync("go", ["test", "-c", "-o", bin, pkg.importPath], { stdio: "inherit", env });
    if (built.error || built.status !== 0) {
        console.error(`verify: could not build the tests of ${pkg.importPath}${built.error ? `: ${built.error.message}` : ""}`);
        console.log(`FAIL\t${pkg.importPath} [build failed]`);
        return false;
    }
    // a TestMain logs to stderr, so stdout holds only the names
    const listed = spawnSync(bin, ["-test.list", "."], { cwd: pkg.dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (listed.error || listed.status !== 0) {
        console.error(`verify: could not list the tests of ${pkg.importPath}:\n${listed.error?.message ?? listed.stderr}`);
        console.log(goSummary(pkg.importPath, false, (Date.now() - start) / 1000));
        return false;
    }
    const names = listed.stdout.split("\n").map((l) => l.trim()).filter((l) => LISTED_TEST.test(l));
    const results = await Promise.all(dealShards(names, SHARDS).map((shard) => runShard(bin, pkg.dir, shard)));
    for (const r of results) {
        process.stdout.write(r.output);
    }
    const ok = results
        .filter((r) => !r.ok)
        .every((r) =>
            rerunAlone(pkg.importPath, rerunnableTests(r.output), flaky, (pattern) =>
                spawnSync(bin, ["-test.run", pattern, "-test.timeout=10m"], {
                    cwd: pkg.dir,
                    encoding: "utf8",
                    maxBuffer: OUTPUT_MAX,
                })
            )
        );
    console.log(goSummary(pkg.importPath, ok, (Date.now() - start) / 1000));
    return ok;
}

function runShard(bin, dir, names) {
    return new Promise((done) => {
        const chunks = [];
        const child = spawn(bin, ["-test.run", runPattern(names), "-test.timeout=10m"], { cwd: dir });
        child.stdout.on("data", (c) => chunks.push(c));
        child.stderr.on("data", (c) => chunks.push(c));
        child.on("error", (e) => done({ ok: false, output: `verify: could not run ${bin}: ${e.message}\n` }));
        child.on("close", (code) => done({ ok: code === 0, output: Buffer.concat(chunks).toString("utf8") }));
    });
}

const VITEST = ["node_modules/vitest/vitest.mjs", "run"];
const TSC = ["--stack-size=4000", "node_modules/typescript/lib/tsc.js", "--noEmit"];

async function main(patterns) {
    if (patterns.length === 0) {
        console.error("usage: node scripts/verify.mjs <go package pattern>...");
        process.exit(2);
    }
    const listFile = process.env.ARC_VERIFY_CHANGED;
    const changed = listFile ? readChangedFile(listFile) : null;
    if (!changed) {
        await goTest(patterns);
        run("node", VITEST);
        return;
    }
    const modulePath = readFileSync("go.mod", "utf8").match(/^module\s+(\S+)/m)[1];
    const goChanged = needsGoGraph(changed);
    const graph = goChanged ? goGraph() : [];
    const universe = goChanged ? new Set(goList(patterns)) : new Set();
    const plan = planVerify(changed, graph, universe, modulePath);
    const goArgs = plan.goAll ? patterns : plan.goPkgs;
    if (goArgs.length === 0 && plan.vitest === "none" && !plan.tsc) {
        console.log(`verify: nothing to test for the ${changed.length} changed path(s)`);
        return;
    }
    if (goArgs.length > 0) {
        await goTest(goArgs);
    }
    if (plan.tsc) {
        run("node", TSC);
    }
    if (plan.vitest === "all") {
        run("node", VITEST);
    } else if (Array.isArray(plan.vitest)) {
        // vitest related takes source files and runs the tests that import them; a deleted file is in no import
        // graph, so the tests that imported it are found only by running everything
        const present = plan.vitest.filter((p) => existsSync(p));
        if (present.length < plan.vitest.length) {
            run("node", VITEST);
        } else {
            run("node", ["node_modules/vitest/vitest.mjs", "related", "--run", ...present]);
        }
    }
}

// run as a script, not when the test imports it; Windows may differ in the drive letter's case
const self = fileURLToPath(import.meta.url).toLowerCase();
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === self) {
    main(process.argv.slice(2)).catch((e) => {
        console.error(`verify: ${e.stack ?? e}`);
        process.exit(1);
    });
}
