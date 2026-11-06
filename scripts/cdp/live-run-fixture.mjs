// The live-run states fixture (cdp-shots/review/live-run): three orchestrator runs held in unborn repos
// (arrangeHeldRun), so no model ever starts, with their tasks seeded into every state a run card, tree row and rail
// section draws. Run A has a lead and one task per state; run B has no lead in the roster and had one once; run C
// has every task landed and its Final stage failed in round 1, finalizing. The roster is set in the page
// (setPageRoster), and what only a live worker or the engine's event log would make is injected in the page too:
// the digest's ask reasons, the child asks, and run events. Used by the Cockpit and Agent scenarios that check them.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    arrangeHeldRun,
    fstWriteRun,
    heldStandIn,
    lookEval,
    seedHeldRun,
    setPageRoster,
    teardownHeldRuns,
} from "./scenarios-shared.mjs";

const M = 60_000;

export const LIVE_TASKS_A = [
    { id: "t-1", label: "wire the parser" },
    { id: "t-2", label: "pick the cache key" },
    { id: "t-3", label: "port the retry loop" },
    { id: "t-4", label: "rename the flags" },
    { id: "t-5", label: "migrate the schema" },
    { id: "t-6", label: "tidy the logs" },
    { id: "t-7", label: "land the API" },
    { id: "t-8", label: "update the docs" },
    { id: "t-9", label: "write the tests" },
    { id: "t-10", label: "seed the fixtures" },
    { id: "t-11", label: "drop the shim" },
    { id: "t-12", label: "ship it", deps: ["t-1", "t-2"] },
    { id: "t-13", label: "final polish of the parser error messages", deps: ["t-12"] },
    { id: "t-14", label: "bench the cache" },
];
export const LIVE_VERIFY_ERROR = "go test ./pkg/api: FAIL TestRoutes";
const TASKS_B = [
    { id: "t-1", label: "split the loader" },
    { id: "t-2", label: "cache the manifest" },
    { id: "t-3", label: "wire the loader", deps: ["t-1"] },
];
const TASKS_C = [
    { id: "t-1", label: "build the view" },
    { id: "t-2", label: "wire the store" },
    { id: "t-3", label: "add the scenario" },
];
export const LIVE_IDS = {
    leadA: "fx-live-lead-a",
    leadC: "fx-live-lead-c",
    w1: "fx-live-a1",
    w2: "fx-live-a2",
    w3: "fx-live-a3",
    w4: "fx-live-a4",
    w9: "fx-live-a9",
    r9: "fx-live-ar9",
    b1: "fx-live-b1",
    plain: "fx-live-plain",
};

// makes the three runs; ctx.live holds them by key, ctx.held (for teardown) every run made
export async function arrangeLiveRuns(h, ctx) {
    const now = Date.now();
    const A = await arrangeHeldRun(h, ctx, { key: "A", title: "verify live-run A: parser and cache work", tasks: LIVE_TASKS_A, parallelism: 4 });
    const c = {};
    for (const id of ["t-1", "t-2", "t-3", "t-4", "t-5", "t-6", "t-7", "t-8", "t-9", "t-10"]) c[id] = await heldStandIn(h, A, id);
    const r9 = await heldStandIn(h, A, "t-9 reviewer");
    await seedHeldRun(h, A, {
        "t-1": { state: "running", runid: c["t-1"], firstactivity: now - 6 * M, spawnedts: now - 6 * M },
        "t-2": { state: "running", runid: c["t-2"], firstactivity: now - 9 * M, spawnedts: now - 9 * M },
        "t-3": { state: "running", runid: c["t-3"], firstactivity: now - 4 * M, spawnedts: now - 4 * M },
        "t-4": { state: "review-failed", runid: c["t-4"], reviewround: 1, firstactivity: now - 20 * M },
        "t-5": { state: "failed", runid: c["t-5"], lastfailurekind: "exit 1", attempts: 1, firstactivity: now - 15 * M },
        "t-6": { state: "stalled", runid: c["t-6"], firstactivity: now - 30 * M, lastactivity: now - 12 * M },
        "t-7": { state: "verify-failed", runid: c["t-7"], verifyerror: `${LIVE_VERIFY_ERROR}\nmore output`, firstactivity: now - 25 * M },
        "t-8": { state: "verifying", runid: c["t-8"], merged: true, verifystartedts: now - 90_000, firstactivity: now - 18 * M },
        "t-9": { state: "reviewing", runid: c["t-9"], reviewrunid: r9, reviewround: 0, firstactivity: now - 14 * M },
        "t-10": { state: "done", runid: c["t-10"], merged: true, firstactivity: now - 40 * M },
        "t-11": { state: "skipped" },
    });
    // an unborn repo records no landing tree; a run lands on its own wave/<id> tree by default, so A is given one
    // (never made: the engine cannot tick a held run far enough to use it)
    A.landPath = join(A.cwd, "land");
    await fstWriteRun(h, A.runId, (r) => ({ ...r, landpath: A.landPath }));

    const B = await arrangeHeldRun(h, ctx, { key: "B", title: "verify live-run B: leadless lanes", tasks: TASKS_B });
    const b1 = await heldStandIn(h, B, "t-1");
    const b2 = await heldStandIn(h, B, "t-2");
    await seedHeldRun(h, B, {
        "t-1": { state: "running", runid: b1, firstactivity: now - 3 * M },
        "t-2": { state: "done", runid: b2, merged: true },
    });

    const C = await arrangeHeldRun(h, ctx, { key: "C", title: "verify live-run C: final stage", tasks: TASKS_C });
    const cc = {};
    for (const id of ["t-1", "t-2", "t-3"]) cc[id] = await heldStandIn(h, C, id);
    await seedHeldRun(
        h,
        C,
        Object.fromEntries(TASKS_C.map((t) => [t.id, { state: "done", merged: true, runid: cc[t.id], firstactivity: now - 30 * M }])),
        {
            status: "finalizing",
            check: "npm run check",
            verify: "node scripts/verify.mjs ./pkg/waveobj",
            finalcmd: "node scripts/cdp/final-verify.mjs live-run",
            final: {
                state: "failed",
                round: 1,
                startedts: now - 9 * M,
                detail: "Final `node scripts/cdp/final-verify.mjs live-run` failed (exit 1):\nFAIL live-run 3. the lead card shows the Final row",
                tree: `${C.cwd.replace(/\\/g, "/")}/.waveterm/worktrees/${C.runId}-final`,
                commit: "c0ffee5a".padEnd(40, "0"),
            },
        }
    );
    ctx.live = { A, B, C };
}

// run B had a lead once: a worker oref on its phase is what the cockpit reads that from. teardown takes it off before
// the cancel, which otherwise fails on a tab that does not exist
export const markLeadClosed = (h, run, on = true) =>
    fstWriteRun(h, run.runId, (r) => ({
        ...r,
        phases: (r.phases?.length ? r.phases : [{}]).map((p, i) => (i === 0 ? { ...p, workerorefs: on ? ["tab:fx-closed-lead"] : [] } : p)),
    }));

const msg = (text) => ({ kind: "message", text });

export function liveRoster(ctx) {
    const { A, B, C } = ctx.live;
    const now = Date.now();
    const plan = join(C.cwd, "live-run-plan.md");
    writeFileSync(plan, "# Live-run plan\n\nA plan for the doc review dialog.\n");
    const base = { project: "verify-live-run", agent: "claude", model: "sonnet" };
    return [
        { ...base, id: LIVE_IDS.leadA, name: "live-run lead A", task: "lead run A", state: "working", atPrompt: true, model: "opus", activeMs: 22 * M, runId: A.runId, blockId: "fx-blk-live-lead-a",
            previousInfo: [msg("Submitted the plan: 14 tasks in 4 lanes."), msg("Standing by while the engine runs the lanes.")] },
        { ...base, id: LIVE_IDS.w1, name: "worker t-1", task: "wire the parser", state: "working", activity: "editing parser.go", activeMs: 6 * M, runId: A.children["t-1"], blockId: "fx-blk-live-a1" },
        { ...base, id: LIVE_IDS.w2, name: "worker t-2", task: "pick the cache key", state: "asking", blockedMs: 4 * M, runId: A.children["t-2"], blockId: "fx-blk-live-a2",
            ask: { askId: "fx-live-ask-a2", oref: "block:fx-blk-live-a2", questions: [{ header: "Cache key", question: "Should the cache key include the tenant id?",
                options: [{ label: "include the tenant id" }, { label: "per-route only" }] }] } },
        { ...base, id: LIVE_IDS.w3, name: "worker t-3", task: "port the retry loop", state: "working", activity: "waiting on the lead", activeMs: 4 * M, runId: A.children["t-3"], blockId: "fx-blk-live-a3" },
        // idle past the five-minute grace: the card owns them, so they must not also park in Idle
        { ...base, id: LIVE_IDS.w4, name: "worker t-4", task: "rename the flags", state: "idle", idleSince: now - 13 * M, runId: A.children["t-4"], blockId: "fx-blk-live-a4" },
        { ...base, id: LIVE_IDS.w9, name: "worker t-9", task: "write the tests", state: "idle", idleSince: now - 9 * M, runId: A.children["t-9"], blockId: "fx-blk-live-a9" },
        { ...base, id: LIVE_IDS.r9, name: "reviewer t-9", task: "review t-9", state: "working", activity: "reading the diff", activeMs: 2 * M, runId: A.children["t-9 reviewer"], blockId: "fx-blk-live-ar9", model: "opus" },
        { ...base, id: LIVE_IDS.b1, name: "worker B t-1", task: "split the loader", state: "working", activity: "moving loader.go", activeMs: 3 * M, runId: B.children["t-1"], blockId: "fx-blk-live-b1" },
        { ...base, id: LIVE_IDS.leadC, name: "live-run lead C", task: "lead run C", state: "working", atPrompt: true, model: "opus", activeMs: 9 * M, runId: C.runId, blockId: "fx-blk-live-lead-c",
            previousInfo: [msg("Final round 1 failed: 1 of 12 steps."), msg("Writing a fix round.")] },
        { ...base, id: LIVE_IDS.plain, name: "plain agent", task: "unrelated", state: "working", activity: "reading files", activeMs: 2 * M, blockId: "fx-blk-live-plain", previousInfo: [msg("Reading the repo.")] },
    ];
}

export const setLiveRoster = (h, ctx) => setPageRoster(h, liveRoster(ctx));

// the digest's ask reasons and the run's child asks: only a live worker's question makes them. The next digest load
// or asks refresh replaces them, so a step re-injects before it reads them
export const injectLiveAsks = (h, ctx) =>
    lookEval(
        h,
        `const { globalStore } = await mod("app/store/jotaiStore.ts");
        const L = await mod("app/view/agents/runlineagestore.ts");
        const CA = await mod("app/view/agents/childaskstore.ts");
        const id = ${JSON.stringify(ctx.live.A.runId)};
        const now = Date.now();
        if (!(await until(() => globalStore.get(L.runDigestsAtom)[id], 15000))) return "no digest for run A";
        const d = globalStore.get(L.runDigestsAtom)[id];
        const tasks = d.tasks.map((t) =>
            t.taskid === "t-2" ? { ...t, waitreason: "ask", asksummary: "Should the cache key include the tenant id?", askts: now - 240000 }
            : t.taskid === "t-3" ? { ...t, waitreason: "lead-ask", askdeadline: now + 4 * 60000, asksummary: "Retry 429s with backoff, or fail fast?" }
            : t);
        globalStore.set(L.runDigestsAtom, (prev) => ({ ...prev, [id]: { ...d, tasks } }));
        globalStore.set(CA.childAsksAtom, (prev) => ({ ...prev, [id]: [
            { taskid: "t-2", askid: "fx-live-ask-a2", owner: "user", questions: [{ header: "Cache key", question: "Should the cache key include the tenant id?", options: [{ label: "include the tenant id" }, { label: "per-route only" }] }], blockoref: "block:fx-blk-live-a2", ts: now - 240000 },
            { taskid: "t-3", askid: "fx-live-ask-a3", owner: "lead", deadline: now + 4 * 60000, questions: [{ header: "Retries", question: "Retry 429s with backoff, or fail fast?", options: [{ label: "backoff" }, { label: "fail fast" }] }], blockoref: "block:fx-blk-live-a3", ts: now - 60000 },
        ] }));
        return "ok";`
    );

// run events no RPC writes: the page appends each run:event it receives to that run's list until the next reload
export async function publishLiveEvents(h, ctx) {
    const { A, B } = ctx.live;
    const now = Date.now();
    const pub = (run, id, kind, detail, ago) =>
        h.rpc("eventpublish", {
            event: "run:event",
            scopes: [`run:${run.runId}`],
            data: { channelid: run.channelId, runid: run.runId, event: { id, kind, ts: now - ago, runid: run.runId, channelid: run.channelId, detail: JSON.stringify(detail) } },
        });
    await pub(A, "fx-live-rf-1", "task-review-failed", { taskid: "t-4", round: 1, note: "The flag rename misses wshcmd-run.go." }, 12 * M);
    await pub(A, "fx-live-rf-2", "task-review-failed", { taskid: "t-4", round: 2, note: "Help text still names the old flags." }, 6 * M);
    await pub(A, "fx-live-e1", "task-merged", { taskid: "t-10" }, 50_000);
    await pub(A, "fx-live-e2", "task-failed", { taskid: "t-5", kind: "exit 1" }, 40_000);
    await pub(A, "fx-live-e3", "task-verify-failed", { taskid: "t-7" }, 30_000);
    await pub(B, "fx-live-e4", "task-merged", { taskid: "t-2" }, 20_000);
    await pub(B, "fx-live-e5", "task-failed", { taskid: "t-1", kind: "exit 2" }, 10_000);
}

export async function teardownLiveRuns(h, ctx, name) {
    if (ctx.live?.B && ctx.leadClosed) {
        await markLeadClosed(h, ctx.live.B, false).catch((e) => console.error(`${name} teardown: unmark run B: ${e?.message ?? e}`));
    }
    await teardownHeldRuns(h, ctx, name);
}
