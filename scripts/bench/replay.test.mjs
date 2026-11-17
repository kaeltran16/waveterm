import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ARMS, arcBuild, cleanup, loadPicks, start, startArgs, status, withPlanSkill } from "./replay.mjs";

const PICKS_FILE = fileURLToPath(new URL("./plan-skill-picks.json", import.meta.url));
const KEY = "run:planskill";
// sha256 of the bytes "arc build fixture\n", from `sha256sum`
const FIXTURE_BYTES = "arc build fixture\n";
const FIXTURE_SHA = "0bb13ed3cfd4464fb2a96463c517847e12d032a8901b6ea50cd56e6cc7e0c191";

let root;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bench-replay-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

describe("withPlanSkill", () => {
    it("sets the key only while fn runs and keeps every other key", () => {
        const settings = join(root, "settings.json");
        writeFileSync(settings, JSON.stringify({ "memory:vaultpath": "C:\\vault", "debug:pprofport": 6060 }, null, 2));
        let during;
        withPlanSkill(settings, "plan", () => {
            during = readJson(settings);
        });
        expect(during).toEqual({ "memory:vaultpath": "C:\\vault", "debug:pprofport": 6060, [KEY]: "plan" });
        expect(readJson(settings)).toEqual({ "memory:vaultpath": "C:\\vault", "debug:pprofport": 6060 });
        expect(KEY in readJson(settings)).toBe(false);
    });

    it("restores a prior value, even when fn throws", () => {
        const settings = join(root, "settings.json");
        writeFileSync(settings, JSON.stringify({ [KEY]: "writing-plans", other: true }));
        expect(() =>
            withPlanSkill(settings, "plan", () => {
                throw new Error("boom");
            })
        ).toThrow("boom");
        expect(readJson(settings)).toEqual({ [KEY]: "writing-plans", other: true });
    });

    it("removes the file again when there was none", () => {
        const settings = join(root, "settings.json");
        withPlanSkill(settings, "writing-plans", () => {
            expect(readJson(settings)).toEqual({ [KEY]: "writing-plans" });
        });
        expect(existsSync(settings)).toBe(false);
    });
});

describe("startArgs", () => {
    const base = { goal: "Build X.", worktree: "C:\\b\\wt\\pwa-plan", spec: "C:\\b\\specs\\pwa.md" };
    const valueOf = (args, flag) => args[args.indexOf(flag) + 1];

    it("carries the pinned route, autonomy, width, spec and prototype, and never --effort", () => {
        const args = startArgs({ ...base, prototype: "C:\\main\\canvas.dc.html" });
        expect(args.slice(0, 3)).toEqual(["runs", "start", "Build X."]);
        expect(valueOf(args, "--mode")).toBe("orchestrator");
        expect(valueOf(args, "--project")).toBe(base.worktree);
        expect(valueOf(args, "--spec")).toBe(base.spec);
        expect(valueOf(args, "--prototype")).toBe("C:\\main\\canvas.dc.html");
        for (const [flag, value] of [
            ["--runtime", "claude"],
            ["--model", "opus"],
            ["--worker-runtime", "claude"],
            ["--worker-model", "opus"],
            ["--reviewer-runtime", "claude"],
            ["--reviewer-model", "opus"],
            ["--parallelism", "3"],
        ]) {
            expect(valueOf(args, flag)).toBe(value);
        }
        expect(args).toContain("--autonomous");
        expect(args).toContain("--json");
        expect(args).not.toContain("--effort");
    });

    it("leaves --prototype out for a pick without one", () => {
        expect(startArgs({ ...base, prototype: null })).not.toContain("--prototype");
    });
});

describe("arcBuild", () => {
    it("is the sha-256 of the file", () => {
        const f = join(root, "wavesrv.x64.exe");
        writeFileSync(f, FIXTURE_BYTES);
        expect(arcBuild(f)).toBe(FIXTURE_SHA);
    });
});

describe("loadPicks", () => {
    it("loads the three pinned picks", () => {
        expect(loadPicks(PICKS_FILE).map((p) => p.id)).toEqual(["resource", "pwa", "rendered"]);
    });
});

// a stand-in for git, node and wsh: the harness's only boundary is the processes it starts
function fakeProcs({ recordedSkill } = {}) {
    const calls = [];
    const state = { settingsAtStart: [] };
    let next = 0;
    const run = (cmd, args, cwd) => {
        calls.push({ cmd, args, cwd });
        if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
            mkdirSync(args[4], { recursive: true });
            return "";
        }
        if (cmd === "git" && args[0] === "show") return "# Resource management\n\nbody\n";
        if (cmd === "wsh" && args[1] === "start") {
            state.settingsAtStart.push(readJson(state.settings)[KEY]);
            next++;
            return JSON.stringify({ id: `run-${next}`, status: "planning" });
        }
        if (cmd === "wsh" && args[1] === "show") {
            const skill = recordedSkill ?? state.settingsAtStart[state.settingsAtStart.length - 1];
            return JSON.stringify({ run: { id: args[2], planskill: skill, status: "running" } });
        }
        return "";
    };
    return { run, calls, state };
}

const PICK = {
    id: "resource",
    originalRun: "f72341e4",
    base: "d8266279142f6758902a117eedd2a42c8f21477a",
    specCommit: "9598fd5c5ba9045f5b2b9312427c5e8c637d2945",
    specPath: "docs/superpowers/specs/2026-11-12-arc-resource-management-design.md",
    prototype: null,
};

function setup(procs, picks = [PICK]) {
    const bench = join(root, "bench");
    const settings = join(root, "settings.json");
    const wavesrv = join(root, "wavesrv.x64.exe");
    writeFileSync(settings, JSON.stringify({ keep: 1 }));
    writeFileSync(wavesrv, FIXTURE_BYTES);
    procs.state.settings = settings;
    const opts = { bench, pickId: "resource", picks, main: "C:\\main", settingsPath: settings, wavesrvPath: wavesrv, run: procs.run };
    return { bench, settings, opts };
}

describe("start", () => {
    it("launches plan then writing-plans, each from its own worktree, and records both rows", () => {
        const procs = fakeProcs();
        const { bench, settings, opts } = setup(procs);
        start(opts);

        expect(procs.state.settingsAtStart).toEqual(ARMS);
        expect(readJson(settings)).toEqual({ keep: 1 });
        const spec = join(bench, "specs", "resource.md");
        expect(readFileSync(spec, "utf8")).toContain("# Resource management");

        const starts = procs.calls.filter((c) => c.cmd === "wsh" && c.args[1] === "start");
        expect(starts.map((c) => c.cwd)).toEqual(ARMS.map((a) => join(bench, "wt", `resource-${a}`)));
        expect(starts[0].args[2]).toBe("Build Resource management.");

        const adds = procs.calls.filter((c) => c.cmd === "git" && c.args[1] === "add");
        expect(adds.map((c) => c.args)).toEqual(
            ARMS.map((a) => ["worktree", "add", "-b", `bench/resource-${a}`, join(bench, "wt", `resource-${a}`), PICK.base])
        );
        const prepares = procs.calls.filter((c) => c.args.includes("prepare"));
        expect(prepares.map((c) => c.args)).toEqual(ARMS.map(() => [join("C:\\main", "scripts", "worktree-junctions.mjs"), "prepare"]));

        const rows = readJson(join(bench, "runs.json"));
        expect(rows.map((r) => [r.pick, r.arm, r.runId, r.branch, r.arcBuild])).toEqual([
            ["resource", "plan", "run-1", "bench/resource-plan", FIXTURE_SHA],
            ["resource", "writing-plans", "run-2", "bench/resource-writing-plans", FIXTURE_SHA],
        ]);
        expect(rows[0]).toMatchObject({ base: PICK.base, spec, worktree: join(bench, "wt", "resource-plan") });
        expect(typeof rows[0].startedTs).toBe("number");
    });

    it("cancels the run and fails, naming both skills, when the recorded plan skill is not the arm", () => {
        const procs = fakeProcs({ recordedSkill: "writing-plans" });
        const { bench, opts } = setup(procs);
        expect(() => start(opts)).toThrow(/"writing-plans"[\s\S]*"plan"|"plan"[\s\S]*"writing-plans"/);
        const cancel = procs.calls.find((c) => c.cmd === "wsh" && c.args[1] === "cancel");
        expect(cancel.args).toEqual(["runs", "cancel", "run-1", "--yes"]);
        expect(existsSync(join(bench, "runs.json"))).toBe(false);
    });

    it("refuses an Arc build that differs from the first row's, naming both, before any worktree", () => {
        const procs = fakeProcs();
        const { bench, opts } = setup(procs);
        mkdirSync(bench, { recursive: true });
        writeFileSync(join(bench, "runs.json"), JSON.stringify([{ pick: "pwa", arm: "plan", arcBuild: "aaaa" }]));
        expect(() => start(opts)).toThrow(new RegExp(`aaaa[\\s\\S]*${FIXTURE_SHA}|${FIXTURE_SHA}[\\s\\S]*aaaa`));
        expect(procs.calls).toEqual([]);
    });

    it("refuses an unknown pick before any worktree", () => {
        const procs = fakeProcs();
        const { bench, opts } = setup(procs);
        expect(() => start({ ...opts, pickId: "nope" })).toThrow(/nope/);
        expect(procs.calls).toEqual([]);
        expect(existsSync(join(bench, "wt"))).toBe(false);
    });

    it("refuses a pick missing a field before any worktree", () => {
        for (const field of ["base", "specCommit", "specPath", "prototype"]) {
            const procs = fakeProcs();
            const broken = { ...PICK };
            delete broken[field];
            const { bench, opts } = setup(procs, [broken]);
            expect(() => start(opts)).toThrow(new RegExp(field));
            expect(procs.calls).toEqual([]);
            expect(existsSync(join(bench, "wt"))).toBe(false);
        }
    });
});

describe("status and cleanup", () => {
    function benchWithRows() {
        const bench = join(root, "bench");
        mkdirSync(bench);
        const rows = ARMS.map((arm, i) => ({ pick: "pwa", arm, runId: `r${i}`, worktree: join(bench, "wt", `pwa-${arm}`) }));
        writeFileSync(join(bench, "runs.json"), JSON.stringify(rows));
        return { bench, rows };
    }

    it("status prints each row's run status", () => {
        const { bench } = benchWithRows();
        const run = (cmd, args) => JSON.stringify({ run: { id: args[2], status: args[2] === "r0" ? "done" : "running" } });
        expect(status({ bench, run })).toEqual(["pwa  plan  r0  done", "pwa  writing-plans  r1  running"]);
    });

    it("cleanup removes each worktree through the task, from the main checkout", () => {
        const { bench, rows } = benchWithRows();
        for (const r of rows) mkdirSync(r.worktree, { recursive: true });
        const calls = [];
        cleanup({ bench, main: "C:\\main", run: (cmd, args, cwd) => calls.push({ cmd, args, cwd }) });
        expect(calls).toEqual(rows.map((r) => ({ cmd: "task", args: ["worktree:cleanup", "--", r.worktree], cwd: "C:\\main" })));
    });
});
