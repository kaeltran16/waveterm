// motion-peeks: the motion sweep's moments on the avatar popup's item peeks (docs/superpowers/plans/2026-11-10-motion-sweep.md).
// The data is peek-item-views' (its fixture lead, deferred run and initiative) plus one held run whose task graph
// the scenario seeds. Each moment is sampled in-page: an observer reads the opacity a node mounts with, and a frame
// sampler reads a value every animation frame, because a CDP round trip per sample is slower than the motion.
import { peekItemViews } from "./scenarios-brief.mjs";
import {
    TREE_RAIL_LEAD_ID,
    arrangeHeldRun,
    polishWaitFor,
    seedHeldRun,
    teardownHeldRuns,
} from "./scenarios-shared.mjs";

const HELD_TASKS = [
    { id: "t-1", label: "first" },
    { id: "t-2", label: "second" },
    { id: "t-3", label: "third" },
];
const ITEM = "[data-pet-peek-item]";
const TASKS_STATE = `${ITEM} [data-peek-run-phase="Tasks"] span.truncate`;
// the initiative's third chunk (Verify): its fill is the segment's only child
const VERIFY_FILL = `${ITEM} .grid[aria-hidden="true"] > span:nth-child(3) > span`;

// records each added node matching sel (itself or a descendant) with the opacity it mounts with
const watchAdded = (sel) => `(() => {
    window.__mpObs?.disconnect();
    window.__mpAdded = [];
    const sel = ${JSON.stringify(sel)};
    window.__mpObs = new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
            if (!(n instanceof Element)) continue;
            for (const el of [n, ...n.querySelectorAll(sel)]) {
                if (el.matches(sel)) {
                    window.__mpAdded.push({ key: el.dataset.peekFade ?? el.textContent, opacity: getComputedStyle(el).opacity });
                }
            }
        }
    });
    window.__mpObs.observe(document.body, { childList: true, subtree: true });
    return true;
})()`;
const readAdded = `(() => { window.__mpObs?.disconnect(); return window.__mpAdded ?? []; })()`;

// reads expr (a function body returning a value) every animation frame into window.__mpFrames[name] until stopped
const startFrames = (name, expr) => `(() => {
    const f = { on: true, values: [] };
    (window.__mpFrames ??= {})[${JSON.stringify(name)}] = f;
    const read = () => { try { ${expr} } catch { return null; } };
    const tick = () => {
        f.values.push(read());
        if (f.on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return true;
})()`;
const stopFrames = (name) =>
    `(() => { const f = window.__mpFrames[${JSON.stringify(name)}]; f.on = false; return f.values; })()`;
const distinct = (values) => values.filter((v, i) => v != null && v !== values[i - 1]);
// the AutoHeight box the peek's body sits in
const BODY_HEIGHT = `return document.querySelector('[data-pet-peek-body] > div')?.offsetHeight ?? null;`;
// the Tasks phase's words: textContent, because innerText breaks lines around the tick's flex item
const tasksText = `(document.querySelector('${TASKS_STATE}')?.textContent ?? '').replace(/\\s+/g, ' ').trim()`;

// the x scale of the Verify segment's fill, from its computed matrix
const VERIFY_SCALE = `const t = getComputedStyle(document.querySelector(${JSON.stringify(VERIFY_FILL)})).transform;
    if (t === "none") return 1;
    return Math.round(Number(t.slice(7).split(",")[0]) * 1000) / 1000;`;

export const motionPeeks = {
    name: "motion-peeks",
    surface: "jarvis",
    async arrange(h) {
        // the held run first: peek-item-views' arrange ends in the reload that primes the Brief with both runs
        const held = {};
        let heldError = null;
        try {
            held.run = await arrangeHeldRun(h, held, { key: "peeks", title: "verify motion-peeks", tasks: HELD_TASKS });
        } catch (e) {
            heldError = String(e?.message ?? e);
        }
        const ctx = await peekItemViews.arrange(h);
        ctx.held = held.held;
        ctx.run = held.run;
        ctx.arrangeError ??= heldError ?? undefined;
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail: JSON.stringify(detail) });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
        await h.goto("jarvis");
        const hooks = await polishWaitFor(h, `typeof window.__peekAddress === 'function'`, 5000);
        rec("1. the fixtures are arranged and the peek hooks are installed", ctx.arrangeError == null && hooks === true, {
            arrangeError: ctx.arrangeError ?? null,
            hooks,
        });
        if (ctx.arrangeError != null || hooks !== true) return steps;

        const closePopup = async () => {
            await h.ev(`document.querySelector('[data-pet-peek] button[aria-label="Close Jarvis panel"]')?.click()`);
            await polishWaitFor(h, `!document.querySelector('[data-pet-peek]')`, 3000);
            await settle(300);
        };
        const peek = (address) => h.ev(`window.__peekAddress(${JSON.stringify(address)})`);
        const ready = (kind, check) =>
            polishWaitFor(
                h,
                `(() => {
                    const el = document.querySelector('[data-pet-peek-item="${kind}"][data-pet-peek-status="ready"]');
                    return !!el && (${check});
                })()`,
                10000
            );

        // 2. loading -> the initiative's body: the body fades in and the peek's height follows it
        await closePopup();
        await h.ev(watchAdded(`[data-peek-fade="body"]`));
        await peek(`effort:${ctx.effortId}`);
        const effortReady = await ready("effort", `/Peek item views initiative/.test(el.innerText)`);
        await settle(700);
        const bodyAdded = await h.ev(readAdded);
        const bodySettled = await h.ev(`getComputedStyle(document.querySelector('[data-peek-fade="body"]')).opacity`);
        await h.shot("cdp-shots/motion-peeks-effort.png");
        rec(
            "2. a peek's body fades in from 0 when its load lands, instead of cutting over the skeleton",
            effortReady === true && bodyAdded[0]?.opacity === "0" && bodySettled === "1",
            { effortReady, bodyAdded, bodySettled }
        );

        // 3. a chunk finishing while the peek is up: the chunk list swaps through a fade, the next segment fills, and
        // the peek shrinks by the row that left (its skeleton and body happen to be the same height, so step 2 can't)
        await h.ev(watchAdded(`${ITEM} [data-peek-fade]:not([data-peek-fade="body"])`));
        await h.ev(startFrames("scale", VERIFY_SCALE));
        await h.ev(startFrames("height", BODY_HEIGHT));
        await h.rpc("effortmutate", {
            effortoid: ctx.effortId,
            author: "you",
            ops: [
                { op: "setChunkStatus", chunk: "Peek", status: "done" },
                { op: "setChunkStatus", chunk: "Verify", status: "active" },
            ],
        });
        const swapped = await polishWaitFor(h, `/2 done/.test(document.querySelector('${ITEM}')?.innerText ?? '')`, 5000);
        await settle(700);
        const fill = distinct(await h.ev(stopFrames("scale")));
        const heights = distinct(await h.ev(stopFrames("height")));
        const chunksAdded = await h.ev(readAdded);
        await h.shot("cdp-shots/motion-peeks-chunks.png");
        rec(
            "3. a chunk finishing swaps the chunk list in from opacity 0, and the next segment fills and the peek shrinks through intermediate frames",
            swapped === true &&
                chunksAdded[0]?.opacity === "0" &&
                fill[0] === 0 &&
                fill.at(-1) === 1 &&
                fill.some((v) => v > 0 && v < 1) &&
                heights.at(-1) < heights[0] &&
                heights.some((v) => v < heights[0] && v > heights.at(-1)),
            { swapped, chunksAdded, fill, heights }
        );

        // 4. reduced motion: the same kind of change lands at once, the segment empties with no frame between
        await h.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
        await settle(300);
        await h.ev(watchAdded(`${ITEM} [data-peek-fade]:not([data-peek-fade="body"])`));
        await h.ev(startFrames("scale", VERIFY_SCALE));
        await h.ev(startFrames("height", BODY_HEIGHT));
        await h.rpc("effortmutate", {
            effortoid: ctx.effortId,
            author: "you",
            ops: [{ op: "setChunkStatus", chunk: "Verify", status: "skipped" }],
        });
        const emptied = await polishWaitFor(h, `!/Verify/.test(document.querySelector('${ITEM} [data-peek-fade]:not([data-peek-fade="body"])')?.innerText ?? 'Verify')`, 5000);
        await settle(700);
        const reducedFill = distinct(await h.ev(stopFrames("scale")));
        const reducedHeights = distinct(await h.ev(stopFrames("height")));
        const reducedAdded = await h.ev(readAdded);
        await h.cdp("Emulation.setEmulatedMedia", { features: [] });
        rec(
            "4. under reduced motion the chunk list swaps in at full opacity, and the segment empties and the peek shrinks with no intermediate frame",
            emptied === true &&
                reducedAdded[0]?.opacity === "1" &&
                reducedFill.at(-1) === 0 &&
                reducedFill.every((v) => v === 0 || v === 1) &&
                reducedHeights.length === 2 &&
                reducedHeights[1] < reducedHeights[0],
            { emptied, reducedAdded, reducedFill, reducedHeights }
        );

        // 5. the agent's quick run finishing while its peek is up draws the done check
        await closePopup();
        await peek(`agent:${TREE_RAIL_LEAD_ID}`);
        const agentReady = await ready("agent", `/Agent/.test(el.innerText)`);
        await settle(600);
        // the body's first svg is the badge's check: the header's icons come before it in the dialog
        await h.ev(
            startFrames("draw", `return document.querySelector('${ITEM} [data-pet-peek-body] svg path')?.getAttribute('stroke-dasharray') ?? null;`)
        );
        await h.ev(`window.__cockpitRosterFixture.patch(${JSON.stringify(TREE_RAIL_LEAD_ID)}, { state: "idle", runDone: true })`);
        await settle(700);
        const draw = distinct(await h.ev(stopFrames("draw")));
        const drawn = (d) => d != null && Number(d.split(/[ ,]+/)[0]);
        await h.shot("cdp-shots/motion-peeks-agent.png");
        rec(
            "5. an agent's run finishing while its peek is up draws its check from part-drawn to whole",
            agentReady === true && draw.some((d) => drawn(d) > 0 && drawn(d) < 1) && drawn(draw.at(-1)) === 1,
            { agentReady, draw }
        );

        // 6. a task landing while the run's peek is up rolls the Tasks count
        await closePopup();
        await peek(`run:${ctx.run.runId}`);
        const runReady = await ready("run", `${tasksText} === '0 of 3 landed'`);
        await settle(600);
        await h.ev(watchAdded(`${TASKS_STATE} .inline-block`));
        await seedHeldRun(h, ctx.run, { "t-1": { state: "done" } });
        const ticked = await polishWaitFor(h, `${tasksText} === '1 of 3 landed'`, 5000);
        await settle(500);
        const rolled = await h.ev(readAdded);
        await h.shot("cdp-shots/motion-peeks-run.png");
        rec(
            "6. a task landing rolls the Tasks count: the new number mounts at opacity 0 and the line settles on 1 of 3",
            runReady === true && ticked === true && rolled.some((r) => r.key === "1" && r.opacity === "0"),
            { runReady, ticked, rolled }
        );
        await closePopup();
        return steps;
    },
    async teardown(h, ctx) {
        await h.cdp("Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
        await h.cdp("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
        await teardownHeldRuns(h, ctx, "motion-peeks");
        await peekItemViews.teardown(h, ctx);
    },
};
