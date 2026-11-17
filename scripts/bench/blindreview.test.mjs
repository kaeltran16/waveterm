import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { armDiff, buildPrompt, claudeEnv, combineOrders, judgePick, parseVerdict, reviewBench } from "./blindreview.mjs";

let dir;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blindreview-"));
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

const git = (cwd, ...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();

function put(root, rel, text) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
}

// a repo with a base commit and a branch that touches code, a plan doc and the design scratch dir
function repoWithBranch(name, branch, files) {
    const root = join(dir, name);
    mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    put(root, "keep.txt", "base\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    const base = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-q", "-b", branch);
    for (const [rel, text] of Object.entries(files)) put(root, rel, text);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "work");
    return { root, base };
}

describe("armDiff", () => {
    it("leaves out docs/superpowers/plans/ and .superpowers/, which would reveal the skill", () => {
        const { root, base } = repoWithBranch("a", "bench/x-plan", {
            "pkg/feature.go": "package pkg\n",
            "docs/superpowers/plans/2026-01-01-x.md": "plan form\n",
            ".superpowers/design/mock.html": "<html>\n",
            "docs/superpowers/specs/keep-me.md": "spec edit\n",
        });
        const diff = armDiff(root, base, "bench/x-plan");
        expect(diff).toContain("pkg/feature.go");
        expect(diff).toContain("docs/superpowers/specs/keep-me.md");
        expect(diff).not.toContain("docs/superpowers/plans/");
        expect(diff).not.toContain(".superpowers/design");
        expect(diff).not.toContain("plan form");
    }, 30_000);
});

describe("parseVerdict", () => {
    it("reads the last line of a reply that has prose before it", () => {
        const reply = 'X covers more of the spec.\nY misses the retry case.\n{"winner": "X", "why": "fuller coverage"}\n';
        expect(parseVerdict(reply, "pwa", "first")).toEqual({ winner: "X", why: "fuller coverage" });
    });
    it("accepts a tie", () => {
        expect(parseVerdict('{"winner":"tie","why":"same"}', "pwa", "first").winner).toBe("tie");
    });
    it("is an error naming the pick and order when the last line is not a verdict", () => {
        expect(() => parseVerdict("I prefer X.", "rendered", "second")).toThrow(/rendered.*second/);
    });
    it("is an error naming the pick and order when the winner is not X, Y or tie", () => {
        expect(() => parseVerdict('{"winner": "plan", "why": "?"}', "resource", "first")).toThrow(/resource.*first/);
    });
    it("is an error, not a tie, for an empty reply", () => {
        expect(() => parseVerdict("\n", "pwa", "second")).toThrow(/pwa.*second/);
    });
});

describe("combineOrders", () => {
    const key = { X: "writing-plans", Y: "plan" };
    it("gives the arm both orders picked, unblinded through the key", () => {
        expect(combineOrders("Y", "Y", key)).toBe("plan");
        expect(combineOrders("X", "X", key)).toBe("writing-plans");
    });
    it("is a tie when the orders disagree", () => {
        expect(combineOrders("X", "Y", key)).toBe("tie");
    });
    it("is a tie when either order says tie", () => {
        expect(combineOrders("tie", "tie", key)).toBe("tie");
        expect(combineOrders("X", "tie", key)).toBe("tie");
    });
});

describe("buildPrompt", () => {
    it("inserts the spec and shows the two diffs in the given order under their labels", () => {
        const text = buildPrompt("SPEC-BODY", [
            { label: "Y", diff: "DIFF-OF-Y" },
            { label: "X", diff: "DIFF-OF-X" },
        ]);
        expect(text).toContain("SPEC-BODY");
        expect(text.indexOf("DIFF-OF-Y")).toBeLessThan(text.indexOf("DIFF-OF-X"));
        expect(text).toMatch(/Y[\s\S]*DIFF-OF-Y[\s\S]*X[\s\S]*DIFF-OF-X/);
    });
});

describe("claudeEnv", () => {
    it("drops the session variables, sets the cache ttl, and keeps the rest", () => {
        const env = claudeEnv({
            CLAUDE_CODE_CHILD_SESSION: "1",
            CLAUDE_CODE_SESSION_ID: "s",
            CLAUDE_CODE_ENTRYPOINT: "cli",
            CLAUDE_CODE_MESSAGING_SOCKET: "p",
            CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
            PATH: "/bin",
        });
        expect(env).toEqual({ PATH: "/bin", CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" });
    });
});

describe("judgePick", () => {
    it("shows X first then Y first, and returns both verdicts", async () => {
        const seen = [];
        const run = async (prompt) => {
            seen.push(prompt);
            return `reasoning\n{"winner": "${seen.length === 1 ? "X" : "Y"}", "why": "w"}`;
        };
        const out = await judgePick("pwa", "SPEC", { X: "DX", Y: "DY" }, run);
        expect(out.first.winner).toBe("X");
        expect(out.second.winner).toBe("Y");
        expect(seen[0].indexOf("DX")).toBeLessThan(seen[0].indexOf("DY"));
        expect(seen[1].indexOf("DY")).toBeLessThan(seen[1].indexOf("DX"));
    });
    it("fails with the pick and order when a reply has no verdict", async () => {
        const run = async () => "no json here";
        await expect(judgePick("rendered", "S", { X: "a", Y: "b" }, run)).rejects.toThrow(/rendered.*first/);
    });
});

describe("reviewBench", () => {
    function benchWith(picks) {
        const bench = join(dir, "bench");
        const runs = [];
        for (const pick of picks) {
            put(bench, `specs/${pick}.md`, `spec of ${pick}\n`);
            for (const arm of ["plan", "writing-plans"]) {
                const { root, base } = repoWithBranch(`${pick}-${arm}`, `bench/${pick}-${arm}`, {
                    [`src/${pick}-${arm}.go`]: `package ${arm.replace("-", "")}\n`,
                    [`docs/superpowers/plans/${arm}.md`]: "plan\n",
                });
                runs.push({ pick, arm, base, branch: `bench/${pick}-${arm}`, worktree: root });
            }
        }
        put(bench, "runs.json", JSON.stringify(runs));
        return bench;
    }
    const sealed = (bench) => JSON.parse(readFileSync(join(bench, "results", "blind-key.json"), "utf8"));

    // answers the label of the "# Diff X|Y" section holding the plan arm's file, whatever order the prompt shows them in
    const preferPlan = async (prompt) => {
        const at = prompt.search(/src\/\w+-plan\.go/);
        expect(at).toBeGreaterThan(-1);
        const headers = [...prompt.matchAll(/^# Diff (X|Y)$/gm)].filter((m) => m.index < at);
        expect(headers.length).toBeGreaterThan(0);
        const label = headers[headers.length - 1][1];
        return `reasoning first\n{"winner": "${label}", "why": "plan"}`;
    };

    it.each([0.1, 0.9])("writes shuffled diffs, a key, and verdicts unblinded through the key (rng %s)", async (draw) => {
        const bench = benchWith(["pwa", "rendered"]);
        const result = await reviewBench({ bench, run: preferPlan, rng: () => draw });
        const written = JSON.parse(readFileSync(join(bench, "results", "blind.json"), "utf8"));
        expect(written).toEqual(result);
        for (const pick of ["pwa", "rendered"]) {
            expect(written[pick].winner).toBe("plan");
            expect(readdirSync(join(bench, "blind"))).toEqual(expect.arrayContaining([`${pick}-X.diff`, `${pick}-Y.diff`]));
            const key = sealed(bench)[pick];
            expect(Object.values(key).sort()).toEqual(["plan", "writing-plans"]);
            const planSide = Object.keys(key).find((side) => key[side] === "plan");
            const planDiff = readFileSync(join(bench, "blind", `${pick}-${planSide}.diff`), "utf8");
            expect(planDiff).toContain(`src/${pick}-plan.go`);
            expect(planDiff).not.toContain("docs/superpowers/plans/");
        }
    }, 30_000);

    it("puts the arms on both sides across picks according to the random source", async () => {
        const bench = benchWith(["pwa"]);
        const run = async () => '{"winner": "tie", "why": "same"}';
        await reviewBench({ bench, run, rng: () => 0.1 });
        const low = sealed(bench).pwa;
        await reviewBench({ bench, run, rng: () => 0.9 });
        const high = sealed(bench).pwa;
        expect(low.X).not.toBe(high.X);
    }, 30_000);

    it("is a tie when a judge that always answers the first diff shown flips with the order", async () => {
        const bench = benchWith(["pwa"]);
        let calls = 0;
        const run = async () => `{"winner": "${++calls === 1 ? "X" : "Y"}", "why": "first listed"}`;
        const result = await reviewBench({ bench, run, rng: () => 0.9 });
        expect(result.pwa).toEqual({ first: "X", second: "Y", winner: "tie" });
    }, 30_000);

    it("refuses a pick with only one arm", async () => {
        const bench = benchWith(["pwa"]);
        const runs = JSON.parse(readFileSync(join(bench, "runs.json"), "utf8")).filter((r) => r.arm === "plan");
        writeFileSync(join(bench, "runs.json"), JSON.stringify(runs));
        await expect(reviewBench({ bench, run: async () => "", rng: () => 0.5 })).rejects.toThrow(/pwa/);
    }, 30_000);
});
