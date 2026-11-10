import { describe, expect, it } from "vitest";
import { parseTestOutput } from "./testoutput";

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

    it("counts tests and lists the failure with its package, message and location", () => {
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
                    message: "want 3 tasks, got 1",
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

    it("counts tests and attributes the failure to the package line that follows it", () => {
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
                    message: "want 3 tasks, got 1",
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
    it("counts packages, reads the failed test's message, and skips packages with no test files", () => {
        const out = [
            "--- FAIL: TestPlanParseFencedBullet (0.00s)",
            "    plan_test.go:88: want 3 tasks, got 1",
            "FAIL",
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
                    message: "want 3 tasks, got 1",
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
        " Test Files  1 failed | 1 passed (2)",
        "      Tests  1 failed | 3 passed | 1 skipped (5)",
        "   Start at  10:01:02",
        "   Duration  1.2s",
    ].join("\n");

    const want = {
        runner: "vitest",
        unit: "test",
        pass: 3,
        fail: 1,
        skip: 1,
        failures: [
            {
                pkg: "frontend/b.test.ts",
                test: "sums > adds two numbers",
                message: "AssertionError: expected 3 to be 4 // Object.is equality",
                loc: "frontend/b.test.ts:12",
            },
        ],
    };

    it("reads the summary counts and the failure block", () => {
        expect(parseTestOutput(out)).toEqual(want);
    });

    it("strips ANSI colors first", () => {
        const colored = out
            .replace(" FAIL ", "\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m")
            .replace("1 failed |", "\x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m\x1b[2m |\x1b[22m")
            .replace(" ❯ frontend/b.test.ts:12:20", "\x1b[36m ❯ frontend/b.test.ts:\x1b[2m12:20\x1b[22m\x1b[39m");
        expect(colored).not.toBe(out);
        expect(parseTestOutput(colored)).toEqual(want);
    });

    it("reads a passing run with no failures", () => {
        const s = parseTestOutput(" Test Files  2 passed (2)\n      Tests  7 passed (7)\n");
        expect(s).toEqual({ runner: "vitest", unit: "test", pass: 7, fail: 0, skip: 0, failures: [] });
    });
});

describe("parseTestOutput unrecognized", () => {
    it("returns null for unrelated text", () => {
        expect(parseTestOutput("hello\nworld\nok then")).toBeNull();
        expect(parseTestOutput("")).toBeNull();
        expect(parseTestOutput('{"a":1}\n{"Action":"x"}')).toBeNull();
    });
});
