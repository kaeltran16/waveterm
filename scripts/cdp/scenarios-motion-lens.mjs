// motion-lens: the motion sweep's moments on the Workflow lens, the design canvas, the doc review dialog and the Diff
// surface's comment bar (docs/superpowers/plans/2026-11-10-motion-sweep.md, and the follow-ups' section 6). The data is
// workflow-scan's (its deferred run, whose record each step rewrites), canvas-tabs' two-board canvas,
// brainstorm-answer-boards' question, doc-review's fixture roster and diff-comments' repo. RPCs whose busy label or
// error a step reads are answered on the page, so no scan, send or prompt reaches the server. Each moment is sampled in-page: an
// observer reads what a node mounts with, and a frame sampler reads a value every animation frame, because a CDP round
// trip per sample is slower than the motion.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { CANVAS_TABS, CANVAS_TABS_TOPIC, CANVAS_TREE_TAG, canvasTabsScenario, dragMarkBox } from "./scenarios-agent.mjs";
import { BS_KIT, brainstormAnswerBoards } from "./scenarios-brainstorm.mjs";
import { DOC_REVIEW_LEAD_ID, DOC_REVIEW_PANEL } from "./scenarios-cockpit.mjs";
import { docReview } from "./scenarios-doc-review.mjs";
import { diffComments } from "./scenarios-files.mjs";
import { CANVAS_PANE, UI_ROUTE, failRpc, lookEval, polishNap, polishWaitFor, releaseRpc, setInputExpr } from "./scenarios-shared.mjs";
import { WFS_LENS, workflowScan, wfsScan, wfsSeed } from "./scenarios-usage.mjs";

const VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const SETTLE_MS = 700;
// how long a frame sampler waits for the end state it asserts, well above a solo animation's ~530 ms
const SAMPLER_END_WAIT_MS = 4000;
// after the end state is reached, so the sampler records the resting frame
const REST_FRAME_MS = 100;
const CANVAS_REMOVED_WAIT_MS = 6000;
// past two of the canvas poller's 3s ticks
const CANVAS_POLL_WAIT_MS = 8000;
// a passage of doc-review's fixture plan, quoted in the review dialog
const DOC_PASSAGE = "small plan";
const { bsShowFile, BS_PANE, BS_POLL_WAIT_MS } = BS_KIT;

const ADDED_TEXT_CHARS = 40;
// records each added node matching sel (itself or a descendant) with what read (a function body over el) returns
const watchAdded = (sel, read = "return getComputedStyle(el).opacity;") => `(() => {
    window.__mlObs?.disconnect();
    window.__mlAdded = [];
    const sel = ${JSON.stringify(sel)};
    const read = (el) => { ${read} };
    window.__mlObs = new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
            if (!(n instanceof Element)) continue;
            for (const el of [n, ...n.querySelectorAll(sel)]) {
                if (el.matches(sel)) window.__mlAdded.push({ text: el.textContent.trim().slice(0, ${ADDED_TEXT_CHARS}), value: read(el) });
            }
        }
    });
    window.__mlObs.observe(document.body, { childList: true, subtree: true });
    return true;
})()`;
const readAdded = `(() => { window.__mlObs?.disconnect(); return window.__mlAdded ?? []; })()`;
// the text watchAdded records for a node reading text
const addedText = (text) => text.slice(0, ADDED_TEXT_CHARS);

// reads expr (a function body returning a value) every animation frame until stopped
const startFrames = (expr) => `(() => {
    const f = { on: true, values: [] };
    window.__mlFrames = f;
    const read = () => { try { ${expr} } catch { return null; } };
    const tick = () => {
        f.values.push(read());
        if (f.on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return true;
})()`;
const stopFrames = `(() => { window.__mlFrames.on = false; return window.__mlFrames.values; })()`;
const distinct = (values) => values.filter((v, i) => v != null && v !== values[i - 1]);

// an element's x translation from its computed matrix, 0 for none
const translateX = (elExpr) => `const el = ${elExpr};
    if (!el) return null;
    const t = getComputedStyle(el).transform;
    return t === "none" ? 0 : Math.round(Number(t.slice(t.indexOf("(") + 1).split(",")[4]) * 10) / 10;`;
// how much of a DrawCheck's stroke is drawn: motion writes pathLength as the dash array's first value
const checkDrawn = (stage) => `const d = document.querySelector('[data-workflow-stage="${stage}"] svg path')?.getAttribute('stroke-dasharray');
    return d == null ? null : Math.round(Number(d.split(/[ ,]+/)[0]) * 100) / 100;`;

// a run record whose scan is wfsScan's fixture; extra overrides wfsScan's fixture fields
const scanAt = (ctx, extra) => (run) => ({ ...run, workflowscan: wfsScan(ctx, extra) });

// Replies to every call of an RPC after `ms`, refusing it with `message` or passing it with null, without reaching the
// server, until releaseRpc puts the original back. The delay holds a busy label up long enough to read it settled.
const replyAfter = (h, command, ms, message = null) =>
    lookEval(h, `
        const { RpcApi } = await mod("app/store/wshclientapi.ts");
        (window.__heldRpc ??= {})[${JSON.stringify(command)}] ??= RpcApi[${JSON.stringify(command)}];
        RpcApi[${JSON.stringify(command)}] = () =>
            new Promise((ok, no) => setTimeout(() => (${message != null} ? no(new Error(${JSON.stringify(message)})) : ok(null)), ${ms}));
        return true;
    `);
// how long a stubbed RPC holds its busy label, and when inside that hold the label is read settled
const HOLD_MS = 1200;
const BUSY_READ_MS = 500;
const START_REFUSAL = "motion-lens refused this scan on the page";
const START_REFUSAL_AGAIN = "motion-lens refused this scan again";
const SEND_REFUSAL = "motion-lens refused these picks on the page";
const PROMPT_REFUSAL = "motion-lens refused this prompt on the page";

// the opacity of every node matching sel, as strings
const opacities = (sel) => `[...document.querySelectorAll(${JSON.stringify(sel)})].map((el) => getComputedStyle(el).opacity)`;
// a nudge moved both ways off 0 and came back to rest
const nudged = (xs) => xs.some((x) => x < 0) && xs.some((x) => x > 0) && xs.at(-1) === 0;
// a reveal's sampled heights start at 0, pass through a value short of the last, and end open
const grewOpen = (hs) => hs[0] === 0 && hs.at(-1) > 0 && hs.some((v) => v > 0 && v < hs.at(-1));

export const motionLens = {
    name: "motion-lens",
    surface: "usage",
    arrange: (h) => workflowScan.arrange(h),
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok: !!ok, detail: JSON.stringify(detail) });
        const settle = (ms = SETTLE_MS) => polishNap(ms);
        await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
        rec("1. the workflow-scan fixture run is open on Usage > Workflow", ctx.arrangeError == null && ctx.shown, {
            arrangeError: ctx.arrangeError ?? null,
            shown: ctx.shown,
        });
        if (ctx.arrangeError != null || !ctx.shown) return steps;

        // 2. idle -> scanning fades the new phase in; a stage finishing draws its check; the kept count rolls
        await h.ev(watchAdded(`[data-view-swap="scanning"]`));
        const scanning = await wfsSeed(h, ctx, "scanning", scanAt(ctx, { state: "scanning", stage: "patterns" }));
        await settle();
        const phaseAdded = await h.ev(readAdded);
        const phaseSettled = await h.ev(`getComputedStyle(document.querySelector('[data-view-swap="scanning"]')).opacity`);
        await h.ev(startFrames(checkDrawn("Sonnet patterns")));
        await wfsSeed(h, ctx, "scanning", scanAt(ctx, { state: "scanning", stage: "recount" }));
        const recounted = await polishWaitFor(h, `!!document.querySelector('[data-workflow-detail="recount"]')`, 5000);
        await settle();
        const draw = distinct(await h.ev(stopFrames));
        const survivors = wfsScan(ctx).survivors;
        await wfsSeed(h, ctx, "scanning", scanAt(ctx, { state: "scanning", stage: "checking", verdicts: [], survivors: survivors.slice(0, 3) }));
        const three = await polishWaitFor(h, `/Opus checks 3 patterns/.test(document.querySelector('[data-workflow-detail="checking"]')?.textContent ?? '')`, 5000);
        await settle(300);
        await h.ev(watchAdded(`[data-workflow-detail="checking"] .inline-block`));
        await wfsSeed(h, ctx, "scanning", scanAt(ctx, { state: "scanning", stage: "checking", verdicts: [], survivors }));
        const five = await polishWaitFor(h, `/Opus checks 5 patterns/.test(document.querySelector('[data-workflow-detail="checking"]')?.textContent ?? '')`, 5000);
        await settle(500);
        const rolled = await h.ev(readAdded);
        await h.shot("cdp-shots/motion-lens-scanning.png");
        rec(
            "2. scanning fades in from opacity 0; Sonnet patterns finishing draws its check through part-drawn frames; the kept count rolls 3 -> 5",
            scanning &&
                phaseAdded[0]?.value === "0" &&
                phaseSettled === "1" &&
                recounted &&
                draw.some((d) => d > 0 && d < 1) &&
                draw.at(-1) === 1 &&
                three &&
                five &&
                rolled.some((r) => r.text === "5" && r.value === "0"),
            { scanning, phaseAdded, phaseSettled, recounted, draw, three, five, rolled }
        );

        // 3. picking: the phase fades in, a card's more quotes grow open, and Drop reveals the reason field
        await h.ev(watchAdded(`[data-view-swap="picking"]`));
        const picking = await wfsSeed(h, ctx, "picking", scanAt(ctx));
        await settle();
        const pickAdded = await h.ev(readAdded);
        const MORE_HEIGHT = `const b = document.querySelector('[data-workflow-card="p1"] [data-workflow-more]');
            const w = b?.previousElementSibling;
            return w && w.classList.contains('overflow-hidden') ? w.offsetHeight : 0;`;
        await h.ev(startFrames(MORE_HEIGHT));
        await h.ev(`document.querySelector('[data-workflow-card="p1"] [data-workflow-more]')?.click()`);
        await settle();
        const more = distinct(await h.ev(stopFrames));
        await h.ev(watchAdded(`[data-workflow-reason]`, "return getComputedStyle(el.parentElement).opacity;"));
        await h.ev(`document.querySelector('[data-workflow-card="p3"] [data-workflow-pick="drop"]')?.click()`);
        const reasonShown = await polishWaitFor(h, `!!document.querySelector('[data-workflow-reason="p3"]')`, 3000);
        await settle();
        const reasonAdded = await h.ev(readAdded);
        const reasonSettled = await h.ev(`getComputedStyle(document.querySelector('[data-workflow-reason="p3"]').parentElement).opacity`);
        await h.shot("cdp-shots/motion-lens-picking.png");
        rec(
            "3. picking fades in from 0; + more grows its quotes open through intermediate heights; Drop reveals the reason field from opacity 0",
            picking &&
                pickAdded[0]?.value === "0" &&
                more[0] === 0 &&
                more.at(-1) > 0 &&
                more.some((v) => v > 0 && v < more.at(-1)) &&
                reasonShown &&
                reasonAdded[0]?.value === "0" &&
                reasonSettled === "1",
            { picking, pickAdded, more, reasonShown, reasonAdded, reasonSettled }
        );

        // 3a. the already-covered toggle grows its filed rows open, and a second click collapses them
        const COVERED = `document.querySelector('[data-workflow-covered-toggle]')`;
        const FILED_PANE = `${COVERED}?.nextElementSibling`;
        await h.ev(watchAdded(`[data-workflow-filed]`, "return getComputedStyle(el.closest('.overflow-hidden')).opacity;"));
        await h.ev(startFrames(`return ${FILED_PANE}?.offsetHeight ?? null;`));
        await h.ev(`${COVERED}?.click()`);
        await settle();
        const filedOpen = distinct(await h.ev(stopFrames));
        const filedAdded = await h.ev(readAdded);
        const filedRows = await h.ev(`${FILED_PANE}?.querySelectorAll('[data-workflow-filed]').length ?? 0`);
        await h.shot("cdp-shots/motion-lens-filed-open.png");
        await h.ev(startFrames(`const p = ${FILED_PANE}; return p ? Math.round(Number(getComputedStyle(p).opacity) * 100) / 100 : null;`));
        await h.ev(`${COVERED}?.click()`);
        await settle();
        const filedFade = distinct(await h.ev(stopFrames));
        const filedGone = await h.ev(`!${FILED_PANE}`);
        rec(
            "3a. the already-covered toggle grows its two filed rows open from opacity 0 through intermediate heights; a second click fades them out while attached, then removes them",
            filedRows === 2 &&
                filedAdded.length === 2 &&
                filedAdded.every((a) => a.value === "0") &&
                grewOpen(filedOpen) &&
                filedFade.some((o) => o > 0 && o < 1) &&
                filedGone,
            { filedRows, filedAdded, filedOpen, filedFade, filedGone }
        );

        // 3b. a send refused on the page holds Sending… up, then reveals the error in the picking footer and nudges it
        await h.ev(setInputExpr(`document.querySelector('[data-workflow-reason="p3"]')`, "covered elsewhere"));
        const ready = await polishWaitFor(h, `document.querySelector('[data-workflow-send]')?.disabled === false`, 3000);
        const PICKS_ERROR = `${WFS_LENS("picking")}?.querySelector('[data-workflow-send-error]')`;
        let sending = null;
        let pickErrAdded = null;
        let pickNudge = null;
        let pickError = null;
        try {
            await replyAfter(h, "WorkflowScanPicksCommand", HOLD_MS, SEND_REFUSAL);
            await h.ev(
                watchAdded(
                    `[data-crossfade="busy"], [data-workflow-send-error]`,
                    "return getComputedStyle(el.matches('[data-crossfade]') ? el : el.parentElement.parentElement).opacity;"
                )
            );
            await h.ev(startFrames(translateX(`${PICKS_ERROR}?.parentElement`)));
            await h.ev(`document.querySelector('[data-workflow-send]')?.click()`);
            await settle(BUSY_READ_MS);
            sending = await h.ev(opacities(`[data-workflow-send] [data-crossfade="busy"]`));
            await polishWaitFor(h, `!!${PICKS_ERROR}`, HOLD_MS + 2000);
            await settle();
            pickNudge = distinct(await h.ev(stopFrames));
            pickErrAdded = await h.ev(readAdded);
            pickError = await h.ev(`${PICKS_ERROR}?.textContent.trim() ?? null`);
            await h.shot("cdp-shots/motion-lens-picks-refused.png");
        } finally {
            await releaseRpc(h, "WorkflowScanPicksCommand");
        }
        const sendLabel = pickErrAdded?.find((a) => a.text === "Sending…");
        const pickErrMount = pickErrAdded?.find((a) => a.text === addedText(SEND_REFUSAL));
        rec(
            "3b. a refused send cross-fades the button to Sending… from opacity 0 (settled at 1 while held), then the error reveals in the picking footer from opacity 0, nudges left and right of 0 and settles at 0",
            ready &&
                sendLabel?.value === "0" &&
                JSON.stringify(sending) === JSON.stringify(["1"]) &&
                pickErrMount?.value === "0" &&
                pickError === SEND_REFUSAL &&
                nudged(pickNudge ?? []),
            { ready, sending, pickErrAdded, pickError, pickNudge }
        );

        // 4. send: the fixture has no agent to deliver to, so the error lands in the applying view and nudges once
        await h.ev(startFrames(translateX(`document.querySelector('[data-workflow-send-error]')?.parentElement`)));
        await h.ev(`document.querySelector('[data-workflow-send]')?.click()`);
        const errored = await polishWaitFor(h, `!!${WFS_LENS("applying")}?.querySelector('[data-workflow-send-error]')`, 10000);
        await settle();
        const nudge = distinct(await h.ev(stopFrames));
        await h.shot("cdp-shots/motion-lens-send-error.png");
        rec(
            "4. a failed send's error shakes along x (left and right of 0) and settles at 0",
            ready && errored && nudge.some((x) => x < 0) && nudge.some((x) => x > 0) && nudge.at(-1) === 0,
            { ready, errored, nudge }
        );

        // 5. reduced motion: the phase swaps in at full opacity and a finishing stage's check is drawn at once
        await h.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
        await settle(300);
        await h.ev(watchAdded(`[data-view-swap="scanning"]`));
        const reducedScan = await wfsSeed(h, ctx, "scanning", scanAt(ctx, { state: "scanning", stage: "patterns" }));
        await settle(300);
        const reducedAdded = await h.ev(readAdded);
        await h.ev(startFrames(checkDrawn("Sonnet patterns")));
        await wfsSeed(h, ctx, "scanning", scanAt(ctx, { state: "scanning", stage: "recount" }));
        await settle();
        const reducedDraw = distinct(await h.ev(stopFrames));
        await h.cdp("Emulation.setEmulatedMedia", { features: [] });
        rec(
            "5. under reduced motion the scanning phase mounts at opacity 1 and the finished stage's check lands whole, with no part-drawn frame",
            reducedScan && reducedAdded[0]?.value === "1" && reducedDraw.length === 1 && reducedDraw[0] === 1,
            { reducedScan, reducedAdded, reducedDraw }
        );

        await startErrorSteps(h, ctx, rec);
        steps.push(...(await canvasSteps(h, ctx)));
        steps.push(...(await boardActionsSteps(h, ctx)));
        steps.push(...(await docReviewSteps(h, ctx)));
        if (ctx.doc?.rosterLoaded) steps.push(...(await commentBarSteps(h, ctx)));
        return steps;
    },
    async teardown(h, ctx) {
        await h.cdp("Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
        if (ctx.canvas != null && !ctx.canvasDown) await canvasTabsScenario.teardown(h, ctx.canvas);
        if (ctx.board != null && !ctx.boardDown) await brainstormAnswerBoards.teardown(h, ctx.board);
        if (ctx.comments != null) await diffComments.teardown(h, ctx.comments);
        if (ctx.doc != null) await docReview.teardown(h, ctx.doc);
        await workflowScan.teardown(h, ctx);
        await h.cdp("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
    },
};

// A scan start refused on the page, so no scan agent starts: from idle both Scan buttons cross-fade to Starting… and the
// error reveals and nudges under the big button; from done the header's error nudges in the toolbar.
async function startErrorSteps(h, ctx, rec) {
    const IDLE_ERROR = `${WFS_LENS("idle")}?.querySelector('[data-workflow-start-error]')`;
    const failedIdle = await wfsSeed(h, ctx, "idle", scanAt(ctx, { state: "failed" }));
    await polishNap(SETTLE_MS);
    let busy = null;
    let added = null;
    let nudge = null;
    let error = null;
    try {
        await replyAfter(h, "WorkflowScanStartCommand", HOLD_MS, START_REFUSAL);
        await h.ev(
            watchAdded(
                `[data-crossfade="busy"], [data-workflow-start-error]`,
                "return getComputedStyle(el.matches('[data-crossfade]') ? el : el.parentElement.parentElement).opacity;"
            )
        );
        await h.ev(startFrames(translateX(`${IDLE_ERROR}?.parentElement`)));
        await h.ev(`document.querySelector('[data-workflow-idle-scan]')?.click()`);
        await polishNap(BUSY_READ_MS);
        busy = await h.ev(opacities(`[data-crossfade="busy"]`));
        await polishWaitFor(h, `!!${IDLE_ERROR}`, HOLD_MS + 2000);
        await polishNap(SETTLE_MS);
        nudge = distinct(await h.ev(stopFrames));
        added = await h.ev(readAdded);
        error = await h.ev(`${IDLE_ERROR}?.textContent.trim() ?? null`);
        await h.shot("cdp-shots/motion-lens-start-refused.png");
    } finally {
        await releaseRpc(h, "WorkflowScanStartCommand");
    }
    const labels = added?.filter((a) => a.text === "Starting…") ?? [];
    const errMount = added?.find((a) => a.text === addedText(START_REFUSAL));
    rec(
        "5a. a refused start from idle cross-fades both Scan buttons to Starting… from opacity 0 (settled at 1 while held), then reveals the error under the big button from opacity 0, nudging left and right of 0 to rest at 0",
        failedIdle &&
            labels.length === 2 &&
            labels.every((l) => l.value === "0") &&
            JSON.stringify(busy) === JSON.stringify(["1", "1"]) &&
            errMount?.value === "0" &&
            error === START_REFUSAL &&
            nudged(nudge ?? []),
        { failedIdle, busy, added, error, nudge }
    );

    // the done view keeps the header's Scan enabled, so its error shows in the toolbar
    const HEAD_ERROR = `document.querySelector('[data-workflow-lens="done"] [data-workflow-start-error]')`;
    const done = await wfsSeed(h, ctx, "done", (run) => ({ ...scanAt(ctx)(run), status: "done" }));
    await polishNap(SETTLE_MS);
    const enabled = await h.ev(`document.querySelector('[data-workflow-scan-button]')?.disabled === false`);
    let headNudge = null;
    let headError = null;
    try {
        await replyAfter(h, "WorkflowScanStartCommand", BUSY_READ_MS, START_REFUSAL_AGAIN);
        await h.ev(startFrames(`const e = ${HEAD_ERROR};
            if (e?.textContent.trim() !== ${JSON.stringify(START_REFUSAL_AGAIN)}) return null;
            ${translateX("e")}`));
        await h.ev(`document.querySelector('[data-workflow-scan-button]')?.click()`);
        await polishWaitFor(h, `${HEAD_ERROR}?.textContent.trim() === ${JSON.stringify(START_REFUSAL_AGAIN)}`, 3000);
        await polishNap(SETTLE_MS);
        headNudge = distinct(await h.ev(stopFrames));
        headError = await h.ev(`${HEAD_ERROR}?.textContent.trim() ?? null`);
        await h.shot("cdp-shots/motion-lens-start-refused-head.png");
    } finally {
        await releaseRpc(h, "WorkflowScanStartCommand");
    }
    rec(
        "5b. on the done view a refused header Scan nudges its new error in the toolbar left and right of 0, settling at 0",
        done && enabled && headError === START_REFUSAL_AGAIN && nudged(headNudge ?? []),
        { done, enabled, headError, headNudge }
    );
    // back to the run's own status, so teardown can cancel it: a done run cannot be cancelled
    await wfsSeed(h, ctx, "idle", scanAt(ctx, { state: "failed" }));
}

// canvas-tabs' two boards: a tab switch slides, a drawn mark scales in, and the removed state fades in
async function canvasSteps(h, ctx) {
    const steps = [];
    const rec = (step, ok, detail) => steps.push({ step, ok: !!ok, detail: JSON.stringify(detail) });
    ctx.canvas = await canvasTabsScenario.arrange(h);
    const c = ctx.canvas;
    if (c.launchError != null || !c.inRoster) {
        rec("6. the canvas terminal launched", false, { launchError: c.launchError ?? null, inRoster: c.inRoster });
        return steps;
    }
    await h.rpc("uireveal", { address: `canvas:${CANVAS_TABS_TOPIC}`, callerblockid: c.blockId, callercwd: c.cwd }, UI_ROUTE);
    await polishWaitFor(h, `!!${CANVAS_TREE_TAG}`, 3000);
    await h.ev(`${CANVAS_TREE_TAG}?.click()`);
    const tabs = await polishWaitFor(h, `(${CANVAS_TABS}?.querySelectorAll('[role="tab"]').length ?? 0) === 3`, 8000);
    await polishNap(SETTLE_MS);

    // 6. Main -> Cards is a step forward: the old board leaves to the left, the new one arrives from the right
    await h.ev(startFrames(translateX(`document.querySelector('[data-canvas-scroll] > div')`)));
    await h.ev(`[...(${CANVAS_TABS}?.querySelectorAll('[role="tab"]') ?? [])].find((b) => (b.textContent || "").trim() === "Cards")?.click()`);
    await polishWaitFor(
        h,
        `JSON.stringify([...document.querySelectorAll("[data-canvas-frame]")].map((f) => f.getAttribute("data-canvas-frame"))) === '["Cards.dc.html"]' &&
            (() => { ${translateX(`document.querySelector('[data-canvas-scroll] > div')`)} })() === 0`,
        SAMPLER_END_WAIT_MS
    );
    await polishNap(REST_FRAME_MS);
    const slide = distinct(await h.ev(stopFrames));
    const frames = await h.ev(`[...document.querySelectorAll("[data-canvas-frame]")].map((f) => f.getAttribute("data-canvas-frame"))`);
    await h.shot("cdp-shots/motion-lens-canvas-board.png");
    rec(
        "6. switching Main -> Cards slides the board out to the left and the next in from the right, settling at 0",
        tabs && slide.some((x) => x < 0) && slide.some((x) => x > 0) && slide.at(-1) === 0 && JSON.stringify(frames) === JSON.stringify(["Cards.dc.html"]),
        { tabs, slide, frames }
    );

    // 7. a drawn mark's box scales in from opacity 0
    await h.ev(`[...(${CANVAS_PANE}?.querySelectorAll("button") ?? [])].find((b) => (b.textContent || "").trim() === "Mark")?.click()`);
    const marking = await polishWaitFor(h, `(${CANVAS_PANE}?.textContent || "").includes("Drag a box around")`, 2000);
    await h.ev(watchAdded(`[data-canvas-mark]`, "return getComputedStyle(el.parentElement).opacity;"));
    const dragged = await dragMarkBox(h);
    await polishNap(SETTLE_MS);
    const markAdded = await h.ev(readAdded);
    const markSettled = await h.ev(`(() => { const m = document.querySelector("[data-canvas-mark]"); return m ? getComputedStyle(m.parentElement).opacity : null; })()`);
    await h.shot("cdp-shots/motion-lens-canvas-mark.png");
    rec(
        "7. a drawn mark's box mounts at opacity 0 and settles at 1",
        marking && dragged && markAdded[0]?.value === "0" && markSettled === "1",
        { marking, dragged, markAdded, markSettled }
    );

    // 7a. wavesrv refusing to serve the design folder: the poller's next tick finds no base and the pane fades the
    // server-down state in. Dropping the base makes the tick ask wavesrv again, as a fresh attach does.
    let downAdded = null;
    let downSettled = null;
    let dropped = null;
    let down = false;
    try {
        await failRpc(h, "CanvasServeCommand", "motion-lens refused to serve this canvas");
        await h.ev(watchAdded(`[data-view-swap="server-down"]`));
        dropped = await lookEval(h, `
            const cs = await mod("app/view/agents/canvasstore.ts");
            const id = [${JSON.stringify(c.tabId)}, ${JSON.stringify(c.blockId)}].find((k) => k && cs.getCanvas(k) != null);
            if (id == null) return null;
            cs.updateCanvas(id, (s) => ({ ...s, base: null }));
            return id;`);
        down = await polishWaitFor(h, `!!document.querySelector('[data-view-swap="server-down"]')`, CANVAS_POLL_WAIT_MS);
        await polishNap(SETTLE_MS);
        downAdded = await h.ev(readAdded);
        downSettled = await h.ev(`(() => { const el = document.querySelector('[data-view-swap="server-down"]'); return el ? getComputedStyle(el).opacity : null; })()`);
        await h.shot("cdp-shots/motion-lens-canvas-server-down.png");
    } finally {
        await releaseRpc(h, "CanvasServeCommand");
    }
    const back = await polishWaitFor(h, `!!document.querySelector('[data-canvas-scroll]')`, CANVAS_POLL_WAIT_MS);
    rec(
        "7a. with wavesrv refusing to serve the canvas, the server-down state fades in from opacity 0 in place of the board and settles at 1; serving again brings the board back",
        dropped != null && down && downAdded[0]?.value === "0" && downSettled === "1" && back,
        { dropped, down, downAdded, downSettled, back }
    );

    // 8. the canvas folder going away fades the removed state in
    await h.ev(watchAdded(`[data-view-swap="removed"]`));
    rmSync(join(c.cwd, ".superpowers", "design", CANVAS_TABS_TOPIC), { recursive: true, force: true });
    const removed = await polishWaitFor(h, `!!document.querySelector('[data-view-swap="removed"]')`, CANVAS_REMOVED_WAIT_MS);
    await polishNap(SETTLE_MS);
    const removedAdded = await h.ev(readAdded);
    const removedSettled = await h.ev(`getComputedStyle(document.querySelector('[data-view-swap="removed"]')).opacity`);
    await h.shot("cdp-shots/motion-lens-canvas-removed.png");
    rec(
        "8. the removed state fades in from opacity 0 in place of the board",
        removed && removedAdded[0]?.value === "0" && removedSettled === "1",
        { removed, removedAdded, removedSettled }
    );
    await canvasTabsScenario.teardown(h, c);
    ctx.canvasDown = true;
    return steps;
}

// brainstorm-answer-boards' question: a board an answer names draws its pick row under the canvas toolbar, which All
// hides; stepping back from All onto the board reveals the row
async function boardActionsSteps(h, ctx) {
    const steps = [];
    const rec = (step, ok, detail) => steps.push({ step, ok: !!ok, detail: JSON.stringify(detail) });
    ctx.board = await brainstormAnswerBoards.arrange(h);
    const missing = await bsShowFile(h, ctx.board);
    if (missing != null) {
        rec("8a. the board actions row reveals when a board that names an answer is shown", false, { missing });
        return steps;
    }
    const OPEN = `${BS_PANE}?.querySelector("[data-brainstorm-row-boards] [data-brainstorm-open-board]")`;
    const PICKS = `${BS_PANE}?.querySelector("[data-canvas-pane] [data-brainstorm-board-picks]")`;
    const TAB = (label) =>
        `[...(${BS_PANE}?.querySelectorAll('[data-canvas-pane] [role="tab"]') ?? [])].find((t) => t.textContent.trim() === ${label})`;
    await polishWaitFor(h, `!!${OPEN}`, BS_POLL_WAIT_MS);
    await h.ev(`${OPEN}?.click()`);
    const shown = await polishWaitFor(h, `!!${PICKS}`, BS_POLL_WAIT_MS);
    const board = await h.ev(
        `(${BS_PANE}?.querySelector('[data-canvas-pane] [role="tab"][aria-selected="true"]')?.textContent ?? "").trim()`
    );
    await h.ev(`${TAB(JSON.stringify("All"))}?.click()`);
    const hidden = await polishWaitFor(h, `!${PICKS}`, 3000);
    await polishNap(SETTLE_MS);
    await h.ev(watchAdded(`[data-brainstorm-board-picks]`, "return getComputedStyle(el.parentElement).opacity;"));
    await h.ev(startFrames(`return ${PICKS}?.parentElement?.offsetHeight ?? null;`));
    await h.ev(`${TAB(JSON.stringify(board))}?.click()`);
    await polishWaitFor(h, `(() => { const p = ${PICKS}?.parentElement; return !!p && getComputedStyle(p).opacity === "1"; })()`, SAMPLER_END_WAIT_MS);
    await polishNap(REST_FRAME_MS);
    const grow = distinct(await h.ev(stopFrames));
    const added = await h.ev(readAdded);
    const settled = await h.ev(`(() => { const p = ${PICKS}?.parentElement; return p ? getComputedStyle(p).opacity : null; })()`);
    await h.shot("cdp-shots/motion-lens-board-actions.png");
    rec(
        "8a. stepping from All back onto a board that names an answer reveals its pick row from opacity 0 through intermediate heights, settling at 1",
        shown && board !== "" && hidden && added[0]?.value === "0" && grewOpen(grow) && settled === "1",
        { shown, board, hidden, added, grow, settled }
    );
    await brainstormAnswerBoards.teardown(h, ctx.board);
    ctx.boardDown = true;
    return steps;
}

// doc-review's fixture lead: the plan fades in over its skeleton, and Request changes grows the note field open
async function docReviewSteps(h, ctx) {
    const steps = [];
    const rec = (step, ok, detail) => steps.push({ step, ok: !!ok, detail: JSON.stringify(detail) });
    ctx.doc = await docReview.arrange(h);
    if (ctx.doc.arrangeError != null || !ctx.doc.rosterLoaded) {
        rec("9. the doc-review fixture roster loaded", false, { arrangeError: ctx.doc.arrangeError ?? null });
        return steps;
    }
    await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);

    // 9. the plan is read over RPC once the dialog is up, and fades in when it lands
    await h.ev(watchAdded(`[data-view-swap="ok"]`));
    await lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const { docReviewAtom } = await mod("app/view/agents/docreview.ts");
        globalStore.set(docReviewAtom, ${JSON.stringify(DOC_REVIEW_LEAD_ID)});
        return true;`);
    const loaded = await polishWaitFor(h, `!!${DOC_REVIEW_PANEL}?.querySelector("[data-doc-review-doc] h1")`, 8000);
    await polishNap(SETTLE_MS);
    const docAdded = await h.ev(readAdded);
    const docSettled = await h.ev(`getComputedStyle(document.querySelector('[data-view-swap="ok"]')).opacity`);
    rec(
        "9. the plan replaces the skeleton through a fade from opacity 0",
        loaded && docAdded[0]?.value === "0" && docSettled === "1",
        { loaded, docAdded, docSettled }
    );

    // 9a. selecting a passage reveals the quoting field
    const FIELD_INPUT = `${DOC_REVIEW_PANEL}?.querySelector("[data-doc-note-field] input")`;
    const NOTES_PANE = `${DOC_REVIEW_PANEL}?.querySelector("[data-doc-notes-list]")?.parentElement`;
    const TOGGLE = `${DOC_REVIEW_PANEL}?.querySelector("[data-doc-notes-toggle]")`;
    await h.ev(watchAdded(`[data-doc-note-field]`, "return getComputedStyle(el.parentElement).opacity;"));
    const selected = await h.ev(`(() => {
        const root = ${DOC_REVIEW_PANEL}?.querySelector("[data-doc-review-doc]");
        if (!root) return false;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const at = n.nodeValue.indexOf(${JSON.stringify(DOC_PASSAGE)});
            if (at < 0) continue;
            const range = document.createRange();
            range.setStart(n, at);
            range.setEnd(n, at + ${DOC_PASSAGE.length});
            getSelection().removeAllRanges();
            getSelection().addRange(range);
            root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
            return true;
        }
        return false;
    })()`);
    const fieldShown = await polishWaitFor(h, `!!${FIELD_INPUT}`, 3000);
    await polishNap(SETTLE_MS);
    const fieldAdded = await h.ev(readAdded);
    const fieldSettled = await h.ev(`(() => { const f = ${DOC_REVIEW_PANEL}?.querySelector("[data-doc-note-field]"); return f ? getComputedStyle(f.parentElement).opacity : null; })()`);
    await h.shot("cdp-shots/motion-lens-doc-quoting.png");
    rec(
        "9a. selecting a passage reveals the quoting field from opacity 0, settling at 1",
        selected && fieldShown && fieldAdded[0]?.value === "0" && fieldSettled === "1",
        { selected, fieldShown, fieldAdded, fieldSettled }
    );

    // 9b. the note lands in the notes list; its header collapses the list through a fade and expands it again
    await h.ev(setInputExpr(FIELD_INPUT, "Say which plan."));
    await h.ev(`${FIELD_INPUT}?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }))`);
    const listed = await polishWaitFor(h, `!!${NOTES_PANE}`, 3000);
    await polishNap(SETTLE_MS);
    const FADE = `const p = ${NOTES_PANE}; return p ? Math.round(Number(getComputedStyle(p).opacity) * 100) / 100 : null;`;
    await h.ev(startFrames(FADE));
    await h.ev(`${TOGGLE}?.click()`);
    await polishWaitFor(h, `!${NOTES_PANE} && ${TOGGLE}?.getAttribute("aria-expanded") === "false"`, SAMPLER_END_WAIT_MS);
    await polishNap(REST_FRAME_MS);
    const collapse = distinct(await h.ev(stopFrames));
    const collapsed = await h.ev(`!${NOTES_PANE} && ${TOGGLE}?.getAttribute("aria-expanded") === "false"`);
    await h.ev(watchAdded(`[data-doc-notes-list]`, "return getComputedStyle(el.parentElement).opacity;"));
    await h.ev(startFrames(`return ${NOTES_PANE}?.offsetHeight ?? null;`));
    await h.ev(`${TOGGLE}?.click()`);
    await polishWaitFor(h, `(() => { const p = ${NOTES_PANE}; return !!p && Number(getComputedStyle(p).opacity) === 1; })()`, SAMPLER_END_WAIT_MS);
    await polishNap(REST_FRAME_MS);
    const expand = distinct(await h.ev(stopFrames));
    const expandAdded = await h.ev(readAdded);
    await h.shot("cdp-shots/motion-lens-doc-notes.png");
    rec(
        "9b. collapsing Your notes fades the list out while attached, then removes it; expanding grows it back from opacity 0 through intermediate heights",
        listed &&
            collapse[0] === 1 &&
            collapse.some((o) => o > 0 && o < 1) &&
            collapsed &&
            expandAdded[0]?.value === "0" &&
            grewOpen(expand),
        { listed, collapse, collapsed, expandAdded, expand }
    );

    // 10. Request changes: the note field grows open and the buttons cross-fade to Send / Cancel
    const NOTE_HEIGHT = `return document.querySelector('#doc-review-note')?.parentElement?.offsetHeight ?? 0;`;
    await h.ev(watchAdded(`[data-crossfade="request"]`));
    await h.ev(startFrames(NOTE_HEIGHT));
    await h.ev(`[...(${DOC_REVIEW_PANEL}?.querySelectorAll("button") ?? [])].find((b) => (b.textContent || "").trim().startsWith("Request changes"))?.click()`);
    await polishNap(SETTLE_MS);
    const grow = distinct(await h.ev(stopFrames));
    const swapAdded = await h.ev(readAdded);
    await h.shot("cdp-shots/motion-lens-doc-request.png");
    rec(
        "10. Request changes grows the note field open through intermediate heights and fades Send / Cancel in from 0",
        grow[0] === 0 && grow.at(-1) > 0 && grow.some((v) => v > 0 && v < grow.at(-1)) && swapAdded[0]?.value === "0",
        { grow, swapAdded }
    );
    await h.ev(`(document.activeElement || document.body).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }))`);
    await polishWaitFor(h, `!${DOC_REVIEW_PANEL}`, 3000);
    return steps;
}

// doc-review's fixture worker (scenarios-cockpit.mjs), a live claude agent at work in the roster the doc steps loaded
const FX_WORKER_ID = "fx-doc-worker";
const FX_WORKER_NAME = "doc-review worker";
const BAR = `document.querySelector("[data-comment-send-bar]")`;

// writes one pending comment for the Diff surface's published source, stored under the given source kind: a project
// source goes to a new agent, an agent source to the fixture worker
const seedBatch = (h, kind) =>
    lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const dc = await mod("app/view/agents/diffcomments.ts");
        const active = globalStore.get(dc.activeCommentSourceAtom);
        if (active == null) return null;
        const source = ${JSON.stringify(kind)} === "agent" ? { ...active, kind: "agent", agentId: ${JSON.stringify(FX_WORKER_ID)} } : active;
        const comment = {
            id: "motion-lens-1",
            path: "README.md",
            side: "modified",
            start: 1,
            end: 1,
            quote: ["# retry"],
            refs: { original: { kind: "ref", ref: "HEAD" }, modified: { kind: "worktree" } },
            note: "motion-lens: say what retries.",
            at: Date.now(),
        };
        globalStore.set(dc.commentStoreAtom, { ...globalStore.get(dc.commentStoreAtom), [active.key]: { source, at: Date.now(), comments: [comment] } });
        return active.key;`);

// diff-comments' repo on the Diff surface, its project picked, with a batch written in the page rather than drawn in
// Monaco: the recipient cross-fades, a refused send holds Sending… and nudges its error in, and a send that lands
// reveals the sent note. Every prompt is answered on the page, so nothing reaches the fixture worker.
async function commentBarSteps(h, ctx) {
    const steps = [];
    const rec = (step, ok, detail) => steps.push({ step, ok: !!ok, detail: JSON.stringify(detail) });
    ctx.comments = await diffComments.arrange(h);
    await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
    await h.goto("files");
    await h.ev(`document.querySelector("[data-files-source-picker]")?.click()`);
    const OPTION = `document.querySelector('[data-files-source-option=${JSON.stringify(ctx.comments.name)}]')`;
    await polishWaitFor(h, `!!${OPTION}`, 4000);
    await h.ev(`${OPTION}?.click()`);
    const picked = await polishWaitFor(h, `!!document.querySelector('[data-changed-file-row="src/retry/policy.go"]') && !!${BAR}`, 15000);
    const toNew = picked ? await seedBatch(h, "project") : null;
    const newShown = await polishWaitFor(h, `${BAR}?.dataset.recipientKind === "new"`, 5000);
    await polishNap(SETTLE_MS);

    // 11. the recipient: a new agent -> the live worker
    await h.ev(watchAdded(`[data-comment-recipient] [data-crossfade]`));
    const toLive = await seedBatch(h, "agent");
    const liveShown = await polishWaitFor(h, `${BAR}?.dataset.recipientKind === "live"`, 5000);
    await polishNap(SETTLE_MS);
    const recipientAdded = await h.ev(readAdded);
    const recipientSettled = await h.ev(opacities(`[data-comment-recipient] [data-crossfade="live"]`));
    await h.shot("cdp-shots/motion-lens-comment-recipient.png");
    rec(
        `11. the bar's recipient cross-fades from a new agent to ${FX_WORKER_NAME}, the name fading in from opacity 0 to 1`,
        picked &&
            toNew != null &&
            newShown &&
            toLive != null &&
            liveShown &&
            recipientAdded.some((a) => a.text === FX_WORKER_NAME && a.value === "0") &&
            JSON.stringify(recipientSettled) === JSON.stringify(["1"]),
        { picked, toNew, newShown, liveShown, recipientAdded, recipientSettled }
    );

    const SEND = `${BAR}?.querySelector("[data-comment-send]")`;
    const ERROR = `${BAR}?.querySelector("[data-comment-error]")`;
    try {
        // 12. a refused send: Sending… while held, then the error strip reveals and nudges, and the button reads Send again
        await replyAfter(h, "AgentPromptCommand", HOLD_MS, PROMPT_REFUSAL);
        await h.ev(
            watchAdded(
                `[data-comment-send] [data-crossfade], [data-comment-error]`,
                "return getComputedStyle(el.matches('[data-crossfade]') ? el : el.parentElement).opacity;"
            )
        );
        await h.ev(startFrames(translateX(ERROR)));
        await h.ev(`${SEND}?.click()`);
        await polishNap(BUSY_READ_MS);
        const sending = await h.ev(opacities(`[data-comment-send] [data-crossfade="sending"]`));
        const errored = await polishWaitFor(h, `!!${ERROR}`, HOLD_MS + 2000);
        await polishNap(SETTLE_MS);
        const nudge = distinct(await h.ev(stopFrames));
        const added = await h.ev(readAdded);
        const error = await h.ev(`${ERROR}?.textContent.trim() ?? null`);
        await h.shot("cdp-shots/motion-lens-comment-refused.png");
        const mount = (text) => added.find((a) => a.text.startsWith(text));
        rec(
            "12. a refused send cross-fades the button to Sending… from opacity 0 (settled at 1 while held), reveals the error strip from opacity 0 with a nudge left and right of 0 resting at 0, and cross-fades the button to Send again",
            mount("Sending…")?.value === "0" &&
                JSON.stringify(sending) === JSON.stringify(["1"]) &&
                errored &&
                mount("Couldn't send")?.value === "0" &&
                (error ?? "").includes(PROMPT_REFUSAL) &&
                nudged(nudge) &&
                mount("Send again")?.value === "0",
            { sending, errored, error, added, nudge }
        );

        // 13. a send that lands: the comments leave and the sent note reveals in their place
        await replyAfter(h, "AgentPromptCommand", BUSY_READ_MS);
        await h.ev(watchAdded(`[data-comment-sent-note]`, "return getComputedStyle(el.parentElement).opacity;"));
        await h.ev(`${SEND}?.click()`);
        const sent = await polishWaitFor(h, `!!${BAR}?.querySelector("[data-comment-sent-note]")`, HOLD_MS + 2000);
        await polishNap(SETTLE_MS);
        const noteAdded = await h.ev(readAdded);
        const note = await h.ev(`(() => { const n = ${BAR}?.querySelector("[data-comment-sent-note]"); return n ? { text: n.textContent.trim(), opacity: getComputedStyle(n.parentElement).opacity } : null; })()`);
        await h.shot("cdp-shots/motion-lens-comment-sent.png");
        rec(
            `13. a send that lands reveals Sent 1 comment to ${FX_WORKER_NAME} from opacity 0, settling at 1`,
            sent && noteAdded[0]?.value === "0" && note?.opacity === "1" && note.text.startsWith(`Sent 1 comment to ${FX_WORKER_NAME}`),
            { sent, noteAdded, note }
        );
    } finally {
        await releaseRpc(h, "AgentPromptCommand");
    }
    return steps;
}
