// Scenario `transcript-dag`: the run cards a lead, worker, reviewer and verifier leave in their transcripts (plan
// submitted, fix round, task complete, task review, Final, run complete landed and held) and the dag status view an
// opened `wsh jarvis dag status` step shows, each drawn from argv and the seeded dag and run (wshcards-dag.tsx).
// The compact checks run at a card's width; the last step's run was never seeded, so its card stands on argv.

import { bash, clearTranscript, prose, ROOT, showTranscript, user, waitSeam } from "./transcript-fixture.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T0 = Date.UTC(2026, 10, 16, 9, 0, 0);
const S = 1000;
const M = 60 * S;
// an opened step's body settles before a step reads it
const MOTION_MS = 600;
// a fetch for a run that does not exist has failed by then
const FETCH_FAIL_MS = 3_000;
const WIDTH = 736;
const COMPACT_WIDTH = 380;

const CH = "ch-dag-fixture";
const RUN = "5f2d916b-0000-4000-8000-00000000d001";
const HELD_RUN = "d508bb65-0000-4000-8000-00000000d002";
const MISSING_RUN = "0badf00d-0000-4000-8000-00000000d003";
const SHA = {
    t1: "162e724aa0000000000000000000000000000001",
    t2: "720eb1ab00000000000000000000000000000002",
    t3: "8a1c3e9c00000000000000000000000000000003",
    t4: "b47d0e1d00000000000000000000000000000004",
    merged: "59c03d0e00000000000000000000000000000005",
    landed: "c72b9fa000000000000000000000000000000006",
};

const lead = (runId) => ({ role: { kind: "lead", runId }, channelId: CH });
const worker = (taskId) => ({ role: { kind: "worker", leadRunId: RUN, taskId }, channelId: CH });
const VERIFIER = { role: { kind: "stage", leadRunId: RUN, stageRole: "verifier" }, channelId: CH };

const task = (id, label, extra = {}) => ({ id, label, state: "pending", ...extra });

const group = (runId, tasks, extra = {}) => ({
    otype: "dag",
    oid: `dag-${runId.slice(0, 8)}`,
    version: 1,
    meta: {},
    id: `dag-${runId.slice(0, 8)}`,
    runid: runId,
    channelid: CH,
    parallelism: 3,
    tasks,
    status: "running",
    failures: 0,
    createdts: T0,
    updatedts: T0,
    finalcmd: "node scripts/cdp/final-verify.mjs",
    // the engine stamps its round limits on every dag it creates; the cards draw "of N" from these
    maxfinalrounds: 3,
    maxreviewrounds: 2,
    ...extra,
});

// a dag created before the engine stamped its round limits
const unstamped = ({ group: { maxfinalrounds, maxreviewrounds, ...g }, ...rest }) => ({ ...rest, group: g });

const digest = (extra = {}) => ({
    dagversion: 1,
    health: "healthy",
    counts: { total: 4, done: 2, running: 1, stalled: 0, dependencywaiting: 0, attention: 1, recoveredretry: 0, mergeready: 0 },
    next: { kind: "dispatch" },
    tasks: [],
    durations: { elapsedms: 0 },
    report: { workerms: 0, commits: [], answered: 0, forwarded: 0 },
    ...extra,
});

const run = (id, extra = {}) => ({
    otype: "run",
    oid: id,
    version: 1,
    meta: {},
    id,
    channeloid: CH,
    goal: "Arithmetic modules",
    workspaceid: "ws-fixture",
    projectpath: "C:/fixture/demo-calc",
    status: "done",
    phases: [],
    createdts: T0,
    mode: "orchestrator",
    basebranch: "main",
    ...extra,
});

const PLAN = [
    task("t-1", "add module"),
    task("t-2", "subtract module"),
    task("t-3", "multiply module", { deps: ["t-1"] }),
    task("t-4", "truncate"),
];

// stamped when the seed is serialised for the page, not at module load: final-verify loads every scenario module
// before the first runs, so a load-time stamp is minutes old by the time this scenario reads it
const ago = (t, key, ms) => Object.defineProperty(t, key, { get: () => Date.now() - ms, enumerable: true });

// the four tasks mid-run: two landed, one running, one in review, and t-4's worker asking
const BUILD = [
    task("t-1", "add module", { state: "done", merged: true }),
    ago(task("t-2", "subtract module", { state: "running" }), "firstactivity", 4 * M + 10 * S),
    ago(task("t-3", "multiply module", { deps: ["t-1"], state: "reviewing", reviewround: 0 }), "lastactivity", 2 * M + 11 * S),
    task("t-4", "truncate", { state: "running", reviewround: 1, reviewcommit: SHA.t4 }),
];

const FINAL_TEXT = "Every scenario passes on the merged result; the four modules import cleanly.";

const LIVE = {
    group: group(RUN, BUILD, {
        planreview: {
            state: "reviewing",
            round: 1,
            reviewers: [
                { lens: "full", state: "reviewing" },
                { lens: "second", state: "reviewing" },
            ],
        },
        final: {
            state: "passed",
            round: 1,
            commit: SHA.merged,
            detail: FINAL_TEXT,
            outdir: "C:/fixture/final-out",
            shotsmanifest: true,
            shots: [{ name: "calc-ui", files: ["calc-ui-1.png"], steps: [{ step: "renders", state: "pass" }] }],
        },
    }),
    digest: digest({
        counts: { total: 4, done: 1, running: 2, stalled: 0, dependencywaiting: 0, attention: 1, recoveredretry: 0, mergeready: 0 },
        tasks: [{ taskid: "t-4", waitreason: "ask", mergestate: "waiting", cleanupstate: "clear" }],
        report: { workerms: 0, commits: [{ taskid: "t-1", commit: SHA.t1 }], answered: 0, forwarded: 0 },
    }),
};

const LANDED = {
    group: group(RUN, PLAN.map((t) => ({ ...t, state: "done", merged: true })), { status: "done" }),
    digest: digest({
        health: "done",
        counts: { total: 4, done: 4, running: 0, stalled: 0, dependencywaiting: 0, attention: 0, recoveredretry: 0, mergeready: 0 },
        durations: { elapsedms: 39 * M + 38 * S },
        report: {
            workerms: 0,
            commits: ["t1", "t2", "t3", "t4", "t1", "t2", "t3", "t4"].map((k, i) => ({ taskid: `t-${(i % 4) + 1}`, commit: SHA[k] })),
            answered: 1,
            forwarded: 0,
        },
    }),
};

const fixRound = (n, k) =>
    task(`t-${n}`, k === 1 ? "Bound arrows store their box's x/y after a glide" : "Empty state clears the toolbar at narrow widths", {
        description: `Fix round 3: this is task ${k} of the fix plan at docs/fix.md; re-read it there`,
    });

const HELD = {
    group: group(HELD_RUN, [...PLAN.map((t) => ({ ...t, state: "done", merged: true })), fixRound(5, 1), fixRound(6, 2)], {
        status: "done",
        failures: 0,
        final: { state: "failed", round: 3, commit: SHA.merged, detail: "the label lags its arrow" },
    }),
    digest: digest({
        health: "done",
        counts: { total: 6, done: 6, running: 0, stalled: 0, dependencywaiting: 0, attention: 0, recoveredretry: 0, mergeready: 0 },
        durations: { elapsedms: 161 * M },
        report: { workerms: 0, commits: [{ taskid: "t-5", commit: SHA.t3 }], answered: 0, forwarded: 1 },
    }),
};

const SEED_LIVE = { [`dag:${RUN}`]: LIVE, [`run:${RUN}`]: run(RUN, { status: "running" }) };
const SEED_UNSTAMPED = { ...SEED_LIVE, [`dag:${RUN}`]: unstamped(LIVE) };

const brief = (text) => [user(text, T0), prose("Reading the plan's files.", T0 + S)];

// named { entries, seed, ctx } the boards scenario composes (transcript-boards)
export const fixtures = {
    planSubmitted: {
        ctx: lead(RUN),
        seed: SEED_LIVE,
        entries: [
            ...brief("Goal: add, subtract, multiply and truncate modules with tests"),
            bash({
                description: "Submit the plan",
                command: "wsh jarvis dag submit --plan docs/plans/arith.md",
                output: "dag submitted (4 tasks, 3 lanes, longest chain 2, parallelism 3)",
                ts: T0 + 3 * M,
                durationMs: 1800,
            }),
            prose("Submitted. The plan review is reading it.", T0 + 3 * M + 2 * S),
        ],
    },
    fixRound: {
        ctx: lead(HELD_RUN),
        seed: { [`dag:${HELD_RUN}`]: HELD },
        entries: [
            prose("Both defects are real. A fix round with one task per defect.", T0),
            bash({
                description: "Submit the fix round",
                command: "wsh jarvis dag submit --round --plan docs/fix.md",
                output: "dag submitted",
                ts: T0 + S,
                durationMs: 900,
            }),
        ],
    },
    dagStatus: {
        ctx: lead(RUN),
        seed: SEED_LIVE,
        entries: [
            prose("Checking where the tasks stand.", T0),
            bash({ description: "Check the tasks", command: "wsh jarvis dag status", output: "dag status", ts: T0 + S, durationMs: 200 }),
            prose("Two landed; t-4 asks.", T0 + 2 * S),
        ],
    },
    taskComplete: {
        ctx: worker("t-2"),
        seed: SEED_LIVE,
        entries: [
            ...brief("t-2: subtract module, with tests, in src/subtract.js"),
            prose("Subtract is in src/subtract.js with four tests; the suite passes.", T0 + 2 * M),
            bash({
                description: "Complete the task",
                command: `wsh jarvis complete --commit ${SHA.t2} --report C:/tmp/t-2.md`,
                output: "run phase marked complete; the engine takes it from here",
                ts: T0 + 2 * M + S,
                durationMs: 600,
            }),
        ],
    },
    reviewPassed: {
        ctx: worker("t-3"),
        seed: SEED_LIVE,
        entries: [
            bash({
                description: "Pass the review",
                command: 'wsh jarvis dag review pass "Multiply matches the plan: it imports add from t-1, four tests."',
                output: "review recorded",
                ts: T0,
                durationMs: 300,
            }),
        ],
    },
    reviewSentBack: {
        ctx: worker("t-4"),
        seed: SEED_LIVE,
        entries: [
            bash({
                description: "Send the task back",
                command: `wsh jarvis dag review fail "truncate returns the input unchanged when n is 0; the plan says it returns \\"\\". Add a test for n = 0."`,
                output: "review recorded",
                ts: T0,
                durationMs: 300,
            }),
        ],
    },
    reviewSentBackUnstamped: {
        ctx: worker("t-4"),
        seed: SEED_UNSTAMPED,
        entries: [
            bash({
                description: "Send the task back",
                command: 'wsh jarvis dag review fail "Add a test for n = 0."',
                output: "review recorded",
                ts: T0,
                durationMs: 300,
            }),
        ],
    },
    finalPassed: {
        ctx: VERIFIER,
        seed: SEED_LIVE,
        entries: [
            bash({
                description: "Record the verdict",
                command: `wsh jarvis dag final pass "${FINAL_TEXT}"`,
                output: "final verdict recorded",
                ts: T0,
                durationMs: 400,
            }),
        ],
    },
    runLanded: {
        ctx: lead(RUN),
        seed: {
            [`dag:${RUN}`]: LANDED,
            [`run:${RUN}`]: run(RUN, { land: { state: "landed", commit: SHA.landed } }),
        },
        entries: [
            prose("All four modules landed and Final passed on the merged result.", T0),
            bash({
                description: "Complete the run",
                command: "wsh jarvis complete --commit $(git rev-parse HEAD) --report C:/tmp/run.md",
                output: "run phase marked complete; the engine takes it from here",
                ts: T0 + S,
                durationMs: 2100,
            }),
        ],
    },
    runHeld: {
        ctx: lead(HELD_RUN),
        seed: {
            [`dag:${HELD_RUN}`]: HELD,
            [`run:${HELD_RUN}`]: run(HELD_RUN, {
                landpath: "C:/fixture/wt/d508bb65",
                land: { state: "held", reason: "the final stage failed" },
            }),
        },
        entries: [
            prose("No round is left, so I'm completing the run; the branch stays unmerged until you decide.", T0),
            bash({
                description: "Complete the run",
                command: "wsh jarvis complete --hold-land --report C:/tmp/run.md",
                output: "run phase marked complete; the engine takes it from here",
                ts: T0 + S,
                durationMs: 1700,
            }),
        ],
    },
    runMissing: {
        ctx: lead(MISSING_RUN),
        entries: [
            bash({
                description: "Complete the run",
                command: `wsh jarvis complete --commit ${SHA.landed} --report C:/tmp/run.md`,
                output: "run phase marked complete",
                ts: T0,
                durationMs: 500,
            }),
        ],
    },
};

const probe = (body) => `(() => { const root = document.querySelector(${JSON.stringify(ROOT)}); if (!root) return null; ${body} })()`;

const cardState = (key) =>
    probe(`
    const cards = [...root.querySelectorAll('[data-wsh-card=${JSON.stringify(key)}]')];
    return cards.map((c) => ({
        text: c.textContent,
        inFold: !!c.closest('[data-steps]'),
        showCommand: !!c.querySelector('button[aria-label="Show the command"]'),
        buttons: [...c.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean),
        planTasks: c.querySelectorAll('[data-plan-task]').length,
        roundTasks: c.querySelectorAll('[data-round-task]').length,
        stats: c.querySelector('[data-run-stats]')?.textContent ?? null,
        landLine: c.querySelector('[data-land-line]')?.textContent ?? null,
        loadError: c.querySelector('[data-wsh-load-error]')?.textContent ?? null,
        width: Math.round(c.getBoundingClientRect().width),
    }));
`);

const STATUS_STATE = probe(`
    const view = root.querySelector('[data-wsh-view="dag-status"]');
    if (!view) return null;
    return {
        text: view.textContent,
        pills: [...view.querySelectorAll('[data-task-pill]')].map((p) => p.getAttribute('data-task-pill')),
        rawFooter: view.textContent.includes('Open full view'),
    };
`);

const OPEN_STATUS_STEP = probe(`
    const step = [...root.querySelectorAll('[data-step]')].find((s) => s.textContent.includes('Check the tasks'));
    const btn = step?.querySelector('button');
    if (!btn) return false;
    btn.click();
    return true;
`);

async function show(h, name, width = WIDTH, compact = false) {
    const f = fixtures[name];
    await showTranscript(h, { entries: f.entries, width, compact, active: false, renderers: true, ctx: f.ctx, seed: f.seed });
}

const includesAll = (text, parts) => text != null && parts.every((p) => text.includes(p));

async function openStatus(h) {
    const clicked = await h.ev(OPEN_STATUS_STEP);
    await sleep(MOTION_MS);
    return { clicked, view: await h.ev(STATUS_STATE) };
}

async function fullSteps(h) {
    const steps = [];

    await show(h, "planSubmitted");
    const [plan] = (await h.ev(cardState("dag-submit"))) ?? [];
    await h.shot("cdp-shots/transcript-dag-plan.png");
    steps.push({
        step: "Plan submitted with the lane grid and review status",
        ok:
            plan != null &&
            includesAll(plan.text, ["Plan submitted", "4 tasks · 3 lanes · longest chain 2", "after t-1", "multiply module", "Plan review, round 1", "Full review and Second pass are reading it", "as of now"]) &&
            plan.planTasks === 4 &&
            plan.inFold === false &&
            plan.showCommand === true &&
            plan.buttons.includes("Plan"),
        detail: JSON.stringify(plan),
    });

    await show(h, "fixRound");
    const [round] = (await h.ev(cardState("dag-submit"))) ?? [];
    await h.shot("cdp-shots/transcript-dag-fixround.png");
    steps.push({
        step: "Fix round submitted, the last round",
        ok:
            round != null &&
            includesAll(round.text, ["Fix round submitted", "round 3", "2 tasks · the last round", "t-5", "Bound arrows"]) &&
            round.roundTasks === 2,
        detail: JSON.stringify(round),
    });

    await show(h, "dagStatus");
    const status = await openStatus(h);
    await h.shot("cdp-shots/transcript-dag-status.png");
    steps.push({
        step: "dag status opened with four task states",
        ok:
            status.clicked === true &&
            status.view != null &&
            includesAll(status.view.text, ["Running", "1 of 4 done", "parallelism 3", "as of now", "162e724", "in review", "idle 2m", "asks"]) &&
            JSON.stringify(status.view.pills) === JSON.stringify(["landed", "running", "review", "asks"]) &&
            status.view.rawFooter,
        detail: JSON.stringify(status),
    });

    await show(h, "taskComplete");
    const [done] = (await h.ev(cardState("jarvis-complete"))) ?? [];
    await h.shot("cdp-shots/transcript-dag-taskcomplete.png");
    steps.push({
        step: "Task complete in a worker's transcript",
        ok:
            done != null &&
            includesAll(done.text, ["Task complete", "t-2", "commit 720eb1a", "The engine takes it from here"]) &&
            done.buttons.includes("Report") &&
            done.showCommand,
        detail: JSON.stringify(done),
    });

    await show(h, "reviewPassed");
    const [passed] = (await h.ev(cardState("dag-review"))) ?? [];
    await h.shot("cdp-shots/transcript-dag-review-passed.png");
    await show(h, "reviewSentBack");
    const [sentBack] = (await h.ev(cardState("dag-review"))) ?? [];
    await h.shot("cdp-shots/transcript-dag-review-sentback.png");
    steps.push({
        step: "Task review passed and sent back",
        ok:
            includesAll(passed?.text, ["Task review", "t-3", "passed", "imports add from t-1"]) &&
            includesAll(sentBack?.text, ["Task review", "t-4", "sent back", "round 1 of 2", "Add a test for n = 0"]),
        detail: JSON.stringify({ passed, sentBack }),
    });

    await show(h, "reviewSentBackUnstamped");
    const [unstampedBack] = (await h.ev(cardState("dag-review"))) ?? [];
    await h.shot("cdp-shots/transcript-dag-review-unstamped.png");
    steps.push({
        step: "a send-back on a dag without round limits reads round 1 with no total",
        ok: includesAll(unstampedBack?.text, ["Task review", "t-4", "sent back", "round 1"]) && !unstampedBack.text.includes("round 1 of"),
        detail: JSON.stringify(unstampedBack),
    });

    await show(h, "finalPassed");
    const [final] = (await h.ev(cardState("dag-final"))) ?? [];
    await h.shot("cdp-shots/transcript-dag-final.png");
    steps.push({
        step: "Final passed with Shots",
        ok:
            final != null &&
            includesAll(final.text, ["Final", "passed", "round 1 of 3", "on the merged result", "59c03d0", "Every scenario passes"]) &&
            final.buttons.includes("Shots"),
        detail: JSON.stringify(final),
    });

    await show(h, "runLanded");
    const [landed] = (await h.ev(cardState("jarvis-complete"))) ?? [];
    await h.shot("cdp-shots/transcript-dag-run-landed.png");
    steps.push({
        step: "Run complete landed with its stats",
        ok:
            landed != null &&
            includesAll(landed.text, ["Run complete", "landed c72b9fa on main"]) &&
            includesAll(landed.stats, ["4 tasks", "0 failures", "39m 38s", "8 commits", "0 questions to you"]) &&
            landed.buttons.includes("Report"),
        detail: JSON.stringify(landed),
    });

    await show(h, "runHeld");
    const [held] = (await h.ev(cardState("jarvis-complete"))) ?? [];
    await h.shot("cdp-shots/transcript-dag-run-held.png");
    steps.push({
        step: "Run complete with the land held",
        ok:
            held != null &&
            includesAll(held.text, ["Run complete", "land held", "the final stage failed", `wave/${HELD_RUN}`]) &&
            held.landLine === `wsh runs land ${HELD_RUN} --force` &&
            includesAll(held.stats, ["6 tasks", "2h 41m", "1 question to you"]),
        detail: JSON.stringify(held),
    });

    await show(h, "runMissing");
    await sleep(FETCH_FAIL_MS);
    const [missing] = (await h.ev(cardState("jarvis-complete"))) ?? [];
    await h.shot("cdp-shots/transcript-dag-run-missing.png");
    steps.push({
        step: "a Run complete whose run is gone still draws from argv, the load error inline",
        ok: missing != null && includesAll(missing.text, ["Run complete", "commit c72b9fa"]) && missing.loadError != null,
        detail: JSON.stringify(missing),
    });
    return steps;
}

async function compactSteps(h) {
    await show(h, "dagStatus", COMPACT_WIDTH, true);
    const status = await openStatus(h);
    await h.shot("cdp-shots/transcript-dag-compact-status.png");
    await show(h, "runLanded", COMPACT_WIDTH, true);
    const [landed] = (await h.ev(cardState("jarvis-complete"))) ?? [];
    await h.shot("cdp-shots/transcript-dag-compact-complete.png");
    return [
        {
            step: "compact dag status and Run complete at 380 px",
            ok:
                status.clicked === true &&
                status.view != null &&
                JSON.stringify(status.view.pills) === JSON.stringify(["landed", "running", "review", "asks"]) &&
                includesAll(status.view.text, ["running 4m"]) &&
                landed != null &&
                includesAll(landed.text, ["Run complete", "landed c72b9fa"]) &&
                includesAll(landed.stats, ["4 tasks · 0 failures · 39m 38s · 8 commits"]) &&
                landed.width <= COMPACT_WIDTH,
            detail: JSON.stringify({ status, landed }),
        },
    ];
}

export const transcriptDag = {
    name: "transcript-dag",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const seam = await waitSeam(h);
        const steps = [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
        if (!seam) return steps;
        steps.push(...(await fullSteps(h)));
        steps.push(...(await compactSteps(h)));
        return steps;
    },
    async teardown(h) {
        await clearTranscript(h);
    },
};
