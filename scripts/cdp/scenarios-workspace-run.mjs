// Scenario `workspace-run`: the workspace pane's Run tab (Task 5 of docs/superpowers/plans/2026-11-17-workspace-pane.md;
// boards RunTasks and RunGraph). A fixture lead (a claude agent backed by a real tab with no controller) shows the
// Rendered view of a transcript holding its `wsh jarvis dag forward` call, whose card links the run. The run is
// page-only: its run and dag objects go into the page's object cache, its digest into the digest map, its events are
// seeded and its user-owned ask is put in the ask map, so no engine runs. Answering stubs the two dag ask RPCs, the
// engine's side of an answer, and teardown puts them back.

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
import { CTRL, polishNap, polishWaitFor, restoreLocalStorage } from "./scenarios-shared.mjs";

const NAME = "workspace-run";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
const WIDTH_KEY = "agent.workspace.width";
const VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const WAIT_MS = 10_000;
// past the pane's macro reveal and a view swap, so a read after it sees the settled pane
const SETTLE_MS = 700;
const MIN = 60_000;
const RUN_ID = "7f3a91c2-0b4d-4e6f-8a1b-2c3d4e5f6a7b";
const DAG_ID = "fx-workspace-run-dag";
const CHANNEL = "fx-workspace-run-channel";
const TITLE = "stats and dedupe packages";
const PLAN = "docs/superpowers/plans/2026-11-17-stats-dedupe.md";
const TAB_KEY = `run:${RUN_ID}`;
const QUESTION = "Should two URLs that differ only by a trailing slash count as duplicates?";
const OPTIONS = ["Yes, the same URL", "No, different URLs"];
const ANSWERED_Q = 'Count a bookmark with no tags under an "untagged" key?';
const FORWARD_NOTE = "a scope call on trailing slashes";
// openref's refusal once the peek finds no run on the server
const RUN_GONE = "That run no longer exists";

const PANE = `document.querySelector('aside[aria-label="Workspace"]')`;
const RV = `document.querySelector("[data-rendered-view]")`;
const RUN_TAB = `document.querySelector("[data-workspace-run]")`;
const OPEN_RUN = `${RV}?.querySelector('[data-open-run="${RUN_ID}"]')`;
const TAB_DOT = `document.querySelector('[data-workspace-tab="${TAB_KEY}"] [data-workspace-tab-waiting]')`;

const tasksOf = (now) => [
    { id: "t-1", label: "plan review", state: "done", merged: true },
    { id: "t-2", label: "internal/stats counters", state: "done", merged: true, spawnedts: now - 6 * MIN },
    { id: "t-3", label: "internal/dedupe groups", state: "running", spawnedts: now - 3 * MIN, deps: ["t-1"] },
    { id: "t-4", label: "go test and go vet", state: "pending", deps: ["t-2", "t-3"] },
    { id: "t-5", label: "final verification", state: "pending", deps: ["t-4"] },
];

const runObj = (now, version = 1) => ({
    otype: "run",
    oid: RUN_ID,
    id: RUN_ID,
    version,
    goal: TITLE,
    title: TITLE,
    status: "executing",
    mode: "orchestrator",
    runtime: "claude",
    model: "claude-opus-5-5",
    channeloid: CHANNEL,
    dagoref: DAG_ID,
    workspaceid: "",
    projectpath: "C:\\fx\\linkshelf",
    phases: [],
    createdts: now - 7 * MIN,
});

const dagObj = (now, version = 1) => ({
    otype: "dag",
    oid: DAG_ID,
    id: DAG_ID,
    version,
    runid: RUN_ID,
    channelid: CHANNEL,
    title: TITLE,
    parallelism: 2,
    status: "running",
    failures: 0,
    createdts: now - 6 * MIN - 29_000,
    updatedts: now,
    planpath: PLAN,
    tasks: tasksOf(now),
});

const digestOf = (version) => ({
    dagversion: version,
    health: "needs-you",
    counts: {},
    next: { kind: "waiting" },
    tasks: [{ taskid: "t-3", waitreason: "ask", mergestate: "", cleanupstate: "" }],
    lanes: [["t-1"], ["t-2"], ["t-3"], ["t-4"], ["t-5"]],
    durations: { elapsedms: 0, tasks: [{ taskid: "t-2", runms: 2 * MIN + 51_000 }] },
    report: { workerms: 6 * MIN + 49_000, answered: 1, forwarded: 1 },
});

const event = (id, kind, ts, detail) => ({ id, runid: RUN_ID, channelid: CHANNEL, kind, ts, detail: JSON.stringify(detail) });

// oldest first; the Activity view reads them newest first
const eventsOf = (now) => [
    event("fx-wr-1", "task-spawned", now - 6 * MIN, { taskid: "t-2" }),
    event("fx-wr-2", "child-ask", now - 5 * MIN, { taskid: "t-2", question: ANSWERED_Q }),
    event("fx-wr-3", "child-answered", now - 4 * MIN - 30_000, { taskid: "t-2" }),
    event("fx-wr-4", "task-merged", now - 3 * MIN - 30_000, { taskid: "t-2" }),
    event("fx-wr-5", "task-spawned", now - 3 * MIN, { taskid: "t-3" }),
    event("fx-wr-6", "task-forwarded", now - MIN, { taskid: "t-3", note: FORWARD_NOTE }),
];

const askOf = (now) => ({
    taskid: "t-3",
    askid: "fx-workspace-run-ask",
    owner: "user",
    questions: [{ question: QUESTION, header: "Duplicates", options: OPTIONS.map((label) => ({ label })) }],
    blockoref: "",
    ts: now - MIN,
});

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
const page = (h, body) => agentPage(h, `${LIB} ${body}`);

// the page-only run: objects, digest, events and the ask, written before anything reads them
const seedRun = (h, now, version = 1) =>
    agentPage(
        h,
        `const L = await mod("app/view/agents/runlineagestore.ts");
        const E = await mod("app/view/agents/runeventstore.ts");
        const C = await mod("app/view/agents/childaskstore.ts");
        WOS.updateWaveObject({ updatetype: "update", otype: "dag", oid: ${JSON.stringify(DAG_ID)}, obj: ${JSON.stringify(dagObj(now, version))} });
        WOS.updateWaveObject({ updatetype: "update", otype: "run", oid: ${JSON.stringify(RUN_ID)}, obj: ${JSON.stringify(runObj(now, version))} });
        globalStore.set(L.runDigestsAtom, (prev) => ({ ...prev, ${JSON.stringify(RUN_ID)}: ${JSON.stringify(digestOf(version))} }));
        E.seedRunEvents(${JSON.stringify(RUN_ID)}, ${JSON.stringify(eventsOf(now).reverse())});
        globalStore.set(C.childAsksAtom, (prev) => ({ ...prev, ${JSON.stringify(RUN_ID)}: [${JSON.stringify(askOf(now))}] }));
        return true;`
    );

const mouse = (h, type, x, y, extra = {}) => h.cdp("Input.dispatchMouseEvent", { type, x, y, ...extra });

// a real click at the centre of what expr names; modifiers as CDP's bitmask
async function clickAt(h, expr, modifiers = 0) {
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

// the Run tab as drawn
const readTab = (h) =>
    page(
        h,
        `const tab = ${RUN_TAB};
        const q = (sel) => tab?.querySelector(sel);
        return {
            pane: ${PANE}?.dataset.workspacePane ?? null,
            tabs: [...document.querySelectorAll("[data-workspace-tab]")].map((t) => t.dataset.workspaceTab),
            active: document.querySelector('[data-workspace-tab] [role="tab"][aria-selected="true"]')?.closest("[data-workspace-tab]")?.dataset.workspaceTab ?? null,
            run: tab?.dataset.workspaceRun ?? null,
            head: flat(q("[data-workspace-run-head]")),
            state: q("[data-workspace-run-state]")?.dataset.workspaceRunState ?? null,
            line: flat(q("[data-workspace-run-line]")),
            needs: flat(q("[data-workspace-run-needs]")),
            view: q('[role="tab"][aria-selected="true"]')?.dataset.runView ?? null,
            views: [...(tab?.querySelectorAll("[data-run-view]") ?? [])].map((b) => flat(b)),
            tasks: [...(tab?.querySelectorAll("[data-workspace-run-task]") ?? [])].map((r) => [r.dataset.workspaceRunTask, flat(r.querySelector("[data-workspace-run-task-state]"))]),
            asks: [...(tab?.querySelectorAll("[data-workspace-run-ask]") ?? [])].map((a) => ({ task: a.dataset.workspaceRunAsk, text: flat(a), options: [...a.querySelectorAll("button")].map((b) => flat(b)).filter(Boolean) })),
            answered: [...(tab?.querySelectorAll("[data-workspace-run-answered]") ?? [])].map((a) => flat(a)),
            activity: [...(tab?.querySelectorAll("[data-workspace-run-activity] > div") ?? [])].map((a) => flat(a)),
            totals: flat(q("[data-workspace-run-totals]")),
            graph: q("[data-workspace-run-graph]") != null,
            nodes: [...(tab?.querySelectorAll("[data-dag-node]") ?? [])].map((n) => n.getAttribute("data-dag-node")),
            peek: document.querySelector("[data-dag-task-peek]")?.getAttribute("data-dag-task-peek") ?? null,
            peekText: flat(document.querySelector("[data-dag-task-peek]")),
            dot: ${TAB_DOT} != null,
        };`
    );

export const workspaceRun = {
    name: NAME,
    surface: "agent",
    async arrange(h) {
        const tag = Date.now().toString(36);
        const ctx = { tabIds: [], dir: mkdtempSync(join(tmpdir(), "verify-workspace-run-")) };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            ctx.prevWidth = await h.ev(`localStorage.getItem(${JSON.stringify(WIDTH_KEY)})`);
            await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
            const now = Date.now();
            ctx.now = now;
            const transcript = writeTranscript(ctx.dir, `workspace-run-${tag}`, [
                userText(`Run the ${TITLE} plan.`),
                toolUse("toolu_fx_fwd", "Bash", { command: `wsh jarvis dag forward t-3 "${FORWARD_NOTE}" --runid ${RUN_ID}`, description: "hand t-3 to the user" }),
                toolResult("toolu_fx_fwd", "forwarded t-3"),
                assistantText("The dedupe task needs your call on trailing slashes."),
            ]);
            await h.goto("agent");
            const lead = await makeTab(h, ctx, { label: `workspace-run-${tag}`, blockMeta: { view: "term", controller: null } });
            ctx.leadId = lead.tabId;
            await h.ev(`localStorage.removeItem(${JSON.stringify(WIDTH_KEY)})`);
            await seedRun(h, now);
            ctx.seeded = true;
            await pinDefaultView(h, "rendered");
            await setRoster(h, [
                {
                    id: lead.tabId,
                    name: `workspace-run-${tag}`,
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
        } catch (err) {
            ctx.arrangeError = String(err?.message ?? err);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
        if (ctx.arrangeError != null) {
            rec(`${NAME}: arrange`, false, ctx.arrangeError);
            return steps;
        }
        // one throwing step is one FAIL, not the end of the run
        const step = async (name, fn) => {
            try {
                const [ok, detail] = await fn();
                rec(name, ok, detail);
            } catch (err) {
                rec(name, false, `threw: ${err?.message ?? err}`);
            }
        };
        const LEAD = JSON.stringify(ctx.leadId);
        const pick = async (view) => {
            await h.ev(`document.querySelector('[data-workspace-run] [data-run-view="${view}"]')?.click()`);
            await polishNap(SETTLE_MS);
            return readTab(h);
        };

        // the peek loads the run from the server, which has no page-only run: it starts, then is refused, and the cache
        // now reads the run as gone, so the step puts the run back at a newer version
        await step("Ctrl+click on the run card's Answer in the run peeks the run and opens no tab", async () => {
            await page(
                h,
                `const P = await mod("app/view/jarvis/peekstore.ts");
                window.__wrPeeks = [];
                window.__wrPeekOff = globalStore.sub(P.peekItemAtom, () => {
                    const item = globalStore.get(P.peekItemAtom);
                    if (item) window.__wrPeeks.push(item.target);
                });
                return true;`
            );
            const clicked = await clickAt(h, OPEN_RUN, CTRL);
            await polishNap(SETTLE_MS);
            const r = await page(
                h,
                `const P = await mod("app/view/jarvis/peekstore.ts");
                const T = await mod("app/cockpit/notificationstore.ts");
                const refused = (t) => t.title === ${JSON.stringify(RUN_GONE)};
                await until(() => globalStore.get(T.toastsAtom).some(refused));
                globalStore.get(T.toastsAtom).filter(refused).forEach((t) => T.dismissToast(t.id));
                window.__wrPeekOff();
                const out = { tabs: ws(${LEAD}).tabs.length, peeks: window.__wrPeeks, pane: ${PANE} != null };
                delete window.__wrPeeks;
                delete window.__wrPeekOff;
                P.closePeek();
                return out;`
            );
            await seedRun(h, ctx.now, 2);
            await polishNap(SETTLE_MS);
            const peeked = r.peeks.some((t) => t.kind === "run" && t.runId === RUN_ID);
            return [clicked && r.tabs === 0 && !r.pane && peeked, r];
        });

        // RunTasks board
        await step("a plain click on Answer in the run opens the Run tab beside with Tasks shown, the head and the ask answerable inline (RunTasks board)", async () => {
            const clicked = await clickAt(h, OPEN_RUN);
            await polishWaitFor(h, `${RUN_TAB} != null`, WAIT_MS);
            await polishWaitFor(h, `document.querySelector("[data-workspace-run-ask]") != null`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const t = await readTab(h);
            await h.shot(SHOT(1, "tasks"));
            const ask = t.asks.find((a) => a.task === "t-3");
            const ok =
                clicked &&
                t.pane === "open" &&
                t.active === TAB_KEY &&
                t.run === RUN_ID &&
                t.view === "tasks" &&
                t.head.startsWith(TITLE) &&
                t.state === "live" &&
                t.line === `2/5 tasks · 6m · ${RUN_ID.slice(0, 8)} · plan 2026-11-17-stats-dedupe.md` &&
                t.needs === "Needs you · then t-4 · go test and go vet" &&
                JSON.stringify(t.views.map((v) => v.replace(/\s+/g, ""))) === JSON.stringify(["Tasks5", "Asks2", "Activity6", "Graph"]) &&
                JSON.stringify(t.tasks.map((r) => r[0])) === JSON.stringify(["t-1", "t-2", "t-3", "t-4", "t-5"]) &&
                t.tasks[2][1] === "asking you" &&
                t.tasks[3][1] === "waits on t-3" &&
                ask != null &&
                ask.text.includes(QUESTION) &&
                OPTIONS.every((o) => ask.options.some((b) => b.includes(o))) &&
                t.totals.includes("Worker time 6m") &&
                t.dot;
            return [ok, t];
        });

        await step("the Asks view: the question waiting on you first, answerable, then the answered one; the indicator slides (9) and the body fades in (viewFade)", async () => {
            const sampled = await page(
                h,
                `const ind = () => document.querySelector("[data-run-view-indicator]");
                const xs = sampleFrames(() => { const r = ind()?.getBoundingClientRect(); return r ? Math.round(r.x) : null; });
                const fades = sampleFrames(() => { const el = document.querySelector('[data-workspace-run] [data-view-swap="asks"]'); return el ? Number(getComputedStyle(el).opacity).toFixed(2) : null; });
                document.querySelector('[data-workspace-run] [data-run-view="asks"]').click();
                await nap(${SETTLE_MS});
                xs.stop();
                fades.stop();
                return { xs: xs.values, fades: fades.values };`
            );
            const t = await readTab(h);
            const slid = sampled.xs.length >= 3;
            const faded = sampled.fades.some((o) => Number(o) > 0 && Number(o) < 1) && sampled.fades.at(-1) === "1.00";
            const ok =
                t.view === "asks" &&
                t.asks.length === 1 &&
                t.asks[0].text.startsWith("t-3 asks you") &&
                t.asks[0].text.includes(QUESTION) &&
                t.answered.length === 1 &&
                t.answered[0].startsWith("t-2 asked · answered") &&
                t.answered[0].includes(ANSWERED_Q) &&
                slid &&
                faded;
            return [ok, { sampled, view: t.view, asks: t.asks, answered: t.answered }];
        });

        await step("the Activity view: every event of the run, newest first", async () => {
            const t = await pick("activity");
            const ok =
                t.view === "activity" &&
                t.activity.length === 6 &&
                t.activity[0].includes("t-3 handed to you") &&
                t.activity.at(-1).includes("Task spawned · t-2");
            return [ok, { view: t.view, activity: t.activity }];
        });

        // RunGraph board
        await step("the Graph view: the run's DAG with no header of its own, and a selected task shows its card (RunGraph board)", async () => {
            const t0 = await pick("graph");
            await polishWaitFor(h, `document.querySelectorAll("[data-workspace-run-graph] [data-dag-node]").length === 6`, WAIT_MS);
            const clicked = await clickAt(h, `document.querySelector('[data-workspace-run-graph] [data-dag-node="t-3"]')`);
            await polishWaitFor(h, `document.querySelector('[data-dag-task-peek="t-3"]') != null`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const t = await readTab(h);
            const header = await h.ev(`document.querySelector("[data-workspace-run-graph] [data-dag-stage-entry]") != null`);
            await h.shot(SHOT(2, "graph"));
            const ok =
                t0.view === "graph" &&
                t.graph &&
                // the final stage is the graph's last node from the start of the run
                JSON.stringify([...t.nodes].sort()) === JSON.stringify(["final", "t-1", "t-2", "t-3", "t-4", "t-5"]) &&
                !header &&
                clicked &&
                t.peek === "t-3" &&
                t.peekText.includes("internal/dedupe groups");
            return [ok, { view: t.view, nodes: t.nodes, header, peek: t.peek, peekText: t.peekText.slice(0, 160) }];
        });

        await step("answering the ask inline sends it, and the tab's dot goes once the run has it", async () => {
            const back = await pick("tasks");
            const before = back.dot;
            // the engine's side: the answer is taken, and the ask list read after it no longer has the ask
            await page(
                h,
                `const { RpcApi } = await mod("app/store/wshclientapi.ts");
                window.__wrAnswers = [];
                RpcApi.DagAnswerCommand = async (_client, data) => {
                    window.__wrAnswers.push(data);
                    globalStore.set(C.childAsksAtom, (prev) => ({ ...prev, ${JSON.stringify(RUN_ID)}: [] }));
                };
                RpcApi.DagAsksCommand = async () => ({ asks: globalStore.get(C.childAsksAtom)[${JSON.stringify(RUN_ID)}] ?? [] });
                return true;`
            );
            ctx.stubbed = true;
            const clicked = await clickAt(
                h,
                `[...(document.querySelector('[data-workspace-run-ask="t-3"]')?.querySelectorAll("button") ?? [])].find((b) => b.innerText.includes(${JSON.stringify(OPTIONS[0])}))`
            );
            const gone = await polishWaitFor(h, `${TAB_DOT} == null`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const t = await readTab(h);
            const sent = await h.ev(`window.__wrAnswers`);
            await h.shot(SHOT(3, "answered"));
            const ok =
                before &&
                clicked &&
                gone &&
                !t.dot &&
                sent?.length === 1 &&
                sent[0].taskid === "t-3" &&
                sent[0].runid === RUN_ID &&
                t.needs === "" &&
                t.asks.length === 0;
            return [ok, { before, clicked, gone, sent, needs: t.needs, asks: t.asks }];
        });

        return steps;
    },
    async teardown(h, ctx) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`${NAME} teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        if (ctx.stubbed) {
            await step("put the ask RPCs back", () =>
                agentPage(
                    h,
                    `const { RpcApi } = await mod("app/store/wshclientapi.ts");
                    delete RpcApi.DagAnswerCommand;
                    delete RpcApi.DagAsksCommand;
                    delete window.__wrAnswers;
                    return true;`
                )
            );
        }
        if (ctx.leadId) {
            await step("close the workspace tabs", () =>
                page(h, `for (const t of [...ws(${JSON.stringify(ctx.leadId)}).tabs]) W.closeWorkspaceTab(${JSON.stringify(ctx.leadId)}, t.kind === "run" ? "run:" + t.runId : t.kind); return true;`)
            );
        }
        if (ctx.seeded) {
            await step("drop the run's ask and digest", () =>
                agentPage(
                    h,
                    `const C = await mod("app/view/agents/childaskstore.ts");
                    const L = await mod("app/view/agents/runlineagestore.ts");
                    const drop = (prev) => { const next = { ...prev }; delete next[${JSON.stringify(RUN_ID)}]; return next; };
                    globalStore.set(C.childAsksAtom, drop);
                    globalStore.set(L.runDigestsAtom, drop);
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
    },
};
