import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { mutateRanges, run, strykerArgs, toMutationJson } from "./tsmutate.mjs";

function git(cwd, ...args) {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
}

function write(root, path, text) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
}

function lines(n, prefix = "line") {
    return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";
}

function makeRepo() {
    const root = mkdtempSync(join(tmpdir(), "tsmutate-"));
    git(root, "init", "-q");
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "t");
    git(root, "config", "core.autocrlf", "false");
    return root;
}

function commit(root) {
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "c");
    return git(root, "rev-parse", "HEAD");
}

const roots = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

describe("mutateRanges", () => {
    it("lists exactly the added or changed lines of non-test, non-generated TS files", () => {
        const root = makeRepo();
        roots.push(root);
        write(root, "frontend/a.ts", lines(10));
        write(root, "frontend/gone.ts", lines(3));
        write(root, "frontend/view.tsx", lines(5));
        write(root, "pkg/x.go", lines(3));
        const base = commit(root);

        // a.ts: change line 2, insert two lines after line 6, delete line 9
        const a = lines(10).split("\n");
        a[1] = "changed 2";
        a.splice(6, 0, "new a", "new b");
        a.splice(10, 1);
        write(root, "frontend/a.ts", a.join("\n"));
        rmSync(join(root, "frontend/gone.ts"));
        write(root, "frontend/view.tsx", lines(5) + "added 6\n");
        // distinct text, so git does not pair it with the deleted gone.ts as a rename
        write(root, "frontend/new.ts", lines(4, "fresh"));
        write(root, "frontend/a.test.ts", lines(2));
        write(root, "frontend/view.test.tsx", lines(2));
        write(root, "frontend/app/store/wshclientapi.ts", lines(2));
        write(root, "frontend/app/store/services.ts", lines(2));
        write(root, "frontend/types/gotypes.d.ts", lines(2));
        write(root, "frontend/types/waveevent.d.ts", lines(2));
        write(root, "pkg/x.go", lines(4));
        write(root, "notes.md", "hi\n");
        commit(root);

        expect(mutateRanges(root, base).sort()).toEqual(
            ["frontend/a.ts:2-2", "frontend/a.ts:7-8", "frontend/new.ts:1-4", "frontend/view.tsx:6-6"].sort()
        );
    });

    it("is empty when the diff touches no TS lines", () => {
        const root = makeRepo();
        roots.push(root);
        write(root, "frontend/a.ts", lines(3));
        const base = commit(root);
        write(root, "pkg/x.go", lines(3));
        write(root, "frontend/a.test.ts", lines(3));
        commit(root);
        expect(mutateRanges(root, base)).toEqual([]);
    });
});

describe("toMutationJson", () => {
    const mutant = (status, line, mutatorName = "EqualityOperator", replacement = "a <= b") => ({
        id: `${line}-${status}`,
        mutatorName,
        replacement,
        status,
        location: { start: { line, column: 1 }, end: { line, column: 5 } },
    });
    const report = {
        schemaVersion: "2",
        thresholds: { high: 80, low: 60 },
        files: {
            "frontend/a.ts": {
                language: "typescript",
                source: "",
                mutants: [
                    mutant("Killed", 1),
                    mutant("Killed", 2),
                    mutant("Timeout", 3),
                    mutant("Survived", 4),
                    mutant("CompileError", 5),
                ],
            },
            "frontend\\b.tsx": {
                language: "typescript",
                source: "",
                mutants: [
                    mutant("NoCoverage", 7, "BooleanLiteral", "false"),
                    mutant("RuntimeError", 8),
                    mutant("Killed", 9),
                    mutant("Ignored", 10),
                ],
            },
        },
    };

    it("maps Stryker statuses to the shared counts and score", () => {
        const out = toMutationJson(report, { base: "b1", head: "h1" });
        expect(out).toMatchObject({
            tool: "stryker",
            base: "b1",
            head: "h1",
            killed: 3,
            timedOut: 1,
            survived: 2,
            invalid: 2,
        });
        expect(out.score).toBeCloseTo(4 / 6);
        expect(out.files).toEqual([
            { path: "frontend/a.ts", killed: 2, timedOut: 1, survived: 1 },
            { path: "frontend/b.tsx", killed: 1, timedOut: 0, survived: 1 },
        ]);
        expect(out.survivors).toEqual([
            { path: "frontend/a.ts", line: 4, op: "EqualityOperator: a <= b" },
            { path: "frontend/b.tsx", line: 7, op: "BooleanLiteral: false" },
        ]);
    });

    it("scores null when every mutant is invalid", () => {
        const out = toMutationJson(
            { files: { "a.ts": { mutants: [mutant("CompileError", 1)] } } },
            { base: "b", head: "h" }
        );
        expect(out.invalid).toBe(1);
        expect(out.score).toBeNull();
    });
});

describe("strykerArgs", () => {
    it("runs the pinned core and vitest runner through npx", () => {
        const args = strykerArgs("cfg.json");
        expect(args.slice(0, 1)).toEqual(["-y"]);
        const pkgs = args.filter((_, i) => args[i - 1] === "-p");
        expect(pkgs).toHaveLength(2);
        expect(pkgs[0]).toMatch(/^@stryker-mutator\/core@\d+\.\d+\.\d+$/);
        expect(pkgs[1]).toMatch(/^@stryker-mutator\/vitest-runner@\d+\.\d+\.\d+$/);
        // the runner's peer dependency on core is exact
        expect(pkgs[0].split("@")[2]).toBe(pkgs[1].split("@")[2]);
        expect(args.slice(-3)).toEqual(["stryker", "run", "cfg.json"]);
    });
});

describe("run", () => {
    it("writes score null without starting Stryker when no TS line changed", () => {
        const root = makeRepo();
        roots.push(root);
        write(root, "pkg/x.go", lines(2));
        const base = commit(root);
        write(root, "pkg/x.go", lines(3));
        const head = commit(root);
        const outRoot = mkdtempSync(join(tmpdir(), "tsmutate-out-"));
        roots.push(outRoot);
        const out = join(outRoot, "mutation", "ts.json");

        let started = false;
        run({ dir: root, base, out }, () => {
            started = true;
        });

        expect(started).toBe(false);
        expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
            tool: "stryker",
            base,
            head,
            killed: 0,
            timedOut: 0,
            survived: 0,
            invalid: 0,
            score: null,
            files: [],
            survivors: [],
        });
    });

    it("hands the ranges to Stryker and writes its converted report", () => {
        const root = makeRepo();
        roots.push(root);
        write(root, "src/a.ts", lines(2));
        const base = commit(root);
        write(root, "src/a.ts", lines(3));
        const head = commit(root);
        const out = join(mkdtempSync(join(tmpdir(), "tsmutate-out-")), "ts.json");
        roots.push(dirname(out));

        let got;
        run({ dir: root, base, out }, (dir, ranges) => {
            got = { dir, ranges };
            return { files: { "src/a.ts": { mutants: [{ status: "Survived", mutatorName: "M", replacement: "r", location: { start: { line: 3 } } }] } } };
        });

        expect(got).toEqual({ dir: root, ranges: ["src/a.ts:3-3"] });
        const written = JSON.parse(readFileSync(out, "utf8"));
        expect(written).toMatchObject({ base, head, survived: 1, score: 0 });
    });
});
