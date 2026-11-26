import { describe, expect, it } from "vitest";
import { failureLabel, isTestCommand, parseTestOutput } from "./testoutput";

const J = (o: Record<string, unknown>) => JSON.stringify(o);

describe("parseTestOutput go test -json", () => {
    const out = [
        J({ Action: "start", Package: "pkg/jarvis" }),
        J({ Action: "run", Package: "pkg/jarvis", Test: "TestPlanParse" }),
        J({ Action: "output", Package: "pkg/jarvis", Test: "TestPlanParse", Output: "=== RUN   TestPlanParse\n" }),
        J({ Action: "pass", Package: "pkg/jarvis", Test: "TestPlanParse", Elapsed: 0 }),
        J({ Action: "run", Package: "pkg/jarvis", Test: "TestPlanParseFencedBullet" }),
        J({
            Action: "output",
            Package: "pkg/jarvis",
            Test: "TestPlanParseFencedBullet",
            Output: "    plan_test.go:88: want 3 tasks, got 1\n",
        }),
        J({
            Action: "output",
            Package: "pkg/jarvis",
            Test: "TestPlanParseFencedBullet",
            Output: "        the fence opened in a bullet\n",
        }),
        J({ Action: "output", Package: "pkg/jarvis", Test: "TestPlanParseFencedBullet", Output: "debug: 1 task\n" }),
        J({
            Action: "output",
            Package: "pkg/jarvis",
            Test: "TestPlanParseFencedBullet",
            Output: '    plan_test.go:91: want task 2 named "Land"\n',
        }),
        J({
            Action: "output",
            Package: "pkg/jarvis",
            Test: "TestPlanParseFencedBullet",
            Output: "--- FAIL: TestPlanParseFencedBullet (0.00s)\n",
        }),
        J({ Action: "fail", Package: "pkg/jarvis", Test: "TestPlanParseFencedBullet", Elapsed: 0 }),
        J({ Action: "run", Package: "pkg/jarvis", Test: "TestSlow" }),
        J({ Action: "skip", Package: "pkg/jarvis", Test: "TestSlow", Elapsed: 0 }),
        J({ Action: "fail", Package: "pkg/jarvis", Elapsed: 0.2 }),
        J({ Action: "run", Package: "pkg/wstore", Test: "TestA" }),
        J({ Action: "pass", Package: "pkg/wstore", Test: "TestA" }),
        J({ Action: "run", Package: "pkg/wstore", Test: "TestB" }),
        J({ Action: "skip", Package: "pkg/wstore", Test: "TestB" }),
        J({ Action: "pass", Package: "pkg/wstore", Elapsed: 0.1 }),
    ].join("\n");

    it("counts tests and lists the failure with its package, whole message and first location", () => {
        expect(parseTestOutput(out)).toEqual({
            runner: "go",
            unit: "test",
            pass: 2,
            fail: 1,
            skip: 2,
            failures: [
                {
                    pkg: "pkg/jarvis",
                    test: "TestPlanParseFencedBullet",
                    message:
                        'want 3 tasks, got 1\nthe fence opened in a bullet\ndebug: 1 task\nplan_test.go:91: want task 2 named "Land"',
                    loc: "plan_test.go:88",
                },
            ],
        });
    });

    it("lists only the failing subtest, not its failing parent", () => {
        const sub = [
            J({ Action: "run", Package: "p", Test: "TestX" }),
            J({ Action: "output", Package: "p", Test: "TestX/case", Output: "    x_test.go:9: bad\n" }),
            J({ Action: "fail", Package: "p", Test: "TestX/case" }),
            J({ Action: "fail", Package: "p", Test: "TestX" }),
            J({ Action: "fail", Package: "p" }),
        ].join("\n");
        const s = parseTestOutput(sub);
        expect(s?.fail).toBe(2);
        expect(s?.failures).toEqual([{ pkg: "p", test: "TestX/case", message: "bad", loc: "x_test.go:9" }]);
    });
});

describe("parseTestOutput go test -v", () => {
    const out = [
        "=== RUN   TestPlanParse",
        "--- PASS: TestPlanParse (0.00s)",
        "=== RUN   TestPlanParseFencedBullet",
        "    plan_test.go:88: want 3 tasks, got 1",
        "        more detail",
        "--- FAIL: TestPlanParseFencedBullet (0.00s)",
        "=== RUN   TestSlow",
        "    plan_test.go:120: slow",
        "--- SKIP: TestSlow (0.00s)",
        "FAIL",
        "FAIL\tpkg/jarvis\t0.214s",
        "=== RUN   TestA",
        "--- PASS: TestA (0.00s)",
        "PASS",
        "ok  \tpkg/wstore\t0.101s",
    ].join("\n");

    it("counts tests and attributes the failure, its continuation line included, to the package line after it", () => {
        expect(parseTestOutput(out)).toEqual({
            runner: "go",
            unit: "test",
            pass: 2,
            fail: 1,
            skip: 1,
            failures: [
                {
                    pkg: "pkg/jarvis",
                    test: "TestPlanParseFencedBullet",
                    message: "want 3 tasks, got 1\nmore detail",
                    loc: "plan_test.go:88",
                },
            ],
        });
    });

    it("counts a 20,000-line output", () => {
        const lines: string[] = [];
        for (let i = 0; i < 10_000; i++) {
            const verdict = i % 1000 === 0 ? "FAIL" : i % 100 === 0 ? "SKIP" : "PASS";
            lines.push(`=== RUN   Test${i}`, `--- ${verdict}: Test${i} (0.00s)`);
        }
        lines.push("FAIL\tpkg/big\t9.9s");
        const s = parseTestOutput(lines.join("\n"));
        expect(s).toMatchObject({ runner: "go", unit: "test", pass: 9_900, fail: 10, skip: 90 });
        expect(s?.failures).toHaveLength(10);
        expect(s?.failures[0]).toMatchObject({ pkg: "pkg/big", test: "Test0" });
    });
});

describe("parseTestOutput plain go test", () => {
    it("counts packages, reads the failed test's whole message but not go's own lines, and skips packages with no test files", () => {
        const out = [
            "--- FAIL: TestPlanParseFencedBullet (0.00s)",
            "    plan_test.go:88: want 3 tasks, got 1",
            "    plan_test.go:95: the fence opened twice",
            "FAIL",
            "exit status 1",
            "FAIL\tpkg/jarvis\t0.214s",
            "ok  \tpkg/wstore\t0.101s",
            "ok  \tpkg/wshrpc\t(cached)",
            "?   \tpkg/util\t[no test files]",
            "FAIL",
        ].join("\n");
        expect(parseTestOutput(out)).toEqual({
            runner: "go",
            unit: "package",
            pass: 2,
            fail: 1,
            skip: 1,
            failures: [
                {
                    pkg: "pkg/jarvis",
                    test: "TestPlanParseFencedBullet",
                    message: "want 3 tasks, got 1\nplan_test.go:95: the fence opened twice",
                    loc: "plan_test.go:88",
                },
            ],
        });
    });

    it("lists a package that failed with no failing test, such as a build failure", () => {
        const s = parseTestOutput("# pkg/x\nx.go:3:2: undefined: y\nFAIL\tpkg/x [build failed]\nok  \tpkg/y\t0.1s");
        expect(s).toMatchObject({ unit: "package", pass: 1, fail: 1 });
        expect(s?.failures).toEqual([{ pkg: "pkg/x", test: "", message: "build failed" }]);
    });
});

describe("parseTestOutput vitest", () => {
    const out = [
        " RUN  v3.2.4 C:/repo",
        "",
        " ✓ frontend/a.test.ts (3 tests) 4ms",
        " ❯ frontend/b.test.ts (2 tests | 1 failed) 6ms",
        "   × sums > adds two numbers 3ms",
        "     → expected 3 to be 4 // Object.is equality",
        "",
        "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
        "",
        " FAIL  frontend/b.test.ts > sums > adds two numbers",
        "AssertionError: expected 3 to be 4 // Object.is equality",
        "",
        "- Expected",
        "+ Received",
        "",
        " ❯ frontend/b.test.ts:12:20",
        '     10|     it("adds two numbers", () => {',
        "",
        "⎯⎯⎯⎯⎯⎯⎯[1/2]⎯",
        "",
        " FAIL  frontend/c.test.ts > timeline > groups an approve",
        "TypeError: Cannot read properties of undefined (reading 'actor')",
        " ❯ entryFor frontend/c.ts:88:31",
        " ❯ frontend/c.test.ts:31:24",
        "",
        "⎯⎯⎯⎯⎯⎯⎯[2/2]⎯",
        "",
        " Test Files  2 failed | 1 passed (3)",
        "      Tests  2 failed | 3 passed | 1 skipped (6)",
        "   Start at  10:01:02",
        "   Duration  1.2s",
    ].join("\n");

    const want = {
        runner: "vitest",
        unit: "test",
        pass: 3,
        fail: 2,
        skip: 1,
        failures: [
            {
                pkg: "frontend/b.test.ts",
                test: "sums > adds two numbers",
                message: "AssertionError: expected 3 to be 4 // Object.is equality\n\n- Expected\n+ Received",
                loc: "frontend/b.test.ts:12",
            },
            {
                pkg: "frontend/c.test.ts",
                test: "timeline > groups an approve",
                message:
                    "TypeError: Cannot read properties of undefined (reading 'actor')\n ❯ entryFor frontend/c.ts:88:31",
                loc: "frontend/c.test.ts:31",
            },
        ],
    };

    it("reads the summary counts and each failure's whole block, up to its bare location line", () => {
        expect(parseTestOutput(out)).toEqual(want);
    });

    it("strips ANSI colors first", () => {
        const colored = out
            .replace(" FAIL ", "\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m")
            .replace("2 failed |", "\x1b[1m\x1b[31m2 failed\x1b[39m\x1b[22m\x1b[2m |\x1b[22m")
            .replace(" ❯ frontend/b.test.ts:12:20", "\x1b[36m ❯ frontend/b.test.ts:\x1b[2m12:20\x1b[22m\x1b[39m");
        expect(colored).not.toBe(out);
        expect(parseTestOutput(colored)).toEqual(want);
    });

    it("ends a block cut before its location line at the summary", () => {
        const cut = [
            " FAIL  a.test.ts > x",
            "Error: boom",
            "",
            " Test Files  1 failed (1)",
            "      Tests  1 failed (1)",
        ];
        expect(parseTestOutput(cut.join("\n"))?.failures).toEqual([
            { pkg: "a.test.ts", test: "x", message: "Error: boom" },
        ]);
    });

    it("reads a passing run with no failures", () => {
        const s = parseTestOutput(" Test Files  2 passed (2)\n      Tests  7 passed (7)\n");
        expect(s).toEqual({ runner: "vitest", unit: "test", pass: 7, fail: 0, skip: 0, failures: [] });
    });
});

describe("parseTestOutput final-verify", () => {
    const detail = '{"stage":"final","reason":"no board"}';
    const out = [
        "",
        "# final-stage",
        "  PASS  1. the pane opens",
        "        it drew 3 rows",
        "  FAIL  2. the Final row is a Tests card",
        `        ${detail}`,
        "  SKIP  3. no scan report to cite",
        "",
        "# agent-tree-rail",
        "  PASS  L1. the rail draws",
        "",
        "2/3 steps passed, 1 skipped",
        "final-verify timing: slot wait 0s, prep 41s, app 33s, verify 22s",
    ].join("\n");

    it("counts the step lines and names a failure by its scenario, step and detail", () => {
        expect(parseTestOutput(out)).toEqual({
            runner: "final-verify",
            unit: "test",
            pass: 2,
            fail: 1,
            skip: 1,
            failures: [{ pkg: "final-stage", test: "2. the Final row is a Tests card", message: detail }],
        });
    });

    it("keeps a failure with no detail and ends a detail at the next unindented line", () => {
        const s = parseTestOutput("# a\n  FAIL  x\n\n# b\n  FAIL  y\n        why\n1/3 steps passed");
        expect(s?.failures).toEqual([
            { pkg: "a", test: "x", message: "failed" },
            { pkg: "b", test: "y", message: "why" },
        ]);
    });

    it("reads a scenario that threw as a failure named the scenario threw", () => {
        const s = parseTestOutput("\n# final-stage\n  ERROR: net::ERR_CONNECTION_REFUSED\n\n0/0 steps passed");
        expect(s).toMatchObject({ runner: "final-verify", fail: 1, pass: 0 });
        expect(s?.failures).toEqual([
            { pkg: "final-stage", test: "the scenario threw", message: "net::ERR_CONNECTION_REFUSED" },
        ]);
    });

    it("still reads a go build error that starts with a # line as go", () => {
        expect(parseTestOutput("# pkg/x\nx.go:3:2: undefined: y\nFAIL\tpkg/x [build failed]")?.runner).toBe("go");
    });
});

describe("parseTestOutput unrecognized", () => {
    it("returns null for unrelated text", () => {
        expect(parseTestOutput("hello\nworld\nok then")).toBeNull();
        expect(parseTestOutput("")).toBeNull();
        expect(parseTestOutput('{"a":1}\n{"Action":"x"}')).toBeNull();
    });
});

describe("failureLabel", () => {
    it("names a vitest failure's file once, as file:line", () => {
        expect(
            failureLabel("vitest", {
                pkg: "frontend/app/view/agents/agentcomposer.test.ts",
                test: "submitComposer > handles Escape",
                message: "expected 1 to be 2",
                loc: "frontend/app/view/agents/agentcomposer.test.ts:24",
            })
        ).toEqual({
            name: "submitComposer > handles Escape",
            where: "agentcomposer.test.ts:24",
            whereFull: "frontend/app/view/agents/agentcomposer.test.ts:24",
        });
    });
    it("falls back to the vitest file when it has no location", () => {
        expect(failureLabel("vitest", { pkg: "a\\b\\c.test.ts", test: "x", message: "m" }).where).toBe("c.test.ts");
    });
    it("prefixes a go location with its package's last element", () => {
        expect(
            failureLabel("go", {
                pkg: "github.com/wavetermdev/waveterm/pkg/wshrpc/wshserver",
                test: "TestStream",
                message: "bad",
                loc: "transcript_test.go:362",
            })
        ).toEqual({
            name: "TestStream",
            where: "wshserver/transcript_test.go:362",
            whereFull: "github.com/wavetermdev/waveterm/pkg/wshrpc/wshserver/transcript_test.go:362",
        });
    });
    it("names a failed go package by its last element, with nothing beside it", () => {
        expect(failureLabel("go", { pkg: "example.com/m/stats", test: "", message: "build failed" })).toEqual({
            name: "stats",
            whereFull: "example.com/m/stats",
        });
    });
    it("names a final-verify failure by its step, with its scenario beside it", () => {
        expect(failureLabel("final-verify", { pkg: "final-stage", test: "2. the row", message: "m" })).toEqual({
            name: "2. the row",
            where: "final-stage",
            whereFull: "final-stage",
        });
    });
    it("keeps a go failure with no package", () => {
        expect(failureLabel("go", { test: "TestX", message: "m", loc: "x_test.go:9" })).toEqual({
            name: "TestX",
            where: "x_test.go:9",
            whereFull: "x_test.go:9",
        });
    });
});

describe("isTestCommand", () => {
    it("matches go test and vitest", () => {
        expect(isTestCommand("go test -json ./...")).toBe(true);
        expect(isTestCommand("npx vitest run x")).toBe(true);
        expect(isTestCommand("go build ./...")).toBe(false);
        expect(isTestCommand("npm run lint")).toBe(false);
    });
    it.each([
        "node scripts/verify.mjs ./pkg/x",
        "node scripts\\cdp\\final-verify.mjs final-stage",
        "ARC_FINAL_OUT=/tmp/o node scripts/cdp/final-verify.mjs final-stage",
        "node scripts/cdp/verify.mjs motion-final",
        "task verify:ui -- final-stage",
    ])("matches Arc's own runner: %s", (cmd) => {
        expect(isTestCommand(cmd)).toBe(true);
    });
    it("does not match other scripts or tasks", () => {
        expect(isTestCommand("node scripts/cdp-shot.mjs")).toBe(false);
        expect(isTestCommand("task check:ts")).toBe(false);
    });
});
