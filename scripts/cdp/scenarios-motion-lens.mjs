// motion-lens: the motion sweep's moments on the Workflow lens, the design canvas and the doc review dialog
// (docs/superpowers/plans/2026-11-10-motion-sweep.md). The data is workflow-scan's (its deferred run, whose record each
// step rewrites), canvas-tabs' two-board canvas and doc-review's fixture lead. Each moment is sampled in-page: an
// observer reads what a node mounts with, and a frame sampler reads a value every animation frame, because a CDP round
// trip per sample is slower than the motion.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { CANVAS_TABS, CANVAS_TABS_TOPIC, CANVAS_TREE_TAG, canvasTabsScenario, dragMarkBox } from "./scenarios-agent.mjs";
import { DOC_REVIEW_LEAD_ID, DOC_REVIEW_PANEL, docReview } from "./scenarios-cockpit.mjs";
import { CANVAS_PANE, UI_ROUTE, lookEval, polishNap, polishWaitFor, setInputExpr } from "./scenarios-shared.mjs";
import { WFS_LENS, workflowScan, wfsScan, wfsSeed } from "./scenarios-usage.mjs";

const VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const SETTLE_MS = 700;
const CANVAS_REMOVED_WAIT_MS = 6000;

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
                if (el.matches(sel)) window.__mlAdded.push({ text: el.textContent.trim().slice(0, 40), value: read(el) });
            }
        }
    });
    window.__mlObs.observe(document.body, { childList: true, subtree: true });
    return true;
})()`;
const readAdded = `(() => { window.__mlObs?.disconnect(); return window.__mlAdded ?? []; })()`;

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

        // 4. send: the fixture has no agent to deliver to, so the error lands in the applying view and nudges once
        await h.ev(setInputExpr(`document.querySelector('[data-workflow-reason="p3"]')`, "covered elsewhere"));
        const ready = await polishWaitFor(h, `document.querySelector('[data-workflow-send]')?.disabled === false`, 3000);
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

        steps.push(...(await canvasSteps(h, ctx)));
        steps.push(...(await docReviewSteps(h, ctx)));
        return steps;
    },
    async teardown(h, ctx) {
        await h.cdp("Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
        if (ctx.canvas != null && !ctx.canvasDown) await canvasTabsScenario.teardown(h, ctx.canvas);
        if (ctx.doc != null) await docReview.teardown(h, ctx.doc);
        await workflowScan.teardown(h, ctx);
        await h.cdp("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
    },
};

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
    await polishNap(900);
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
