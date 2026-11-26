// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure test-output parser for the rendered view's test card: go test (-json, -v, plain), vitest and Arc's CDP runners.
// Deterministic, linear in the output, never throws on odd input; null when nothing is recognized.

export interface TestFailure {
    pkg?: string;
    test: string;
    message: string;
    loc?: string;
}

export interface TestSummary {
    runner: "go" | "vitest" | "final-verify";
    unit: "test" | "package";
    pass: number;
    fail: number;
    skip: number;
    failures: TestFailure[];
}

// colour and cursor escapes; the CSI rule of utilfn.StripANSI
// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(s: string): string {
    return s.replace(CSI_RE, "");
}

// Arc's own runners: verify.mjs (go packages), the CDP runners and the task that wraps one; either path separator
const TEST_CMD =
    /(?:^|[\s;&|(])(?:go\s+test|vitest|task\s+verify:ui)\b|(?:^|[\s;&|(/\\])scripts[\\/](?:cdp[\\/](?:final-)?)?verify\.mjs\b/;

export function isTestCommand(cmd: string): boolean {
    return TEST_CMD.test(cmd);
}

// a t.Errorf line: "    plan_test.go:88: want 3 tasks, got 1"
const GO_LOC_LINE = /^(\s*)([\w.\-/\\]+\.go:\d+): ?(.*)$/;
// go indents a log line's continuation this much past the line itself
const GO_CONTINUATION_INDENT = 4;
const GO_RUN = /^=== (?:RUN|CONT|NAME|PAUSE)\s+(\S+)/;
const GO_RESULT = /^\s*--- (PASS|FAIL|SKIP): (\S+)/;

// up to n leading whitespace characters cut, so indent past them stays
function dedent(line: string, n: number): string {
    let i = 0;
    while (i < n && i < line.length && /\s/.test(line[i])) i++;
    return line.slice(i);
}

interface Message {
    lines?: string[];
    loc?: string;
    // the first located line's indent: what every later line is dedented by
    indent?: number;
}

// The whole message a test printed, from its first located line on, its own === RUN / --- FAIL lines left out.
// attributed: the line is known to be the test's (go test -json names it); plain text attributes only indented lines,
// since go indents every log line and its own FAIL, PASS and exit status lines are not.
function noteMessage(m: Message, line: string, attributed: boolean): void {
    if (GO_RUN.test(line) || GO_RESULT.test(line)) {
        return;
    }
    if (m.loc == null) {
        const lm = GO_LOC_LINE.exec(line);
        if (lm) {
            m.loc = lm[2];
            m.indent = lm[1].length;
            m.lines = [lm[3].trimEnd()];
        }
        return;
    }
    if (!attributed && !/^\s/.test(line)) {
        return;
    }
    m.lines.push(dedent(line, m.indent + GO_CONTINUATION_INDENT).trimEnd());
}

// the lines joined, blank lines at either end dropped
function messageText(lines: string[] | undefined): string {
    const all = lines ?? [];
    let start = 0;
    let end = all.length;
    while (start < end && all[start].trim() === "") start++;
    while (end > start && all[end - 1].trim() === "") end--;
    return all.slice(start, end).join("\n");
}

// a failing parent test whose subtest also failed adds nothing the subtest does not say
function leafFailures(failures: TestFailure[]): TestFailure[] {
    const parents = new Set<string>();
    for (const f of failures) {
        const parts = f.test.split("/");
        for (let i = 1; i < parts.length; i++) {
            parents.add(`${f.pkg ?? ""}\x00${parts.slice(0, i).join("/")}`);
        }
    }
    return failures.filter((f) => f.test === "" || !parents.has(`${f.pkg ?? ""}\x00${f.test}`));
}

function toFailure(pkg: string | undefined, test: string, m: Message | undefined, fallback: string): TestFailure {
    return {
        ...(pkg ? { pkg } : {}),
        test,
        message: messageText(m?.lines) || fallback,
        ...(m?.loc ? { loc: m.loc } : {}),
    };
}

function parseGoJson(lines: string[]): TestSummary | null {
    const tests = { pass: 0, fail: 0, skip: 0 };
    const pkgs = { pass: 0, fail: 0, skip: 0 };
    const messages = new Map<string, Message>();
    const failed: { pkg: string; test: string }[] = [];
    const failedPkgs: string[] = [];
    const pkgsWithFailedTest = new Set<string>();
    let seen = false;
    for (const line of lines) {
        if (!line.startsWith("{")) {
            continue;
        }
        let ev: any;
        try {
            ev = JSON.parse(line);
        } catch {
            continue;
        }
        if (typeof ev?.Action !== "string" || typeof ev.Package !== "string") {
            continue;
        }
        seen = true;
        const pkg: string = ev.Package;
        const test: string | undefined = typeof ev.Test === "string" ? ev.Test : undefined;
        const counts = test != null ? tests : pkgs;
        if (ev.Action === "pass" || ev.Action === "fail" || ev.Action === "skip") {
            counts[ev.Action]++;
        }
        if (ev.Action === "output" && test != null && typeof ev.Output === "string") {
            const key = `${pkg}\x00${test}`;
            const m = messages.get(key) ?? {};
            noteMessage(m, ev.Output.replace(/\r?\n$/, ""), true);
            messages.set(key, m);
        }
        if (ev.Action === "fail") {
            if (test != null) {
                failed.push({ pkg, test });
                pkgsWithFailedTest.add(pkg);
            } else {
                failedPkgs.push(pkg);
            }
        }
    }
    if (!seen) {
        return null;
    }
    const failures = failed.map((f) => toFailure(f.pkg, f.test, messages.get(`${f.pkg}\x00${f.test}`), "failed"));
    for (const pkg of failedPkgs) {
        if (!pkgsWithFailedTest.has(pkg)) {
            failures.push({ pkg, test: "", message: "package failed" });
        }
    }
    const byTest = tests.pass + tests.fail + tests.skip > 0;
    return {
        runner: "go",
        unit: byTest ? "test" : "package",
        ...(byTest ? tests : pkgs),
        failures: leafFailures(failures),
    };
}

// "ok\tpkg\t0.1s", "ok  \tpkg\t(cached)", "FAIL\tpkg\t0.2s", "FAIL\tpkg [build failed]"
const GO_PKG_OK = /^ok\s+(\S+)\s+(?:\d+(?:\.\d+)?s|\(cached\)|\[no tests to run\])/;
const GO_PKG_FAIL = /^FAIL\s+(\S+)(\s+(?:\d+(?:\.\d+)?s|\[[^\]]+\]))/;
const GO_PKG_NOTESTS = /^\?\s+(\S+)\s+\[no test files\]/;

function parseGoText(lines: string[]): TestSummary | null {
    const tests = { pass: 0, fail: 0, skip: 0 };
    const pkgs = { pass: 0, fail: 0, skip: 0 };
    const messages = new Map<string, Message>();
    const failures: TestFailure[] = [];
    // failures seen since the last package line; the next package line names their package
    let pending: TestFailure[] = [];
    let current: string | undefined;
    let verbose = false;
    let seen = false;
    for (const line of lines) {
        const run = GO_RUN.exec(line);
        if (run) {
            verbose = true;
            seen = true;
            current = run[1];
            continue;
        }
        const res = GO_RESULT.exec(line);
        if (res) {
            seen = true;
            current = res[2];
            const verdict = res[1].toLowerCase() as "pass" | "fail" | "skip";
            tests[verdict]++;
            if (verdict === "fail") {
                // plain go test prints the messages after the FAIL line, so read the message when the package closes
                pending.push({ test: res[2], message: "" });
            }
            continue;
        }
        const ok = GO_PKG_OK.exec(line);
        const bad = ok ? null : GO_PKG_FAIL.exec(line);
        const none = ok || bad ? null : GO_PKG_NOTESTS.exec(line);
        if (ok || bad || none) {
            seen = true;
            const pkg = (ok ?? bad ?? none)[1];
            if (ok) pkgs.pass++;
            if (bad) pkgs.fail++;
            if (none) pkgs.skip++;
            for (const f of pending) {
                failures.push(toFailure(pkg, f.test, messages.get(f.test), "failed"));
            }
            if (bad && pending.length === 0) {
                const why = bad[2].match(/\[(.+)\]/)?.[1];
                failures.push({ pkg, test: "", message: why ?? "package failed" });
            }
            pending = [];
            messages.clear();
            current = undefined;
            continue;
        }
        if (current != null) {
            const m = messages.get(current) ?? {};
            noteMessage(m, line, false);
            messages.set(current, m);
        }
    }
    if (!seen) {
        return null;
    }
    // output cut before its package line still lists its failures
    for (const f of pending) {
        failures.push(toFailure(undefined, f.test, messages.get(f.test), "failed"));
    }
    return {
        runner: "go",
        unit: verbose ? "test" : "package",
        ...(verbose ? tests : pkgs),
        failures: leafFailures(failures),
    };
}

const VITEST_TESTS = /^\s*Tests\s+(.*?)\s*\(\d+\)\s*$/;
const VITEST_COUNT = /(\d+)\s+(passed|failed|skipped|todo)/g;
// " FAIL  a.test.ts > suite > name", or " FAIL  a.test.ts [ a.test.ts ]" when the file itself failed
const VITEST_FAIL = /^\s*FAIL\s+(\S+\.[cm]?[jt]sx?)(?:\s+>\s+(.*?))?(?:\s+\[.*\])?\s*$/;
const VITEST_LOC = /^\s*❯\s+(\S+?:\d+)(?::\d+)?\s*$/;
// the "⎯⎯⎯[1/3]⎯" rule between failures, or the "Test Files" summary
const VITEST_BLOCK_END = /^\s*(?:⎯|Test Files\s)/;

function parseVitest(lines: string[]): TestSummary | null {
    let summary: string | undefined;
    for (const line of lines) {
        const m = VITEST_TESTS.exec(line);
        if (m) {
            summary = m[1];
        }
    }
    if (summary == null) {
        return null;
    }
    const counts = { pass: 0, fail: 0, skip: 0 };
    for (const m of summary.matchAll(VITEST_COUNT)) {
        const n = Number(m[1]);
        if (m[2] === "passed") counts.pass += n;
        else if (m[2] === "failed") counts.fail += n;
        else counts.skip += n;
    }
    // a failure's message is every line from its FAIL header to its bare location line; a stack frame with a function
    // name before it stays in the message
    const failures: TestFailure[] = [];
    let open: { failure: TestFailure; lines: string[] } | null = null;
    const close = () => {
        if (open != null) {
            open.failure.message = messageText(open.lines);
            open = null;
        }
    };
    for (const line of lines) {
        const head = VITEST_FAIL.exec(line);
        if (head) {
            close();
            open = { failure: { pkg: head[1], test: head[2] ?? "", message: "" }, lines: [] };
            failures.push(open.failure);
            continue;
        }
        if (open == null) {
            continue;
        }
        const loc = VITEST_LOC.exec(line);
        if (loc) {
            open.failure.loc = loc[1];
            close();
            continue;
        }
        // a block cut before its location still ends at the next failure's rule or the summary
        if (VITEST_BLOCK_END.test(line)) {
            close();
            continue;
        }
        open.lines.push(line.trimEnd());
    }
    close();
    return { runner: "vitest", unit: "test", ...counts, failures };
}

// scripts/cdp/report.mjs formatResults: "# scenario", "  PASS|FAIL|SKIP  step", its detail indented eight spaces
// beneath, "  ERROR: msg" under a header when the scenario threw
const CDP_HEADER = /^# (.+?)\s*$/;
const CDP_STEP = /^ {2}(PASS|FAIL|SKIP) {2}(.*?)\s*$/;
const CDP_ERROR = /^ {2}ERROR: (.*?)\s*$/;
const CDP_DETAIL = /^ {3,}\S/;
// shotsManifest's name for the same failure
const CDP_THREW = "the scenario threw";

function parseFinalVerify(lines: string[]): TestSummary | null {
    const counts = { pass: 0, fail: 0, skip: 0 };
    const failures: TestFailure[] = [];
    let scenario: string | undefined;
    // the last FAIL, still collecting its detail lines; a PASS or SKIP detail is not kept
    let open: { failure: TestFailure; lines: string[] } | null = null;
    const close = () => {
        if (open != null) {
            open.failure.message = open.lines.join("\n") || "failed";
            open = null;
        }
    };
    for (const line of lines) {
        const header = CDP_HEADER.exec(line);
        if (header) {
            close();
            scenario = header[1];
            continue;
        }
        if (scenario == null) {
            continue;
        }
        const err = CDP_ERROR.exec(line);
        if (err) {
            close();
            counts.fail++;
            failures.push({ pkg: scenario, test: CDP_THREW, message: err[1] || "failed" });
            continue;
        }
        const step = CDP_STEP.exec(line);
        if (step) {
            close();
            const verdict = step[1].toLowerCase() as "pass" | "fail" | "skip";
            counts[verdict]++;
            if (verdict === "fail") {
                const failure = { pkg: scenario, test: step[2], message: "" };
                failures.push(failure);
                open = { failure, lines: [] };
            }
            continue;
        }
        if (open != null && CDP_DETAIL.test(line)) {
            open.lines.push(line.trim());
        } else {
            close();
        }
    }
    close();
    if (counts.pass + counts.fail + counts.skip === 0) {
        return null;
    }
    return { runner: "final-verify", unit: "test", ...counts, failures };
}

export function parseTestOutput(output: string): TestSummary | null {
    const lines = stripAnsi(output).split(/\r?\n/);
    return parseGoJson(lines) ?? parseVitest(lines) ?? parseFinalVerify(lines) ?? parseGoText(lines);
}

function lastSegment(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export interface FailureLabel {
    name: string;
    // the short place a failure row shows; whereFull is its tooltip
    where?: string;
    whereFull?: string;
}

// How a failure row names its test and place. vitest's pkg and loc name the same file, so only loc's file:line
// shows; a go package path shares its module prefix on every row, so only its last element prefixes the location.
export function failureLabel(runner: TestSummary["runner"], f: TestFailure): FailureLabel {
    if (runner === "final-verify") {
        return { name: f.test, where: f.pkg, whereFull: f.pkg };
    }
    if (runner === "vitest") {
        const full = f.loc ?? f.pkg;
        return { name: f.test || (f.pkg ?? ""), ...(full ? { where: lastSegment(full), whereFull: full } : {}) };
    }
    if (f.test === "") {
        return { name: lastSegment(f.pkg ?? ""), ...(f.pkg ? { whereFull: f.pkg } : {}) };
    }
    if (f.loc == null) {
        return { name: f.test, ...(f.pkg ? { where: lastSegment(f.pkg), whereFull: f.pkg } : {}) };
    }
    return {
        name: f.test,
        where: f.pkg ? `${lastSegment(f.pkg)}/${f.loc}` : f.loc,
        whereFull: f.pkg ? `${f.pkg}/${f.loc}` : f.loc,
    };
}
