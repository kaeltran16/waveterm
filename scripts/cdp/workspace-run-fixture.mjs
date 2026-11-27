// The shared fixture of the Run tab scenarios (`workspace-run`, `workspace-run-activity`, `workspace-run-graph`;
// docs/superpowers/plans/2026-11-18-run-tab-polish.md): the canvas's 8-task "stats and dedupe packages" run, so a
// screenshot compares to its boards. The live run is the Main board's, and `finished` seeds the Done board's instead.
//
// A fixture lead (a claude agent backed by a real tab with no controller) shows the Rendered view of a transcript
// holding its `wsh jarvis dag forward` call, whose card links the run. The run is page-only: its run, dag and child
// run objects go into the page's object cache, its digest into the digest map, its usage into the usage map (sealed,
// so no load replaces it), its events are seeded and its open question put in the ask map, so no engine runs.
// Teardown drops what it put in the maps and runs each scenario's own `ctx.cleanups`.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    agentPage,
    assistantText,
    closeTabs,
    focusAgent,
    makeTab,
    pinDefaultView,
    restoreDefaultView,
    restoreRoster,
    setRoster,
    toolResult,
    toolUse,
    userText,
    writeTranscript,
} from "./agent-page-fixtures.mjs";
import { polishNap, polishWaitFor, restoreLocalStorage } from "./scenarios-shared.mjs";

export const MIN = 60_000;
export const WAIT_MS = 10_000;
// past the pane's macro reveal and a view swap, so a read after it sees the settled pane
export const SETTLE_MS = 700;
// long enough for the lead's turn-end auto-open to have acted, were it going to
const AUTO_OPEN_MS = 3000;
const WIDTH_KEY = "agent.workspace.width";
const VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };

export const RUN_ID = "7f3a91c2-0b4d-4e6f-8a1b-2c3d4e5f6a7b";
export const SHORT_ID = RUN_ID.slice(0, 8);
export const DAG_ID = "fx-workspace-run-dag";
export const CHANNEL = "fx-workspace-run-channel";
export const TITLE = "stats and dedupe packages";
export const PLAN = "docs/superpowers/plans/2026-11-17-stats-dedupe.md";
export const TAB_KEY = `run:${RUN_ID}`;
export const VERIFY_CMD = "go test ./...";
export const LAND_COMMIT = "4c1e9a2f6b8d0c3e5a7f9b1d2c4e6a8b0d1f3e5a";
export const FINAL_SHOTS = 6;
// t-3's open question, which the lead holds
export const QUESTION = "Should two URLs that differ only by a trailing slash count as duplicates?";
export const QUESTION_HEADER = "Duplicates";
export const OPTIONS = ["Yes, the same URL", "No, different URLs"];
export const ASK_ID = "fx-workspace-run-ask";
// t-1's question, which the lead answered
export const ANSWERED_Q = 'Count a bookmark with no tags under an "untagged" key?';
export const ANSWERED_A = "Yes, under untagged";
export const FORWARD_NOTE = "a scope call on trailing slashes";
export const T6_FAIL = "--- FAIL: TestPocketImport/tags (0.02s)\npocket_test.go:48: got 3 bookmarks, want 4\nFAIL\tlinkshelf/internal/importer\t0.41s";

// the canvas's tasks in plan order
export const TASKS = [
    { id: "t-1", label: "internal/stats counters", deps: [], description: "Adds per-host counters and a linkshelf stats backend." },
    { id: "t-2", label: "internal/importer URL normalizing", deps: [], description: "Normalizes imported URLs before they are stored." },
    { id: "t-3", label: "internal/dedupe groups", deps: ["t-1"], description: "Groups bookmarks by normalized URL." },
    { id: "t-4", label: "cmd/linkshelf stats command", deps: ["t-1"], description: "Adds linkshelf stats over internal/stats." },
    { id: "t-5", label: "web bookmarks list view", deps: [], description: "Lists bookmarks in the web app." },
    { id: "t-6", label: "importer: Pocket export", deps: [], description: "Imports a Pocket export with its tags." },
    { id: "t-7", label: "go test and go vet", deps: ["t-3", "t-4"], description: "Runs go test ./... and go vet ./... on the merged tree." },
    { id: "t-8", label: "docs/cli.md stats section", deps: ["t-1"], description: "Documents linkshelf stats and its flags." },
];
export const TASK_IDS = TASKS.map((t) => t.id);
// the Main board's dot per task, as the Tasks rows and the head strip draw them
export const MAIN_DOTS = ["merged", "working", "asked", "working", "working", "failed", "waits", "waits"];

export const childRunId = (taskId) => `fx-workspace-run-${taskId}`;

// a worker run's sealed evidence: the files the canvas's Changes tab lists for t-1, t-2 and t-5
const EVIDENCE = {
    "t-1": {
        summary: "Added per-host counters and a linkshelf stats backend, with 9 tests.",
        files: [["internal/stats/counters.go", 120, 4], ["internal/stats/counters_test.go", 64, 8]],
    },
    "t-2": {
        summary: "Normalized imported URLs: scheme, host case and default ports.",
        files: [["internal/importer/url.go", 31, 9], ["internal/importer/url_test.go", 11, 0]],
    },
    "t-5": {
        summary: "Added the bookmarks list view with paging.",
        files: [["web/src/bookmarks/List.tsx", 148, 22], ["web/src/bookmarks/List.test.tsx", 62, 9]],
    },
};

// the canvas's clock: the run started 15 minutes before the Main board's now, 31 before the Done board's end
const T0_LIVE = 15 * MIN;
const T0_DONE = 31 * MIN + 30_000;
const DONE_ELAPSED = 31 * MIN;

const evidenceOf = (taskId, at) => {
    const ev = EVIDENCE[taskId];
    const files = ev.files.map(([path, add, del]) => ({ path, stat: "M", add, del }));
    return {
        capturedts: at,
        hash: `fx-${taskId}`,
        summary: ev.summary,
        files,
        addtotal: files.reduce((n, f) => n + f.add, 0),
        deltotal: files.reduce((n, f) => n + f.del, 0),
        runtimems: 3 * MIN,
        durationms: 3 * MIN,
    };
};

const childRunObj = (task, t0, version) => ({
    otype: "run",
    oid: childRunId(task.id),
    id: childRunId(task.id),
    version,
    goal: task.label,
    title: task.label,
    status: EVIDENCE[task.id] ? "done" : "executing",
    mode: "worker",
    runtime: "claude",
    model: "claude-opus-5-5",
    channeloid: CHANNEL,
    workspaceid: "",
    projectpath: "C:\\fx\\linkshelf",
    phases: [],
    createdts: t0 + 5 * MIN,
    taskid: task.id,
    ...(EVIDENCE[task.id] ? { evidence: evidenceOf(task.id, t0 + 8 * MIN) } : {}),
});

const runObj = (now, version, finished) => ({
    otype: "run",
    oid: RUN_ID,
    id: RUN_ID,
    version,
    goal: TITLE,
    title: TITLE,
    status: finished ? "done" : "executing",
    mode: "orchestrator",
    runtime: "claude",
    model: "claude-opus-5-5",
    channeloid: CHANNEL,
    dagoref: DAG_ID,
    workspaceid: "",
    projectpath: "C:\\fx\\linkshelf",
    phases: [],
    createdts: now - (finished ? T0_DONE : T0_LIVE),
    ...(finished ? { completedts: now - 30_000, land: { state: "landed", commit: LAND_COMMIT } } : {}),
});

// the Main board's task states: t-1 merged after the lead answered it, t-2 merged and verifying, t-3 asking the lead,
// t-4 working, t-5 reviewing, t-6 failed its verify, t-7 waiting on t-3 and t-4, t-8 waiting for a free worker
function liveTasks(now) {
    const t0 = now - T0_LIVE;
    const at = (m) => t0 + m * MIN;
    const base = (t) => ({ id: t.id, label: t.label, description: t.description, ...(t.deps.length ? { deps: t.deps } : {}) });
    const [t1, t2, t3, t4, t5, t6, t7, t8] = TASKS.map(base);
    const run = (t) => ({ runid: childRunId(t.id) });
    return [
        { ...t1, ...run(t1), state: "done", merged: true, spawnedts: at(5), firstactivity: at(5.2) },
        { ...t2, ...run(t2), state: "verifying", merged: true, spawnedts: at(5), verifystartedts: now - 40_000 },
        { ...t3, ...run(t3), state: "running", spawnedts: at(9), firstactivity: at(9.2), askts: at(11) },
        { ...t4, ...run(t4), state: "running", spawnedts: at(10), firstactivity: at(10.4) },
        { ...t5, ...run(t5), state: "reviewing", spawnedts: at(5), reviewspawnedts: now - 30_000 },
        { ...t6, ...run(t6), state: "failed", spawnedts: at(5), verifyerror: "go test failed", verifyoutput: T6_FAIL },
        { ...t7, state: "pending" },
        { ...t8, state: "pending" },
    ];
}

function doneTasks(now) {
    const t0 = now - T0_DONE;
    return TASKS.map((t, i) => ({
        id: t.id,
        label: t.label,
        description: t.description,
        ...(t.deps.length ? { deps: t.deps } : {}),
        runid: childRunId(t.id),
        state: "done",
        merged: true,
        spawnedts: t0 + (5 + i) * MIN,
    }));
}

const dagObj = (now, version, finished) => ({
    otype: "dag",
    oid: DAG_ID,
    id: DAG_ID,
    version,
    runid: RUN_ID,
    channelid: CHANNEL,
    title: TITLE,
    parallelism: 4,
    status: finished ? "done" : "running",
    failures: finished ? 0 : 1,
    createdts: now - (finished ? T0_DONE : 9 * MIN + 5_000),
    updatedts: now,
    planpath: PLAN,
    verify: VERIFY_CMD,
    planreview: { state: "passed", round: 1 },
    ...(finished
        ? {
              final: {
                  state: "passed",
                  round: 1,
                  startedts: now - 5 * MIN,
                  shots: Array.from({ length: FINAL_SHOTS }, (_, i) => ({ name: `scenario-${i + 1}`, files: [] })),
              },
          }
        : {}),
    tasks: finished ? doneTasks(now) : liveTasks(now),
});

const taskDigest = (taskid, extra = {}) => ({ taskid, waitreason: "", mergestate: "", cleanupstate: "", ...extra });

function digestOf(now, version, finished) {
    const runms = (taskId, m) => ({ taskid: taskId, runms: m * MIN });
    if (finished) {
        return {
            dagversion: version,
            health: "done",
            counts: {},
            next: { kind: "terminal", terminalstatus: "done" },
            tasks: TASK_IDS.map((id) => taskDigest(id)),
            durations: { elapsedms: DONE_ELAPSED, tasks: TASK_IDS.map((id, i) => runms(id, 2 + (i % 4))) },
            report: { workerms: 41 * MIN, answered: 1, forwarded: 0 },
        };
    }
    const t0 = now - T0_LIVE;
    return {
        dagversion: version,
        health: "attention",
        counts: {},
        next: { kind: "waiting" },
        tasks: [
            taskDigest("t-1"),
            taskDigest("t-2", { verifystartedts: now - 40_000 }),
            taskDigest("t-3", {
                waitreason: "lead-ask",
                askid: ASK_ID,
                asksummary: QUESTION,
                askts: t0 + 11 * MIN,
                askdeadline: now + 2 * MIN + 20_000,
            }),
            taskDigest("t-4"),
            taskDigest("t-5"),
            taskDigest("t-6", { verifyfailline: "pocket_test.go:48: got 3 bookmarks, want 4" }),
            taskDigest("t-7", { blockingtaskids: ["t-3", "t-4"] }),
            taskDigest("t-8", { waitreason: "parallelism" }),
        ],
        durations: { elapsedms: 0, tasks: [runms("t-1", 2), runms("t-2", 3), runms("t-6", 2), runms("t-5", 4)] },
        report: { workerms: 14 * MIN, answered: 1, forwarded: 0 },
    };
}

// tokens priced at opus 5.5's rates: the Main board's ~$2.10 and 1.2M, the Done board's ~$6.40 and 3.4M
const usageOf = (finished) => [
    finished
        ? { role: "worker", model: "claude-opus-5-5", input: 600_000, output: 150_000, cacheread: 2_600_000, cachewrite: 96_000, cachewrite1h: 0, msgs: 80 }
        : { role: "worker", model: "claude-opus-5-5", input: 200_000, output: 50_000, cacheread: 900_000, cachewrite: 24_000, cachewrite1h: 0, msgs: 30 },
];

const event = (id, kind, ts, detail) => ({ id, runid: RUN_ID, channelid: CHANNEL, kind, ts, detail: JSON.stringify(detail ?? {}) });

// the canvas's Activity, oldest first: 23 events on the Main board; the Done board's carry on to DAG complete
function eventsOf(now, finished) {
    const t0 = now - (finished ? T0_DONE : T0_LIVE);
    let n = 0;
    const ev = (m, kind, detail) => event(`fx-wr-${++n}`, kind, t0 + m * MIN, detail);
    const live = [
        ev(0, "run-created"),
        ev(0.6, "lead-launched"),
        ev(4, "plan-reviewed", { verdict: "approved", round: 1 }),
        ev(5, "task-spawned", { taskid: "t-1" }),
        ev(5, "task-spawned", { taskid: "t-2" }),
        ev(5, "task-spawned", { taskid: "t-5" }),
        ev(5, "task-spawned", { taskid: "t-6" }),
        ev(6, "child-ask", { taskid: "t-1", question: ANSWERED_Q }),
        ev(7, "child-answered", { taskid: "t-1", answer: ANSWERED_A }),
        ev(7.6, "task-done", { taskid: "t-1" }),
        ev(7.8, "task-review-passed", { taskid: "t-1" }),
        ev(8, "task-merged", { taskid: "t-1" }),
        ev(9, "task-spawned", { taskid: "t-3" }),
        ev(10, "task-spawned", { taskid: "t-4" }),
        ev(10.4, "task-first-activity", { taskid: "t-4" }),
        ev(11, "child-ask", { taskid: "t-3", question: QUESTION, header: QUESTION_HEADER }),
        ev(11.6, "task-done", { taskid: "t-2" }),
        ev(11.8, "task-review-passed", { taskid: "t-2" }),
        ev(12, "task-merged", { taskid: "t-2" }),
        ev(12.1, "task-verify-started", { taskid: "t-2", command: VERIFY_CMD }),
        ev(13, "task-failed", { taskid: "t-6", error: T6_FAIL }),
        ev(14, "task-done", { taskid: "t-5" }),
        ev(14.2, "task-review-started", { taskid: "t-5" }),
    ];
    if (!finished) {
        return live;
    }
    return [
        ...live,
        ev(15, "child-answered", { taskid: "t-3" }),
        ev(15.5, "task-verify-passed", { taskid: "t-2" }),
        ev(16, "task-review-passed", { taskid: "t-5" }),
        ev(16.2, "task-merged", { taskid: "t-5" }),
        ev(16.5, "task-spawned", { taskid: "t-8" }),
        ev(17, "task-retried", { taskid: "t-6" }),
        ev(19, "task-done", { taskid: "t-4" }),
        ev(19.5, "task-merged", { taskid: "t-4" }),
        ev(20, "task-done", { taskid: "t-8" }),
        ev(20.5, "task-merged", { taskid: "t-8" }),
        ev(21, "task-done", { taskid: "t-3" }),
        ev(22, "task-merged", { taskid: "t-3" }),
        ev(22.5, "task-spawned", { taskid: "t-7" }),
        ev(24, "task-done", { taskid: "t-6" }),
        ev(24.6, "task-review-passed", { taskid: "t-6" }),
        ev(25, "task-merged", { taskid: "t-6" }),
        ev(25.5, "task-done", { taskid: "t-7" }),
        ev(26, "task-merged", { taskid: "t-7" }),
        ev(30.6, "final-ended", { state: "passed", round: 1 }),
        ev(31, "dag-done", { status: "done" }),
    ];
}

const askOf = (now) => ({
    taskid: "t-3",
    askid: ASK_ID,
    owner: "lead",
    deadline: now + 2 * MIN + 20_000,
    questions: [{ question: QUESTION, header: QUESTION_HEADER, options: OPTIONS.map((label) => ({ label })) }],
    blockoref: "",
    ts: now - T0_LIVE + 11 * MIN,
});

// the brief fetchBriefRun (arcmessagerow.tsx) builds from the run and its dag; seeded, so the lead's brief never asks
// the server, whose null for this page-only run would wipe the seeded run from the object cache
const briefOf = (run, dag) => ({
    goal: run.goal,
    planSkill: run.planskill,
    autonomous: dag.autonomous ?? run.autonomous,
    tasks: dag.tasks.map((t) => ({ id: t.id, label: t.label, state: t.state })),
});

// the page-only run, written before anything reads it; a later version replaces an earlier one in the object cache.
// layer(seed, { now, version }) lets a scenario change what is written: it gets { run, dag, children, digest, usage,
// events (oldest first), extra (more objects to put) } and returns it, changed
export const seedRun = (h, now, { version = 1, finished = false, layer } = {}) => {
    const base = {
        run: runObj(now, version, finished),
        dag: dagObj(now, version, finished),
        children: TASKS.map((t) => childRunObj(t, now - (finished ? T0_DONE : T0_LIVE), version)),
        digest: digestOf(now, version, finished),
        usage: usageOf(finished),
        events: eventsOf(now, finished),
        extra: [],
    };
    const { run, dag, children, digest, usage, events, extra } = layer ? layer(base, { now, version }) : base;
    return agentPage(
        h,
        `const L = await mod("app/view/agents/runlineagestore.ts");
        const E = await mod("app/view/agents/runeventstore.ts");
        const C = await mod("app/view/agents/childaskstore.ts");
        const U = await mod("app/view/agents/runtokenstore.ts");
        const D = await mod("app/view/agents/wshdata.ts");
        const put = (obj) => WOS.updateWaveObject({ updatetype: "update", otype: obj.otype, oid: obj.oid, obj });
        for (const child of ${JSON.stringify([...children, ...extra])}) put(child);
        put(${JSON.stringify(dag)});
        put(${JSON.stringify(run)});
        D.seedWshData({ ${JSON.stringify(`arc-run:${RUN_ID}`)}: ${JSON.stringify(briefOf(run, dag))} });
        // the router opens a dag on its owner run's sheet, which it finds through the channel
        put(${JSON.stringify({ otype: "channel", oid: CHANNEL, version, name: TITLE, createdts: now })});
        globalStore.set(L.runDigestsAtom, (prev) => ({ ...prev, ${JSON.stringify(RUN_ID)}: ${JSON.stringify(digest)} }));
        globalStore.set(U.runUsageAtom, (prev) => ({ ...prev, ${JSON.stringify(RUN_ID)}: { rows: ${JSON.stringify(usage)}, sealed: true } }));
        E.seedRunEvents(${JSON.stringify(RUN_ID)}, ${JSON.stringify([...events].reverse())});
        globalStore.set(C.childAsksAtom, (prev) => ({ ...prev, ${JSON.stringify(RUN_ID)}: ${JSON.stringify(finished ? [] : [askOf(now)])} }));
        return true;`
    );
};

export const PANE = `document.querySelector('aside[aria-label="Workspace"]')`;
export const RV = `document.querySelector("[data-rendered-view]")`;
export const RUN_TAB = `document.querySelector("[data-workspace-run]")`;
export const OPEN_RUN = `${RV}?.querySelector('[data-open-run="${RUN_ID}"]')`;
export const TAB_DOT = `document.querySelector('[data-workspace-tab="${TAB_KEY}"] [data-workspace-tab-waiting]')`;

// page helpers spliced into each evaluated body, beside agentPage's own (mod, globalStore, WOS, nap, until, flat)
const LIB = `
    const W = await mod("app/view/agents/workspacestore.ts");
    const C = await mod("app/view/agents/childaskstore.ts");
    const ws = (id) => globalStore.get(W.workspaceAtom(id));
    // every distinct value read() takes, one read per frame, until stop()
    const sampleFrames = (read) => {
        const values = [];
        let on = true;
        const tick = () => {
            const v = read();
            if (v != null && v !== values.at(-1)) values.push(v);
            if (on) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return { values, stop: () => (on = false) };
    };
`;
export const page = (h, body) => agentPage(h, `${LIB} ${body}`);

const mouse = (h, type, x, y, extra = {}) => h.cdp("Input.dispatchMouseEvent", { type, x, y, ...extra });

// a real click at the centre of what expr names; modifiers as CDP's bitmask
export async function clickAt(h, expr, modifiers = 0) {
    const at = await h.ev(
        `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`
    );
    if (at == null) return false;
    await mouse(h, "mousePressed", at.x, at.y, { button: "left", buttons: 1, clickCount: 1, modifiers });
    await mouse(h, "mouseReleased", at.x, at.y, { button: "left", buttons: 0, clickCount: 1, modifiers });
    return true;
}

const openFolds = (h) =>
    h.ev(`(() => {
        const folds = [...(${RV}?.querySelectorAll('[data-fold][aria-expanded="false"]') ?? [])];
        folds.forEach((f) => f.click());
        return folds.length;
    })()`);

// the lead, its transcript and the seeded run, up to the run card's link drawn; opts.finished seeds the Done board.
// A throw past the first line still returns ctx, so teardown removes whatever was already made.
export async function arrange(h, name, { finished = false, layer } = {}) {
    const tag = Date.now().toString(36);
    // rows: the finished rows the scenario focused (focusRow), whose tabs and seeding teardown undoes
    const ctx = { name, tabIds: [], cleanups: [], rows: [], version: 1, layer, dir: mkdtempSync(join(tmpdir(), `verify-${name}-`)) };
    try {
        ctx.prevWidth = await h.ev(`localStorage.getItem(${JSON.stringify(WIDTH_KEY)})`);
        await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
        const now = Date.now();
        ctx.now = now;
        const transcript = writeTranscript(ctx.dir, `${name}-${tag}`, [
            userText(`Run the ${TITLE} plan.`),
            toolUse("toolu_fx_fwd", "Bash", { command: `wsh jarvis dag forward t-3 "${FORWARD_NOTE}" --runid ${RUN_ID}`, description: "hand t-3 to the user" }),
            toolResult("toolu_fx_fwd", "forwarded t-3"),
            assistantText("The dedupe task needs a call on trailing slashes."),
        ]);
        await h.goto("agent");
        const lead = await makeTab(h, ctx, { label: `${name}-${tag}`, blockMeta: { view: "term", controller: null } });
        ctx.leadId = lead.tabId;
        await h.ev(`localStorage.removeItem(${JSON.stringify(WIDTH_KEY)})`);
        await seedRun(h, now, { version: ctx.version, finished, layer });
        ctx.seeded = true;
        await pinDefaultView(h, "rendered");
        await setRoster(h, [
            {
                id: lead.tabId,
                name: `${name}-${tag}`,
                project: "linkshelf",
                task: TITLE,
                state: "idle",
                agent: "claude",
                model: "claude-opus-5-5",
                blockId: lead.blockId,
                runId: RUN_ID,
                transcriptPath: transcript,
            },
        ]);
        await focusAgent(h, lead.tabId);
        if (!(await polishWaitFor(h, `${RV} != null`, WAIT_MS))) throw new Error("the lead never showed the Rendered view");
        await openFolds(h);
        if (!(await polishWaitFor(h, `${OPEN_RUN} != null`, WAIT_MS))) {
            await openFolds(h);
            if (!(await polishWaitFor(h, `${OPEN_RUN} != null`, WAIT_MS))) {
                const seen = await h.ev(`(${RV}?.innerText ?? "").replace(/\s+/g, " ").slice(0, 600)`);
                throw new Error(`the run card's Answer in the run never drew; the transcript reads: ${seen}`);
            }
        }
        // a lead's own run opens beside it by itself (autoopenmodel.ts), and that tab's load from the server, which has
        // no page-only run, marks the run gone: dismiss it as a user's close does, so it stays shut, and seed again
        if (await polishWaitFor(h, `${PANE} != null`, AUTO_OPEN_MS)) {
            const LEAD = JSON.stringify(ctx.leadId);
            await page(h, `const A = await mod("app/view/agents/autoopen.ts"); for (const t of [...ws(${LEAD}).tabs]) A.dismissWorkspaceTab(${LEAD}, t); return true;`);
            if (!(await polishWaitFor(h, `${PANE} == null`, WAIT_MS))) throw new Error("the auto-opened Run tab never closed");
        }
        await reseed(h, ctx, { finished, now });
        await polishNap(SETTLE_MS);
    } catch (err) {
        ctx.arrangeError = String(err?.message ?? err);
    }
    return ctx;
}

// reseeds the run at a newer version, so the cache takes it over the one already there, with arrange's layer
export async function reseed(h, ctx, { finished = false, now = Date.now() } = {}) {
    ctx.version += 1;
    ctx.now = now;
    await seedRun(h, now, { version: ctx.version, finished, layer: ctx.layer });
}

// --- finished rows on the Done board: a done task's worker, the Final stage, an ended verifier or plan reviewer ---

export const endedRowId = (rest) => `ended:${RUN_ID}:${rest}`;
export const FINAL_ROW_ID = `final:${RUN_ID}`;
export const RAIL = `document.querySelector('aside[aria-label="Agent details"]')`;
export const RAIL_VISIBLE_KEY = "agent.rail.visible";

// the transcript an ended row reads, by its child run's id, so no lookup asks the server about this page-only run
export const seedTranscriptPath = (h, runId, path) =>
    page(
        h,
        `const L = await mod("app/view/agents/runlineagestore.ts");
        globalStore.set(L.runTranscriptPathsAtom, (prev) => ({ ...prev, ${JSON.stringify(runId)}: ${JSON.stringify(path)} }));
        return true;`
    );

// focuses a finished row as a tree click does; teardown closes the tabs of every row focused and forgets its seeding
export async function focusRow(h, ctx, id) {
    if (!ctx.rows.includes(id)) ctx.rows.push(id);
    await focusAgent(h, id);
    await polishNap(SETTLE_MS);
}

// the focused row as drawn: the rail and the rail setting, the pane, its tabs, and what the center and the tab show
export const readRow = (h) =>
    page(
        h,
        `const tabs = [...document.querySelectorAll("[data-workspace-tab]")];
        return {
            rail: ${RAIL} != null,
            railSetting: localStorage.getItem(${JSON.stringify(RAIL_VISIBLE_KEY)}),
            pane: ${PANE}?.dataset.workspacePane ?? null,
            tabs: tabs.map((t) => t.dataset.workspaceTab),
            labels: tabs.map((t) => t.querySelector('[role="tab"]')?.getAttribute("aria-label") ?? null),
            active: tabs.find((t) => t.querySelector('[role="tab"][aria-selected="true"]'))?.dataset.workspaceTab ?? null,
            unseen: tabs.filter((t) => t.querySelector("[data-workspace-tab-unseen]")).map((t) => t.dataset.workspaceTab),
            ended: document.querySelector("[data-agent-center] [data-ended-to-run]") != null,
            finalPane: document.querySelector("[data-final-pane]") != null,
            task: document.querySelector("[data-workspace-task]")?.dataset.workspaceTask ?? null,
            final: document.querySelector("[data-workspace-final]")?.dataset.workspaceFinal ?? null,
            // the list, or its empty state while the row has no read of its own
            changes: document.querySelector("[data-workspace-changes], [data-workspace-changes-empty]") != null,
        };`
    );

// reads the row until ok holds or the wait runs out, and returns the last read either way
export async function rowUntil(h, ok, ms = WAIT_MS) {
    for (let waited = 0; ; waited += 250) {
        const s = await readRow(h).catch(() => null);
        if ((s != null && ok(s)) || waited >= ms) return s;
        await polishNap(250);
    }
}

// a plain click on the run card's link opens the Run tab beside; true once it is drawn
export async function openRunTab(h) {
    const clicked = await clickAt(h, OPEN_RUN);
    const drawn = await polishWaitFor(h, `${RUN_TAB} != null`, WAIT_MS);
    await polishNap(SETTLE_MS);
    return clicked && drawn;
}

// the Run tab's head as drawn, and which view is shown
export const readHead = (h) =>
    page(
        h,
        `const tab = ${RUN_TAB};
        const q = (sel) => tab?.querySelector(sel);
        return {
            pane: ${PANE}?.dataset.workspacePane ?? null,
            active: document.querySelector('[data-workspace-tab] [role="tab"][aria-selected="true"]')?.closest("[data-workspace-tab]")?.dataset.workspaceTab ?? null,
            run: tab?.dataset.workspaceRun ?? null,
            head: flat(q("[data-workspace-run-head]")),
            state: q("[data-workspace-run-state]")?.dataset.workspaceRunState ?? null,
            stateText: flat(q("[data-workspace-run-state]")),
            line: flat(q("[data-workspace-run-line]")),
            spend: flat(q("[data-workspace-run-spend]")),
            strip: [...(tab?.querySelectorAll("[data-workspace-run-strip] [data-strip-dot]") ?? [])].map((s) => s.dataset.stripDot),
            view: q('[role="tab"][aria-selected="true"]')?.dataset.runView ?? null,
            views: [...(tab?.querySelectorAll("[data-run-view]") ?? [])].map((b) => flat(b).replace(/\\s+/g, "")),
            indicator: q("[data-run-view-indicator]")?.closest("[data-run-view]")?.dataset.runView ?? null,
            needs: q("[data-workspace-run-needs]") != null,
            totals: q("[data-workspace-run-totals]") != null,
            dot: ${TAB_DOT} != null,
        };`
    );

// picks a view from the head's segmented control, and reads the head once the swap settles
export async function pickView(h, view) {
    await h.ev(`document.querySelector('[data-workspace-run] [data-run-view="${view}"]')?.click()`);
    await polishNap(SETTLE_MS);
    return readHead(h);
}

// a scenario's step recorder: one throwing step is one FAIL, not the end of the run
export function stepper() {
    const steps = [];
    const rec = (step, ok, detail) => steps.push({ step, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
    const step = async (name, fn) => {
        try {
            const [ok, detail] = await fn();
            rec(name, ok, detail);
        } catch (err) {
            rec(name, false, `threw: ${err?.message ?? err}`);
        }
    };
    return { steps, rec, step };
}

export async function teardown(h, ctx, name) {
    const step = async (what, fn) => {
        try {
            await fn();
        } catch (e) {
            console.error(`${name} teardown: ${what} failed: ${e?.message ?? e}`);
        }
    };
    for (const [i, cleanup] of (ctx.cleanups ?? []).entries()) {
        await step(`cleanup ${i + 1}`, () => cleanup(h));
    }
    const owners = [ctx.leadId, ...(ctx.rows ?? [])].filter(Boolean);
    if (owners.length > 0) {
        await step("close the workspace tabs and forget the rows' seeding", () =>
            page(
                h,
                `const M = await mod("app/view/agents/workspacemodel.ts");
                // off the rows first, so a focused row's first-focus seeding does not open its tabs again
                if (${JSON.stringify(ctx.leadId ?? null)} != null) globalStore.set(agentsModel().focusIdAtom, ${JSON.stringify(ctx.leadId ?? null)});
                await nap(100);
                for (const id of ${JSON.stringify(owners)}) for (const t of [...ws(id).tabs]) W.closeWorkspaceTab(id, M.tabKey(t));
                W.forgetFinishedRows(${JSON.stringify(ctx.rows ?? [])});
                return true;`
            )
        );
    }
    if (ctx.seeded) {
        await step("drop the run's ask, digest and usage", () =>
            agentPage(
                h,
                `const C = await mod("app/view/agents/childaskstore.ts");
                const L = await mod("app/view/agents/runlineagestore.ts");
                const U = await mod("app/view/agents/runtokenstore.ts");
                const drop = (prev) => { const next = { ...prev }; delete next[${JSON.stringify(RUN_ID)}]; return next; };
                globalStore.set(C.childAsksAtom, drop);
                globalStore.set(L.runDigestsAtom, drop);
                globalStore.set(U.runUsageAtom, drop);
                return true;`
            )
        );
    }
    await step("restore the roster", () => restoreRoster(h));
    await step("restore the default view", () => restoreDefaultView(h));
    await step("close the tabs", () => closeTabs(h, ctx));
    await step("restore the pane width", () => h.ev(restoreLocalStorage(WIDTH_KEY, ctx.prevWidth ?? null)));
    await step("clear the viewport", () => h.cdp("Emulation.clearDeviceMetricsOverride", {}));
    await step("remove the temp dir", () => rmSync(ctx.dir, { recursive: true, force: true }));
    await step("go home", () => h.goto("cockpit"));
}
