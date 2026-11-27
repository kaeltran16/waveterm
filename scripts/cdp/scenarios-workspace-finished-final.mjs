// Scenario `workspace-finished-final`: the Final stage's row and an ended verifier show the workspace pane with the
// Final tab, never the details rail; an ended plan reviewer shows neither (docs/superpowers/plans/
// 2026-11-27-finished-row-workspace.md, boards Final, Final-Failed and Verifier). The run is the shared fixture's
// Done board (workspace-run-fixture.mjs), layered here with two Final rounds (round 1 failed at Verify, round 2 passed
// with its verifier's run and verdict) and a plan reviewer that gave its verdict; the Final-Failed board reseeds it
// with round 1 failed at Final and a question to you. The run points at a temp git repo whose second commit is the
// one round 2 verified, so the Final tab's Changes line has a real range to count, as workspace-finished-changes reads.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git, polishNap, polishWaitFor } from "./scenarios-shared.mjs";
import {
    arrange,
    CHANNEL,
    clickAt,
    endedRowId,
    FINAL_ROW_ID,
    focusRow,
    LAND_COMMIT,
    MIN,
    page,
    reseed,
    RUN_ID,
    rowUntil,
    seedTranscriptPath,
    SETTLE_MS,
    stepper,
    teardown,
    WAIT_MS,
} from "./workspace-run-fixture.mjs";

const NAME = "workspace-finished-final";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
const FINAL_KEY = `final:${RUN_ID}`;
const VERIFIER_RUN = "fx-workspace-run-verifier";
const REVIEWER_RUN = "fx-workspace-run-plan-reviewer";
const VERIFIER_ROW = endedRowId(`verifier:${VERIFIER_RUN}`);
const REVIEWER_ROW = endedRowId(`review:${REVIEWER_RUN}`);
const NARROW = { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false };
const WIDE = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };

// the canvas's Final board: round 1 failed at Verify, round 2 passed
const CHECK = "go vet ./...";
const FINAL_CMD = "node scripts/final.mjs bookmarks-list linkshelf-stats";
const TREE = "C:\\Users\\fx\\.arc\\runs\\7f3a91c2\\final";
const ROUND1_COMMIT = "7d01c3e4b2a19f08c6d5e3a1b7f9c2d4e6a8b0c1";
const VERIFY_FAIL = "Verify `go test ./...` failed (exit 1):\n--- FAIL: TestStatsEmptyShelf (0.00s)\n    stats_test.go:31: avg tags = NaN, want 0";
const VERDICT = "Read the diff against the plan. stats prints the counters the brief names and the empty shelf prints 0.0; the list view groups duplicates. No findings.";
const outDir = (round) => `C:/fx/final-shots/fx-workspace-run-dag/${round}`;
// a scenario's shots.json entry: one file per step, each tagged with its step; failAt marks that step failed
const scenarioShots = (name, steps, failAt = -1) => {
    const files = steps.map((_, i) => `cdp-shots/${name}-${i + 1}.png`);
    return {
        name,
        files,
        filesteps: Object.fromEntries(files.map((f, i) => [f, i])),
        steps: steps.map((step, i) => ({ step, state: i === failAt ? "fail" : "pass" })),
    };
};
const LIST_STEPS = ["list loads", "duplicates grouped", "tag filter"];
const STATS_STEPS = ["stats output", "empty shelf"];

// the verified commit's change: README.md edited one line for another, two files added with this many lines
const README_BASE = "# linkshelf\nbookmarks, kept\n";
const README_FINAL = "# linkshelf\nbookmarks, kept and counted\n";
const ADDED = [["cmd/linkshelf/stats.go", 9], ["internal/stats/counters.go", 12]];
const CHANGES_COUNT = `${ADDED.length + 1} files`;
const CHANGES_ADDS = `+${ADDED.reduce((n, [, add]) => n + add, 1)}`;
const CHANGES_DELS = "−1";
const lines = (n) => Array.from({ length: n }, (_, i) => `// line ${i + 1}`).join("\n") + "\n";

// copied from workspace-finished-changes: a base commit, then the commit Final verified
function makeRepo() {
    const root = mkdtempSync(join(tmpdir(), `verify-${NAME}-repo-`));
    const repo = join(root, "linkshelf");
    mkdirSync(repo);
    git(repo, "init", "-q", "--initial-branch=main");
    writeFileSync(join(repo, "README.md"), README_BASE);
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD").toString().trim();
    writeFileSync(join(repo, "README.md"), README_FINAL);
    for (const [path, n] of ADDED) {
        mkdirSync(join(repo, dirname(path)), { recursive: true });
        writeFileSync(join(repo, path), lines(n));
    }
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "squash lane");
    const verified = git(repo, "rev-parse", "HEAD").toString().trim();
    return { root, repo, base, verified };
}

// the run at the repo from its base, and the current round's commit the one Final verified there
const withRepo = (r, inner) => (seed, o) => {
    const out = inner(seed, o);
    return {
        ...out,
        run: { ...out.run, projectpath: r.repo, basecommit: r.base },
        dag: { ...out.dag, final: { ...out.dag.final, commit: r.verified } },
    };
};

// a round's final-step events, each step ending where the next starts: [step, seconds, ok]
const stepEvents = (round, start, steps) => {
    let ts = start;
    return steps.map(([step, sec, ok = true]) => {
        ts += sec * 1000;
        const detail = JSON.stringify({ round, step, ms: sec * 1000, ok });
        return { id: `fx-wff-${round}-${step}`, runid: RUN_ID, channelid: CHANNEL, kind: "final-step", ts, detail };
    });
};
const withEvents = (events, more) => [...events, ...more].sort((x, y) => x.ts - y.ts);

const verifierRunObj = (now, version) => ({
    otype: "run",
    oid: VERIFIER_RUN,
    id: VERIFIER_RUN,
    version,
    goal: "final verifier",
    title: "Verifier",
    status: "done",
    mode: "worker",
    runtime: "claude",
    model: "claude-opus-5-5",
    channeloid: CHANNEL,
    workspaceid: "",
    projectpath: "C:\\fx\\linkshelf",
    phases: [],
    stagerole: "verifier",
    createdts: now - 8 * MIN,
    completedts: now - 30_000,
});

const layer = (seed, { now, version }) => {
    const round1 = { state: "failed", round: 1, commit: ROUND1_COMMIT, tree: TREE, detail: VERIFY_FAIL, startedts: now - 40 * MIN, outdir: outDir(1) };
    seed.dag.check = CHECK;
    seed.dag.finalcmd = FINAL_CMD;
    seed.dag.maxfinalrounds = 3;
    seed.dag.pastfinals = [round1];
    seed.dag.final = {
        state: "passed",
        round: 2,
        commit: LAND_COMMIT,
        tree: TREE,
        verifierrunid: VERIFIER_RUN,
        startedts: now - 8 * MIN,
        verdicttext: VERDICT,
        outdir: outDir(2),
        shotsmanifest: true,
        shots: [scenarioShots("bookmarks-list", LIST_STEPS), scenarioShots("linkshelf-stats", STATS_STEPS)],
    };
    seed.dag.planreview = { ...seed.dag.planreview, reviewers: [{ lens: "full", state: "passed", runid: REVIEWER_RUN }] };
    seed.extra = [...seed.extra, verifierRunObj(now, version)];
    seed.events = withEvents(seed.events, [
        ...stepEvents(1, now - 40 * MIN, [["tree", 22], ["check", 18], ["verify", 330, false]]),
        ...stepEvents(2, now - 12 * MIN, [["tree", 22], ["check", 18], ["verify", 182], ["final", 64]]),
    ]);
    return seed;
};

// the Final-Failed board: round 1 failed at Final on bookmarks-list's step 2, and the run asks you about it
const FINAL_FAIL = `Final \`${FINAL_CMD}\` failed (exit 1):\nFAIL bookmarks-list 2. duplicates grouped\n     {"groups":0,"want":2}`;
const FAILED_FILE = "cdp-shots/bookmarks-list-2.png";
const failedLayer = (seed, { now }) => {
    seed.dag.check = CHECK;
    seed.dag.finalcmd = FINAL_CMD;
    seed.dag.maxfinalrounds = 3;
    seed.dag.status = "blocked";
    seed.dag.pastfinals = [];
    seed.dag.final = {
        state: "failed",
        round: 1,
        commit: ROUND1_COMMIT,
        tree: TREE,
        detail: FINAL_FAIL,
        startedts: now - 6 * MIN,
        outdir: outDir(1),
        shotsmanifest: true,
        shots: [scenarioShots("linkshelf-stats", STATS_STEPS), scenarioShots("bookmarks-list", LIST_STEPS, 1)],
    };
    seed.events = withEvents(seed.events, stepEvents(1, now - 6 * MIN, [["tree", 22], ["check", 18], ["verify", 182], ["final", 64, false]]));
    return seed;
};
const USER_ASK = {
    taskid: "",
    askid: "fx-workspace-run-final-ask",
    owner: "user",
    questions: [{ question: "Final failed on bookmarks-list. Rerun it, or plan a fix round?", header: "Final", options: [{ label: "Rerun" }, { label: "Fix round" }] }],
    blockoref: "",
    ts: 0,
};

// a DOM key event at the focused element, as the keybinding dispatcher on window hears it: CDP's key events often
// never reach the WebView
const pressKey = (h, key, code) =>
    h.ev(`(() => {
        const target = document.activeElement ?? document.body;
        const init = { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, bubbles: true, cancelable: true };
        target.dispatchEvent(new KeyboardEvent("keydown", init));
        target.dispatchEvent(new KeyboardEvent("keyup", init));
        return true;
    })()`);

const seeded = (r) => JSON.stringify(r.tabs) === JSON.stringify([FINAL_KEY, "changes"]) && r.active === FINAL_KEY;

const TAB = `document.querySelector("[data-workspace-final]")`;
const VIEWER = `document.querySelector("[data-final-shots-viewer]")`;
// the Final tab as drawn: its head, its sections in order, the verifier, the screenshots, and the tab's dots
const readFinal = (h, rowId) =>
    page(
        h,
        `const tab = ${TAB};
        const q = (sel) => tab?.querySelector(sel);
        const verifier = q('[data-final-tab-section="verifier"]');
        const tree = [...(q("[data-final-facts]")?.querySelectorAll("span[title]") ?? [])].find((s) => /final$/.test(s.title));
        const shot = (b) => ({ file: b.dataset.finalTabShot, failed: b.dataset.finalTabShotFailed === "true", label: flat(b), border: getComputedStyle(b).borderTopColor });
        return {
            head: flat(q("[data-workspace-final-head]")),
            state: flat(q("[data-final-tab-state]")),
            rounds: [...(tab?.querySelectorAll("[data-final-tab-round]") ?? [])].map((b) => ({ round: b.dataset.finalTabRound, on: b.getAttribute("aria-selected") === "true" })),
            meta: flat(q("[data-final-tab-meta]")),
            sections: [...(tab?.querySelectorAll("[data-final-tab-section]") ?? [])].map((s) => s.dataset.finalTabSection),
            why: flat(q('[data-final-tab-section="why"] [data-tool-error]')),
            lead: flat(q("[data-final-tab-lead]")),
            verifierRan: verifier?.dataset.finalTabVerifierRan ?? null,
            changes: {
                heading: flat(q('[data-final-tab-section="changes"] h3')),
                line: flat(q("[data-final-tab-changes]")).replace(/\\s+/g, ""),
                button: flat(q("[data-final-tab-open-changes]")),
            },
            session: verifier?.dataset.finalTabSession === "true",
            verifierText: flat(verifier),
            verifierMeta: flat(q("[data-final-tab-verifier-meta]")),
            tree: tree ? { dir: tree.getAttribute("dir"), text: flat(tree) } : null,
            scenarios: [...(tab?.querySelectorAll("[data-final-tab-scenario]") ?? [])].map((s) => s.dataset.finalTabScenario),
            shots: [...(tab?.querySelectorAll("[data-final-tab-shot]") ?? [])].map(shot),
            empty: flat(q("[data-final-tab-shots-empty]")),
            picked: ws(${JSON.stringify(rowId)}).tabs.find((t) => t.kind === "final")?.round ?? null,
            waiting: document.querySelector('[data-workspace-tab="${FINAL_KEY}"] [data-workspace-tab-waiting]') != null,
            active: ws(${JSON.stringify(rowId)}).active,
        };`
    );

async function finalUntil(h, rowId, ok, ms = WAIT_MS) {
    for (let waited = 0; ; waited += 250) {
        const s = await readFinal(h, rowId).catch(() => null);
        if ((s != null && ok(s)) || waited >= ms) return s;
        await polishNap(250);
    }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export const workspaceFinishedFinal = {
    name: NAME,
    surface: "agent",
    async arrange(h) {
        let r;
        try {
            r = makeRepo();
        } catch (err) {
            return { name: NAME, cleanups: [], rows: [], arrangeError: `making the temp repo: ${err?.message ?? err}` };
        }
        const ctx = await arrange(h, NAME, { finished: true, layer: withRepo(r, layer) });
        ctx.cleanups.push(() => rmSync(r.root, { recursive: true, force: true }));
        if (ctx.arrangeError != null) return ctx;
        try {
            // neither session's transcript is looked up on the server, which has no page-only run
            await seedTranscriptPath(h, VERIFIER_RUN, "");
            await seedTranscriptPath(h, REVIEWER_RUN, "");
        } catch (err) {
            ctx.arrangeError = String(err?.message ?? err);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const { steps, rec, step } = stepper(h);
        if (ctx.arrangeError != null) {
            rec(`${NAME}: arrange`, false, ctx.arrangeError);
            return steps;
        }

        await step("the Final row shows no details rail and the pane, Final active and Changes unseen, beside the stage's steps", async () => {
            await focusRow(h, ctx, FINAL_ROW_ID);
            const s = await rowUntil(h, (r) => r.final === RUN_ID && r.pane === "open");
            await h.shot(SHOT(1, "final-row"));
            const ok =
                !s.rail &&
                s.finalPane &&
                s.pane === "open" &&
                seeded(s) &&
                s.labels[0] === "Final" &&
                JSON.stringify(s.unseen) === JSON.stringify(["changes"]) &&
                s.final === RUN_ID;
            return [ok, s];
        });

        await step("board Final: the tab opens on round 2 passed, a Round switch over both rounds, round 2 of 3, then Verified (Tree keeping its end), Verifier, Screenshots and Changes", async () => {
            const f = await finalUntil(h, FINAL_ROW_ID, (x) => x.rounds.length === 2 && x.shots.length > 0);
            await h.shot(SHOT(2, "final-round-2"));
            const ok =
                f.head.startsWith("Final verification") &&
                f.state === "Passed" &&
                same(f.rounds, [{ round: "1", on: false }, { round: "2", on: true }]) &&
                f.meta.startsWith("round 2 of 3 · ") &&
                same(f.sections, ["verified", "verifier", "shots", "changes"]) &&
                f.verifierRan === "true" &&
                f.verifierText.includes(VERDICT) &&
                f.verifierMeta.startsWith("opus-5-5") &&
                f.verifierMeta.endsWith("nothing unverified") &&
                f.tree?.dir === "rtl" &&
                /final$/.test(f.tree.text) &&
                same(f.scenarios, ["bookmarks-list", "linkshelf-stats"]) &&
                f.shots[0].label === `1. ${LIST_STEPS[0]}` &&
                f.shots.every((x) => !x.failed);
            return [ok, f];
        });

        await step("board Final: once the row's read lands, Changes reads the verified range's file count with its adds and dels before Open changes", async () => {
            const want = `${CHANGES_COUNT}${CHANGES_ADDS}${CHANGES_DELS}`.replace(/\s+/g, "");
            const f = await finalUntil(h, FINAL_ROW_ID, (x) => x.changes.line !== "");
            await h.shot(SHOT("2b", "final-changes"));
            const ok =
                same(f.sections.slice(-1), ["changes"]) &&
                f.changes.heading === "Changes" &&
                f.changes.line === want &&
                f.changes.button === "Open changes";
            return [ok, f.changes];
        });

        await step("board Final: Round 1 shows Why it failed first and a verifier that did not run, the pick kept on the tab", async () => {
            await clickAt(h, `${TAB}?.querySelector('[data-final-tab-round="1"]')`);
            const f = await finalUntil(h, FINAL_ROW_ID, (x) => x.sections[0] === "why");
            await h.shot(SHOT(3, "final-round-1"));
            const ok =
                f.picked === 1 &&
                f.state === "Failed at Verify" &&
                f.meta.startsWith("round 1 of 3 · ") &&
                f.meta.endsWith(`commit ${ROUND1_COMMIT.slice(0, 7)}`) &&
                same(f.sections, ["why", "shots", "verifier", "verified", "changes"]) &&
                f.why.startsWith("Verify `go test ./...` failed") &&
                f.verifierRan === "false" &&
                /did not run/i.test(f.verifierText) &&
                f.shots.length === 0 &&
                f.empty.includes("ended at Verify");
            return [ok, f];
        });

        await step("Open changes in the Final tab activates the Changes tab", async () => {
            await clickAt(h, `${TAB}?.querySelector("[data-final-tab-open-changes]")`);
            const s = await rowUntil(h, (r) => r.active === "changes");
            const ok = s.active === "changes" && s.unseen.length === 0;
            // back on Final for the boards below
            await page(h, `W.activateWorkspaceTab(${JSON.stringify(FINAL_ROW_ID)}, ${JSON.stringify(FINAL_KEY)}); return true;`);
            await rowUntil(h, (r) => r.active === FINAL_KEY);
            return [ok, s];
        });

        await step("d collapses the Final row's pane to its strip, and no rail opens", async () => {
            await pressKey(h, "d", "KeyD");
            const s = await rowUntil(h, (r) => r.pane === "strip");
            await h.shot(SHOT(4, "collapsed"));
            await pressKey(h, "d", "KeyD");
            await polishNap(SETTLE_MS);
            return [s.pane === "strip" && !s.rail, s];
        });

        await step("the ended verifier's row opens its Final tab, with no details rail", async () => {
            await focusRow(h, ctx, VERIFIER_ROW);
            const s = await rowUntil(h, (r) => r.final === RUN_ID && r.pane === "open");
            await h.shot(SHOT(5, "verifier"));
            return [!s.rail && s.ended && seeded(s) && s.final === RUN_ID, s];
        });

        await step("board Verifier: the ended verifier's tab leads with its round's Verifier, marked this session", async () => {
            const f = await finalUntil(h, VERIFIER_ROW, (x) => x.sections.length > 0);
            const ok =
                f.picked === 2 &&
                same(f.sections, ["verifier", "verified", "shots", "changes"]) &&
                f.session &&
                f.verifierMeta.startsWith("this session · ") &&
                f.verifierText.includes(VERDICT);
            return [ok, f];
        });

        await step("an ended plan reviewer's row shows its transcript with neither the rail nor the pane", async () => {
            await focusRow(h, ctx, REVIEWER_ROW);
            await polishNap(SETTLE_MS);
            const s = await rowUntil(h, (r) => r.pane == null && !r.finalPane);
            await h.shot(SHOT(6, "plan-reviewer"));
            const center = await h.ev(`(document.querySelector("[data-agent-center]")?.textContent ?? "").includes("No transcript found")`);
            return [!s.rail && s.pane == null && s.tabs.length === 0 && center, { ...s, center }];
        });

        // the Final-Failed board: round 1 failed at Final, the lead asking you about it
        try {
            ctx.layer = failedLayer;
            await reseed(h, ctx, { finished: true });
            await page(
                h,
                `const D = await mod("app/view/agents/devmock.ts");
                globalStore.set(D.devMockAgentsAtom, (prev) => prev.map((a) => (a.id === ${JSON.stringify(ctx.leadId)} ? { ...a, state: "asking" } : a)));
                globalStore.set(C.childAsksAtom, (prev) => ({ ...prev, ${JSON.stringify(RUN_ID)}: [${JSON.stringify({ ...USER_ASK, ts: Date.now() })}] }));
                return true;`
            );
            await focusRow(h, ctx, FINAL_ROW_ID);
        } catch (err) {
            rec("Final-Failed: reseed", false, String(err?.message ?? err));
            return steps;
        }

        await step("board Final-Failed: Why it failed leads with the lead's line, the failed step outlined, and the Final tab carries the waiting dot", async () => {
            // the row's tab still has round 1 picked from the Final board, which is now the current round
            const f = await finalUntil(h, FINAL_ROW_ID, (x) => x.state === "Failed at Final" && x.waiting && x.lead !== "");
            await h.shot(SHOT(7, "final-failed"));
            const failed = f.shots.filter((x) => x.failed);
            const passed = f.shots.find((x) => !x.failed);
            const ok =
                same(f.sections, ["why", "shots", "verifier", "verified", "changes"]) &&
                f.why.startsWith("Final `") &&
                f.lead.startsWith("The lead is asking you") &&
                f.rounds.length === 0 &&
                f.meta.endsWith(`commit ${ROUND1_COMMIT.slice(0, 7)}`) &&
                same(f.scenarios, ["bookmarks-list", "linkshelf-stats"]) &&
                failed.length === 1 &&
                failed[0].file === FAILED_FILE &&
                failed[0].label === `2. ${LIST_STEPS[1]}` &&
                passed != null &&
                failed[0].border !== passed.border &&
                f.verifierRan === "false" &&
                f.verifierText.includes("Did not run: the stage stops at the first failed step.") &&
                f.waiting;
            return [ok, f];
        });

        await step("board Final-Failed: a click on the failed step's thumbnail opens the viewer on that round, scenario and step", async () => {
            await clickAt(h, `${TAB}?.querySelector('[data-final-tab-shot="${FAILED_FILE}"]')`);
            const shown = await polishWaitFor(h, `!!${VIEWER}`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const v = await page(
                h,
                `const v = ${VIEWER};
                return {
                    text: flat(v),
                    round: flat([...(v?.querySelectorAll('[role="group"][aria-label="Round"] button[aria-pressed="true"], [role="group"][aria-label="Round"] button[aria-selected="true"]') ?? [])][0]),
                };`
            );
            await h.shot(SHOT(8, "viewer"));
            await h.ev(`${VIEWER}?.querySelector('button[aria-label="Close"]')?.click()`);
            await polishWaitFor(h, `!${VIEWER}`, WAIT_MS);
            const ok = shown && v.text.includes(`${outDir(1)}/${FAILED_FILE}`) && v.text.includes("bookmarks-list");
            return [ok, { shown, ...v, text: v.text.slice(0, 300) }];
        });

        await step("at 1000x700 beside the open pane, the stage pane's headline keeps its outcome unclipped", async () => {
            await h.cdp("Emulation.setDeviceMetricsOverride", NARROW);
            await polishNap(800);
            const head = await page(
                h,
                `const head = document.querySelector("[data-final-headline]");
                return {
                    pane: document.querySelector('aside[aria-label="Workspace"]')?.dataset.workspacePane ?? null,
                    center: document.querySelector("[data-final-pane]")?.getBoundingClientRect().width ?? null,
                    headline: flat(head),
                    clipped: head ? head.scrollWidth > head.clientWidth + 1 : null,
                };`
            );
            await h.shot(SHOT(9, "narrow-headline"));
            await h.cdp("Emulation.setDeviceMetricsOverride", WIDE);
            await polishNap(SETTLE_MS);
            return [head.pane === "open" && /failed at Final/.test(head.headline) && head.clipped === false, head];
        });
        return steps;
    },
    teardown: (h, ctx) => teardown(h, ctx, NAME),
};
