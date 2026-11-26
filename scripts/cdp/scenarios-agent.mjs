import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCENARIOS as COCKPIT_FIXTURES } from "../cockpit-fixtures/scenarios.mjs";
import {
    CANVAS_PANE,
    CANVAS_TABS_WAIT_MS,
    CANVAS_TOPIC,
    COCKPIT,
    LOOK_TOOLTIP_STYLE,
    MIN_FONT_PX,
    MODELS_VIEWPORT,
    OBS_WIDE,
    RAIL_VISIBLE_KEY,
    RUN_SHEET_POLISH_TASKS,
    TREE_RAIL_FIXTURE,
    TREE_RAIL_LEAD,
    TREE_RAIL_LEAD_ID,
    UI_ROUTE,
    arrangeFixtureRun,
    arrangeHeldRun,
    floorDetail,
    floorOk,
    flatText,
    floorStep,
    fstWriteRun,
    heldStandIn,
    lookEval,
    lookHover,
    lookOpen,
    lookShot,
    openCanvasTerminal,
    polishNap,
    polishWaitFor,
    pressCanvasKey,
    seedHeldRun,
    setPageRoster,
    skipStep,
    teardownFixtureRun,
    tooltipLookOk,
    treeRailRoster,
    waitForDispatch,
    waveService,
} from "./scenarios-shared.mjs";
import { closeTabs, makeTab, pinDefaultView, restoreDefaultView } from "./agent-page-fixtures.mjs";
import { arrangeLiveRuns, injectLiveAsks, LIVE_IDS, LIVE_TASKS_A, liveRoster, publishLiveEvents, setLiveRoster, teardownLiveRuns } from "./live-run-fixture.mjs";

async function openOwnTerminal(h, label) {
    const bootTab = String(await h.ev("window.TabRpcClient.routeId")).replace(/^tab:/, "");
    const wslist = await h.rpc("workspacelist", null);
    const ws = wslist.find((w) => (w.workspacedata?.tabids ?? []).includes(bootTab)) ?? wslist[0];
    const term = { workspaceId: ws.workspacedata.oid };
    term.tabId = await waveService(h, "workspace", "CreateTab", [term.workspaceId, label, false]);
    const tab = await waveService(h, "object", "GetObject", [`tab:${term.tabId}`]);
    term.blockId = tab?.blockids?.[0];
    if (!term.blockId) throw new Error("the new tab has no block");
    await h.rpc("setmeta", { oref: `block:${term.blockId}`, meta: { view: "term", controller: "shell", "cmd:cwd": "~" } });
    return term;
}
async function closeOwnTerminal(h, term, scenario) {
    if (term?.tabId == null) return;
    try {
        await waveService(h, "workspace", "CloseTab", [term.workspaceId, term.tabId, false]);
    } catch (e) {
        console.error(`${scenario} teardown: closing ${term.tabId} failed: ${e?.message ?? e}`);
    }
}

// the text glyphs the polish replaced with lucide icons
const TREE_RAIL_GLYPHS = ["↳", "◆", "▸", "▾", "›_", "↗", "‹"];

const TREE_RAIL_SUBAGENT_PROMPT = "survey the tree rail";

// a parent transcript with one subagent file whose last record is not an assistant turn, so it reads as working
function writeLeadTranscript(cwd) {
    const parent = join(cwd, "lead.jsonl");
    const subs = join(cwd, "lead", "subagents");
    mkdirSync(subs, { recursive: true });
    const userTurn = (content) => JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
    writeFileSync(parent, userTurn("verify tree rail"));
    writeFileSync(join(subs, "agent-fxsub.jsonl"), userTurn(TREE_RAIL_SUBAGENT_PROMPT));
    return parent;
}

// idle rows in a project that already has its asking agent, so step 1's badges hold; enough that the tree scrolls,
// which step 10 needs to show the last row scrolling clear of the avatar
const TREE_RAIL_FILLER_COUNT = 30;

function appendTreeRailFiller(now) {
    const roster = JSON.parse(readFileSync(TREE_RAIL_FIXTURE, "utf8"));
    for (let i = 1; i <= TREE_RAIL_FILLER_COUNT; i++) {
        roster.push({
            id: `fx-filler-${i}`,
            name: `filler scribe ${i}`,
            project: "siem-platform",
            task: `filler task ${i}`,
            state: "idle",
            model: "sonnet",
            idleSince: now - 60_000 - i * 1000,
            blockId: `fx-blk-filler-${i}`,
        });
    }
    writeFileSync(TREE_RAIL_FIXTURE, JSON.stringify(roster, null, 2));
}

// the lead row is named by its run's plan title, not the tab's name (D12)
const TREE_RAIL_TITLE = "verify tree-rail";
// t-1's worker tab step 9b adds, and the project of the shell tab that is its block
const TREE_WORKER_NAME = "tree-rail worker";
const TREE_WORKER_TOPIC = "verify-tree-rail-worker";
// the words of a block the header could not start (F5)
const BLOCK_ERROR_RE = /failed to start|error getting block/i;
const WORKER_RUNNING_WAIT_MS = 10_000;
const WORKER_RUNNING_POLL_MS = 250;
// the projects of the shell tabs that are the tree-rail lead's and lead D's blocks
const TREE_LEAD_TOPIC = "verify-tree-rail-lead";
const LANDED_LEAD_TOPIC = "verify-tree-rail-lead-d";

// a real shell tab for an injected agent tab, so its header starts a block that exists (F5). A failure is kept on
// the term for the step that reads that header; a tab made before it is still closed in teardown
async function openAgentTerm(h, topic) {
    const term = {};
    try {
        await openCanvasTerminal(h, term, topic);
    } catch (e) {
        term.error = String(e?.message ?? e);
    }
    return term;
}

// the header starts the tab's shell on mount; a block it could not start reads as an error at once
async function waitShellRunning(h, blockId) {
    let status = null;
    for (let waited = 0; blockId && status !== "running" && waited < WORKER_RUNNING_WAIT_MS; waited += WORKER_RUNNING_POLL_MS) {
        status = (await waveService(h, "block", "GetControllerStatus", [blockId]).catch(() => null))?.shellprocstatus ?? null;
        if (status !== "running") await polishNap(WORKER_RUNNING_POLL_MS);
    }
    return status;
}

// a focused lead tab is a real running block: neither its tree row nor the header shows a block error (F5)
async function leadBlockCheck(h, term, agentId) {
    const status = await waitShellRunning(h, term?.blockId);
    const rowExpr = `${LIVE_TREE}?.querySelector(${JSON.stringify(`[data-tree-agent="${agentId}"]`)})`;
    const text = await h.ev(`({ row: ${flatText(rowExpr)}, header: ${flatText(`document.querySelector("[data-agent-header]")`)} })`);
    const errors = [text.row, text.header].map((t) => t.match(BLOCK_ERROR_RE)?.[0]).filter(Boolean);
    return {
        ok: term?.error == null && term?.blockId != null && status === "running" && text.row !== "" && text.header !== "" && errors.length === 0,
        detail: { error: term?.error ?? (term ? null : "not arranged"), blockId: term?.blockId, status, errors, ...text },
    };
}

async function arrangeTreeRail(h, ctx) {
    // made before the fixture is written: the roster is read once at boot, and its lead names this block
    ctx.leadTerm = await openAgentTerm(h, TREE_LEAD_TOPIC);
    const leadBlock = ctx.leadTerm.blockId ? { blockId: ctx.leadTerm.blockId } : {};
    await arrangeFixtureRun(h, ctx, "tree-rail", TREE_RAIL_LEAD, { transcriptPath: writeLeadTranscript(ctx.cwd), ...leadBlock });
    appendTreeRailFiller(Date.now());
    await h.rpc("dagsubmit", {
        channelid: ctx.channelId,
        runid: ctx.runId,
        title: TREE_RAIL_TITLE,
        parallelism: 1,
        tasks: RUN_SHEET_POLISH_TASKS,
    });
    // a queued task folds away, so t-1 has a worker row only once it dispatches
    await waitForDispatch(h, ctx, "t-1");
    // the rail is off by default and persisted, and the fixture roster is read once at boot
    await h.ev(`localStorage.setItem(${JSON.stringify(RAIL_VISIBLE_KEY)}, "true")`);
    await h.ev("location.reload()");
    await h.ev(`(async () => {
        for (let i = 0; i < 60 && !document.querySelector("nav button"); i++) {
            await new Promise((r) => setTimeout(r, 500));
        }
    })()`);
    await h.goto("agent");
    // the lead row nests once its run loads, which is when its mark turns from a dot into the Workflow icon
    ctx.leadFocused = await h.ev(`(async () => {
        const leadRow = () => {
            const tree = document.querySelector("[data-agent-tree]");
            const name = tree && [...tree.querySelectorAll("div")].find(
                (d) => d.textContent.trim() === ${JSON.stringify(TREE_RAIL_TITLE)} && d.children.length === 0
            );
            return name ? name.closest(".cursor-pointer") : null;
        };
        for (let i = 0; i < 40; i++) {
            const row = leadRow();
            if (row && row.firstElementChild?.firstElementChild?.tagName.toLowerCase() === "svg") {
                row.click();
                return true;
            }
            await new Promise((r) => setTimeout(r, 250));
        }
        return false;
    })()`);
    // let the rail's width slide and the run section settle before the shot
    await new Promise((r) => setTimeout(r, 1200));
}

// the app's view model, found from the nav's props
const LIVE_MODEL = `(() => {
    const nav = document.querySelector("nav");
    const key = nav && Object.keys(nav).find((k) => k.startsWith("__reactFiber$"));
    for (let f = key ? nav[key] : null; f; f = f.return) {
        if (f.memoizedProps?.model?.focusIdAtom) return f.memoizedProps.model;
    }
    return null;
})()`;
const LIVE_RAIL = `document.querySelector('aside[aria-label="Agent details"]')`;
const LIVE_TREE = `document.querySelector("[data-agent-tree]")`;
const LIVE_NARROW = { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false };

// focuses an id on the Agent surface and waits for the rail to say it is there
const liveFocus = (h, id, until) =>
    lookEval(
        h,
        `const { globalStore } = await mod("app/store/jotaiStore.ts");
        const model = ${LIVE_MODEL};
        globalStore.set(model.focusIdAtom, ${JSON.stringify(id)});
        return await until(() => ${until}, 8000);`
    );

// The live-run review's Agent surface findings (cdp-shots/review/live-run, F11-F15, F20, F21, F24-F26) on three
// held runs (live-run-fixture.mjs): no model starts. Each step reads the tree row, rail section or pane the finding
// was seen on, at the width it was broken at.
async function liveRunAgentSteps(h, ctx) {
    const steps = [];
    const rec = (step, ok, detail) => steps.push({ step, ok: !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
    if (ctx.liveError || !ctx.live) {
        rec("L0. the live-run fixture's three held runs", false, ctx.liveError ?? "not arranged: the tree-rail arrange failed first");
        return steps;
    }
    const { A, C } = ctx.live;
    await h.goto("agent");
    await setLiveRoster(h, ctx);
    const focused = await liveFocus(h, LIVE_IDS.leadA, `!!${LIVE_RAIL} && /review failed/.test(flat(${LIVE_RAIL}))`);
    await publishLiveEvents(h, ctx);
    const asks = await injectLiveAsks(h, ctx);
    await polishNap(800);
    rec("L0. lead A is focused with its rail's lanes", focused === true && asks === "ok", { focused, asks });
    await h.shot("cdp-shots/agent-tree-rail-live-lead.png");

    // F11: the run line counts what it shows; the done fold lists what was skipped
    const tree = await lookEval(h, `
        const text = flat(${LIVE_TREE});
        return { live: (text.match(/\\d+ live/) ?? [null])[0], workers: /\\d+ workers?\\b/.test(text), fold: /1 landed · 1 skipped/.test(text) };`);
    rec("L1. the run line says what is live, and the done fold names the skipped task (F11)", tree.live != null && !tree.workers && tree.fold, tree);

    // F12, F13: the lanes and the next step read in words
    const rail = await lookEval(h, `
        const text = flat(${LIVE_RAIL});
        return {
            words: ["review failed", "verify failed", "verifying"].filter((w) => text.includes(w)),
            raw: (text.match(/review-failed|verify-failed|sendback|fix-round|resolve-merge/g) ?? []),
        };`);
    rec("L2. the rail's lanes and next step use words, not engine ids (F12, F13)", rail.words.length === 3 && rail.raw.length === 0, rail);

    // F21: a lane's lead-ask keeps its time left whole, at both widths
    const leftWhole = () =>
        lookEval(h, `
            await until(() => ${LIVE_RAIL}?.querySelector("[data-lane-ask-left]"), 4000);
            const left = ${LIVE_RAIL}?.querySelector("[data-lane-ask-left]");
            return left ? { text: flat(left), clipped: left.scrollWidth > left.clientWidth + 1 } : { missing: true };`);
    const wide = await leftWhole();
    await h.cdp("Emulation.setDeviceMetricsOverride", LIVE_NARROW);
    await polishNap(800);
    await injectLiveAsks(h, ctx);
    const narrow = await leftWhole();
    await h.shot("cdp-shots/agent-tree-rail-live-lane-ask-1000.png");
    await h.cdp("Emulation.setDeviceMetricsOverride", OBS_WIDE);
    await polishNap(500);
    rec(
        "L3. the lead-ask's time left is not truncated, at 1600 or 1000 (F21)",
        /\dm/.test(wide.text ?? "") && !wide.clipped && /\dm/.test(narrow.text ?? "") && !narrow.clipped,
        { wide, narrow }
    );

    // F25: a failed Take over says why without "Error:", and its error goes with the ask
    await injectLiveAsks(h, ctx);
    const takeover = await lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const CA = await mod("app/view/agents/childaskstore.ts");
        const btn = button(${LIVE_RAIL}, /^Take over$/);
        if (!btn) return { error: "no Take over button" };
        btn.click();
        await until(() => !globalStore.get(CA.childAsksAtom)[${JSON.stringify(A.runId)}]?.some((a) => a.askid === "fx-live-ask-a3"), 6000);
        await nap(300);
        return { errors: globalStore.get(CA.childAskErrorAtom), errorShown: /Error:/.test(flat(${LIVE_RAIL})) };`);
    rec(
        "L4. Take over on a question the engine no longer holds leaves no raw error behind (F25)",
        takeover.error == null && !("fx-live-ask-a3" in (takeover.errors ?? {})) && !takeover.errorShown,
        takeover
    );

    // F24: the lead's header links to its run
    const link = await lookEval(h, `
        const a = document.querySelector("[data-header-run-link]");
        if (!a) return { error: "no run link in the lead's header" };
        const text = flat(a);
        a.click();
        const sheet = await until(() => !!document.querySelector("[data-run-sheet]"), 8000);
        return { text, sheet };`);
    rec("L5. the lead's header names its run as a link that opens the run (F24)", link.sheet === true && /orchestrator run [0-9a-f]{8}/.test(link.text ?? ""), link);
    await h.goto("agent");

    // F14: a failed Final reads failed, not verifying, on the tree and the rail
    const failedC = await liveFocus(h, LIVE_IDS.leadC, `/Final failed/.test(flat(${LIVE_RAIL}))`);
    const cText = await lookEval(h, `
        return { tree: /3\\/3 · final failed/.test(flat(${LIVE_TREE})), railVerifying: /\\bVerifying\\b/.test(flat(${LIVE_RAIL})) };`);
    await h.shot("cdp-shots/agent-tree-rail-live-final-failed.png");
    rec("L6. a run whose Final failed reads Final failed on its row and rail, not Verifying (F14)", failedC === true && cText.tree && !cText.railVerifying, { failedC, ...cText });

    // F15: an ended worker's banner names the branch the run lands on
    const ended = await liveFocus(h, `ended:${A.runId}:t-10`, `/session ended/.test(document.body.innerText)`);
    const banner = await lookEval(h, `
        const line = document.body.innerText.split("\\n").find((l) => /session ended/.test(l)) ?? "";
        return { line };`);
    const branch = `wave/${A.runId.slice(0, 8)}`;
    rec("L7. a landed task's ended worker names the run's landing branch, not main (F15)", ended === true && banner.line.includes(`landed on ${branch}`), { ended, ...banner, branch });

    // F26 and F20: the Final stage's rail Tree keeps its end; its pane fits at 1000x700
    const stage = await liveFocus(h, `final:${C.runId}`, `!!document.querySelector("[data-final-pane]") && !!document.querySelector("[data-final-rail]")`);
    const tree26 = await lookEval(h, `
        const fact = [...document.querySelectorAll("[data-final-rail] span[title]")].find((s) => /-final$/.test(s.title));
        return fact ? { dir: fact.getAttribute("dir"), text: flat(fact) } : { missing: true };`);
    rec("L8. the Final rail's Tree path clips its start, keeping its -final end (F26)", stage === true && tree26.dir === "rtl" && /-final$/.test(tree26.text ?? ""), { stage, ...tree26 });
    await h.cdp("Emulation.setDeviceMetricsOverride", LIVE_NARROW);
    await polishNap(800);
    const pane = await lookEval(h, `
        const steps = document.querySelector("[data-final-pane] [data-final-steps]");
        const head = document.querySelector("[data-final-headline]");
        const box = steps?.getBoundingClientRect();
        // a row clips when it or its head overflows, or its head's last part (facts, chevron) leaves the box
        const rows = [...(steps?.querySelectorAll("[data-final-step]") ?? [])].map((r) => {
            const hd = r.querySelector("[data-final-step-head]");
            const end = hd?.lastElementChild?.getBoundingClientRect();
            return Math.max(r.scrollWidth - r.clientWidth, hd ? hd.scrollWidth - hd.clientWidth : 0, end && box ? end.right - box.right : 0);
        });
        return {
            stepsOverflow: steps ? steps.scrollWidth - steps.clientWidth : null,
            cells: rows,
            headline: flat(head),
            headClipped: head ? head.scrollWidth > head.clientWidth + 1 : null,
        };`);
    await h.shot("cdp-shots/agent-tree-rail-live-final-1000.png");
    await h.cdp("Emulation.setDeviceMetricsOverride", OBS_WIDE);
    rec(
        "L9. at 1000x700 the Final pane's steps fit unclipped and its headline keeps its outcome (F20)",
        pane.stepsOverflow === 0 && pane.cells.length > 0 && pane.cells.every((d) => d <= 1) && /failed at Final/.test(pane.headline) && pane.headClipped === false,
        pane
    );
    return steps;
}

// The live-run review's phase 2 findings on the tree and the rail (P14, P17, P2, P18), on a fourth held run: run D
// has finished and landed, its plan review was accepted by the human after it failed, and only its lead is open.
// its block is a real shell tab made in arrange (ctx.landedLeadTerm)
const LANDED_LEAD = { id: "fx-tree-lead-d", name: "tree-rail lead D" };
const LANDED_TITLE = "verify tree-rail D: landed run";
const LANDED_TASKS = [
    { id: "t-1", label: "split the router" },
    { id: "t-2", label: "wire the router" },
];
const LANDED_COMMIT = "d29f0d2".padEnd(40, "0");
const LANDED_TASK_COMMIT = "a91c4f2".padEnd(40, "0");

async function arrangeLandedRun(h, ctx) {
    const now = Date.now();
    const D = await arrangeHeldRun(h, ctx, { key: "D", title: LANDED_TITLE, tasks: LANDED_TASKS });
    const t1 = await heldStandIn(h, D, "t-1");
    const t2 = await heldStandIn(h, D, "t-2");
    const rv = await heldStandIn(h, D, "plan reviewer");
    await seedHeldRun(
        h,
        D,
        {
            "t-1": { state: "done", merged: true, runid: t1, firstactivity: now - 30 * 60_000 },
            "t-2": { state: "done", merged: true, runid: t2, firstactivity: now - 20 * 60_000 },
        },
        { status: "done", planreview: { state: "accepted", round: 1, reviewers: [{ lens: "full", state: "failed", runid: rv }] } }
    );
    await fstWriteRun(h, D.runId, (r) => ({ ...r, basebranch: "main", land: { state: "landed", commit: LANDED_COMMIT } }));
    ctx.landed = D;
}

// the digest's report: a held run's stand-ins never commit and no question was ever handed over, so only the page
// can hold the landed commit and the count. The next digest load replaces it, so a step injects before it reads
const injectLandedReport = (h, ctx) =>
    lookEval(
        h,
        `const { globalStore } = await mod("app/store/jotaiStore.ts");
        const L = await mod("app/view/agents/runlineagestore.ts");
        const id = ${JSON.stringify(ctx.landed.runId)};
        if (!(await until(() => globalStore.get(L.runDigestsAtom)[id], 15000))) return "no digest for run D";
        globalStore.set(L.runDigestsAtom, (prev) => ({ ...prev, [id]: { ...prev[id], health: "done",
            report: { ...prev[id].report, commits: [{ taskid: "t-1", commit: ${JSON.stringify(LANDED_TASK_COMMIT)} }], answered: 1, forwarded: 1 } } }));
        return "ok";`
    );

// P14b's rows, title then second line, in the order the done fold lists them: round 1's reviewers in dag order (both
// failed), then round 2's. The round is on the second line: the title truncates before it at the tree's width
const PLAN_REVIEW_ROUND_ROWS = [
    ["Plan review · Full review", "failed · round 1"],
    ["Plan review · Second pass", "failed · round 1"],
    ["Plan review · Round-2 follow-up", "passed · round 2"],
];

// seeds run D's plan review with a round 1 of two ended reviewers and a passed round 2, reads its reviewer rows in
// the open done fold and shoots them, then restores the accepted one-round review P14 reads
async function planReviewRoundsStep(h, D) {
    const rv = D.children["plan reviewer"];
    const restore = { state: "accepted", round: 1, reviewers: [{ lens: "full", state: "failed", runid: rv }] };
    const out = {};
    try {
        const full = await heldStandIn(h, D, "round-1 full reviewer");
        const second = await heldStandIn(h, D, "round-1 second reviewer");
        await seedHeldRun(h, D, {}, {
            planreview: {
                state: "passed",
                round: 2,
                reviewers: [{ lens: "followup", state: "passed", runid: rv }],
                pastrounds: [
                    {
                        round: 1,
                        reviewers: [
                            { lens: "full", state: "failed", runid: full },
                            { lens: "second", state: "failed", runid: second },
                        ],
                    },
                ],
            },
        });
        Object.assign(out, await lookEval(h, `
            const L = await mod("app/view/agents/runlineagestore.ts");
            L.toggleRunDoneOpen(${JSON.stringify(D.runId)}, false, ${LANDED_TASKS.length});
            const sel = ${JSON.stringify(`[data-tree-stage="plan-reviewer"][data-tree-agent^="ended:${D.runId}:review:"]`)};
            const rows = () => [...(${LIVE_TREE}?.querySelectorAll(sel) ?? [])];
            await until(() => rows().length === 3 && /round 2/.test(flat(rows()[2])), 8000);
            // the new rows slide in over the old one, so the read and the shot wait for the tree to stop moving
            ${SETTLE_TREE_ROWS}
            const { settled, rows: treeRowRects } = await settleTreeRows();
            const lines = (r) => [...r.querySelectorAll("div.truncate")];
            return {
                settled,
                treeRowRects,
                rows: rows().map((r) => lines(r).map(flat)),
                // a second line wider than its box is clipped, so its round would not be seen; a long title may clip
                clipped: rows().filter((r) => { const sub = lines(r)[1]; return !sub || sub.scrollWidth > sub.clientWidth + 1; }).length,
                fold: [...(${LIVE_TREE}?.querySelectorAll("div.cursor-pointer") ?? [])].map(flat).find((t) => /^2 landed · \\d+ plan reviews?$/.test(t)) ?? null,
            };`));
        // the shot is of the two rounds, so it is taken before the restore
        await h.shot("cdp-shots/agent-tree-rail-p14b-rounds.png");
    } catch (e) {
        out.error = String(e?.message ?? e);
    } finally {
        try {
            await seedHeldRun(h, D, {}, { planreview: restore });
            out.restored = await lookEval(h, `
                const sel = ${JSON.stringify(`[data-tree-stage="plan-reviewer"][data-tree-agent^="ended:${D.runId}:review:"]`)};
                return await until(() => (${LIVE_TREE}?.querySelectorAll(sel) ?? []).length === 1 && !/round/.test(flat(${LIVE_TREE}?.querySelector(sel))), 8000);`);
        } catch (e) {
            out.restoreError = String(e?.message ?? e);
        }
    }
    return out;
}

async function landedRunSteps(h, ctx) {
    const steps = [];
    const rec = (step, ok, detail) => steps.push({ step, ok: !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
    if (ctx.landedError || !ctx.landed) {
        rec("P0. run D, finished and landed with an accepted plan review", false, ctx.landedError ?? "not arranged: an earlier arrange failed first");
        return steps;
    }
    const D = ctx.landed;
    await h.cdp("Emulation.setDeviceMetricsOverride", OBS_WIDE);
    await h.goto("agent");
    await setPageRoster(h, [
        ...liveRoster(ctx),
        { ...LANDED_LEAD, blockId: ctx.landedLeadTerm?.blockId, project: "verify-live-run", agent: "claude", model: "opus", task: "lead run D", state: "idle", idleSince: Date.now() - 5 * 60_000, runId: D.runId },
    ]);
    const focused = await liveFocus(h, LANDED_LEAD.id, `!!${LIVE_RAIL} && flat(document.querySelector("[data-agent-header]")).includes(${JSON.stringify(LANDED_TITLE)})`);
    const injected = await injectLandedReport(h, ctx);
    // read before the P12 shot, so the shot shows the lead's shell once it runs
    const landedBlock = await leadBlockCheck(h, ctx.landedLeadTerm, LANDED_LEAD.id);

    // P12: the lead stands for its run, so the tree's row and the header name it by the plan's title, not the tab's
    const named = await lookEval(h, `
        const row = ${LIVE_TREE}?.querySelector(${JSON.stringify(`[data-tree-agent="${LANDED_LEAD.id}"]`)});
        const header = document.querySelector("[data-agent-header]");
        return { row: flat(row), header: flat(header) };`);
    await h.shot("cdp-shots/agent-tree-rail-p12-run-name.png");
    rec(
        "P12. the tree's lead row and the agent header name the run by its plan title, not the lead's tab name (D12)",
        named.row.includes(LANDED_TITLE) &&
            named.header.includes(LANDED_TITLE) &&
            !named.row.includes(LANDED_LEAD.name) &&
            !named.header.includes(LANDED_LEAD.name),
        { focused, ...named }
    );
    rec("P12b. lead D's tab is a real running block: its tree row and header show no error text (F5)", landedBlock.ok, landedBlock.detail);

    // P14: the accepted plan review's row, in run D's done fold
    const accepted = await lookEval(h, `
        const L = await mod("app/view/agents/runlineagestore.ts");
        L.toggleRunDoneOpen(${JSON.stringify(D.runId)}, false, ${LANDED_TASKS.length});
        await until(() => ${LIVE_TREE}?.querySelector('[data-tree-stage="plan-reviewer"]'), 8000);
        const row = ${LIVE_TREE}?.querySelector('[data-tree-stage="plan-reviewer"]');
        if (!row) return { missing: true };
        const dot = row.querySelector("span.rounded-full");
        return {
            text: flat(row),
            dot: dot ? getComputedStyle(dot).backgroundColor : null,
            muted: getComputedStyle(document.documentElement).getPropertyValue("--color-muted").trim(),
            // the fold row's label is its own text; flat() of the whole tree runs it into the next row's title
            fold: [...(${LIVE_TREE}?.querySelectorAll("div.cursor-pointer") ?? [])].map(flat).find((t) => /^2 landed · 1 plan review$/.test(t)) ?? null,
        };`);
    const mutedRgb = (hex) => (/^#[0-9a-f]{6}$/i.test(hex ?? "") ? `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})` : hex);
    await h.shot("cdp-shots/agent-tree-rail-p14-accepted.png");
    rec(
        "P14. an accepted plan review's row reads \"accepted by you\" with a muted dot, not failed, and the fold says plan review (D14)",
        /accepted by you/.test(accepted.text ?? "") && !/failed/.test(accepted.text ?? "") && accepted.dot === mutedRgb(accepted.muted) && accepted.fold != null,
        { focused, injected, ...accepted }
    );

    // P14b: a plan review with an earlier round lists every round's reviewers, oldest round first, labelled by round
    const { treeRowRects, ...rounds } = await planReviewRoundsStep(h, D);
    rounds.overlaps = rowOverlaps(treeRowRects ?? []);
    rec(
        "P14b. a two-round plan review lists round 1's two reviewers, then round 2's, each labelled with its round (F2)",
        JSON.stringify(rounds.rows) === JSON.stringify(PLAN_REVIEW_ROUND_ROWS) &&
            rounds.clipped === 0 &&
            rounds.settled === true &&
            rounds.overlaps.length === 0 &&
            rounds.fold === "2 landed · 3 plan reviews" &&
            rounds.restored === true,
        rounds
    );

    // P17: the landed lead's rail reads its run's landing, not its removed worktree
    await injectLandedReport(h, ctx);
    const landedRail = await lookEval(h, `
        await until(() => ${LIVE_RAIL}?.querySelector("[data-rail-landed]"), 8000);
        const files = ${LIVE_RAIL}?.querySelector("[data-rail-landed]");
        const text = flat(${LIVE_RAIL});
        return {
            branch: (text.match(/landed on main · [0-9a-f]{7}/) ?? [null])[0],
            // one line per child: the note, then each commit's sha and subject
            lines: [...(files?.children ?? [])].map((c) => (c.children.length ? [...c.children].map(flat).join(" ") : flat(c))),
            notRepo: /Not a git repository/.test(text),
        };`);
    await h.shot("cdp-shots/agent-tree-rail-p17-landed-lead.png");
    rec(
        "P17. a landed lead's rail reads \"worktree removed after landing\" and lists a landed commit (D17)",
        landedRail.branch === `landed on main · ${LANDED_COMMIT.slice(0, 7)}` &&
            landedRail.lines?.[0] === "worktree removed after landing" &&
            landedRail.lines.includes(`${LANDED_TASK_COMMIT.slice(0, 7)} split the router`) &&
            !landedRail.notRepo,
        landedRail
    );

    // P2: a forward or a take-over reads as handed to the human
    await injectLandedReport(h, ctx);
    const handed = await lookEval(h, `
        await until(() => /Handed to you/.test(flat(${LIVE_RAIL})), 8000);
        const text = flat(${LIVE_RAIL});
        return { handed: /Handed to you\\s*1/.test(text), forwarded: /Forwarded/.test(text) };`);
    rec("P2. the run rail's fact row reads \"Handed to you\", not \"Forwarded\" (D2)", handed.handed && !handed.forwarded, handed);

    // P18: the header's Close on the finished run's only tab says it closes the run; the dialog is cancelled
    const close = await lookEval(h, `
        const btn = [...(document.querySelector("[data-agent-header]")?.querySelectorAll("button") ?? [])].find((b) => /^Close agent/.test(b.title));
        if (!btn) return { error: "no Close button in the lead's header" };
        btn.click();
        await until(() => /Close run/.test(flat(dialog())), 4000);
        const d = dialog();
        const out = { title: flat(d?.querySelector("h2")), body: flat(d), confirm: !!button(d, /^Close run/) };
        button(d, /^Cancel/)?.click();
        out.closed = await until(() => !/Close run/.test(flat(dialog())), 4000);
        return out;`);
    await h.shot("cdp-shots/agent-tree-rail-p18-close-run.png");
    rec(
        "P18. the header Close on a finished run's last lead tab opens a \"Close run\" dialog, then Cancel closes it (D18)",
        close.title === "Close run" &&
            // the run's title is whatever name the run goes by; the rest is the spec's copy
            /"[^"]+" has finished and its lead is its last open session\. Close it\? This can't be undone\./.test(close.body ?? "") &&
            close.confirm &&
            close.closed,
        close
    );
    return steps;
}

// Phase 3's tree and rail fixes on run A (D18, D6). A failed task that never had a session is seeded on t-14 (queued,
// no stand-in) for the click, and put back after; the held merge gate is a page-only digest injection on t-10, the
// only done task and alone in its lane, held by t-8 (verifying). The next digest load replaces the injection, so the
// step injects right before it reads.
const GATE_TIP = "t-10";
const GATE_HOLDER = "t-8";
const GATE_LINE = `merge ready · waits on ${GATE_HOLDER}'s Verify`;
const NO_SESSION_TASK = "t-14";
// the gate's lane keeps room to name its task: "t-10 · s…" at the least
const LANE_NAME_MIN_PX = 60;
const taskLabel = (id) => LIVE_TASKS_A.find((t) => t.id === id).label;

// a tree row by its title, as the tree draws it; its first rounded span is the row's dot
const TREE_ROW_LIB = `
    const treeRow = (label) => {
        const name = [...(${LIVE_TREE}?.querySelectorAll("div") ?? [])].find((d) => d.textContent.trim() === label && d.children.length === 0);
        return name ? name.closest(".relative") : null;
    };
    const tokenColor = (prop) => {
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(" + prop + ")";
        document.body.appendChild(probe);
        const c = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return c;
    };
    const dotOf = (row) => row?.querySelector("span.rounded-full") ?? null;`;

const injectGateHeld = (h, ctx) =>
    lookEval(
        h,
        `const { globalStore } = await mod("app/store/jotaiStore.ts");
        const L = await mod("app/view/agents/runlineagestore.ts");
        const id = ${JSON.stringify(ctx.live.A.runId)};
        if (!(await until(() => globalStore.get(L.runDigestsAtom)[id], 15000))) return "no digest for run A";
        const d = globalStore.get(L.runDigestsAtom)[id];
        const tip = (d.tasks ?? []).find((t) => t.taskid === ${JSON.stringify(GATE_TIP)});
        if (!tip) return "no digest task " + ${JSON.stringify(GATE_TIP)};
        window.__treeRailGatePrev ??= { mergestate: tip.mergestate, mergeheldby: tip.mergeheldby };
        const tasks = d.tasks.map((t) => (t === tip ? { ...t, mergestate: "held", mergeheldby: ${JSON.stringify(GATE_HOLDER)} } : t));
        globalStore.set(L.runDigestsAtom, (prev) => ({ ...prev, [id]: { ...d, tasks } }));
        return "ok";`
    );

// puts t-10's digest entry back as the step found it; a later digest load would too
const restoreGate = (h, ctx) =>
    lookEval(
        h,
        `const { globalStore } = await mod("app/store/jotaiStore.ts");
        const L = await mod("app/view/agents/runlineagestore.ts");
        const id = ${JSON.stringify(ctx.live.A.runId)};
        const prev = window.__treeRailGatePrev;
        delete window.__treeRailGatePrev;
        const d = globalStore.get(L.runDigestsAtom)[id];
        if (!prev || !d) return "nothing to restore";
        const tasks = d.tasks.map((t) => (t.taskid === ${JSON.stringify(GATE_TIP)} ? { ...t, ...prev } : t));
        globalStore.set(L.runDigestsAtom, (all) => ({ ...all, [id]: { ...d, tasks } }));
        return "ok";`
    );

const seedNoSessionFailed = (h, ctx, on) =>
    seedHeldRun(h, ctx.live.A, { [NO_SESSION_TASK]: { state: on ? "failed" : "pending" } });

async function treeGateToneSteps(h, ctx) {
    const steps = [];
    const rec = (step, ok, detail) => steps.push({ step, ok: !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
    if (ctx.liveError || !ctx.live) {
        rec("9d. run A's failed rows", false, ctx.liveError ?? "not arranged: the tree-rail arrange failed first");
        return steps;
    }
    await h.cdp("Emulation.setDeviceMetricsOverride", OBS_WIDE);
    await h.goto("agent");
    await setLiveRoster(h, ctx);
    await liveFocus(h, LIVE_IDS.leadA, `!!${LIVE_RAIL} && /review failed/.test(flat(${LIVE_RAIL}))`);
    try {
        await seedNoSessionFailed(h, ctx, true);
        ctx.seededNoSession = true;
    } catch (e) {
        ctx.seedError = String(e?.message ?? e);
    }

    // D18: t-5 (failed) and t-7 (verify failed) draw the error dot; a failed row with no session opens the DAG at it
    const failedRows = async () => {
        const read = await lookEval(h, `${TREE_ROW_LIB}
            await until(() => treeRow(${JSON.stringify(taskLabel(NO_SESSION_TASK))}), 10000);
            const error = tokenColor("--color-error");
            const tone = (label) => {
                const row = treeRow(label);
                const sub = row?.querySelector("span.truncate.font-mono");
                return row ? { dot: getComputedStyle(dotOf(row)).backgroundColor, sub: sub ? getComputedStyle(sub).color : null } : null;
            };
            return {
                error,
                t5: tone(${JSON.stringify(taskLabel("t-5"))}),
                t7: tone(${JSON.stringify(taskLabel("t-7"))}),
                noSession: tone(${JSON.stringify(taskLabel(NO_SESSION_TASK))}),
            };`);
        const click = await lookEval(h, `${TREE_ROW_LIB}
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const S = await mod("app/view/orchestrate/dagstore.ts");
            const M = await mod("app/view/orchestrate/dagmodalstate.ts");
            const row = treeRow(${JSON.stringify(taskLabel(NO_SESSION_TASK))});
            if (!row) return { error: "no row for ${NO_SESSION_TASK}" };
            row.click();
            const modal = await until(() => !!document.querySelector("[data-dag-modal-kind]"), 8000);
            const selected = globalStore.get(S.selectedTaskIdAtom);
            M.closeDagModal();
            await until(() => !document.querySelector("[data-dag-modal-kind]"), 4000);
            return { modal, selected };`);
        await h.goto("agent");
        return { ...read, click };
    };
    const failedOk = (r) =>
        r.t5?.dot === r.error &&
        r.t7?.dot === r.error &&
        r.t5?.sub === r.error &&
        r.noSession?.dot === r.error &&
        r.click?.modal === true &&
        r.click?.selected === NO_SESSION_TASK;
    const wide = ctx.seededNoSession ? await failedRows() : { seedError: ctx.seedError };
    await h.shot("cdp-shots/agent-tree-rail-p3-failed-rows.png");
    rec("9d. at 1600, t-5 and t-7 draw the error dot, and a failed row with no session opens the DAG modal at it (D18)", failedOk(wide), wide);
    await h.cdp("Emulation.setDeviceMetricsOverride", LIVE_NARROW);
    await polishNap(800);
    const narrow = ctx.seededNoSession ? await failedRows() : { seedError: ctx.seedError };
    await h.shot("cdp-shots/agent-tree-rail-p3-failed-rows-1000.png");
    await h.cdp("Emulation.setDeviceMetricsOverride", OBS_WIDE);
    await polishNap(500);
    rec("9e. at 1000x700, the same: error dots, and the no-session row opens the DAG modal at it (D18)", failedOk(narrow), narrow);
    if (ctx.seededNoSession) {
        await seedNoSessionFailed(h, ctx, false);
        ctx.seededNoSession = false;
    }

    // D6: a held tip stays out of the done fold with the gate's line, and its rail lane says the same
    await liveFocus(h, LIVE_IDS.leadA, `!!${LIVE_RAIL} && /review failed/.test(flat(${LIVE_RAIL}))`);
    const injected = await injectGateHeld(h, ctx);
    const gate = await lookEval(h, `${TREE_ROW_LIB}
        const label = ${JSON.stringify(taskLabel(GATE_TIP))};
        await until(() => /merge ready/.test(flat(treeRow(label))), 6000);
        // the row slides out of the fold: let it land before reading where it sits
        await nap(1200);
        const row = treeRow(label);
        const fold = [...(${LIVE_TREE}?.querySelectorAll("div.cursor-pointer") ?? [])].find((d) => /^(\\d+ landed · )?\\d+ skipped$/.test(flat(d)));
        const laneName = [...(${LIVE_RAIL}?.querySelectorAll("div") ?? [])].find((d) => d.textContent.trim() === ${JSON.stringify(`${GATE_TIP} · ${taskLabel(GATE_TIP)}`)} && d.children.length === 0);
        const laneText = laneName?.closest(".grid")?.querySelector("[data-lane-text]");
        const dot = dotOf(row);
        // the tree's rows are siblings' children: the row after this one must start below it
        const next = row?.parentElement?.nextElementSibling;
        return {
            row: flat(row),
            fold: fold ? flat(fold) : null,
            afterFold: !!(row && fold && fold.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING),
            waitDot: dot ? getComputedStyle(dot).backgroundColor === "rgba(0, 0, 0, 0)" && dot.className.includes("border") : false,
            overlap: row && next ? Math.round(row.getBoundingClientRect().bottom - next.getBoundingClientRect().top) : null,
            lane: flat(laneName?.closest(".grid")),
            laneNameWidth: laneName ? laneName.clientWidth : 0,
            laneTextClipped: laneText ? laneText.scrollWidth > laneText.clientWidth + 1 : null,
        };`);
    await h.shot("cdp-shots/agent-tree-rail-p3-merge-gate.png");
    await restoreGate(h, ctx);
    rec(
        `9f. at 1600, a held tip stays out of the done fold, reads "${GATE_LINE}" with a wait dot, and its rail lane says the same (D6)`,
        injected === "ok" &&
            gate.row.includes(GATE_LINE) &&
            gate.fold === "1 skipped" &&
            gate.afterFold &&
            gate.waitDot &&
            gate.overlap != null &&
            gate.overlap <= 0 &&
            gate.lane.includes(GATE_LINE) &&
            gate.laneNameWidth >= LANE_NAME_MIN_PX &&
            gate.laneTextClipped === false,
        { injected, ...gate }
    );
    return steps;
}

// step 9b's shot waits, at most TREE_SETTLE_WAIT_MS, for two samples of the tree rows this far apart to match
const TREE_SETTLE_GAP_MS = 150;
const TREE_SETTLE_WAIT_MS = 3000;
// subpixel rounding can make adjacent rows share a fraction of a pixel
const ROW_OVERLAP_TOLERANCE_PX = 1;

// page code: settleTreeRows() waits, at most TREE_SETTLE_WAIT_MS, for the tree's rows to stop moving and returns
// whether they did with the last sample of them
const SETTLE_TREE_ROWS = `
    const treeRows = () =>
        [...(document.querySelector("[data-agent-tree] .overflow-y-auto")?.children ?? [])].map((r) => {
            const b = r.getBoundingClientRect();
            return { row: flat(r).slice(0, 24), top: Math.round(b.top * 10) / 10, bottom: Math.round(b.bottom * 10) / 10 };
        });
    const settleTreeRows = async () => {
        let prev = treeRows();
        let settled = false;
        for (const t0 = Date.now(); !settled && Date.now() - t0 < ${TREE_SETTLE_WAIT_MS}; ) {
            await nap(${TREE_SETTLE_GAP_MS});
            const cur = treeRows();
            settled = JSON.stringify(cur) === JSON.stringify(prev);
            prev = cur;
        }
        return { settled, rows: prev };
    };`;

// every pair of tree rows ({ row, top, bottom }, as settleTreeRows samples them) that overlap past the tolerance
function rowOverlaps(rows) {
    const overlaps = [];
    for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
            const a = rows[i];
            const b = rows[j];
            const depth = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (depth > ROW_OVERLAP_TOLERANCE_PX) overlaps.push({ a: a.row, b: b.row, depth: Math.round(depth * 10) / 10 });
        }
    }
    return overlaps;
}

export const agentTreeRail = {
    name: "agent-tree-rail",
    surface: "agent",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-tree-rail-"));
        const ctx = { cwd, prevRail: await h.ev(`localStorage.getItem(${JSON.stringify(RAIL_VISIBLE_KEY)})`) };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            await arrangeTreeRail(h, ctx);
            // the rail under test shows in the Terminal view; the Rendered view has the workspace pane in its place; pinned after arrangeTreeRail's reload, which would drop the pin's saved value
            await pinDefaultView(h, "terminal");
            // the block of the worker tab step 9b adds: a real shell, so its header reads as a running worker
            try {
                ctx.workerTerm = {};
                await openCanvasTerminal(h, ctx.workerTerm, TREE_WORKER_TOPIC);
            } catch (e) {
                ctx.workerTermError = String(e?.message ?? e);
            }
            // the live-run states: three runs held in unborn repos, which no tick can start
            try {
                await arrangeLiveRuns(h, ctx);
            } catch (e) {
                ctx.liveError = String(e?.message ?? e);
            }
            // the block of run D's lead, which P12b reads
            ctx.landedLeadTerm = await openAgentTerm(h, LANDED_LEAD_TOPIC);
            // a fourth held run, finished and landed; in ctx.held, so teardownLiveRuns removes it with the others
            try {
                await arrangeLandedRun(h, ctx);
            } catch (e) {
                ctx.landedError = String(e?.message ?? e);
            }
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const RAIL = `document.querySelector('aside[aria-label="Agent details"]')`;
        const TREE = `document.querySelector("[data-agent-tree]")`;
        const HEADER = `document.querySelector("[data-agent-header]")`;
        rec(
            "0. the lead row nested under its run and was focused, and t-1 dispatched",
            ctx.arrangeError == null && ctx.leadFocused === true && ctx.dispatched === true,
            ctx.arrangeError ?? JSON.stringify({ runId: ctx.runId, dispatched: ctx.dispatched, dispatchMs: ctx.dispatchMs })
        );

        const badges = await h.ev(`(() => {
            const tree = ${TREE};
            if (!tree) return null;
            return [...tree.querySelectorAll("span")]
                .map((s) => s.textContent.trim())
                .filter((t) => /^\\d+ asking$/.test(t));
        })()`);
        rec(
            "1. each live project's group carries an asking badge",
            Array.isArray(badges) && badges.filter((t) => t === "1 asking").length === 2,
            `badges=${JSON.stringify(badges)}`
        );

        const glyphs = await h.ev(`(() => {
            const glyphs = ${JSON.stringify(TREE_RAIL_GLYPHS)};
            const hits = [];
            for (const root of [${TREE}, ${RAIL}, ${HEADER}]) {
                if (!root) continue;
                const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
                for (let n = walk.nextNode(); n; n = walk.nextNode()) {
                    if (glyphs.some((g) => n.data.includes(g))) hits.push(n.data.trim());
                }
            }
            return { tree: !!${TREE}, rail: !!${RAIL}, header: !!${HEADER}, hits };
        })()`);
        rec(
            "2. no text glyph survives in the tree, the rail or the focused lead's header",
            glyphs.tree && glyphs.rail && glyphs.header && glyphs.hits.length === 0,
            JSON.stringify(glyphs)
        );

        const mark = await h.ev(`(() => {
            const tree = ${TREE};
            const name = tree && [...tree.querySelectorAll("div")].find(
                (d) => d.textContent.trim() === ${JSON.stringify(TREE_RAIL_TITLE)} && d.children.length === 0
            );
            const row = name && name.closest(".cursor-pointer");
            const slot = row && row.firstElementChild;
            const first = slot && slot.firstElementChild;
            return {
                tag: first ? first.tagName.toLowerCase() : null,
                slotWidth: slot ? getComputedStyle(slot).width : null,
            };
        })()`);
        rec(
            "3. the lead row's mark is an svg in the 14px leading column",
            mark.tag === "svg" && mark.slotWidth === "14px",
            JSON.stringify(mark)
        );

        const labels = await h.ev(`(() => {
            const rail = ${RAIL};
            if (!rail) return null;
            const out = {};
            for (const h3 of rail.querySelectorAll("h3")) {
                const t = h3.textContent.trim();
                if (t === "Details" || t === "Run") {
                    const cs = getComputedStyle(h3);
                    out[t] = { size: cs.fontSize, weight: cs.fontWeight };
                }
            }
            return out;
        })()`);
        const onScale = (l) => l != null && l.size === `${MIN_FONT_PX}px` && l.weight === "700";
        rec(
            "4. the rail's Details and Run headings are 10.5px bold",
            labels != null && onScale(labels.Details) && onScale(labels.Run),
            JSON.stringify(labels)
        );

        steps.push(await floorStep(h, "5. no visible text in the tree or the rail is under 10.5px", TREE, RAIL));

        const collapse = await h.ev(`(() => {
            const b = ${RAIL}?.querySelector('[aria-label="Collapse panel"]');
            return b ? !!b.querySelector("svg") : null;
        })()`);
        rec("6. the rail's collapse control is an icon", collapse === true, `svg=${collapse}`);

        // the rows the sweeps above only cover when they render: a nested row's guide is a 1px line in its first column
        const nested = await h.ev(`(() => {
            const tree = ${TREE};
            if (!tree) return null;
            const rowOf = (text) => {
                const name = [...tree.querySelectorAll("div")].find(
                    (d) => d.textContent.trim() === text && d.children.length === 0
                );
                return name ? name.closest(".relative") : null;
            };
            const guides = (row) =>
                row ? [...row.children].filter((c) => c.tagName === "SPAN" && getComputedStyle(c).width === "1px").length : 0;
            const lead = rowOf(${JSON.stringify(TREE_RAIL_TITLE)});
            const worker = rowOf(${JSON.stringify(RUN_SHEET_POLISH_TASKS[0].label)});
            const sub = rowOf(${JSON.stringify(TREE_RAIL_SUBAGENT_PROMPT)});
            return {
                strip: lead?.querySelector("[role=img]")?.getAttribute("aria-label") ?? null,
                workersChip: lead?.querySelector('button[aria-label="Hide workers"]')?.textContent.trim() ?? null,
                progress: (() => {
                    const s = lead?.querySelector("span.truncate.text-muted");
                    return s ? { text: s.textContent.trim(), clipped: s.scrollWidth > s.clientWidth } : null;
                })(),
                worker: !!worker,
                workerGuides: guides(worker),
                sub: !!sub,
                subGuides: guides(sub),
            };
        })()`);
        rec(
            "7. the lead's run line carries its workers chip, unclipped progress and the task strip",
            nested != null &&
                /^\d+ of 3 tasks done/.test(nested.strip ?? "") &&
                / live$/.test(nested.workersChip ?? "") &&
                nested.progress != null &&
                !nested.progress.clipped,
            JSON.stringify(nested)
        );
        rec(
            "8. t-1's worker row sits under the lead with one guide line",
            nested != null && nested.worker && nested.workerGuides === 1,
            JSON.stringify(nested)
        );
        rec(
            "9. the lead's working subagent is listed under it with one guide line",
            nested != null && nested.sub && nested.subGuides === 1,
            JSON.stringify(nested)
        );

        // read while arrange's focus is still on the lead
        const leadBlock = await leadBlockCheck(h, ctx.leadTerm, TREE_RAIL_LEAD_ID);
        rec("9a. the tree-rail lead's tab is a real running block: its tree row and header show no error text (F5)", leadBlock.ok, JSON.stringify(leadBlock.detail));

        // P12: a worker's header names its lead by the run's plan title, not the lead's tab name
        // the boot roster has no tab for t-1's worker, so one is added in the page for this step and removed after
        await h.cdp("Emulation.setDeviceMetricsOverride", OBS_WIDE);
        const t1Run = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group?.tasks?.find((t) => t.id === "t-1")?.runid;
        const workerBlockId = ctx.workerTerm?.blockId;
        const workerTab = { id: "fx-tree-worker-t1", name: TREE_WORKER_NAME, project: "waveterm", agent: "claude", model: "sonnet", task: "noop", state: "working", runId: t1Run, blockId: workerBlockId };
        const toLead = t1Run == null ? { error: "t-1 has no worker run" } : await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const D = await mod("app/view/agents/devmock.ts");
            const model = ${LIVE_MODEL};
            window.__treeRailPrevFocus = globalStore.get(model.focusIdAtom);
            // every frame from the inject on: where the tab renders. It is out of place in a row of its own or nested
            // (both carry its name, a top-level row its id too), placed once the selected row is t-1's worker row
            const frames = [];
            let sampling = true;
            const sampleFrame = () => {
                const rows = [...(document.querySelector("[data-agent-tree] .overflow-y-auto")?.children ?? [])];
                const stray = rows
                    .filter((r) => r.querySelector('[data-tree-agent="${workerTab.id}"]') || flat(r).includes(${JSON.stringify(TREE_WORKER_NAME)}))
                    .map((r) => flat(r).slice(0, 40));
                const selected = rows.find((r) => r.querySelector(".bg-accentbg"));
                frames.push({ stray, placed: selected != null && flat(selected).includes("t-1 ·") });
                if (sampling) requestAnimationFrame(sampleFrame);
            };
            requestAnimationFrame(sampleFrame);
            globalStore.set(D.devMockAgentsAtom, (cur) => [...(cur ?? []), ${JSON.stringify(workerTab)}]);
            globalStore.set(model.focusIdAtom, ${JSON.stringify(workerTab.id)});
            const btn = () => ${HEADER}?.querySelector('button[title="Go to the lead"]');
            await until(() => btn(), 8000);
            // the rail's Task section names the lead the same way
            const railLead = () => [...(${LIVE_RAIL}?.querySelectorAll("span") ?? [])].find((s) => s.textContent.trim() === "Lead")?.nextElementSibling;
            await until(() => railLead(), 8000);
            // the tab takes t-1's worker row while the row it replaces fades out, so the shot waits for the rows
            // to stop
            ${SETTLE_TREE_ROWS}
            const { settled, rows } = await settleTreeRows();
            sampling = false;
            const strayFrames = frames.filter((f) => f.stray.length > 0);
            return {
                text: flat(btn()),
                railLead: flat(railLead()),
                settled,
                rows,
                frames: frames.length,
                strayFrames: strayFrames.length,
                firstStray: strayFrames[0]?.stray ?? null,
                placed: frames.at(-1)?.placed === true,
            };`);
        const workerStatus = await waitShellRunning(h, workerBlockId);
        const workerText = await h.ev(`({ header: ${flatText(HEADER)}, rail: ${flatText(LIVE_RAIL)} })`);
        await h.shot("cdp-shots/agent-tree-rail-p12-worker-header.png");
        if (t1Run != null) {
            await lookEval(h, `
                const { globalStore } = await mod("app/store/jotaiStore.ts");
                const D = await mod("app/view/agents/devmock.ts");
                globalStore.set(D.devMockAgentsAtom, (cur) => (cur ?? []).filter((a) => a.id !== ${JSON.stringify(workerTab.id)}));
                globalStore.set(${LIVE_MODEL}.focusIdAtom, window.__treeRailPrevFocus);
                delete window.__treeRailPrevFocus;
                return true;`);
        }
        rec(
            "9b. t-1's worker header's Go to the lead and its rail's Lead row read the run's plan title, not the lead's tab name (D12)",
            toLead.settled === true &&
                toLead.text === `↑ ${TREE_RAIL_TITLE}` &&
                !toLead.text.includes(TREE_RAIL_LEAD) &&
                toLead.railLead === TREE_RAIL_TITLE &&
                !toLead.railLead.includes(TREE_RAIL_LEAD),
            JSON.stringify({ ...toLead, rows: undefined })
        );
        const treeRows = toLead.rows ?? [];
        const overlaps = rowOverlaps(treeRows);
        rec(
            "9c. from the inject on, t-1's worker tab renders in no frame anywhere but t-1's worker row, and the settled tree has no overlapping rows (F3)",
            toLead.settled === true &&
                toLead.frames > 0 &&
                toLead.strayFrames === 0 &&
                toLead.placed === true &&
                treeRows.length > 0 &&
                overlaps.length === 0,
            JSON.stringify({
                frames: toLead.frames,
                strayFrames: toLead.strayFrames,
                firstStray: toLead.firstStray,
                placed: toLead.placed,
                settled: toLead.settled,
                overlaps,
                rows: treeRows,
            })
        );
        const workerError = [workerText.header, workerText.rail].map((t) => t.match(BLOCK_ERROR_RE)?.[0]).filter(Boolean);
        rec(
            "9c2. t-1's worker tab is a real running block: its header and rail show no error text (F5)",
            ctx.workerTermError == null &&
                workerStatus === "running" &&
                workerText.header !== "" &&
                workerText.rail !== "" &&
                workerError.length === 0,
            JSON.stringify({ error: ctx.workerTermError, blockId: workerBlockId, status: workerStatus, workerError, header: workerText.header })
        );

        // the avatar at bottom-left sits over the foot of the tree: scrolled to its end, the last row clears it
        ctx.prevCorner = await h.ev(`localStorage.getItem("wave:pet.corner")`);
        const foot = await lookEval(h, `
            const { setPetCorner } = await mod("app/view/jarvis/petstore.ts");
            setPetCorner("bottom-left");
            const avatar = () => document.querySelector('[aria-label="Jarvis condition"]');
            const list = () => document.querySelector("[data-agent-tree] .overflow-y-auto");
            await until(() => (avatar()?.getBoundingClientRect().left ?? 9999) < 330);
            const l = list();
            if (!l || l.lastElementChild == null) return { list: false };
            l.scrollTop = l.scrollHeight;
            await nap(300);
            const last = l.lastElementChild.getBoundingClientRect();
            const a = avatar().getBoundingClientRect();
            const hit = last.left < a.right && last.right > a.left && last.top < a.bottom && last.bottom > a.top;
            // also check the room the list keeps below its last row
            const room = l.getBoundingClientRect().bottom - parseFloat(getComputedStyle(l).paddingBottom);
            return {
                list: true,
                scrollable: l.scrollHeight > l.clientHeight,
                roomEnds: Math.round(room),
                lastBottom: Math.round(last.bottom),
                avatarTop: Math.round(a.top),
                avatarLeft: Math.round(a.left),
                hit,
            };
        `);
        rec(
            "10. avatar bottom-left: the Agent tree scrolled to its end leaves its last row clear of the avatar",
            foot.list === true && foot.scrollable === true && foot.hit === false && foot.lastBottom <= foot.avatarTop && foot.roomEnds <= foot.avatarTop,
            JSON.stringify(foot)
        );
        steps.push(...(await liveRunAgentSteps(h, ctx)));
        steps.push(...(await landedRunSteps(h, ctx)));
        steps.push(...(await treeGateToneSteps(h, ctx)));
        return steps;
    },
    async teardown(h, ctx) {
        // undefined: step 10 never moved the corner
        if (ctx.prevCorner !== undefined) {
            await lookEval(h, `
                const { setPetCorner } = await mod("app/view/jarvis/petstore.ts");
                setPetCorner(${JSON.stringify(ctx.prevCorner ?? "bottom-right")});
            `);
            if (ctx.prevCorner == null) await h.ev(`localStorage.removeItem("wave:pet.corner")`);
        }
        await h.cdp("Emulation.setDeviceMetricsOverride", OBS_WIDE).catch(() => {});
        for (const [what, term] of [["worker", ctx.workerTerm], ["lead", ctx.leadTerm], ["lead D", ctx.landedLeadTerm]]) {
            if (!term?.tabId) continue;
            await waveService(h, "workspace", "CloseTab", [term.workspaceId, term.tabId, false]).catch((e) =>
                console.error(`agent-tree-rail teardown: close the ${what} tab failed: ${e?.message ?? e}`)
            );
        }
        await teardownLiveRuns(h, ctx, "agent-tree-rail");
        await teardownFixtureRun(h, ctx, "agent-tree-rail", {
            what: "restore the rail preference and the default view",
            fn: async () => {
                await h.ev(
                    ctx.prevRail == null
                        ? `localStorage.removeItem(${JSON.stringify(RAIL_VISIBLE_KEY)})`
                        : `localStorage.setItem(${JSON.stringify(RAIL_VISIBLE_KEY)}, ${JSON.stringify(ctx.prevRail)})`
                );
                await restoreDefaultView(h);
            },
        });
    },
};

// --- canvas mode swaps with the terminal, which stays mounted ----------------------------------------
// final-verify boots a fresh store with no agents, so the scenario opens its own plain terminal tab the way
// launchAgent does (CreateTab, then the terminal meta) and reveals a temp canvas as that terminal's. CreateTab is
// a wavesrv service call, which the page cannot reach cross-origin, so Node makes it with the page's auth key.
// wavesrv serves the fixture board, so the pane shows it; the swap is under test, not the board.
const CANVAS_BOARD = "Main.dc.html";
const CANVAS_SWAP = `document.querySelector('[role="group"][aria-label="Show terminal or canvas"]')`;
export const CANVAS_TREE_TAG = `[...document.querySelectorAll("[data-agent-tree] button[aria-pressed]")].find((b) => (b.textContent || "").trim().startsWith("canvas"))`;
// the poller ticks every 3s (CANVAS_POLL_MS), so one tick always lands inside this
const CANVAS_REMOVED_WAIT_MS = 5000;
const CANVAS_ROSTER_WAIT_MS = 10000;
const CANVAS_KEYS = { c: { key: "c", code: "KeyC", keyCode: 67 }, x: { key: "x", code: "KeyX", keyCode: 88 } };

const clickCanvasSwap = (h, label) =>
    h.ev(`(() => {
        const b = [...(${CANVAS_SWAP}?.querySelectorAll("button") ?? [])]
            .find((x) => (x.textContent || "").trim() === ${JSON.stringify(label)});
        if (!b) return false;
        b.click();
        return true;
    })()`);

export const canvasSwap = {
    name: "canvas-swap",
    surface: "agent",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-canvas-"));
        const project = join(cwd, ".superpowers", "design", CANVAS_TOPIC, "project");
        mkdirSync(project, { recursive: true });
        writeFileSync(
            join(project, "canvas.json"),
            JSON.stringify({ boards: { [CANVAS_BOARD]: { w: 1440 } }, order: [CANVAS_BOARD] })
        );
        writeFileSync(join(project, CANVAS_BOARD), "<!doctype html><title>verify canvas</title><p>verify canvas</p>");
        const ctx = { cwd };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            await openCanvasTerminal(h, ctx);
        } catch (e) {
            ctx.launchError = String(e?.message ?? e);
            return ctx;
        }
        await h.goto("agent");
        ctx.inRoster = await polishWaitFor(
            h,
            `!!document.querySelector('[data-agent-terminal="${ctx.tabId}"]')`,
            CANVAS_ROSTER_WAIT_MS
        );
        return ctx;
    },
    async assert(h, ctx) {
        if (ctx.launchError != null) {
            return [skipStep("canvas swap", `could not verify: the terminal launch failed: ${ctx.launchError}`)];
        }
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const TERM = `document.querySelector('[data-agent-terminal="${ctx.tabId}"]')`;
        rec("0. the launched terminal is in the roster", ctx.inRoster === true, `tab=${ctx.tabId}`);
        if (!ctx.inRoster) return steps;

        // tagged before any swap: a remount would drop the attribute with the node
        const tagged = await h.ev(`(() => {
            const t = ${TERM};
            t.setAttribute("data-verify-mark", "canvas-swap");
            const x = t.querySelector(".xterm");
            if (x) x.setAttribute("data-verify-mark", "canvas-swap");
            return { xterm: !!x };
        })()`);

        let revealError = null;
        try {
            await h.rpc(
                "uireveal",
                { address: `canvas:${CANVAS_TOPIC}`, callerblockid: ctx.blockId, callercwd: ctx.cwd },
                UI_ROUTE
            );
        } catch (e) {
            revealError = String(e?.message ?? e);
        }
        // an agent's reveal only attaches; the user opens the canvas from the row's tag
        const attached = await polishWaitFor(h, `!!${CANVAS_TREE_TAG}`, 3000);
        const paneAfterReveal = await h.ev(`!!${CANVAS_PANE}`);
        rec(
            "1. uireveal canvas:<topic> from the terminal attaches the canvas without switching to it",
            revealError == null && attached && !paneAfterReveal,
            `tag=${attached} pane=${paneAfterReveal} error=${revealError}`
        );
        await h.ev(`${CANVAS_TREE_TAG}?.click()`);
        const paneUp = await polishWaitFor(h, `!!${CANVAS_PANE}`, 3000);
        const swap = await h.ev(`(() => {
            const g = ${CANVAS_SWAP};
            return g ? [...g.querySelectorAll("button")].map((b) => (b.textContent || "").trim()) : null;
        })()`);
        const treeKept = await h.ev(`!!document.querySelector("[data-agent-tree]")`);
        rec("1b. the row's canvas tag shows the canvas pane in the terminal's place", paneUp, `pane=${paneUp}`);
        rec("2. canvas mode keeps the agent tree", treeKept === true, `treeKept=${treeKept}`);
        rec(
            "3. the header swaps between Terminal and Canvas",
            JSON.stringify(swap) === JSON.stringify(["Terminal", "Canvas"]),
            `buttons=${JSON.stringify(swap)}`
        );
        await h.shot("cdp-shots/canvas-swap-canvas.png");

        // a real click puts the page in focus, which CDP key events need to reach it at all
        const box = await h.ev(`(() => {
            const r = ${CANVAS_PANE}?.querySelector("span")?.getBoundingClientRect();
            return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null;
        })()`);
        if (box) {
            for (const type of ["mousePressed", "mouseReleased"]) {
                await h.cdp("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
            }
        }
        // x is bound nowhere, so the probe seeing it proves key events arrive: a c that then does nothing is a
        // real failure, not an undelivered key
        await h.ev(`(() => {
            window.__canvasSeen = [];
            window.__canvasProbe = (e) => window.__canvasSeen.push(e.key);
            window.addEventListener("keydown", window.__canvasProbe, true);
            return true;
        })()`);
        await pressCanvasKey(h, CANVAS_KEYS.x);
        const delivered = await h.ev(`window.__canvasSeen.includes("x")`);
        await h.ev(`window.removeEventListener("keydown", window.__canvasProbe, true)`);

        const toTerminal = delivered ? await pressCanvasKey(h, CANVAS_KEYS.c) : await clickCanvasSwap(h, "Terminal");
        await polishNap(300);
        const back = await h.ev(`(() => {
            const t = ${TERM};
            const x = t?.querySelector(".xterm");
            return {
                pane: !!${CANVAS_PANE},
                visible: !!t && !t.classList.contains("hidden"),
                sameNode: t?.getAttribute("data-verify-mark") === "canvas-swap",
                sameXterm: x == null ? null : x.getAttribute("data-verify-mark") === "canvas-swap",
            };
        })()`);
        const keyed = delivered ? "c" : "the Terminal button (CDP keys did not reach the page)";
        rec(
            `4. ${keyed} returns to the terminal`,
            toTerminal !== false && !back.pane && back.visible,
            JSON.stringify({ delivered, ...back })
        );
        rec(
            "5. the terminal was hidden, not remounted",
            back.sameNode && (tagged.xterm ? back.sameXterm === true : true),
            JSON.stringify({ taggedXterm: tagged.xterm, sameNode: back.sameNode, sameXterm: back.sameXterm })
        );
        const tag = await h.ev(`!!${CANVAS_TREE_TAG}`);
        rec("6. the agent tree tags the terminal's row canvas", tag === true, `tag=${tag}`);
        if (!delivered) {
            steps.push(skipStep("4b. the c key itself", "CDP key events never reached the page; drove the header instead"));
        }

        // back in the terminal the xterm holds focus and would take the c; leave it the way Esc does
        await h.ev(`(() => {
            document.activeElement?.blur?.();
            document.querySelector("[data-cockpit-surface-wrap]")?.focus();
            return true;
        })()`);
        if (delivered) await pressCanvasKey(h, CANVAS_KEYS.c);
        else await clickCanvasSwap(h, "Canvas");
        const again = await polishWaitFor(h, `!!${CANVAS_PANE}`, 2000);
        rec(`7. ${delivered ? "c" : "the Canvas button"} brings the canvas back`, again, `pane=${again}`);

        rmSync(join(ctx.cwd, ".superpowers", "design", CANVAS_TOPIC), { recursive: true, force: true });
        const removed = await polishWaitFor(
            h,
            `(${CANVAS_PANE}?.textContent || "").includes(${JSON.stringify(`${CANVAS_TOPIC} was removed`)})`,
            CANVAS_REMOVED_WAIT_MS
        );
        rec("8. deleting the canvas folder shows the removed state", removed, `removed=${removed}`);
        await h.shot("cdp-shots/canvas-swap-removed.png");
        return steps;
    },
    // best-effort, so one failed step does not strand the rest
    async teardown(h, ctx) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`canvas-swap teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        await step("leave the canvas", () =>
            h.ev(`(() => {
                const b = [...(${CANVAS_PANE}?.querySelectorAll("button") ?? [])]
                    .find((x) => (x.textContent || "").trim() === "Close the canvas");
                if (b) b.click();
                return true;
            })()`)
        );
        if (ctx.tabId) {
            await step("close the terminal tab", () =>
                waveService(h, "workspace", "CloseTab", [ctx.workspaceId, ctx.tabId, false])
            );
        }
        await step("remove the temp dir", () => rmSync(ctx.cwd, { recursive: true, force: true }));
        await step("go home", () => h.goto("cockpit"));
    },
};

// --- canvas mark: a box drawn on the board opens the review's note card under it, Esc drops the mark, and Enter
// sends it at once: a feedback picture without the card, one line handed to the agent, and back to the terminal --
const CANVAS_MARK_NOTE = `document.querySelector("[data-canvas-mark-note]")`;
const CANVAS_MARK_BOX = `document.querySelector("[data-canvas-mark]")`;
const CANVAS_MARK_TEXT = "make it wider";
const CANVAS_MARK_SEND_WAIT_MS = 8000;
const CANVAS_MARK_ENTER = { key: "Enter", code: "Enter", keyCode: 13 };
const CANVAS_MARK_ESC = { key: "Escape", code: "Escape", keyCode: 27 };

const pressMarkKey = async (h, { key, code, keyCode }) => {
    const text = key === "Enter" ? "\r" : undefined;
    await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code, text, windowsVirtualKeyCode: keyCode });
    await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
    await polishNap(400);
};

// a real drag over the board, in window coordinates, from 15%/15% to 45%/40% of its visible rect
export async function dragMarkBox(h) {
    const r = await h.ev(`(() => {
        const b = document.querySelector("[data-canvas-board]")?.getBoundingClientRect();
        return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
    })()`);
    if (r == null) return false;
    const at = (fx, fy) => ({ x: Math.round(r.x + r.w * fx), y: Math.round(r.y + r.h * fy) });
    const [a, b] = [at(0.15, 0.15), at(0.45, 0.4)];
    await h.cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...a, button: "left", buttons: 1, clickCount: 1 });
    for (const t of [0.33, 0.66, 1]) {
        const p = { x: Math.round(a.x + (b.x - a.x) * t), y: Math.round(a.y + (b.y - a.y) * t) };
        await h.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...p, button: "left", buttons: 1 });
    }
    await h.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...b, button: "left", buttons: 0, clickCount: 1 });
    await polishNap(300);
    return true;
}

export const canvasMark = {
    name: "canvas-mark",
    surface: "agent",
    arrange: canvasSwap.arrange,
    async assert(h, ctx) {
        if (ctx.launchError != null) {
            return [skipStep("canvas mark", `could not verify: the terminal launch failed: ${ctx.launchError}`)];
        }
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        rec("0. the launched terminal is in the roster", ctx.inRoster === true, `tab=${ctx.tabId}`);
        if (!ctx.inRoster) return steps;

        await h.rpc(
            "uireveal",
            { address: `canvas:${CANVAS_TOPIC}`, callerblockid: ctx.blockId, callercwd: ctx.cwd },
            UI_ROUTE
        );
        await polishWaitFor(h, `!!${CANVAS_TREE_TAG}`, 3000);
        await h.ev(`${CANVAS_TREE_TAG}?.click()`);
        const board = await polishWaitFor(h, `!!document.querySelector("[data-canvas-board] iframe")`, 5000);
        await h.ev(`[...(${CANVAS_PANE}?.querySelectorAll("button") ?? [])]
            .find((b) => (b.textContent || "").trim() === "Mark")?.click()`);
        const hint = await polishWaitFor(
            h,
            `(${CANVAS_PANE}?.textContent || "").includes("Drag a box around what you want changed")`,
            2000
        );
        rec("1. Mark puts the board in mark mode", board && hint, `board=${board} hint=${hint}`);

        // Esc in the card drops the mark and leaves mark mode on
        await dragMarkBox(h);
        const first = await polishWaitFor(h, `!!${CANVAS_MARK_NOTE}`, 2000);
        await pressMarkKey(h, CANVAS_MARK_ESC);
        const dropped = await h.ev(`({ note: !!${CANVAS_MARK_NOTE}, box: !!${CANVAS_MARK_BOX},
            hint: (${CANVAS_PANE}?.textContent || "").includes("Drag a box around") })`);
        rec(
            "2. Esc in the note card drops the mark and keeps marking",
            first && !dropped.note && !dropped.box && dropped.hint,
            JSON.stringify({ first, ...dropped })
        );

        await dragMarkBox(h);
        await polishWaitFor(h, `!!${CANVAS_MARK_NOTE}`, 2000);
        const card = await h.ev(`(() => {
            const n = ${CANVAS_MARK_NOTE}?.getBoundingClientRect();
            const m = ${CANVAS_MARK_BOX}?.getBoundingClientRect();
            const input = ${CANVAS_MARK_NOTE}?.querySelector("input");
            const send = [...(${CANVAS_MARK_NOTE}?.querySelectorAll("button") ?? [])].map((b) => (b.textContent || "").trim());
            return n && m ? {
                below: Math.round(n.top) >= Math.round(m.bottom),
                nearLeft: Math.abs(n.left - m.left) < 2,
                focused: document.activeElement === input,
                buttons: send,
            } : null;
        })()`);
        rec(
            "3. a drawn box opens the note card under it, its input focused, with Cancel Esc and Send Enter",
            card != null && card.below && card.nearLeft && card.focused &&
                card.buttons.some((t) => t.startsWith("Cancel")) && card.buttons.some((t) => t.startsWith("Send")),
            JSON.stringify(card)
        );
        await h.shot("cdp-shots/canvas-mark-note.png");

        await h.cdp("Input.insertText", { text: CANVAS_MARK_TEXT });
        await polishNap(200);
        // what the send hands the agent is read off its rpc calls: the prompt, and anything typed into the pty
        await h.ev(`(() => {
            const c = window.TabRpcClient;
            window.__markSent = [];
            window.__markRpc = c.wshRpcCall;
            c.wshRpcCall = function (cmd, data, opts) {
                if (cmd === "agentprompt") window.__markSent.push({ cmd, block: data.blockid, text: data.text });
                if (cmd === "controllerinput") window.__markSent.push({ cmd, block: data.blockid, text: atob(data.inputdata64) });
                return window.__markRpc.call(this, cmd, data, opts);
            };
            return true;
        })()`);
        await pressMarkKey(h, CANVAS_MARK_ENTER);
        const back = await polishWaitFor(h, `!${CANVAS_PANE}`, CANVAS_MARK_SEND_WAIT_MS);
        const feedback = join(ctx.cwd, ".superpowers", "design", CANVAS_TOPIC, "feedback", "001.png");
        const saved = existsSync(feedback);
        if (saved) {
            writeFileSync("cdp-shots/canvas-mark-feedback.png", readFileSync(feedback));
        }
        const error = await h.ev(`${CANVAS_MARK_NOTE}?.textContent ?? null`);
        rec(
            "4. Enter sends at once: the picture is saved and the agent is back on its terminal",
            back && saved,
            JSON.stringify({ back, saved, card: error })
        );
        const sent = await h.ev(`(() => {
            window.TabRpcClient.wshRpcCall = window.__markRpc;
            return window.__markSent;
        })()`);
        const want = `look at .superpowers/design/${CANVAS_TOPIC}/feedback/001.png — mark on ${CANVAS_BOARD}: ${CANVAS_MARK_TEXT}`;
        // the terminal getting focus back reports it (ESC [I) through controllerinput, which is not the send
        const calls = (sent ?? []).filter((t) => !/^\x1b\[[IO]$/.test(t.text));
        rec(
            "5. one line naming the picture and the note goes to the agent as a prompt, not typed into its composer",
            calls.length === 1 && calls[0].cmd === "agentprompt" && calls[0].block === ctx.blockId && calls[0].text === want,
            JSON.stringify(sent)
        );
        await h.shot("cdp-shots/canvas-mark-sent.png");
        return steps;
    },
    teardown: canvasSwap.teardown,
};

// --- canvas board tabs: each board on its own tab, and All lays them side by side -------------------------
// Unlike canvas-swap, the boards are under test: wavesrv serves them from the fixture's design folder.
export const CANVAS_TABS_TOPIC = "verify-canvas-tabs";
export const CANVAS_TABS = `document.querySelector('[role="tablist"][aria-label="Boards"]')`;

const canvasTabFrames = (h) =>
    h.ev(`(() => ({
        tabs: [...(${CANVAS_TABS}?.querySelectorAll('[role="tab"]') ?? [])].map((b) => (b.textContent || "").trim()),
        frames: [...document.querySelectorAll("[data-canvas-frame]")].map((f) => f.getAttribute("data-canvas-frame")),
    }))()`);

const clickCanvasTab = async (h, label) => {
    await h.ev(`[...(${CANVAS_TABS}?.querySelectorAll('[role="tab"]') ?? [])].find((b) => (b.textContent || "").trim() === ${JSON.stringify(label)})?.click()`);
    await polishNap(400);
    return canvasTabFrames(h);
};

export const canvasTabsScenario = {
    name: "canvas-tabs",
    surface: "agent",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-canvas-tabs-"));
        const project = join(cwd, ".superpowers", "design", CANVAS_TABS_TOPIC, "project");
        mkdirSync(project, { recursive: true });
        writeFileSync(
            join(project, "canvas.json"),
            JSON.stringify({
                boards: {
                    "Main.dc.html": { x: 0, y: 0, w: 640, h: 480, title: "A" },
                    "Cards.dc.html": { x: 720, y: 0, w: 640, h: 480, title: "B" },
                },
                order: ["Main.dc.html", "Cards.dc.html"],
            })
        );
        for (const name of ["Main", "Cards"]) {
            writeFileSync(join(project, `${name}.dc.html`), `<!doctype html><title>${name}</title><p>${name} board</p>`);
        }
        const ctx = { cwd };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            await openCanvasTerminal(h, ctx);
        } catch (e) {
            ctx.launchError = String(e?.message ?? e);
            return ctx;
        }
        await h.goto("agent");
        ctx.inRoster = await polishWaitFor(
            h,
            `!!document.querySelector('[data-agent-terminal="${ctx.tabId}"]')`,
            CANVAS_ROSTER_WAIT_MS
        );
        return ctx;
    },
    async assert(h, ctx) {
        if (ctx.launchError != null) {
            return [skipStep("canvas tabs", `could not verify: ${ctx.launchError}`)];
        }
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        rec("0. the launched terminal is in the roster", ctx.inRoster === true, `tab=${ctx.tabId}`);
        if (!ctx.inRoster) return steps;

        await h.rpc(
            "uireveal",
            { address: `canvas:${CANVAS_TABS_TOPIC}`, callerblockid: ctx.blockId, callercwd: ctx.cwd },
            UI_ROUTE
        );
        await polishWaitFor(h, `!!${CANVAS_TREE_TAG}`, 3000);
        await h.ev(`${CANVAS_TREE_TAG}?.click()`);
        const loaded = await polishWaitFor(
            h,
            `(${CANVAS_TABS}?.querySelectorAll('[role="tab"]').length ?? 0) === 3`,
            CANVAS_TABS_WAIT_MS
        );
        const first = await canvasTabFrames(h);
        rec(
            "1. the header offers All and one tab per board, and opens on the first board alone",
            loaded && JSON.stringify(first.tabs) === JSON.stringify(["All", "Main", "Cards"]) &&
                JSON.stringify(first.frames) === JSON.stringify(["Main.dc.html"]),
            JSON.stringify({ loaded, ...first })
        );
        const all = await clickCanvasTab(h, "All");
        await h.shot("cdp-shots/canvas-tabs-all.png");
        rec(
            "2. All lays every board out side by side",
            JSON.stringify(all.frames) === JSON.stringify(["Main.dc.html", "Cards.dc.html"]),
            JSON.stringify(all)
        );
        const cards = await clickCanvasTab(h, "Cards");
        await h.shot("cdp-shots/canvas-tabs-cards.png");
        rec(
            "3. a board's tab shows that board alone",
            JSON.stringify(cards.frames) === JSON.stringify(["Cards.dc.html"]),
            JSON.stringify(cards)
        );
        return steps;
    },
    // best-effort, so one failed step does not strand the rest
    async teardown(h, ctx) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`canvas-tabs teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        await step("leave the canvas", () => clickCanvasSwap(h, "Terminal"));
        if (ctx.tabId) {
            await step("close the terminal tab", () =>
                waveService(h, "workspace", "CloseTab", [ctx.workspaceId, ctx.tabId, false])
            );
        }
        await step("remove the temp dir", () => rmSync(ctx.cwd, { recursive: true, force: true }));
        await step("go home", () => h.goto("cockpit"));
    },
};

// The Resource Manager (footer readout + popover). Data comes only from window.__resmonFixture (resmonstore.ts),
// modelled on the canvas (.superpowers/design/resource-manager): a pinned snapshot is never overwritten by the
// live poll, and an armed outcome answers the next confirm without touching a process.
const RESMON_VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const RESMON_MIB = 1024 * 1024;
// the snapshot's totals: the canvas's 60.6% and 7.4 GiB
const RESMON_TOTAL_CPU = 60.6;
const RESMON_TOTAL_MEM = 7945689498;
const RESMON_FOOTER = `document.querySelector('[data-hints-footer]')`;
const RESMON_COCKPIT_HINTS = `document.querySelector('[data-cockpit-hints]')`;
const RESMON_POPOVER = `document.querySelector('[data-resmon-popover]')`;
// the window where the footer's chips wrapped out of the bar (visual revisit F2)
const RESMON_NARROW = { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false };
// the footer's h-7 bar
const RESMON_FOOTER_PX = 28;
// each footer chip against the footer below its top border (inside: shown whole) and against the chip row's clip
// (dropped: wholly outside it), and whether the readout shows whole
const RESMON_CHIP_FIT = `(() => {
    const f = ${RESMON_FOOTER};
    const row = f?.querySelector('[data-footer-chips]');
    if (!f || !row) return { footer: !!f, row: !!row, chips: [] };
    const fr = f.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    const top = fr.top + parseFloat(getComputedStyle(f).borderTopWidth);
    const bottom = Math.min(fr.bottom, window.innerHeight);
    const eps = 0.5;
    const within = (r) => r.top >= top - eps && r.bottom <= bottom + eps && r.left >= fr.left - eps && r.right <= fr.right + eps;
    const readout = f.querySelector('[data-resmon-readout]');
    return {
        footer: [fr.left, top, fr.right, bottom].map(Math.round),
        row: [rr.left, rr.top, rr.right, rr.bottom].map(Math.round),
        chips: [...row.children].map((c) => {
            const r = c.getBoundingClientRect();
            return {
                text: c.textContent.trim(),
                inside: within(r),
                dropped: r.top >= rr.bottom - eps || r.bottom <= rr.top + eps || r.left >= rr.right - eps || r.right <= rr.left + eps,
            };
        }),
        readout: readout
            ? { fits: readout.scrollWidth <= readout.clientWidth && within(readout.getBoundingClientRect()), sw: readout.scrollWidth, cw: readout.clientWidth }
            : null,
    };
})()`;
// a run's workers and plan commands share one view, keyed by its run id
const RESMON_GROUP_ORDER = ["arc", "job:14820", "run:run-a", "run:run-b", "job:7716"];
// the popover grows in with a scale reveal; measure after it settles
const RESMON_REVEAL_MS = 500;
const RESMON_CURSOR_MAX_PRESSES = 40;
const resmonNap = (ms) => new Promise((r) => setTimeout(r, ms));

function resmonRows(now, rows) {
    return rows.map(([pid, depth, name, args, cpu, mb, extra]) => ({
        pid,
        depth,
        name,
        command: args ? `${name} ${args}` : name,
        createts: now - (extra?.ageMin ?? 5) * 60_000,
        cpu,
        mem: Math.round(mb * RESMON_MIB),
        mempct: 0,
        numthreads: 1,
        ...(extra?.tag ? { tag: extra.tag } : {}),
        ...(extra?.role ? { role: extra.role } : {}),
    }));
}

function resmonGroup(key, ownerkind, label, runtime, killable, rows, run) {
    return {
        key,
        ownerkind,
        ownerid: key,
        label,
        ...(run ? { runid: run.id, role: run.role } : {}),
        ...(runtime ? { runtime } : {}),
        killable,
        cpu: Math.round(rows.reduce((n, r) => n + r.cpu, 0) * 10) / 10,
        mem: rows.reduce((n, r) => n + r.mem, 0),
        rows,
    };
}

function resmonArcGroup(now) {
    const webview = (role) => ({ role, ageMin: 340 });
    return resmonGroup("arc", "arc", "Arc", "", false, resmonRows(now, [
        [2476, 0, "wave-tauri.exe", "", 0.1, 38, webview("Host")],
        [23360, 1, "msedgewebview2.exe", "", 0.4, 141, webview("WebView browser")],
        [20028, 2, "msedgewebview2.exe", "--type=renderer", 3.1, 337, webview("Renderer")],
        [24188, 2, "msedgewebview2.exe", "--type=gpu-process", 1.9, 298, webview("GPU")],
        [25364, 2, "msedgewebview2.exe", "--type=renderer", 0.2, 74, { role: "Renderer", ageMin: 62 }],
        [27348, 2, "msedgewebview2.exe", "--type=utility --utility-sub-type=network.mojom.NetworkService", 0.1, 43, webview("Network service")],
        [4040, 2, "msedgewebview2.exe", "--type=utility --utility-sub-type=storage.mojom.StorageService", 0.0, 20, webview("Storage service")],
        [1788, 2, "msedgewebview2.exe", "--type=crashpad-handler", 0.0, 13, webview("Crash handler")],
        [27152, 1, "wavesrv.x64.exe", "", 0.9, 219, webview("Backend")],
    ]));
}

function resmonFixture(now = Date.now()) {
    return {
        supported: true,
        ready: true,
        ts: now,
        cpu: RESMON_TOTAL_CPU,
        mem: RESMON_TOTAL_MEM,
        totalmem: 32 * 1024 * RESMON_MIB,
        busycpu: false,
        busymem: false,
        groups: [
            resmonArcGroup(now),
            resmonGroup("job:14820", "agenttab", "waveterm", "claude", true, resmonRows(now, [
                [14820, 0, "claude.exe", "--resume", 1.2, 486, { tag: "agent", ageMin: 42 }],
                [14832, 1, "conhost.exe", "", 0.0, 9, { tag: "console", ageMin: 42 }],
                [18240, 1, "bash.exe", "-c go test ./pkg/orchestrate/... -run TestLiveness", 0.0, 6, { ageMin: 2 }],
                [18244, 2, "go.exe", "test ./pkg/orchestrate/...", 0.6, 152, { ageMin: 2 }],
                [18311, 3, "orchestrate.test.exe", "-test.run TestLiveness", 28.9, 1904, { ageMin: 2 }],
                [9932, 1, "cmd.exe", "/c npm run dev", 0.0, 4, { ageMin: 38 }],
                [9958, 2, "node.exe", "vite --port 5174", 1.1, 846, { ageMin: 38 }],
            ])),
            resmonGroup("job:13060", "runworker", "cache-miss notice", "pi", true, resmonRows(now, [
                [13060, 0, "cmd.exe", "/c pi.cmd", 0.0, 4, { tag: "launcher", ageMin: 16 }],
                [13072, 1, "conhost.exe", "", 0.0, 8, { tag: "console", ageMin: 16 }],
                [13104, 1, "node.exe", "pi", 0.9, 274, { tag: "agent", ageMin: 16 }],
                [21876, 2, "bash.exe", "-c npx vitest run frontend/app/view/agents", 0.0, 6, { ageMin: 1 }],
                [21890, 3, "node.exe", "vitest run frontend/app/view/agents", 13.7, 802, { ageMin: 1 }],
            ]), { id: "run-a", role: "Task 2" }),
            // the run's lead, started first: its core is the launcher, claude, and the arc mod's wsh agentctl
            resmonGroup("job:17544", "runworker", "cache-miss notice", "claude", true, resmonRows(now, [
                [17544, 0, "pwsh.exe", '-c "claude --dangerously-skip-permissions"', 0.0, 93, { tag: "launcher", ageMin: 41 }],
                [1908, 1, "claude.exe", "--dangerously-skip-permissions", 0.1, 378, { tag: "agent", ageMin: 41 }],
                [25284, 2, "wsh.exe", "agentctl", 0.0, 15, { tag: "control", ageMin: 41 }],
                [29268, 3, "conhost.exe", "0x4", 0.0, 7, { tag: "console", ageMin: 41 }],
            ]), { id: "run-a", role: "Lead" }),
            resmonGroup("job:22410", "runcmd", "cleanup round", "", false, resmonRows(now, [
                [22410, 0, "bash.exe", "-c node scripts/verify.mjs ./pkg/orchestrate ./pkg/jarvis", 0.0, 6, { tag: "shell", ageMin: 4 }],
                [22418, 1, "node.exe", "scripts/verify.mjs", 0.3, 58, { ageMin: 4 }],
                [22502, 2, "go.exe", "test ./pkg/jarvis", 0.4, 140, { ageMin: 3 }],
                [22590, 3, "jarvis.test.exe", "-test.count=1", 6.7, 1200, { ageMin: 3 }],
            ]), { id: "run-b", role: "Verify" }),
            resmonGroup("job:7716", "agenttab", "obsidian-notes", "claude", true, resmonRows(now, [
                [7716, 0, "claude.exe", "", 0.1, 303, { tag: "agent", ageMin: 192 }],
                [7724, 1, "conhost.exe", "", 0.0, 9, { tag: "console", ageMin: 192 }],
            ])),
        ],
    };
}

const resmonSet = (h, snap) => h.ev(`window.__resmonFixture.set(${JSON.stringify(snap)})`);
const resmonArm = (h, outcome) => h.ev(`window.__resmonFixture.killOutcome(${JSON.stringify(outcome)})`);
const resmonClick = (expr) => `(() => { const el = ${expr}; if (!el) return false; el.click(); return true; })()`;
const resmonReadout = (scope) => `${scope}?.querySelector('[data-resmon-readout]')`;
// the readout's words as a reader sees them: the flex gaps between its spans carry no text
const resmonReadoutText = (scope) => `(() => {
    const r = ${resmonReadout(scope)};
    return r ? [...r.children].filter((c) => c.tagName === 'SPAN').map((c) => c.textContent.trim()).join(' ') : null;
})()`;
const resmonGroupButton = (key, text) =>
    `[...document.querySelectorAll('[data-resmon-popover] [data-resmon-group="${key}"] button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
const resmonConfirmButton = (text) =>
    `[...document.querySelectorAll('[data-resmon-popover] [data-resmon-confirm] button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
const resmonRowKill = (pid) => `document.querySelector('[data-resmon-popover] [data-resmon-row="${pid}"] button')`;
const resmonChevron = (key) =>
    `document.querySelector('[data-resmon-popover] [data-resmon-group="${key}"] button[aria-expanded]')`;

const RESMON_KEYS = {
    Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
    g: { key: "g", code: "KeyG", windowsVirtualKeyCode: 71, text: "g" },
    m: { key: "m", code: "KeyM", windowsVirtualKeyCode: 77, text: "m" },
    x: { key: "x", code: "KeyX", windowsVirtualKeyCode: 88, text: "x" },
    X: { key: "X", code: "KeyX", windowsVirtualKeyCode: 88, text: "X", shift: true },
};
const RESMON_SHIFT_MODIFIER = 8;

// Input.dispatchKeyEvent often never reaches a WebView without OS focus: probe once, then send every key the same
// way, falling back to a KeyboardEvent on window, where the keybinding dispatcher listens
async function resmonKeyPath(h) {
    await h.ev(`(() => {
        window.__resmonKeyProbe = false;
        const f = (e) => { if (e.key === 'F20') { window.__resmonKeyProbe = true; window.removeEventListener('keydown', f, true); } };
        window.addEventListener('keydown', f, true);
    })()`);
    await h.cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "F20", code: "F20", windowsVirtualKeyCode: 131 });
    await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "F20", code: "F20", windowsVirtualKeyCode: 131 });
    await resmonNap(150);
    return (await h.ev("window.__resmonKeyProbe === true")) ? "cdp" : "window";
}

async function resmonKey(h, ctx, name) {
    const { shift, text, ...k } = RESMON_KEYS[name];
    if (ctx.keyPath === "cdp") {
        const modifiers = shift ? RESMON_SHIFT_MODIFIER : 0;
        await h.cdp("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...k, text, modifiers });
        await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...k, modifiers });
    } else {
        await h.ev(
            `window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k.key)}, code: ${JSON.stringify(k.code)}, shiftKey: ${!!shift}, bubbles: true, cancelable: true }))`
        );
    }
    await resmonNap(200);
}

// keys must not land in a field: the Agent surface's terminal would take them
const resmonBlur = (h) => h.ev(`document.activeElement?.blur?.()`);

const RESMON_POPOVER_STATE = `(() => {
    const p = ${RESMON_POPOVER};
    if (!p) return null;
    const r = p.getBoundingClientRect();
    const where = (el) =>
        el.getAttribute('data-resmon-row') ??
        (el.hasAttribute('data-resmon-member') ? 'm:' + el.getAttribute('data-resmon-member') : null) ??
        el.closest('[data-resmon-group]')?.getAttribute('data-resmon-group');
    const cursor = p.querySelector('[data-resmon-cursor]');
    const confirm = p.querySelector('[data-resmon-confirm]');
    return {
        width: Math.round(r.width),
        right: Math.round(window.innerWidth - r.right),
        bottom: r.bottom,
        groups: [...p.querySelectorAll('[data-resmon-group]')].map((g) => ({
            key: g.getAttribute('data-resmon-group'),
            header: g.querySelector('button[aria-expanded]')?.textContent.trim() ?? '',
            rows: g.querySelectorAll('[data-resmon-row]').length,
            kills: g.querySelectorAll('[data-resmon-row] button[aria-label^="Kill"]').length,
            buttons: g.querySelectorAll('button').length,
            members: [...g.querySelectorAll('[data-resmon-member]')].map((m) => ({
                role: m.querySelector('span.font-semibold')?.textContent.trim() ?? '',
                folded: m.querySelector('[data-resmon-folded]')?.textContent.trim() ?? '',
                foldedTitle: m.querySelector('[data-resmon-folded]')?.getAttribute('title') ?? '',
                killChildren: [...m.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Kill children'),
                readOnly: m.textContent.includes('read-only'),
                icon: m.querySelector('img')?.getAttribute('alt') ?? (m.querySelector('svg') ? 'svg' : ''),
            })),
        })),
        order: [...p.querySelectorAll('[data-resmon-group] > div:first-child, [data-resmon-member], [data-resmon-row]')].map(where),
        cursor: cursor ? where(cursor) : null,
        confirm: confirm ? (confirm.querySelector('span')?.textContent ?? '') : null,
        status: [...p.querySelectorAll('[role="status"]')].map((n) => n.textContent.trim()),
        alert: [...p.querySelectorAll('[role="alert"]')].map((n) => n.textContent.trim()),
        text: p.textContent,
    };
})()`;
const resmonPopover = (h) => h.ev(RESMON_POPOVER_STATE);

// walks the cursor with the arrows onto the row with that pid, or the header of the group with that key
async function resmonCursorTo(h, ctx, target) {
    for (let i = 0; i < RESMON_CURSOR_MAX_PRESSES; i++) {
        const s = await resmonPopover(h);
        if (s == null) return false;
        const at = s.cursor == null ? -1 : s.order.indexOf(s.cursor);
        const want = s.order.indexOf(String(target));
        if (want < 0) return false;
        if (at === want) return true;
        await resmonKey(h, ctx, want > at ? "ArrowDown" : "ArrowUp");
    }
    return false;
}

async function resmonArrange(h) {
    await h.cdp("Emulation.setDeviceMetricsOverride", RESMON_VIEWPORT);
    await h.goto("agent");
    const ready = await polishWaitFor(h, `!!window.__resmonFixture`, 10000);
    const keyPath = await resmonKeyPath(h);
    if (ready) {
        await resmonSet(h, resmonFixture());
        await resmonNap(300);
    }
    return { ready, keyPath };
}

// The Cockpit draws its hints bar, and so its readout, only over a roster: an empty store shows the empty state
// alone. The fixture roster is read once at boot, and the reload drops the pinned snapshot, so it is set again.
async function resmonSeedRoster(h, ctx) {
    if (existsSync(TREE_RAIL_FIXTURE)) return;
    mkdirSync(new URL(".", TREE_RAIL_FIXTURE), { recursive: true });
    writeFileSync(TREE_RAIL_FIXTURE, JSON.stringify(treeRailRoster(undefined, Date.now()), null, 2));
    ctx.wroteFixture = true;
    await h.ev("location.reload()");
    await polishWaitFor(h, `!!document.querySelector("nav button") && !!window.__resmonFixture`, 30000);
    await resmonSet(h, resmonFixture());
}

// after ?: the help button precedes the readout, and only the remote chip (absent unless its status shows it) and
// the readouts' wrapper sit between them
const RESMON_COCKPIT_ORDER = `(() => {
    const bar = ${RESMON_COCKPIT_HINTS};
    const r = ${resmonReadout(RESMON_COCKPIT_HINTS)};
    const help = bar?.querySelector('[data-cockpit-help]');
    const pill = bar?.querySelector('[data-remote-pill]');
    const follows = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const between = r && help
        ? [...bar.querySelectorAll('*')].filter((el) =>
              follows(help, el) && follows(el, r) && !help.contains(el) && !el.contains(r) && !el.closest('[data-remote-pill]'))
        : null;
    return {
        readout: !!r,
        afterHelp: !!r && !!help && follows(help, r) && between.length === 0,
        between: between?.map((el) => el.tagName + (el.textContent.trim() ? ':' + el.textContent.trim() : '')) ?? null,
        remote: !!pill,
        chipBefore: !!pill && !!r && !!help && follows(help, pill) && follows(pill, r),
        footer: !!${RESMON_FOOTER},
    };
})()`;

// clicks the cockpit readout, reads where the popover opened, then closes it
async function resmonCockpitOpen(h, ctx) {
    await h.ev(resmonClick(resmonReadout(RESMON_COCKPIT_HINTS)));
    await resmonNap(RESMON_REVEAL_MS);
    const above = await h.ev(`(() => {
        const p = ${RESMON_POPOVER};
        const bar = ${RESMON_COCKPIT_HINTS};
        if (!p || !bar) return { open: !!p, bar: !!bar };
        return { open: true, bottom: p.getBoundingClientRect().bottom, barTop: bar.getBoundingClientRect().top };
    })()`);
    await resmonBlur(h);
    await resmonKey(h, ctx, "Escape");
    await resmonNap(RESMON_REVEAL_MS);
    return above;
}

// a status that draws the chip as Remote off: remote mode stays off, and nothing is missing from its setup
const RESMON_REMOTE_OFF = { on: false, tunnel: "", subscriptions: 0 };

// sets the status the remote chip reads and returns the one it replaced
const resmonSwapRemote = (h, status) =>
    lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const { remoteStatusAtom } = await mod("app/view/agents/remotestore.ts");
        const prev = globalStore.get(remoteStatusAtom);
        globalStore.set(remoteStatusAtom, ${JSON.stringify(status)});
        return prev;
    `);

async function resmonTeardown(h, ctx) {
    await h.ev(`window.__resmonFixture?.clear()`).catch(() => {});
    if (ctx?.remoteSwapped) await resmonSwapRemote(h, ctx.prevRemote ?? null);
    if (ctx?.wroteFixture) {
        rmSync(TREE_RAIL_FIXTURE, { force: true });
        await h.ev("location.reload()");
        await polishWaitFor(h, `!!document.querySelector("nav button")`, 30000);
    }
    await h.goto("cockpit");
}

const RESMON_NO_HOOK = [{ step: "the dev fixture hook is on window", ok: false, detail: "no window.__resmonFixture" }];

export const resmonFooter = {
    name: "resmon-footer",
    surface: "agent",
    arrange: resmonArrange,
    async assert(h, ctx) {
        if (!ctx.ready) return RESMON_NO_HOOK;
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const shot = (n) => h.shot(`cdp-shots/resmon-footer-${n}.png`);

        await resmonBlur(h);
        // the readout shares a wrapper with the remote chip: the wrapper closes the footer, the readout the wrapper
        const rest = await h.ev(`(() => {
            const f = ${RESMON_FOOTER};
            const r = ${resmonReadout(RESMON_FOOTER)};
            return {
                last: !!r && !!f?.lastElementChild?.contains(r) && r.parentElement?.lastElementChild === r,
                text: ${resmonReadoutText(RESMON_FOOTER)},
            };
        })()`);
        await shot("1-rest");
        rec("1. Agent at rest: the readout ends the footer and reads Arc 61% CPU · 7.4 GB",
            rest.last && rest.text === "Arc 61% CPU · 7.4 GB", JSON.stringify(rest));

        const wide = await h.ev(RESMON_CHIP_FIT);
        rec("1a. 1600x950 Agent: every footer chip lies wholly inside the footer, none dropped",
            wide.chips.length > 0 && wide.chips.every((c) => c.inside), JSON.stringify(wide));

        await h.cdp("Emulation.setDeviceMetricsOverride", RESMON_NARROW);
        let narrow;
        try {
            await h.goto("files");
            await polishWaitFor(h, `!!${RESMON_FOOTER}?.querySelector('[data-footer-chips]')`, 10000);
            await resmonNap(300);
            narrow = await h.ev(RESMON_CHIP_FIT);
            narrow.text = await h.ev(resmonReadoutText(RESMON_FOOTER));
            await shot("1b-diff-1000");
        } finally {
            await h.cdp("Emulation.setDeviceMetricsOverride", RESMON_VIEWPORT);
        }
        rec("1b. 1000x700 Diff: shown chips sit inside the footer, the rest are dropped whole, the readout is not cut",
            narrow.chips.every((c) => c.inside || c.dropped) &&
                narrow.chips.some((c) => c.dropped) &&
                narrow.readout?.fits === true &&
                (narrow.text ?? "").endsWith("GB"),
            JSON.stringify(narrow));

        await h.cdp("Emulation.setDeviceMetricsOverride", RESMON_NARROW);
        let narrowLeader;
        try {
            await h.goto("files");
            await polishWaitFor(h, `!!${RESMON_FOOTER}?.querySelector('[data-footer-chips]')`, 10000);
            await resmonBlur(h);
            await resmonKey(h, ctx, "g");
            await polishWaitFor(h, `[...(${RESMON_FOOTER}?.querySelectorAll('span') ?? [])].some((s) => s.textContent.trim() === 'g →')`, 5000);
            narrowLeader = await h.ev(RESMON_CHIP_FIT);
            narrowLeader.height = await h.ev(`${RESMON_FOOTER}?.getBoundingClientRect().height ?? null`);
            await shot("2a-leader-diff-1000");
        } finally {
            await resmonKey(h, ctx, "Escape");
            await h.cdp("Emulation.setDeviceMetricsOverride", RESMON_VIEWPORT);
        }
        rec("2a. 1000x700 Diff under the g leader: shown chips sit inside the 28px footer, the rest are dropped whole",
            narrowLeader.chips.length > 0 &&
                narrowLeader.chips.every((c) => c.inside || c.dropped) &&
                Math.abs((narrowLeader.height ?? 0) - RESMON_FOOTER_PX) < 0.5,
            JSON.stringify(narrowLeader));
        await h.goto("agent");
        await resmonBlur(h);

        await resmonKey(h, ctx, "g");
        const leader = await h.ev(`(() => {
            const f = ${RESMON_FOOTER};
            const spans = [...(f?.querySelectorAll('span') ?? [])].map((s) => s.textContent.trim());
            return { readout: !!${resmonReadout(RESMON_FOOTER)}, m: spans.includes('mResource Manager'), leader: spans.includes('g →') };
        })()`);
        await shot("2-leader");
        rec("2. g: the leader posture keeps the readout and lists m Resource Manager",
            leader.readout && leader.m && leader.leader, JSON.stringify(leader));

        await resmonKey(h, ctx, "m");
        await resmonNap(RESMON_REVEAL_MS);
        const opened = await h.ev(`!!${RESMON_POPOVER}`);
        await shot("3-gm-open");
        rec("3. m: the popover opens", opened, `popover=${opened}`);

        await resmonKey(h, ctx, "Escape");
        await resmonNap(RESMON_REVEAL_MS);
        const closed = await h.ev(`!${RESMON_POPOVER}`);
        await shot("4-esc-closed");
        rec("4. Esc: the popover closes", closed, `closed=${closed}`);

        const dim = await h.ev(`new Promise((resolve) => {
            const input = document.createElement('input');
            input.setAttribute('data-resmon-probe', '');
            document.body.appendChild(input);
            input.focus();
            setTimeout(() => {
                const chips = ${RESMON_FOOTER}?.querySelector('[data-footer-chips]');
                const readout = ${resmonReadout(RESMON_FOOTER)};
                resolve({ chips: chips ? getComputedStyle(chips).opacity : null, readout: readout ? getComputedStyle(readout).opacity : null });
            }, 300);
        })`);
        await shot("5-editable");
        await h.ev(`document.querySelector('[data-resmon-probe]')?.remove()`);
        rec("5. focus in a field: the chips dim to 0.6, the readout stays at 1",
            dim.chips === "0.6" && dim.readout === "1", JSON.stringify(dim));

        if (!existsSync(TREE_RAIL_FIXTURE)) {
            await h.goto("cockpit");
            await polishWaitFor(h, `!!${RESMON_COCKPIT_HINTS}`, 10000);
            const bare = await h.ev(`(() => {
                const bar = ${RESMON_COCKPIT_HINTS};
                return {
                    readout: !!${resmonReadout(RESMON_COCKPIT_HINTS)},
                    help: [...(bar?.querySelectorAll('button') ?? [])].some((b) => b.textContent.trim() === '?'),
                };
            })()`);
            await shot("5b-cockpit-empty");
            rec("5b. Cockpit with no roster: the hints bar shows the readout alone, no triage hints or ?",
                bare.readout && !bare.help, JSON.stringify(bare));
        }

        await resmonSeedRoster(h, ctx);
        await h.goto("cockpit");
        await polishWaitFor(h, `!!${RESMON_COCKPIT_HINTS}`, 10000);
        const cockpit = await h.ev(RESMON_COCKPIT_ORDER);
        await shot("6-cockpit");
        rec("6. Cockpit: the readout sits in the cockpit hints bar, after ?",
            cockpit.readout && cockpit.afterHelp && !cockpit.footer, JSON.stringify(cockpit));

        await resmonBlur(h);
        await resmonKey(h, ctx, "g");
        const cockpitLeader = await h.ev(`(() => ({
            leader: [...(${RESMON_FOOTER}?.querySelectorAll('span') ?? [])].some((s) => s.textContent.trim() === 'g →'),
            readouts: document.querySelectorAll('[data-resmon-readout]').length,
            inBar: !!${resmonReadout(RESMON_COCKPIT_HINTS)},
        }))()`);
        await shot("6a-cockpit-leader");
        rec("6a. Cockpit under the g leader: one readout, in the hints bar, and the footer's own yields",
            cockpitLeader.leader && cockpitLeader.readouts === 1 && cockpitLeader.inBar, JSON.stringify(cockpitLeader));
        await resmonKey(h, ctx, "Escape");

        const above = await resmonCockpitOpen(h, ctx);
        await shot("6b-cockpit-open");
        rec("6b. Cockpit: clicking that readout opens the popover above the hints bar",
            above.open && above.bottom <= above.barTop, JSON.stringify(above));

        // 6 and 6b again with the remote chip beside the readout, set through the state the chip reads: remote
        // mode itself stays off, and teardown puts the prior status back
        ctx.prevRemote = await resmonSwapRemote(h, RESMON_REMOTE_OFF);
        ctx.remoteSwapped = true;
        await polishWaitFor(h, `!!${RESMON_COCKPIT_HINTS}?.querySelector('[data-remote-pill]')`, 5000);
        const withChip = await h.ev(RESMON_COCKPIT_ORDER);
        await shot("6c-cockpit-remote");
        rec("6c. Cockpit with the remote chip shown: the readout sits in the cockpit hints bar, after ? and the chip",
            withChip.remote && withChip.chipBefore && withChip.readout && withChip.afterHelp && !withChip.footer,
            JSON.stringify(withChip));

        const aboveChip = await resmonCockpitOpen(h, ctx);
        await shot("6d-cockpit-remote-open");
        rec("6d. Cockpit with the remote chip shown: clicking the readout opens the popover above the hints bar",
            aboveChip.open && aboveChip.bottom <= aboveChip.barTop, JSON.stringify(aboveChip));

        await h.goto("agent");
        await resmonBlur(h);
        const busy = [
            ["7", { busycpu: true }, "high CPU"],
            ["8", { busymem: true }, "high memory"],
            ["9", { busycpu: true, busymem: true }, "high CPU and memory"],
        ];
        for (const [n, flags, words] of busy) {
            await resmonSet(h, { ...resmonFixture(), ...flags });
            await resmonNap(200);
            const text = await h.ev(resmonReadoutText(RESMON_FOOTER));
            await shot(`${n}-busy`);
            rec(`${n}. ${Object.keys(flags).join(" + ")}: the readout shows ${words}`,
                text === `Arc 61% CPU · 7.4 GB ${words}`, text);
        }

        await resmonSet(h, null);
        await resmonNap(200);
        const pending = await h.ev(resmonReadoutText(RESMON_FOOTER));
        await shot("10-pending");
        rec("10. pinned null: the readout shows Arc –", pending === "Arc –", pending);

        await resmonSet(h, { ...resmonFixture(), supported: false });
        await resmonNap(200);
        const footerGone = await h.ev(`!!${RESMON_FOOTER} && !${resmonReadout(RESMON_FOOTER)}`);
        await shot("11a-unsupported-agent");
        await h.goto("cockpit");
        await polishWaitFor(h, `!!${RESMON_COCKPIT_HINTS}`, 10000);
        const barGone = await h.ev(`!!${RESMON_COCKPIT_HINTS} && !${resmonReadout(RESMON_COCKPIT_HINTS)}`);
        await shot("11b-unsupported-cockpit");
        rec("11. supported: false: no readout in the footer or the cockpit hints bar",
            footerGone && barGone, `footer=${footerGone} cockpit=${barGone}`);
        return steps;
    },
    teardown: resmonTeardown,
};

export const resmonMain = {
    name: "resmon-main",
    surface: "agent",
    arrange: resmonArrange,
    async assert(h, ctx) {
        if (!ctx.ready) return RESMON_NO_HOOK;
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const shot = (n) => h.shot(`cdp-shots/resmon-main-${n}.png`);
        const arcRows = async () => (await resmonPopover(h))?.groups.find((g) => g.key === "arc")?.rows;

        await h.ev(resmonClick(resmonReadout(RESMON_FOOTER)));
        await resmonNap(RESMON_REVEAL_MS);
        const s1 = await resmonPopover(h);
        const readoutTop = await h.ev(`${resmonReadout(RESMON_FOOTER)}?.getBoundingClientRect().top`);
        await shot("1-open");
        const ok1 =
            s1 != null &&
            s1.width === 700 &&
            Math.abs(s1.right - 12) <= 1 &&
            s1.bottom <= readoutTop - 5 &&
            JSON.stringify(s1.groups.map((g) => g.key)) === JSON.stringify(RESMON_GROUP_ORDER) &&
            s1.groups.every((g) => g.rows === 0 && g.members.length === 0) &&
            s1.text.includes("2 runs · 2 agent tabs · 31 processes") &&
            /cache-miss notice\s*Run · 2 agents · 9 processes/.test(s1.groups[2].header) &&
            /cleanup round\s*Run · 1 command · 4 processes/.test(s1.groups[3].header);
        rec("1. click the readout: 700px, bottom-right; Arc first, then by CPU, every view collapsed; one view per run, not per worker",
            ok1, JSON.stringify({ width: s1?.width, right: s1?.right, bottom: s1?.bottom, readoutTop, groups: s1?.groups }));

        const hot = resmonFixture();
        hot.groups.find((g) => g.key === "job:7716").cpu = 99;
        await resmonSet(h, hot);
        await resmonNap(200);
        const held = (await resmonPopover(h))?.groups.map((g) => g.key);
        await shot("1a-held-order");
        rec("1a. a refresh that ranks the last view first leaves the open popover's order alone",
            JSON.stringify(held) === JSON.stringify(RESMON_GROUP_ORDER), JSON.stringify(held));
        await resmonSet(h, resmonFixture());

        for (const k of RESMON_GROUP_ORDER.slice(1)) {
            await h.ev(resmonClick(resmonChevron(k)));
        }
        await resmonNap(200);
        const s1b = await resmonPopover(h);
        await shot("1b-runs-open");
        const by = (k) => s1b?.groups.find((g) => g.key === k) ?? { members: [] };
        const [lead, task2] = by("run:run-a").members;
        const [verifyCmd] = by("run:run-b").members;
        const [tab] = by("job:14820").members;
        const ok1b =
            by("run:run-a").members.map((m) => m.role).join(",") === "Lead,Task 2" &&
            lead.folded === "+3" && /wsh\.exe \(control\)/.test(lead.foldedTitle) && !lead.killChildren &&
            lead.icon === "Claude Code logo" &&
            task2.folded === "+2" && task2.killChildren && task2.icon === "Pi logo" &&
            by("run:run-a").rows === 2 && by("run:run-a").kills === 2 &&
            verifyCmd.role === "Verify" && verifyCmd.readOnly && !verifyCmd.killChildren && verifyCmd.icon === "svg" &&
            by("run:run-b").rows === 3 && by("run:run-b").kills === 0 &&
            tab.role === "Agent" && tab.folded === "+1" && tab.killChildren &&
            by("job:14820").rows === 5 && by("job:14820").kills === 5 &&
            by("job:7716").rows === 0 && !by("job:7716").members[0]?.killChildren;
        rec("1b. opened: a run lists its lead and workers by role, each one line with its core folded (+N) and the processes it started under it; Verify is read-only",
            ok1b, JSON.stringify(s1b?.groups.slice(1)));

        await h.ev(resmonClick(resmonChevron("arc")));
        await resmonNap(200);
        const expanded = await arcRows();
        await shot("2a-arc-expanded");
        await h.ev(resmonClick(resmonChevron("arc")));
        await resmonNap(200);
        const collapsed = await arcRows();
        await shot("2b-arc-collapsed");
        rec("2. Arc's chevron expands it, a second click collapses it", expanded === 9 && collapsed === 0,
            `expanded=${expanded} collapsed=${collapsed}`);

        await resmonKey(h, ctx, "ArrowDown");
        const c3 = (await resmonPopover(h))?.cursor;
        await resmonKey(h, ctx, "Enter");
        const opened3 = await arcRows();
        await shot("3-cursor-enter");
        rec("3. ↓ puts the cursor on Arc's header, ⏎ expands it", c3 === "arc" && opened3 === 9,
            `cursor=${c3} arcRows=${opened3}`);

        await h.ev(resmonClick(resmonRowKill(18311)));
        await resmonNap(200);
        const c4 = (await resmonPopover(h))?.confirm;
        await shot("4-row-confirm");
        rec("4. × on orchestrate.test.exe asks to kill it alone",
            c4 === "Kill orchestrate.test.exe (18311)? It has no child processes.", c4);

        await resmonBlur(h);
        await resmonKey(h, ctx, "Escape");
        const s5 = await resmonPopover(h);
        await shot("5-esc-cancel");
        rec("5. Esc removes the confirm and leaves the popover open", s5 != null && s5.confirm == null,
            `open=${s5 != null} confirm=${s5?.confirm}`);

        const reached = await resmonCursorTo(h, ctx, 18244);
        await resmonKey(h, ctx, "x");
        const c6 = (await resmonPopover(h))?.confirm;
        await resmonArm(h, { outcome: "killed", killed: 2 });
        await resmonKey(h, ctx, "Enter");
        await resmonNap(200);
        const s6 = await resmonPopover(h);
        await shot("6-killed");
        rec("6. x on go.exe asks for it and its child; ⏎ kills and notes it",
            reached && c6 === "Kill go.exe (18244) and its 1 child process?" &&
                s6?.status.includes("Killed go.exe (18244) and 1 child process."),
            JSON.stringify({ reached, confirm: c6, status: s6?.status }));

        await resmonKey(h, ctx, "Escape");
        await resmonNap(RESMON_REVEAL_MS);
        const gone7 = await h.ev(`!${RESMON_POPOVER}`);
        await shot("7-esc-close");
        rec("7. Esc closes the popover", gone7, `closed=${gone7}`);

        await h.ev(resmonClick(resmonReadout(RESMON_FOOTER)));
        await resmonNap(RESMON_REVEAL_MS);
        const reopened = await h.ev(`!!${RESMON_POPOVER}`);
        // a real pointer press on the Agent surface, clear of the popover and the footer
        const press = { x: 400, y: 300, button: "left", clickCount: 1 };
        await h.cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...press });
        await h.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...press });
        await resmonNap(RESMON_REVEAL_MS);
        const gone8 = await h.ev(`!${RESMON_POPOVER}`);
        await shot("8-outside-click");
        rec("8. a click outside the popover and the readout closes it", reopened && gone8,
            `reopened=${reopened} closed=${gone8}`);
        return steps;
    },
    teardown: resmonTeardown,
};

export const resmonStates = {
    name: "resmon-states",
    surface: "agent",
    arrange: resmonArrange,
    async assert(h, ctx) {
        if (!ctx.ready) return RESMON_NO_HOOK;
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const shot = (n) => h.shot(`cdp-shots/resmon-states-${n}.png`);

        await resmonSet(h, null);
        await h.ev(`window.__resmonFixture.open()`);
        await resmonNap(RESMON_REVEAL_MS);
        const s1 = await resmonPopover(h);
        await shot("1-loading");
        rec("1. pinned null: the loading body",
            s1?.status.includes("Reading agent processes…") && s1.groups.length === 0, JSON.stringify(s1?.status));

        await resmonSet(h, { ...resmonFixture(), groups: [resmonArcGroup(Date.now())] });
        await resmonNap(200);
        const s2 = await resmonPopover(h);
        await shot("2-empty");
        rec("2. Arc only: the empty body",
            s2?.groups.length === 1 && s2.text.includes("No agent processes") &&
                s2.text.includes("Agent tabs, run workers and run commands show here while they run."),
            JSON.stringify(s2?.groups));

        await resmonSet(h, resmonFixture());
        await resmonNap(200);
        await resmonBlur(h);
        const onHeader = await resmonCursorTo(h, ctx, "job:14820");
        await resmonKey(h, ctx, "X");
        const c3 = (await resmonPopover(h))?.confirm;
        const want3 = "Kill 5 processes under waveterm? claude.exe and its console keep running.";
        await shot("3a-children-confirm");
        await h.ev(resmonClick(resmonConfirmButton("Cancel")));
        await resmonNap(200);
        const cancelled = (await resmonPopover(h))?.confirm == null;
        await shot("3b-cancelled");
        rec("3. ⇧X on waveterm's header asks to kill its 5 children; Cancel closes it",
            onHeader && c3 === want3 && cancelled, JSON.stringify({ onHeader, confirm: c3, cancelled }));

        await h.ev(resmonClick(resmonGroupButton("job:14820", "Kill children")));
        await resmonNap(200);
        const c4 = (await resmonPopover(h))?.confirm;
        await resmonArm(h, { outcome: "killed", killed: 5 });
        const clicked4 = await h.ev(resmonClick(resmonConfirmButton("Kill 5")));
        await resmonNap(300);
        const s4 = await resmonPopover(h);
        await shot("4-children-killed");
        rec("4. Kill children opens the same confirm; Kill 5 notes Killed 5 processes.",
            c4 === want3 && clicked4 && s4?.status.includes("Killed 5 processes."),
            JSON.stringify({ confirm: c4, clicked: clicked4, status: s4?.status }));

        // Task 2's rows sit in the run's view, which starts collapsed
        await h.ev(resmonClick(resmonChevron("run:run-a")));
        await resmonNap(200);
        await resmonArm(h, { outcome: "gone", killed: 0 });
        await h.ev(resmonClick(resmonRowKill(21890)));
        await resmonNap(200);
        const clicked5 = await h.ev(resmonClick(resmonConfirmButton("Kill")));
        await resmonNap(300);
        const s5 = await resmonPopover(h);
        await shot("5-gone");
        rec("5. gone: node.exe (21890) had already exited.",
            clicked5 && s5?.status.includes("node.exe (21890) had already exited."), JSON.stringify(s5?.status));

        // the × above left the cursor on node.exe (21890), so x asks for it again
        const alerts = [
            ["6-refused", { outcome: "refused", killed: 0 },
                (a) => a === "Not killed: pid 21890 no longer belongs to this run worker. The list refreshes in 2s.",
                "6. refused: the alert says the pid left this run worker"],
            ["7-protected", { outcome: "protected", killed: 0 },
                (a) => a.startsWith("Not killed: node.exe (21890) is the agent's own process."),
                "7. protected: the alert names the agent's own process"],
            ["8-failed", { outcome: "failed", killed: 0, error: "Access is denied." },
                (a) => /^Could not kill .+: Access is denied\. It is still running\.$/.test(a),
                "8. failed: the alert carries the OS error and says it is still running"],
        ];
        for (const [n, outcome, check, step] of alerts) {
            await resmonBlur(h);
            await resmonArm(h, outcome);
            await resmonKey(h, ctx, "x");
            const confirm = (await resmonPopover(h))?.confirm;
            await resmonKey(h, ctx, "Enter");
            await resmonNap(300);
            const alert = (await resmonPopover(h))?.alert ?? [];
            await shot(n);
            rec(step, confirm != null && alert.length === 1 && check(alert[0]), JSON.stringify({ confirm, alert }));
        }
        return steps;
    },
    teardown: resmonTeardown,
};

export const agentLaunchHero = {
    name: "agent-launch-hero",
    surface: "agent",
    async arrange() {
        return {};
    },
    async assert(h) {
        await lookOpen(h, "agent");
        const s = await lookEval(h, `
            const title = () => [...document.querySelectorAll("div")].find((d) => d.children.length === 0 && flat(d) === "No terminal running");
            await until(() => title() != null, 4000);
            // the recent sessions load after mount
            await until(() => /Recent sessions/.test(flat(document.body)), 3000);
            const list = [...document.querySelectorAll("span")].find((x) => flat(x) === "Recent sessions")?.closest(".rounded-lg");
            return {
                hero: title() != null,
                cta: button(document, /^New agent/) != null,
                sessions: list ? list.querySelectorAll("button").length : 0,
            };
        `);
        if (!s.hero) {
            return [skipStep("the Agent surface with nothing focused shows the launch hero", "an agent is focused in this profile - run it on a fresh store (final-verify.mjs)")];
        }
        await h.shot(lookShot("agent-launch-hero"));
        const heroFloor = await lookEval(h, `
            const title = [...document.querySelectorAll("div")].find((d) => d.children.length === 0 && flat(d) === "No terminal running");
            return floorWalk([title?.closest("div.h-full.w-full") ?? null]);
        `);
        // the CTA's label says what it opens
        const opened = await lookEval(h, `
            button(document, /^New agent/)?.click();
            return until(() => [...document.querySelectorAll('[role="dialog"] h2')].some((x) => flat(x) === "New agent"), 3000);
        `);
        const modalFloor = await lookEval(h, `await nap(300); return floorWalk([dialog() ?? document.querySelector('[role="dialog"]')]);`);
        // the modal rides newAgentOpenAtom, not modalsModel: its own close button shuts it
        await lookEval(h, `document.querySelector('[role="dialog"] button[aria-label="Close"]')?.click();`);
        return [
            {
                step: "the Agent surface with nothing focused shows No terminal running, its New agent CTA and the recent sessions to resume",
                ok: s.cta,
                detail: JSON.stringify(s),
            },
            { step: "New agent opens the New agent modal", ok: opened === true, detail: `opened=${opened}` },
            { step: `no visible text in the launch hero is under ${MIN_FONT_PX}px`, ok: floorOk(heroFloor), detail: floorDetail(heroFloor) },
            { step: `no visible text in the New agent modal is under ${MIN_FONT_PX}px`, ok: floorOk(modalFloor), detail: floorDetail(modalFloor) },
        ];
    },
    async teardown() {},
};

// a shell terminal of the page's own workspace, focused on the Agent surface
const LOOK_TERM_LABEL = "look term";
const LOOK_TERM_URL = "https://example.com/arc/look-term-link";
const LOOK_TERM_WAIT_MS = 15_000;

export const termLinkTooltip = {
    name: "term-link-tooltip",
    surface: "agent",
    async arrange(h) {
        try {
            return await openOwnTerminal(h, LOOK_TERM_LABEL);
        } catch (e) {
            return { launchError: String(e?.message ?? e) };
        }
    },
    async assert(h, ctx) {
        const step = "hovering a URL the terminal printed shows the open-link tooltip";
        if (ctx.launchError != null) return [skipStep(step, `could not verify: the terminal launch failed: ${ctx.launchError}`)];
        await lookOpen(h, "agent");
        const row = `document.querySelector('[data-tree-terminal="${ctx.tabId}"]')`;
        await polishWaitFor(h, `!!${row}`, LOOK_TERM_WAIT_MS);
        await h.ev(`${row}?.click()`);
        const screenVisible = `[...document.querySelectorAll(".xterm-screen")].find((x) => x.checkVisibility())`;
        const ready = await polishWaitFor(h, `!!${screenVisible}`, LOOK_TERM_WAIT_MS);
        // the shell's banner and first prompt land before the cls, so the URL prints at the top
        await polishNap(2500);
        const typed = `cls; echo ${LOOK_TERM_URL}\r`;
        await h.rpc("controllerinput", { blockid: ctx.blockId, inputdata64: Buffer.from(typed).toString("base64") });
        await polishNap(2000);
        const rect = await h.ev(`(() => { const r = ${screenVisible}?.getBoundingClientRect(); return r ? { left: r.left, top: r.top } : null; })()`);
        // the URL's row is found by the pointer the link layer sets over it: the prompt's row holds it too, past
        // where the pointer runs, so the first pointer row is the echo's
        let at = null;
        for (let dy = 4; rect && dy < 240 && at == null; dy += 4) {
            const p = { x: Math.round(rect.left + 60), y: Math.round(rect.top + dy) };
            await lookHover(h, p.x, p.y);
            await polishNap(60);
            if (await h.ev(`${screenVisible}?.classList.contains("xterm-cursor-pointer") ?? false`)) at = p;
        }
        const shown = at != null && (await polishWaitFor(h, `/click to open link/.test(document.body.innerText)`, 2000));
        const look = shown === true ? await h.ev(LOOK_TOOLTIP_STYLE) : null;
        const chip = shown === true ? await h.ev(`[...document.querySelectorAll("[data-tooltip] kbd")].map((k) => k.textContent).join("|")`) : null;
        await h.shot(lookShot("term-link-tooltip"));
        const modKey = process.platform === "darwin" ? "Cmd" : "Ctrl";
        return [
            { step, ok: ready && shown === true, detail: JSON.stringify({ ready, rect, at, shown }) },
            {
                step: `the tooltip reads ${modKey} + click to open link, the modifier in a kbd chip`,
                ok: look?.text.replace(/\s+/g, " ").trim() === `${modKey} + click to open link` && chip === modKey,
                detail: JSON.stringify({ look, chip }),
            },
            { step: "it wears the shared tooltip look", ok: tooltipLookOk(look), detail: JSON.stringify(look) },
        ];
    },
    async teardown(h, ctx) {
        await lookHover(h, 1, 1);
        await closeOwnTerminal(h, ctx, "term-link-tooltip");
        await h.goto("cockpit");
    },
};

// AgentComposer on the mixed fixture roster: the parked idle list's row composer (janitor), and a working card's
// composer expanded from its slim row (waveterm)
const LOOK_COMPOSER_IDLE = "janitor";
const LOOK_COMPOSER_CARD = "waveterm";
const lookComposer = (name) => `document.querySelector('textarea[placeholder="message ${name}…"]')`;

export const agentComposer = {
    name: "agent-composer",
    surface: "cockpit",
    async arrange(h) {
        mkdirSync(new URL(".", TREE_RAIL_FIXTURE), { recursive: true });
        writeFileSync(TREE_RAIL_FIXTURE, JSON.stringify(COCKPIT_FIXTURES.mixed(Date.now()), null, 2));
        // the fixture roster is read once at boot
        await h.reload();
        return { wroteFixture: true };
    },
    async assert(h) {
        const steps = [];
        await lookOpen(h, "cockpit");
        const idle = await lookEval(h, `
            const header = () => [...document.querySelectorAll("div.cursor-pointer")].find((el) => /^Idle\\s*\\d+$/i.test(flat(el)));
            await until(() => header() != null, 8000);
            header()?.click();
            const ok = await until(() => ${lookComposer(LOOK_COMPOSER_IDLE)} != null, 3000);
            ${lookComposer(LOOK_COMPOSER_IDLE)}?.scrollIntoView({ block: "center" });
            await nap(500);
            return { header: header() != null, ok };
        `);
        await h.shot(lookShot("agent-composer-idle"));
        steps.push({ step: "the opened Idle list gives each parked idle agent a message composer", ok: idle.ok, detail: JSON.stringify(idle) });
        // :focus never matches while the dev window is behind another one
        await h.cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
        const card = await lookEval(h, `
            const slim = [...document.querySelectorAll("div.cursor-text")].find((el) => flat(el).startsWith("message ${LOOK_COMPOSER_CARD}…"));
            slim?.scrollIntoView({ block: "center" });
            slim?.click();
            const ta = () => ${lookComposer(LOOK_COMPOSER_CARD)};
            const ok = await until(() => ta() != null, 3000);
            if (ok) {
                const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
                set.call(ta(), "keep the old session cookie name for one release");
                ta().dispatchEvent(new Event("input", { bubbles: true }));
            }
            await nap(500);
            if (!ok) return { slim: slim != null, ok };
            ta().focus();
            await nap(100);
            const send = button(ta().parentElement, /^Send$/);
            // every clipping ancestor, the card's scroll region included, must show Send and the textarea whole
            const clips = [];
            for (let p = ta().parentElement; p; p = p.parentElement) {
                if (getComputedStyle(p).overflow !== "visible") clips.push(p);
            }
            const inside = (el) => clips.every((c) => el.getBoundingClientRect().bottom <= c.getBoundingClientRect().bottom + 0.5);
            const idleTa = ${lookComposer(LOOK_COMPOSER_IDLE)};
            return {
                slim: slim != null,
                ok,
                sendEnabled: send?.disabled === false,
                focusEdge: getComputedStyle(ta()).borderTopColor,
                restEdge: idleTa ? getComputedStyle(idleTa).borderTopColor : null,
                unclipped: inside(ta()) && send != null && inside(send),
                oneLine: ta().offsetHeight <= 34,
            };
        `);
        await h.shot(lookShot("agent-composer-card"));
        await h.cdp("Emulation.setFocusEmulationEnabled", { enabled: false });
        steps.push({
            step: "a working card's composer expands from its slim row and enables Send once it holds a message",
            ok: card.ok && card.sendEnabled === true,
            detail: JSON.stringify(card),
        });
        steps.push({
            step: "the focused composer shows a focus edge, stays one line tall for a one-line message, and its textarea and Send sit inside the card",
            ok: card.ok && card.restEdge != null && card.focusEdge !== card.restEdge && card.unclipped === true && card.oneLine === true,
            detail: JSON.stringify(card),
        });
        steps.push(await floorStep(h, `no visible text on the Cockpit, its Idle list open, is under ${MIN_FONT_PX}px`, COCKPIT));
        return steps;
    },
    async teardown(h, ctx) {
        if (ctx.wroteFixture) rmSync(TREE_RAIL_FIXTURE, { force: true });
        await h.reload();
        await h.goto("cockpit");
    },
};

// --- remote-hand: the Agent header's Hand to phone button -------------------------------------------------------
// A fixture roster holds one plain claude agent with a terminal block. Step 2 sets a handed-over status into
// remoteStatusAtom through the app's store module, as remote-switch does; step 3 clicks the button against the
// real RemoteHandCommand, which refuses: the dev store has no remote setup, and the fixture tab is no live agent.
const REMOTE_HAND_ID = "fx-remote-hand";
// long enough to truncate, so the pills beside it are under pressure and must keep their own width
const REMOTE_HAND_NAME =
    "phone candidate reviewing the council multi-agent expert panel design and every report it attaches, then each reviewer's follow-up notes on the panel";
const REMOTE_HAND_BTN = `document.querySelector('[data-agent-header] [data-hand-to-phone]')`;
const REMOTE_HAND_TOAST = `document.querySelector('[data-notification-toast="error"]')`;
// the hand-over waits up to the switch's 15 s timeout before it fails
const REMOTE_HAND_REFUSE_MS = 20000;
const REMOTE_HAND_READ = `(() => {
    const btn = ${REMOTE_HAND_BTN};
    const full = btn?.nextElementSibling;
    const nameRow = document.querySelector('[data-agent-header] [data-agent-state-pill]')?.parentElement;
    const [nameEl, ...pills] = nameRow ? [...nameRow.children] : [];
    const probe = document.createElement("span");
    probe.className = "text-accent";
    document.body.appendChild(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    const cs = btn ? getComputedStyle(btn) : null;
    return {
        btn: btn != null,
        text: (btn?.textContent || "").trim(),
        label: btn?.getAttribute("aria-label") ?? null,
        iconOnly: btn != null && btn.querySelector("svg") != null && (btn.textContent || "").trim() === "",
        title: btn?.title ?? null,
        pressed: btn?.getAttribute("aria-pressed") ?? null,
        leftOfFullscreen: (full?.title || "").startsWith("Fullscreen terminal") && btn.getBoundingClientRect().right <= full.getBoundingClientRect().left,
        accentText: cs != null && cs.color === accent,
        accentEdge: cs != null && cs.borderTopColor === accent,
        pill: document.querySelector('[data-remote-pill]') != null,
        nameTruncated: nameEl != null && nameEl.scrollWidth > nameEl.clientWidth,
        // one line: no taller than the fullscreen button beside it
        oneLine: btn != null && full != null && btn.getBoundingClientRect().height <= full.getBoundingClientRect().height + 1,
        pillsFit: pills.length >= 2 && pills.every((p) => p.scrollWidth <= p.clientWidth + 1),
    };
})()`;
const remoteHandStatus = (h, status) =>
    lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const { remoteStatusAtom } = await mod("app/view/agents/remotestore.ts");
        globalStore.set(remoteStatusAtom, ${JSON.stringify(status)});
        return true;
    `);
const remoteHandReload = (h) =>
    lookEval(h, `
        await (await mod("app/view/agents/remotestore.ts")).loadRemoteStatus();
        return true;
    `);

export const remoteHand = {
    name: "remote-hand",
    surface: "agent",
    async arrange(h) {
        const ctx = {};
        try {
            // a real block with no controller, so the focused agent's terminal resyncs instead of reading failed to start
            const { blockId } = await makeTab(h, ctx, { label: `verify-${REMOTE_HAND_ID}`, blockMeta: { view: "term", controller: null } });
            mkdirSync(new URL(".", TREE_RAIL_FIXTURE), { recursive: true });
            writeFileSync(
                TREE_RAIL_FIXTURE,
                JSON.stringify(
                    [
                        {
                            id: REMOTE_HAND_ID,
                            name: REMOTE_HAND_NAME,
                            project: "waveterm",
                            task: REMOTE_HAND_NAME,
                            state: "idle",
                            agent: "claude",
                            model: "opus",
                            idleSince: Date.now() - 60_000,
                            blockId,
                        },
                    ],
                    null,
                    2
                )
            );
            ctx.wroteFixture = true;
            // the fixture roster is read once at boot
            await h.reload();
            await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
            await h.goto("agent");
            ctx.focused = await h.ev(`(async () => {
                for (let i = 0; i < 40; i++) {
                    const tree = document.querySelector("[data-agent-tree]");
                    const label = tree && [...tree.querySelectorAll("div")].find(
                        (d) => d.textContent.trim() === ${JSON.stringify(REMOTE_HAND_NAME)} && d.children.length === 0
                    );
                    const row = label && label.closest(".cursor-pointer");
                    if (row) {
                        row.click();
                        return true;
                    }
                    await new Promise((r) => setTimeout(r, 250));
                }
                return false;
            })()`);
            await remoteHandReload(h);
            await polishWaitFor(h, `${REMOTE_HAND_BTN} != null`, 5000);
            await polishNap(500);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const shot = (n) => h.shot(`cdp-shots/remote-hand-${n}.png`);

        const idle = await h.ev(REMOTE_HAND_READ);
        await shot("1-hand");
        rec(
            "1. a plain claude agent's header shows the icon-only Hand to phone button left of the fullscreen button, and its long name truncates without squeezing the pills",
            ctx.arrangeError == null && ctx.focused === true && idle.nameTruncated && idle.pillsFit && idle.iconOnly && idle.label === "Hand to phone" && idle.title === "Hand to phone: turns remote mode on (p)" && idle.pressed === "false" && idle.leftOfFullscreen && !idle.accentText,
            ctx.arrangeError ?? JSON.stringify({ focused: ctx.focused, ...idle })
        );

        await remoteHandStatus(h, { on: true, tunnel: "up", subscriptions: 0, handed: [REMOTE_HAND_ID] });
        await polishWaitFor(h, `(${REMOTE_HAND_BTN}?.textContent || "").includes("On phone")`, 3000);
        await polishNap(300);
        const handed = await h.ev(REMOTE_HAND_READ);
        await shot("2-on-phone");
        rec(
            "2. handed over: the button reads On phone · Take back on one line in the accent style, and the Remote on pill shows",
            handed.text === "On phone · Take back" && handed.oneLine && handed.pillsFit && handed.title === "Take back from the phone (p)" && handed.pressed === "true" && handed.accentText && handed.accentEdge && handed.pill,
            JSON.stringify(handed)
        );

        await remoteHandReload(h);
        await polishWaitFor(h, `${REMOTE_HAND_BTN}?.getAttribute("aria-pressed") === "false"`, 3000);
        await h.ev(`${REMOTE_HAND_BTN}?.click()`);
        const toasted = await polishWaitFor(h, `${REMOTE_HAND_TOAST} != null`, REMOTE_HAND_REFUSE_MS);
        await polishNap(300);
        const refused = await h.ev(REMOTE_HAND_READ);
        const toast = await h.ev(`(${REMOTE_HAND_TOAST}?.textContent || "").trim()`);
        await shot("3-refused");
        rec(
            "3. the real hand-over refuses: an error toast says why, and the button is back to the Hand to phone icon",
            toasted && toast.startsWith("Couldn't hand the agent to the phone") && toast.length > "Couldn't hand the agent to the phone".length && refused.iconOnly && refused.pressed === "false",
            JSON.stringify({ toasted, toast, ...refused })
        );
        return steps;
    },
    async teardown(h, ctx) {
        await remoteHandReload(h).catch(() => {});
        await closeTabs(h, ctx);
        if (ctx.wroteFixture) rmSync(TREE_RAIL_FIXTURE, { force: true });
        await h.reload();
        await h.goto("cockpit");
    },
};

