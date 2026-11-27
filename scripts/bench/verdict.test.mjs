import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decide, loadBench, pooledScore, renderTable } from "./verdict.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "verdict.mjs");
const PLAN = "plan";
const WP = "writing-plans";
const PICKS = ["resource", "pwa", "rendered"];

const row = (o = {}) => ({
    runId: "r",
    planSkill: PLAN,
    tasks: 5,
    width: 2,
    planWords: 900,
    planReviewRounds: 1,
    asks: 0,
    reviewFails: 0,
    verifyFails: 0,
    finalRound1: "passed",
    finalRounds: 1,
    finalFails: 0,
    minutes: 60,
    cost: { lead: 1, worker: 2, taskReviewer: 1, planReviewer: 1, verifier: 1 },
    totalCost: 6,
    ...o,
});

const mut = (killed, survived, timedOut = 0) => ({ tool: "gomutate", base: "b", head: "h", killed, timedOut, survived, invalid: 0, score: null, files: [], survivors: [] });

const win = (winner) => ({ first: "X", second: "X", winner });

// a bench where every term holds for plan, so each case below breaks exactly one
function base() {
    return {
        blind: { resource: win(PLAN), pwa: win(PLAN), rendered: win(WP) },
        rows: { [PLAN]: [row(), row(), row()], [WP]: [row(), row(), row()] },
        mutation: { [PLAN]: [mut(8, 2)], [WP]: [mut(8, 2)] },
    };
}

describe("decide", () => {
    it("keeps plan when all four terms hold", () => {
        expect(decide(base()).default).toBe(PLAN);
    });

    it("keeps plan on ties in Final, mutation and rework", () => {
        const r = decide(base());
        expect(r.terms.map((t) => t.held)).toEqual([true, true, true, true]);
    });

    it("picks writing-plans when plan wins only 1 pick", () => {
        const b = base();
        b.blind = { resource: win(PLAN), pwa: win(WP), rendered: win(WP) };
        const r = decide(b);
        expect(r.default).toBe(WP);
        expect(r.terms.find((t) => t.name === "blind").held).toBe(false);
    });

    it("picks writing-plans when plan wins 1 pick and 2 are ties", () => {
        const b = base();
        b.blind = { resource: win(PLAN), pwa: win("tie"), rendered: win("tie") };
        expect(decide(b).default).toBe(WP);
    });

    it("keeps plan when plan wins 2 picks and 1 is a tie", () => {
        const b = base();
        b.blind = { resource: win(PLAN), pwa: win(PLAN), rendered: win("tie") };
        expect(decide(b).default).toBe(PLAN);
    });

    it("picks writing-plans when plan passes Final round 1 less often", () => {
        const b = base();
        b.rows[PLAN][0] = row({ finalRound1: "failed" });
        const r = decide(b);
        expect(r.default).toBe(WP);
        const t = r.terms.find((x) => x.name === "final");
        expect([t.plan, t.writingPlans, t.held]).toEqual([2, 3, false]);
    });

    it("counts a run that never reached Final as not passed", () => {
        const b = base();
        b.rows[PLAN][0] = row({ finalRound1: null, finalRounds: null });
        expect(decide(b).default).toBe(WP);
    });

    it("picks writing-plans when plan's pooled mutation score is lower", () => {
        const b = base();
        b.mutation[PLAN] = [mut(7, 3)];
        const r = decide(b);
        expect(r.default).toBe(WP);
        expect(r.terms.find((t) => t.name === "mutation").held).toBe(false);
    });

    it("picks writing-plans when plan needs more rework", () => {
        const b = base();
        b.rows[PLAN][1] = row({ reviewFails: 1, verifyFails: 1, finalRounds: 2, finalFails: 1 });
        const r = decide(b);
        expect(r.default).toBe(WP);
        const t = r.terms.find((x) => x.name === "rework");
        expect([t.plan, t.writingPlans, t.held]).toEqual([3, 0, false]);
    });

    it("keeps plan when plan needs less rework", () => {
        const b = base();
        b.rows[WP][1] = row({ planSkill: WP, reviewFails: 2 });
        expect(decide(b).default).toBe(PLAN);
    });

    it("skips the mutation term when an arm has no mutants", () => {
        const b = base();
        b.mutation[PLAN] = [mut(0, 0)];
        const t = decide(b).terms.find((x) => x.name === "mutation");
        expect(t.skipped).toBe(true);
        expect(t.held).toBe(true);
        expect(decide(b).default).toBe(PLAN);
    });

    it("skips the mutation term when the other arm has no mutants", () => {
        const b = base();
        b.mutation[WP] = [mut(0, 0)];
        expect(decide(b).terms.find((x) => x.name === "mutation").skipped).toBe(true);
    });
});

describe("pooledScore", () => {
    it("sums counts across files before dividing", () => {
        // 1 of 1 killed and 1 of 9 killed: pooled 2/10, not the average of 1.0 and 0.11
        expect(pooledScore([mut(1, 0), mut(1, 8)])).toBeCloseTo(0.2);
    });

    it("counts timed-out mutants as killed", () => {
        expect(pooledScore([mut(1, 1, 2)])).toBeCloseTo(0.75);
    });

    it("is null with no mutants", () => {
        expect(pooledScore([mut(0, 0), mut(0, 0)])).toBeNull();
    });
});

describe("renderTable", () => {
    it("shows each pick and arm with its mutation scores", () => {
        const runs = PICKS.flatMap((pick) => [PLAN, WP].map((arm) => ({ pick, arm, runId: "r", row: row({ planSkill: arm }), go: mut(3, 1), ts: mut(0, 0) })));
        const out = renderTable(runs);
        for (const pick of PICKS) expect(out).toContain(pick);
        expect(out).toContain("0.75");
    });
});

describe("loadBench", () => {
    let dir;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "verdict-"));
        mkdirSync(join(dir, "mutation"));
        mkdirSync(join(dir, "results"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const runsJson = PICKS.flatMap((pick) => [PLAN, WP].map((arm) => ({ pick, arm, runId: `${pick}-${arm}` })));
    const writeAll = () => {
        writeFileSync(join(dir, "runs.json"), JSON.stringify(runsJson));
        for (const { pick, arm } of runsJson) for (const k of ["go", "ts"]) writeFileSync(join(dir, "mutation", `${pick}-${arm}-${k}.json`), JSON.stringify(mut(1, 1)));
        writeFileSync(join(dir, "results", "blind.json"), JSON.stringify(Object.fromEntries(PICKS.map((p) => [p, win(PLAN)]))));
    };
    const rowFor = (id) => row({ runId: id, planSkill: id.endsWith(WP) ? WP : PLAN });

    it("joins runs, mutation files and blind verdicts into a decision input", () => {
        writeAll();
        const b = loadBench(dir, rowFor);
        expect(b.rows[PLAN]).toHaveLength(3);
        expect(b.rows[WP]).toHaveLength(3);
        expect(b.mutation[PLAN]).toHaveLength(6);
        expect(decide(b).default).toBe(PLAN);
    });

    it("names every missing mutation file, blind.json and runs.json", () => {
        writeFileSync(join(dir, "runs.json"), JSON.stringify(runsJson));
        expect(() => loadBench(dir, rowFor)).toThrow(/resource-plan-go\.json/);
        expect(() => loadBench(dir, rowFor)).toThrow(/blind\.json/);
        expect(() => loadBench(join(dir, "nope"), rowFor)).toThrow(/runs\.json/);
    });

    it("names a run that has no dag or is not done", () => {
        writeAll();
        expect(() => loadBench(dir, (id) => (id === "pwa-plan" ? null : rowFor(id)))).toThrow(/pwa-plan/);
        expect(() => loadBench(dir, (id) => (id === "pwa-writing-plans" ? row({ minutes: null }) : rowFor(id)))).toThrow(/pwa-writing-plans/);
    });

    it("names a pick missing from blind.json", () => {
        writeAll();
        writeFileSync(join(dir, "results", "blind.json"), JSON.stringify({ resource: win(PLAN), pwa: win(PLAN) }));
        expect(() => loadBench(dir, rowFor)).toThrow(/rendered/);
    });
});

describe("cli", () => {
    it("exits non-zero and names the missing mutation file", () => {
        const dir = mkdtempSync(join(tmpdir(), "verdict-cli-"));
        try {
            writeFileSync(join(dir, "runs.json"), JSON.stringify([{ pick: "resource", arm: PLAN, runId: "x" }]));
            const r = spawnSync(process.execPath, [SCRIPT, "--bench", dir], { encoding: "utf8" });
            expect(r.status).not.toBe(0);
            expect(r.stderr).toContain("resource-plan-go.json");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
