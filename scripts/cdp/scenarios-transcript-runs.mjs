// Scenario `transcript-runs`: wsh runs cards and views in a transcript (wshcards-runs.tsx). Runs show opens to a run
// summary with the token bar, runs attention to "nothing waiting", runs answer is "Answered for you", runs start is
// "Run started" with its chunks; each at the Rendered column's width, the start card also at a card's (380 px).

import { bash, clearTranscript, openFolds, prose, ROOT, showTranscript as showFixture, user, waitSeam } from "./transcript-fixture.mjs";

// every fixture is a finished turn, so its steps and cards sit behind the turn's fold
async function showTranscript(h, opts) {
    await showFixture(h, opts);
    await openFolds(h);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T0 = Date.UTC(2026, 10, 16, 9, 0, 0);
const S = 1000;
const MIN = 60 * S;
// the open motion of a step settles before a step reads it
const MOTION_MS = 600;
const WIDE = 736;
const NARROW = 380;

const RUN_ID = "cecf92e7";
const ANSWER_RUN = "7c03196e";
const START_RUN = "b4e17c02";
const EFFORT_ID = "e-fixture-parity";
const GONE_RUN = "ffffffff";
// the text-secondary @theme token, computed: the colour the Runs board draws "nothing waiting" in
const SECONDARY_RGB = "rgb(207, 213, 219)";

const run = (over = {}) => ({
    otype: "run",
    oid: RUN_ID,
    version: 1,
    id: RUN_ID,
    channeloid: "ch-fixture",
    goal: "Build Slim the orchestrator's superpowers dependency",
    title: "Build Slim the orchestrator's superpowers dependency",
    mode: "orchestrator",
    runtime: "claude",
    model: "claude-opus-5-5",
    autonomous: true,
    status: "done",
    phases: [],
    workspaceid: "w-fixture",
    projectpath: "C:/work/fixture",
    createdts: T0,
    completedts: T0 + 39 * MIN + 38 * S,
    land: { state: "landed", commit: "c72b9fa4d1e0" },
    ...over,
});

const TASK_TITLES = [
    "Engine sessions launch without superpowers",
    "The plan-skill setting and the run's record of it",
    "The lead's plan step and plan format by plan skill",
    "Worker brief, task review and plan review by plan skill",
    "Docs describe the slimmed dependency",
    "The settings page names the plan skill",
    "Reviewer prompts drop the skill tail",
    "Final scenario for the plan skill",
    "Release notes",
];
const COMMITS = { "t-1": "162e7240aaaa", "t-2": "720eb1abbbbb", "t-3": "a7a8df8cccc" };

const usage = (role, tokens) => ({ role, input: tokens, output: 0, cacheread: 0, cachewrite: 0, cachewrite1h: 0, msgs: 4 });

const SHOW_JSON = {
    channel: "fixture",
    channelid: "ch-fixture",
    run: run(),
    dag: {
        group: {
            title: "Build Slim the orchestrator's superpowers dependency",
            tasks: TASK_TITLES.map((label, i) => ({ id: `t-${i + 1}`, label, state: "done" })),
            planreview: { state: "passed", round: 2 },
            final: { state: "passed", round: 1 },
            fasttrack: true,
        },
        digest: {
            counts: { total: 9, done: 9 },
            durations: { elapsedms: 39 * MIN },
            report: {
                commits: Object.entries(COMMITS).map(([taskid, commit]) => ({ taskid, commit })),
                unverifiednotes: [{ taskid: "t-9", text: "The doc text describes behaviour tasks 1-8 build; not checked against their code." }],
                usage: [
                    usage("worker", 14_100_000),
                    usage("lead", 10_700_000),
                    usage("plan-reviewer", 3_800_000),
                    usage("verifier", 1_600_000),
                    usage("reviewer", 1_500_000),
                ],
            },
        },
    },
    asks: [],
};

// raised before answerCall's ts (T0 + 4 s), as the ask the call answered was
const ASKS = [
    {
        taskid: "",
        ts: T0 + 3 * S,
        questions: [{ question: "Approve the fixes?", options: [{ label: "Approve and land" }, { label: "Hold the land" }] }],
    },
];

const START_JSON = run({
    oid: START_RUN,
    id: START_RUN,
    title: "Projection fixes: Skill calls and refused Bash",
    goal: "Projection fixes",
    status: "planning",
    autonomous: false,
    completedts: undefined,
    land: undefined,
    effortref: { effortoid: EFFORT_ID, chunklabel: "3. Refused Bash" },
});

const showCall = bash({
    description: "Show the run",
    command: `wsh runs show ${RUN_ID} --json`,
    output: JSON.stringify(SHOW_JSON),
    ts: T0 + 2 * S,
    durationMs: 400,
});
const attentionCall = bash({
    description: "Check what's waiting on you",
    command: "wsh runs attention --json",
    output: "[]",
    ts: T0 + 3 * S,
    // at least STEP_DURATION_MIN_MS (steprows.tsx), or the row draws no time for the summary to sit before
    durationMs: 1_200,
});
const answerCall = bash({
    description: "Answer the run's question",
    command: `wsh runs answer ${ANSWER_RUN} '[{"selectedindexes":[0]}]'`,
    output: `answer delivered to run ${ANSWER_RUN}'s question`,
    ts: T0 + 4 * S,
    durationMs: 300,
});
const goneAnswerCall = bash({
    description: "Answer the other run",
    command: `wsh runs answer ${GONE_RUN} '[{"text":"ship it"}]'`,
    output: `answer delivered to run ${GONE_RUN}'s question`,
    ts: T0 + 5 * S,
    durationMs: 300,
});
const startCall = bash({
    description: "Start the run",
    command: `wsh runs start "Projection fixes" --mode orchestrator --effort ${EFFORT_ID} --chunk "2. Projection" --json`,
    output: JSON.stringify(START_JSON),
    ts: T0 + 6 * S,
    durationMs: 1_800,
});

const SEED = {
    [`run-asks:${ANSWER_RUN}`]: ASKS,
    [`effort:${EFFORT_ID}`]: { id: EFFORT_ID, title: "Rendered view: chat-renderer parity" },
};

// named { entries, seed?, runEvents?, ctx? } the boards scenario composes (transcript-boards)
export const fixtures = {
    runsShow: {
        entries: [
            user("did the superpowers run land? and is anything waiting on me", T0),
            showCall,
            attentionCall,
            prose("It landed as c72b9fa after 39 minutes. Nothing is waiting on you.", T0 + 10 * S),
        ],
    },
    runsAnswered: {
        entries: [user("answer that run's question for me", T0), answerCall, prose("Answered.", T0 + 10 * S)],
        seed: SEED,
    },
    runsStarted: {
        entries: [user("start the projection fixes", T0), startCall, prose("The run takes chunks 2 and 3.", T0 + 10 * S)],
        seed: SEED,
    },
};

const probe = (body) => `(() => { const root = document.querySelector(${JSON.stringify(ROOT)}); if (!root) return null; ${body} })()`;

// opens the step row whose text holds `text`, so its view mounts
const openStep = (text) =>
    probe(`
    const row = [...root.querySelectorAll('[data-step]')].find((s) => s.textContent.includes(${JSON.stringify(text)}));
    const btn = row?.querySelector('button[aria-expanded]');
    if (!btn) return false;
    if (btn.getAttribute('aria-expanded') !== 'true') btn.click();
    return true;
`);

const SHOW_STATE = probe(`
    const view = root.querySelector('[data-wsh-view="runs-show"]');
    if (!view) return null;
    const bar = view.querySelector('[data-run-tokens]');
    const segs = bar ? [...bar.children].map((c) => ({ flex: c.style.flex, bg: getComputedStyle(c).backgroundColor, w: Math.round(c.getBoundingClientRect().width) })) : [];
    return {
        text: view.textContent,
        bar: bar ? bar.getAttribute('aria-label') : null,
        route: bar?.previousElementSibling?.lastElementChild?.textContent ?? null,
        segments: segs,
        distinctFills: new Set(segs.map((s) => s.bg)).size,
        overflow: view.scrollWidth > view.clientWidth + 1,
    };
`);

// the step row holding `text` before it is opened: whether it is collapsed, its summary, its colour and what follows it
// (the time)
const ROW_SUMMARY = (text) =>
    probe(`
    const row = [...root.querySelectorAll('[data-step]')].find((s) => s.textContent.includes(${JSON.stringify(text)}));
    if (!row) return null;
    const summary = row.querySelector('[data-step-summary]');
    return {
        expanded: row.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') ?? null,
        summary: summary ? summary.textContent : null,
        color: summary ? getComputedStyle(summary).color : null,
        next: summary?.nextElementSibling?.textContent ?? null,
    };
`);

const ATTENTION_STATE = probe(`
    const view = root.querySelector('[data-wsh-view="runs-attention"]');
    return view ? { text: view.textContent } : null;
`);

const CARD_STATE = (key) =>
    probe(`
    const card = root.querySelector('[data-wsh-card=${JSON.stringify(key)}]');
    if (!card) return null;
    return {
        text: card.textContent,
        inBox: !!card.closest('[data-steps]'),
        inFold: !!card.closest('[data-turn-fold]'),
        showCommand: !!card.querySelector('button[aria-label="Show the command"]'),
        checks: card.querySelectorAll('svg').length,
        overflow: card.scrollWidth > card.clientWidth + 1,
    };
`);

async function showSteps(h) {
    const steps = [];
    await showTranscript(h, { ...fixtures.runsShow, width: WIDE });
    const opened = await h.ev(openStep("Show the run"));
    await sleep(MOTION_MS);
    const show = await h.ev(SHOW_STATE);
    await h.shot("cdp-shots/transcript-runs-show.png");
    steps.push({
        step: "runs show opened as a run summary with the token bar",
        ok:
            opened === true &&
            show != null &&
            show.text.includes("Build Slim the orchestrator") &&
            show.text.includes("c72b9fa") &&
            show.text.includes("9 of 9") &&
            show.text.includes("39m") &&
            show.text.includes("passed, round 2") &&
            show.text.includes("162e724") &&
            show.text.includes("no commit") &&
            show.text.includes("5 more tasks") &&
            show.text.includes("Unverified") &&
            show.segments.length === 5 &&
            show.distinctFills === 5 &&
            show.segments.every((s) => s.w > 0) &&
            show.bar.includes("workers 14.1M") &&
            show.overflow === false &&
            !show.text.includes("as of now"),
        detail: JSON.stringify(show),
    });

    await h.shot("cdp-shots/transcript-runs-show-fasttrack.png");
    steps.push({
        step: "runs show's route line, above the token bar, ends fast track for a fast-track dag",
        ok: show != null && typeof show.route === "string" && show.route.endsWith("· fast track") && show.route.includes("autonomous"),
        detail: JSON.stringify({ route: show?.route }),
    });

    const row = await h.ev(ROW_SUMMARY("Check what's waiting"));
    steps.push({
        step: "runs attention's collapsed row says nothing waiting before its time, in secondary",
        ok:
            row != null &&
            row.expanded === "false" &&
            row.summary === "nothing waiting" &&
            row.color === SECONDARY_RGB &&
            !!row.next,
        detail: JSON.stringify(row),
    });

    const attOpened = await h.ev(openStep("Check what's waiting"));
    await sleep(MOTION_MS);
    const att = await h.ev(ATTENTION_STATE);
    await h.shot("cdp-shots/transcript-runs-attention.png");
    steps.push({
        step: "runs attention with nothing waiting",
        ok: attOpened === true && att != null && att.text.includes("nothing waiting"),
        detail: JSON.stringify(att),
    });
    return steps;
}

async function answerSteps(h) {
    const steps = [];
    await showTranscript(h, { ...fixtures.runsAnswered, width: WIDE });
    const card = await h.ev(CARD_STATE("runs-answer"));
    await h.shot("cdp-shots/transcript-runs-answered.png");
    steps.push({
        step: "Answered for you: the question, the run and the picked answer checked, inside the turn's fold but no step box",
        ok:
            card != null &&
            card.text.includes("Answered for you") &&
            card.text.includes("Approve the fixes?") &&
            card.text.includes("7c03196e") &&
            card.text.includes("Approve and land") &&
            card.inFold === true &&
            card.inBox === false &&
            card.showCommand === true &&
            card.text.includes("0.3s") &&
            card.overflow === false,
        detail: JSON.stringify(card),
    });

    // no seed and no such run: the card still draws from argv, with the load error inline
    await showTranscript(h, { entries: [user("answer the other run", T0), goneAnswerCall], width: WIDE, seed: {} });
    await sleep(MOTION_MS);
    const gone = await h.ev(CARD_STATE("runs-answer"));
    await h.shot("cdp-shots/transcript-runs-answered-gone.png");
    steps.push({
        step: "Answered for you with the run gone: argv answer and the load error shown, no crash",
        ok:
            gone != null &&
            gone.text.includes("Answered for you") &&
            gone.text.includes(GONE_RUN) &&
            gone.text.includes("ship it") &&
            gone.text.includes("Could not read the question"),
        detail: JSON.stringify(gone),
    });
    return steps;
}

async function startSteps(h, width, compact) {
    const tag = `[${width}]`;
    await showTranscript(h, { ...fixtures.runsStarted, width, compact });
    await sleep(MOTION_MS);
    const card = await h.ev(CARD_STATE("runs-start"));
    await h.shot(`cdp-shots/transcript-runs-start-${width}.png`);
    return [
        {
            step: compact
                ? "compact Run started at 380 px"
                : "Run started with its chunks, its run id and its status, inside the turn's fold but no step box",
            ok:
                card != null &&
                card.text.includes("Run started") &&
                card.text.includes("Projection fixes: Skill calls and refused Bash") &&
                card.text.includes("planning") &&
                card.text.includes("b4e17c02") &&
                /chunks 2, 3/.test(card.text) &&
                card.text.includes("Rendered view: chat-renderer parity") &&
                card.text.includes("orchestrator") &&
                card.inFold === true &&
                card.inBox === false &&
                card.showCommand === true &&
                card.overflow === false,
            detail: `${tag} ${JSON.stringify(card)}`,
        },
    ];
}

export const transcriptRuns = {
    name: "transcript-runs",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const seam = await waitSeam(h);
        const steps = [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
        if (!seam) return steps;
        steps.push(...(await showSteps(h)));
        steps.push(...(await answerSteps(h)));
        steps.push(...(await startSteps(h, WIDE, false)));
        steps.push(...(await startSteps(h, NARROW, true)));
        return steps;
    },
    async teardown(h) {
        await clearTranscript(h);
    },
};
