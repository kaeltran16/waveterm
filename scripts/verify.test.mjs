import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { goTestEnv, needsGoGraph, planVerify, readChanged, readChangedFile } from "./verify.mjs";

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
