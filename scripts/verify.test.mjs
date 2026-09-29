import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FLAKY_MARKER, SHARDS, SHARD_MIN_TESTS, countTopLevelTests, dealShards, flakyLines, goSummary, goTestEnv, needsGoGraph, packageResults, partitionPackages, planVerify, readChanged, readChangedFile, rerunAlone, rerunnableTests, runPattern } from "./verify.mjs";

const MOD = "github.com/wavetermdev/waveterm";
const graph = [
    { importPath: `${MOD}/pkg/util`, deps: [], testImports: [] },
    { importPath: `${MOD}/pkg/orchestrate`, deps: [`${MOD}/pkg/util`], testImports: [] },
    { importPath: `${MOD}/pkg/wshrpc`, deps: [`${MOD}/pkg/orchestrate`, `${MOD}/pkg/util`], testImports: [] },
    { importPath: `${MOD}/pkg/jarvis`, deps: [], testImports: [`${MOD}/pkg/testkit`] },
    { importPath: `${MOD}/pkg/testkit`, deps: [`${MOD}/pkg/util`], testImports: [] },
    { importPath: `${MOD}/pkg/filestore`, deps: [`${MOD}/pkg/util`], testImports: [] },
];
const universe = new Set(graph.map((p) => p.importPath).filter((p) => !p.endsWith("filestore") && !p.endsWith("testkit")));

describe("planVerify", () => {
    it("tests a changed package and every package that imports it, within the patterns", () => {
        const plan = planVerify(["pkg/util/strings.go"], graph, universe, MOD);
        expect(plan.goAll).toBe(false);
        expect(plan.goPkgs).toEqual([`${MOD}/pkg/util`, `${MOD}/pkg/orchestrate`, `${MOD}/pkg/wshrpc`, `${MOD}/pkg/jarvis`]);
    });
    it("follows a test-only import to the package whose tests use it", () => {
        expect(planVerify(["pkg/testkit/kit.go"], graph, universe, MOD).goPkgs).toEqual([`${MOD}/pkg/jarvis`]);
    });
    it("runs every pattern when go.mod or go.sum changed", () => {
        expect(planVerify(["go.sum"], graph, universe, MOD).goAll).toBe(true);
    });
    it("tolerates a deleted package", () => {
        expect(planVerify(["pkg/gone/gone.go"], graph, universe, MOD).goPkgs).toEqual([]);
    });
    it("typechecks and runs the related vitest files for a frontend change", () => {
        const plan = planVerify(["frontend/app/view/agents/runmodel.ts"], graph, universe, MOD);
        expect(plan).toMatchObject({ tsc: true, vitest: ["frontend/app/view/agents/runmodel.ts"], goPkgs: [] });
    });
    it("runs all of vitest for a config change", () => {
        expect(planVerify(["package.json"], graph, universe, MOD)).toMatchObject({ tsc: true, vitest: "all" });
    });
    it("runs vitest, not tsc, for a script change", () => {
        expect(planVerify(["scripts/cdp/final-verify.mjs"], graph, universe, MOD)).toMatchObject({ tsc: false, vitest: ["scripts/cdp/final-verify.mjs"] });
    });
    it("maps a non-Go file to the Go package whose directory holds it", () => {
        expect(planVerify(["pkg/util/defaults/settings.json"], graph, universe, MOD).goPkgs).toEqual([`${MOD}/pkg/util`, `${MOD}/pkg/orchestrate`, `${MOD}/pkg/wshrpc`, `${MOD}/pkg/jarvis`]);
    });
    it("tests the Go package that embeds a script, and the script's own tests", () => {
        const plan = planVerify(["pkg/util/ext.ts"], graph, universe, MOD);
        expect(plan).toMatchObject({ tsc: true, vitest: ["pkg/util/ext.ts"] });
        expect(plan.goPkgs).toContain(`${MOD}/pkg/util`);
    });
    it("selects nothing for docs", () => {
        expect(planVerify(["docs/open-issues.md", "AGENTS.md"], graph, universe, MOD)).toEqual({ goAll: false, goPkgs: [], vitest: "none", tsc: false });
    });
});

describe("readChanged", () => {
    it("drops blanks and carriage returns and normalizes slashes", () => {
        expect(readChanged("pkg\\util\\a.go\r\n\r\ndocs/x.md\r\n")).toEqual(["pkg/util/a.go", "docs/x.md"]);
    });
});

describe("needsGoGraph", () => {
    it("lists the Go graph only for paths a Go package can hold", () => {
        expect(needsGoGraph(["docs/a.md", "frontend/app/x.ts", "package.json"])).toBe(false);
        expect(needsGoGraph(["db/migrations-wstore/000001_init.up.sql"])).toBe(true);
        expect(needsGoGraph(["pkg/util/a.go"])).toBe(true);
    });
});

describe("readChangedFile", () => {
    it("returns null for a list it cannot read, so Verify runs unscoped", () => {
        expect(readChangedFile(join(tmpdir(), "no-such-arc-verify-list.txt"))).toBeNull();
    });
});

describe("sharding", () => {
    it("counts top-level tests, not TestMain, helpers or methods", () => {
        const src = [
            "func TestMain(m *testing.M) {}",
            "func TestA(t *testing.T) {}",
            "func Test_b(t *testing.T) {}",
            "func Testhelper(t *testing.T) {}",
            "func (s *suite) TestC(t *testing.T) {}",
            "  func TestIndented(t *testing.T) {}",
            "func TestD (t *testing.T) {}",
        ].join("\n");
        expect(countTopLevelTests(src)).toBe(3);
    });
    it("deals names round robin and keeps order within a shard", () => {
        expect(dealShards(["a", "b", "c", "d", "e"], 2)).toEqual([["a", "c", "e"], ["b", "d"]]);
    });
    it("makes no empty shard when there are fewer names than shards", () => {
        expect(dealShards(["a", "b"], SHARDS)).toEqual([["a"], ["b"]]);
    });
    it("anchors the run pattern so TestA does not also run TestAB", () => {
        expect(runPattern(["TestA", "TestB"])).toBe("^(TestA|TestB)$");
    });
    it("summarizes a package like go test, so the engine's excerpt finds FAIL", () => {
        expect(goSummary("example.com/m/pkg/a", true, 1.5)).toBe("ok  \texample.com/m/pkg/a\t1.500s");
        expect(goSummary("example.com/m/pkg/a", false, 2)).toBe("FAIL\texample.com/m/pkg/a\t2.000s");
    });
    it("shards a package at the threshold and runs one below it plain", () => {
        const pkgs = [
            { importPath: "m/pkg/a", dir: "/a" },
            { importPath: "m/pkg/b", dir: "/b" },
        ];
        const counts = { "/a": SHARD_MIN_TESTS, "/b": SHARD_MIN_TESTS - 1 };
        const { sharded, plain } = partitionPackages(pkgs, (dir) => counts[dir]);
        expect(sharded.map((p) => p.importPath)).toEqual(["m/pkg/a"]);
        expect(plain.map((p) => p.importPath)).toEqual(["m/pkg/b"]);
    });
    it("runs a package go list could not resolve plain, without counting its tests", () => {
        const seen = [];
        const { sharded, plain } = partitionPackages([{ importPath: "m/pkg/gone", dir: "" }], (dir) => {
            seen.push(dir);
            return SHARD_MIN_TESTS;
        });
        expect(sharded).toEqual([]);
        expect(plain.map((p) => p.importPath)).toEqual(["m/pkg/gone"]);
        expect(seen).toEqual([]);
    });
});

describe("rerunning a failure alone", () => {
    it("names the failed top-level tests, not their subtests", () => {
        const out = [
            "--- FAIL: TestABatchOfOneFailsWithoutBisecting (0.41s)",
            "    verifybisect_test.go:129: today's wake, got []",
            "--- FAIL: TestTable (0.00s)",
            "    --- FAIL: TestTable/empty (0.00s)",
            "FAIL",
        ].join("\n");
        expect(rerunnableTests(out)).toEqual(["TestABatchOfOneFailsWithoutBisecting", "TestTable"]);
    });
    it("reruns nothing when the process died, since the tests after the failure never ran", () => {
        expect(rerunnableTests("--- FAIL: TestA (0.00s)\npanic: runtime error [recovered]\nFAIL")).toBeNull();
        expect(rerunnableTests("panic: test timed out after 10m0s\nrunning tests:\n\tTestA (10m0s)")).toBeNull();
    });
    it("reruns nothing for a failure with no failed test, such as a build error", () => {
        expect(rerunnableTests("# m/pkg/a\npkg/a/a.go:3:1: syntax error\nFAIL\tm/pkg/a [build failed]")).toBeNull();
    });
    it("splits go test's output into each package's result", () => {
        const out = [
            "ok  \tm/pkg/a\t0.5s",
            "--- FAIL: TestB (0.00s)",
            "FAIL",
            "FAIL\tm/pkg/b\t1.2s",
            "ok  \tm/pkg/c\t(cached)",
            "FAIL",
        ].join("\n");
        const results = packageResults(out);
        expect(results.map((r) => [r.pkg, r.ok])).toEqual([
            ["m/pkg/a", true],
            ["m/pkg/b", false],
            ["m/pkg/c", true],
        ]);
        expect(rerunnableTests(results[1].output)).toEqual(["TestB"]);
    });
});

describe("the flaky report", () => {
    it("prints one marker line per test that passed only on a rerun", () => {
        const flaky = [];
        expect(rerunAlone("m/pkg/a", ["TestX", "TestY"], flaky, () => ({ status: 0, stdout: "", stderr: "" }))).toBe(true);
        expect(flakyLines(flaky)).toEqual([`${FLAKY_MARKER} m/pkg/a TestX`, `${FLAKY_MARKER} m/pkg/a TestY`]);
        expect(FLAKY_MARKER).toBe("ARC_VERIFY_FLAKY:");
    });
    it("reports nothing for a test that failed again, or a run with no rerun", () => {
        const flaky = [];
        expect(rerunAlone("m/pkg/a", ["TestX"], flaky, () => ({ status: 1, stdout: "", stderr: "" }))).toBe(false);
        expect(flakyLines(flaky)).toEqual([]);
        expect(flakyLines([])).toEqual([]);
    });
});

describe("goTestEnv", () => {
    it("turns cgo on with zig on Windows, so the sqlite tests run", () => {
        expect(goTestEnv({ PATH: "p" }, "win32", "x64")).toEqual({
            PATH: "p",
            CGO_ENABLED: "1",
            CC: "zig cc -target x86_64-windows-gnu",
        });
        expect(goTestEnv({}, "win32", "arm64").CC).toBe("zig cc -target aarch64-windows-gnu");
    });

    it("leaves a caller's CC and other platforms alone", () => {
        const env = { CC: "gcc" };
        expect(goTestEnv(env, "win32", "x64")).toBe(env);
        const linux = { PATH: "p" };
        expect(goTestEnv(linux, "linux", "x64")).toBe(linux);
    });
});
