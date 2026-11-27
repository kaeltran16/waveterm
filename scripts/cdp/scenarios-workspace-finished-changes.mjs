// Scenario `workspace-finished-changes`: the Changes tab a done task's worker opens with, behind its Task tab, and the
// Final stage row's (docs/superpowers/plans/2026-11-27-finished-row-workspace.md, boards Main, Worker-Fallback and
// Final's Changes). The run is the shared fixture's Done board (workspace-run-fixture.mjs), pointed at a temp git repo
// whose one squash commit holds t-1's and t-4's files, which both tasks' runs record as their merge commit.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git, polishNap } from "./scenarios-shared.mjs";
import {
    arrange,
    childRunId,
    clickAt,
    endedRowId,
    FINAL_ROW_ID,
    focusRow,
    page,
    reseed,
    rowUntil,
    stepper,
    teardown,
    WAIT_MS,
} from "./workspace-run-fixture.mjs";

const NAME = "workspace-finished-changes";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
const T4 = endedRowId("t-4");
const SHORT = 7;
// a sha no repo holds: t-4's run pointed at it reads as a merge commit gone from the repository
const MISSING_SHA = "deadbeef".repeat(5);

// each task's files, as the squash holds them and its run sealed them: path, lines added
const T1_FILES = [["internal/stats/counters.go", 12], ["internal/stats/counters_test.go", 8]];
const T4_FILES = [["cmd/linkshelf/stats.go", 9], ["cmd/linkshelf/stats_test.go", 6]];
const RUN_FILES = [...T1_FILES, ...T4_FILES].map(([p]) => p);

const lines = (n) => Array.from({ length: n }, (_, i) => `// line ${i + 1}`).join("\n") + "\n";

// the temp repo: a base commit, then the squash that landed t-1 and t-4 together
function makeRepo() {
    const root = mkdtempSync(join(tmpdir(), `verify-${NAME}-repo-`));
    const repo = join(root, "linkshelf");
    mkdirSync(repo);
    git(repo, "init", "-q", "--initial-branch=main");
    writeFileSync(join(repo, "README.md"), "# linkshelf\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD").toString().trim();
    for (const [path, n] of [...T1_FILES, ...T4_FILES]) {
        mkdirSync(join(repo, dirname(path)), { recursive: true });
        writeFileSync(join(repo, path), lines(n));
    }
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "squash lane t-1, t-4");
    const squash = git(repo, "rev-parse", "HEAD").toString().trim();
    return { root, repo, base, squash };
}

const sealed = (files) => ({
    capturedts: 1,
    hash: "fx-t-4",
    files: files.map(([path, add]) => ({ path, stat: "A", add, del: 0 })),
    addtotal: files.reduce((n, [, add]) => n + add, 0),
    deltotal: 0,
    runtimems: 1,
    durationms: 1,
});

// the run at the repo from its base; t-1 and t-4 merged as the squash (t-4 as t4Commit), which Final verified
const layerFor = (r, t4Commit) => (seed) => ({
    ...seed,
    run: { ...seed.run, projectpath: r.repo, basecommit: r.base },
    dag: { ...seed.dag, final: { ...seed.dag.final, commit: r.squash } },
    children: seed.children.map((c) => {
        if (c.id === childRunId("t-1")) return { ...c, endcommit: r.squash };
        if (c.id === childRunId("t-4")) return { ...c, status: "done", endcommit: t4Commit, evidence: sealed(T4_FILES) };
        return c;
    }),
});

// the Changes tab as drawn: each listed file in order, and whether it sits under the merge's Also heading
const readChanges = (h) =>
    page(
        h,
        `const root = document.querySelector("[data-workspace-changes]");
        return {
            sealed: root?.hasAttribute("data-workspace-changes-sealed") ?? false,
            empty: document.querySelector("[data-workspace-changes-empty]")?.dataset.workspaceChangesEmpty ?? null,
            note: flat(root?.querySelector("[data-workspace-changes-note]")),
            line: flat(root?.querySelector("[data-workspace-changes-line]")),
            also: [...(root?.querySelectorAll("[data-changes-also] > div") ?? [])].map(flat),
            files: [...(root?.querySelectorAll("[data-changes-file], [data-changes-sealed-file]") ?? [])].map((el) => ({
                path: el.dataset.changesFile ?? el.dataset.changesSealedFile,
                also: el.closest("[data-changes-also-group]") != null,
            })),
            hunks: root?.querySelectorAll("[data-changes-hunk]").length ?? 0,
            loading: root?.querySelector("[data-changes-loading]") != null,
        };`
    );

async function changesUntil(h, ok, ms = WAIT_MS) {
    for (let waited = 0; ; waited += 250) {
        const s = await readChanges(h).catch(() => null);
        if ((s != null && ok(s)) || waited >= ms) return s;
        await polishNap(250);
    }
}

const paths = (s) => (s?.files ?? []).map((f) => f.path);
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CHANGES_TAB = `document.querySelector('[data-workspace-tab="changes"] [role="tab"]')`;

export const workspaceFinishedChanges = {
    name: NAME,
    surface: "agent",
    async arrange(h) {
        let r;
        try {
            r = makeRepo();
        } catch (err) {
            return { name: NAME, cleanups: [], rows: [], arrangeError: `making the temp repo: ${err?.message ?? err}` };
        }
        const ctx = await arrange(h, NAME, { finished: true, layer: layerFor(r, r.squash) });
        ctx.repoFacts = r;
        ctx.cleanups.push(() => rmSync(r.root, { recursive: true, force: true }));
        return ctx;
    },
    async assert(h, ctx) {
        const { steps, rec, step } = stepper();
        if (ctx.arrangeError != null) {
            rec(`${NAME}: arrange`, false, ctx.arrangeError);
            return steps;
        }
        const r = ctx.repoFacts;
        const short = r.squash.slice(0, SHORT);

        await step("t-4's Changes lists its own files from the merge commit first, then t-1's under Also in this merge", async () => {
            await focusRow(h, ctx, T4);
            await rowUntil(h, (s) => s.task === "t-4");
            const clicked = await clickAt(h, CHANGES_TAB);
            const row = await rowUntil(h, (s) => s.active === "changes");
            const s = await changesUntil(h, (c) => c.files.length === 4);
            await h.shot(SHOT(1, "merge"));
            const own = s?.files.filter((f) => !f.also).map((f) => f.path);
            const also = s?.files.filter((f) => f.also).map((f) => f.path);
            const ok =
                clicked &&
                !row?.rail &&
                row?.unseen.length === 0 &&
                sameList(paths(s), [...T4_FILES, ...T1_FILES].map(([p]) => p)) &&
                sameList(own, T4_FILES.map(([p]) => p)) &&
                sameList(also, T1_FILES.map(([p]) => p)) &&
                s.also.length === 1 &&
                s.also[0].includes("t-1") &&
                s.also[0].includes("internal/stats counters") &&
                s.note.includes(short) &&
                s.note.includes("t-1 → t-4");
            return [ok, { clicked, rail: row?.rail, unseen: row?.unseen, ...s }];
        });

        await step("a click on t-4's file opens its diff", async () => {
            const file = T4_FILES[0][0];
            const clicked = await clickAt(h, `document.querySelector('[data-changes-file="${file}"] [data-changes-toggle]')`);
            const s = await changesUntil(h, (c) => c.hunks > 0 && !c.loading);
            const open = await page(h, `return document.querySelector('[data-changes-file="${file}"]')?.hasAttribute("data-changes-open") ?? false;`);
            await h.shot(SHOT(2, "diff"));
            return [clicked && open && s.hunks > 0, { clicked, open, hunks: s?.hunks, loading: s?.loading }];
        });

        await step("the Final row's Changes lists the run's files and the commit its round verified", async () => {
            await focusRow(h, ctx, FINAL_ROW_ID);
            await rowUntil(h, (s) => s.final != null);
            const clicked = await clickAt(h, CHANGES_TAB);
            await rowUntil(h, (s) => s.active === "changes");
            const s = await changesUntil(h, (c) => c.files.length === RUN_FILES.length && c.note !== "");
            await h.shot(SHOT(3, "final"));
            const ok =
                clicked &&
                sameList([...paths(s)].sort(), [...RUN_FILES].sort()) &&
                s.files.every((f) => !f.also) &&
                s.note.includes(short) &&
                s.note.includes("round 1");
            return [ok, { clicked, ...s }];
        });

        await step("with t-4's merge commit missing, its Changes lists the sealed files and says why", async () => {
            ctx.layer = layerFor(r, MISSING_SHA);
            await reseed(h, ctx, { finished: true });
            await focusRow(h, ctx, T4);
            await rowUntil(h, (s) => s.active === "changes");
            const s = await changesUntil(h, (c) => c.sealed);
            await h.shot(SHOT(4, "fallback"));
            const ok =
                s?.sealed === true &&
                sameList(paths(s), T4_FILES.map(([p]) => p)) &&
                s.hunks === 0 &&
                s.note.includes(MISSING_SHA.slice(0, SHORT)) &&
                s.line.startsWith("2 files");
            return [ok, s];
        });
        return steps;
    },
    teardown: (h, ctx) => teardown(h, ctx, NAME),
};
