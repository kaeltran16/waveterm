// motion-run-sheet: the motion sweep's moments on the run sheet (docs/superpowers/plans/2026-11-10-motion-sweep.md,
// Task 2). The sheet's own moments run on run-sheet-polish's live dag run, changed in the page the way that scenario
// changes it; the record's TaskDetail and DecisionLog and the report's raw toggle are mounted over the page with data
// each step changes, since no RPC rewrites a record's state or a decision's status on demand. Every moment is read
// in-page in one evaluation, because a CDP round trip per sample is slower than the fade it measures: an observer
// reads the opacity a node is added with (motion-gaps), a frame sampler what moves while it moves (dag-motion).

import { dagPeekPublish, injectPageDag, undoPageDag } from "./scenarios-runs.mjs";
import {
    arrangeSheetDagRun,
    fstWriteRun,
    lookEval,
    OBS_WIDE,
    polishNap,
    releaseRpc,
    RUN_SHEET_POLISH_TASKS,
    teardownFixtureRun,
} from "./scenarios-shared.mjs";

const NAME = "motion-run-sheet";
const REDUCE = { features: [{ name: "prefers-reduced-motion", value: "reduce" }] };
const NO_MEDIA = { features: [] };
// a fade or reveal mounts at (near) 0 and settles at 1; read this long after the change, past durMacro
const SETTLE_MS = 700;
const MOUNTED_HIDDEN = 0.1;

const MOTION_LIB = `
    const sheet = () => document.querySelector("[data-run-sheet]");
    const opacity = (el) => (el ? Number(getComputedStyle(el).opacity) : null);
    // the opacity each node pick(n) returns has as it is added, in order
    const watchAdded = (pick) => {
        const seen = [];
        const obs = new MutationObserver((muts) => {
            for (const m of muts) for (const n of m.addedNodes) {
                const hit = n instanceof Element ? pick(n) : null;
                if (hit) seen.push(Number(getComputedStyle(hit).opacity));
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });
        return { seen, stop: () => obs.disconnect() };
    };
    // every distinct value read(el) takes, one read per frame, until stop()
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
const motionEval = (h, body) => lookEval(h, `${MOTION_LIB} ${body}`);

const revealed = (r) => r != null && r.first != null && r.first < MOUNTED_HIDDEN && r.settled === 1;
// a strip segment's samples start at the color read before the change and end at the color it settled on
const recolored = (r) =>
    r != null &&
    r.colorBefore != null &&
    r.colorAfter !== r.colorBefore &&
    r.colors[0] === r.colorBefore &&
    r.colors.at(-1) === r.colorAfter;
const leftMidFade = (r) => r != null && r.mid.attached && r.mid.opacity > 0 && r.mid.opacity < 1 && r.goneAfter;

// a disclosure's toggle, closed first, then opened and closed again: the pane it adds, then the pane leaving
const disclosureExpr = (toggleExpr, paneOf, closeWaitMs) => `
    const btn = ${toggleExpr};
    if (!btn) return { error: "no toggle" };
    if (btn.getAttribute("aria-expanded") === "true") { btn.click(); await nap(${SETTLE_MS}); }
    const pane = ${paneOf};
    const w = watchAdded((n) => (n === pane() ? n : null));
    btn.click();
    await nap(${SETTLE_MS});
    w.stop();
    const svg = btn.querySelector("svg");
    const opened = {
        expanded: btn.getAttribute("aria-expanded"),
        first: w.seen[0] ?? null,
        settled: opacity(pane()),
        turn: svg ? getComputedStyle(svg).rotate : null,
        turnMs: svg ? getComputedStyle(svg).transitionDuration : null,
    };
    const leaving = pane();
    btn.click();
    await nap(${closeWaitMs});
    const mid = { attached: leaving?.isConnected ?? false, opacity: opacity(leaving) };
    await nap(${SETTLE_MS});
    return { opened, mid, goneAfter: leaving != null && !leaving.isConnected };
`;

const OBJECTIVE_BODY = Array.from(
    { length: 8 },
    (_, i) => `Paragraph ${i + 1} of the record's objective, long enough that the body clamps to four lines.`
).join("\n");
const DECISION = (id, summary, status = "active") => ({
    id,
    created: Date.now() - 3_600_000,
    actor: "lead",
    provenance: "",
    status,
    links: [],
    rationale: `Why ${summary.toLowerCase()}.`,
    summary,
});
const D1 = DECISION("motion-d1", "Keep the sheet calm");
const D2 = DECISION("motion-d2", "Fade the new body in");
const DETAIL = {
    id: "motion-run-sheet-record",
    ticket: "",
    objective: `Show the run sheet's changes as changes. ${OBJECTIVE_BODY}`,
    acceptance: [],
    confidence: "",
    status: "active",
    created: Date.now() - 7_200_000,
    updated: Date.now(),
    state: "Planning the sheet",
    blockers: [],
    refs: [],
    notes: "",
    decisions: [D1],
};
const REPORT = "# Run report: motion run sheet\n\nDAG 1: 3/3 tasks done.\n\n## Landed\n- abc1234 t-1 the sheet fades\n";
const MOUNT_STYLE = "width:720px;max-height:80vh;overflow:auto;";

const setUsage = (h, runId, total) =>
    lookEval(h, `
        const { runUsageAtom } = await mod("app/view/agents/runtokenstore.ts");
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        // sealed, so the store's minute refresh leaves the seeded figure alone
        const row = { role: "lead", input: ${total}, output: 0, cacheread: 0, cachewrite: 0, cachewrite1h: 0, msgs: 1 };
        globalStore.set(runUsageAtom, { ...globalStore.get(runUsageAtom), [${JSON.stringify(runId)}]: { sealed: true, rows: [row] } });
        return true;
    `);

// the profile write answers after `ms`, refused or not, so the dock's busy label is on screen long enough to read
const stubProfileWrite = (h, ms, fail) =>
    lookEval(h, `
        const { RpcApi } = await mod("app/store/wshclientapi.ts");
        (window.__heldRpc ??= {}).SetChannelProfileCommand ??= RpcApi.SetChannelProfileCommand;
        RpcApi.SetChannelProfileCommand = () =>
            new Promise((ok, no) => setTimeout(() => (${fail} ? no(new Error("motion-run-sheet: refused")) : ok(null)), ${ms}));
        return true;
    `);

// strip segment i's colors over the next change, and whether the next: line washed
const stripSampler = (i) => `
    const seg = () => sheet()?.querySelectorAll("[data-run-sheet-seg]")[${i}] ?? null;
    const next = () => sheet()?.querySelector("[data-run-sheet-next]");
    const color = () => (seg() ? getComputedStyle(seg()).backgroundColor : null);
    window.__strip?.colors.stop();
    // read now: under load the change can land before the sampler's first frame, which would lose the before color
    const colorBefore = color();
    const colors = sampleFrames(color);
    if (colorBefore != null) colors.values.push(colorBefore);
    window.__strip = {
        colors,
        colorBefore,
        flash: null,
        stateBefore: seg()?.getAttribute("data-run-sheet-seg") ?? null,
        nextBefore: flat(next()),
        transition: seg() ? { property: getComputedStyle(seg()).transitionProperty, ms: getComputedStyle(seg()).transitionDuration } : null,
    };
    const watchFlash = () => {
        const el = next();
        if (el && /changeFlash/.test(el.className)) window.__strip.flash ??= getComputedStyle(el).animationName;
        if (window.__strip.flash == null) requestAnimationFrame(watchFlash);
    };
    requestAnimationFrame(watchFlash);
    return true;
`;
const stripRead = (i) => `
    const seg = () => sheet()?.querySelectorAll("[data-run-sheet-seg]")[${i}] ?? null;
    const s = window.__strip;
    await until(() => seg()?.getAttribute("data-run-sheet-seg") !== s.stateBefore, 8000);
    await nap(${SETTLE_MS});
    s.colors.stop();
    return {
        stateBefore: s.stateBefore,
        stateAfter: seg()?.getAttribute("data-run-sheet-seg") ?? null,
        colors: s.colors.values,
        colorBefore: s.colorBefore,
        colorAfter: seg() ? getComputedStyle(seg()).backgroundColor : null,
        transition: s.transition,
        nextBefore: s.nextBefore,
        nextAfter: flat(sheet()?.querySelector("[data-run-sheet-next]")),
        flash: s.flash,
    };
`;

async function sheetSteps(h, ctx, rec) {
    // 1. the Timing disclosure
    const timing = await motionEval(h, `
        const section = () => sheet()?.querySelector("[data-run-timing]");
        await until(() => section()?.querySelector("button[aria-expanded]") != null, 20000);
        ${disclosureExpr(
            `section()?.querySelector("button[aria-expanded]")`,
            `() => [...(section()?.children ?? [])].find((c) => c.querySelector("[data-run-timing-row]")) ?? null`,
            120
        )}
    `);
    rec(
        "1. Timing opens with its pane growing in from opacity 0 to 1 and the chevron turning on the micro beat, and closes with the pane leaving mid-fade",
        revealed(timing?.opened) && timing.opened.turn === "90deg" && timing.opened.turnMs === "0.14s" && leftMidFade(timing),
        JSON.stringify(timing)
    );

    // 2. the event timeline, then a burst arriving while it is open
    const timeline = await motionEval(h, `
        const toggle = () =>
            [...(sheet()?.querySelectorAll("button[aria-expanded]") ?? [])].find((b) => flat(b).startsWith("timeline"));
        await until(() => toggle() != null, 20000);
        const btn = toggle();
        if (!btn) return { error: "no timeline toggle" };
        if (btn.getAttribute("aria-expanded") === "true") { btn.click(); await nap(${SETTLE_MS}); }
        const pane = () => sheet()?.querySelector("[data-run-sheet-timeline]")?.parentElement ?? null;
        const w = watchAdded((n) => (n.firstElementChild?.matches("[data-run-sheet-timeline]") ? n : null));
        btn.click();
        await nap(${SETTLE_MS});
        w.stop();
        const svg = btn.querySelector("svg");
        return { first: w.seen[0] ?? null, settled: opacity(pane()), turn: getComputedStyle(svg).rotate, turnMs: getComputedStyle(svg).transitionDuration };
    `);
    rec(
        "2. the timeline opens with its pane growing in from opacity 0 to 1 and its chevron turning, rather than swapping glyphs",
        revealed(timeline) && timeline.turn === "90deg" && timeline.turnMs === "0.14s",
        JSON.stringify(timeline)
    );
    await h.shot(`cdp-shots/${NAME}-timeline.png`);

    const ROWS = `[...(sheet()?.querySelectorAll("[data-run-sheet-burst-row]") ?? [])].map((r) => r.getAttribute("data-run-sheet-burst-row"))`;
    await motionEval(h, `
        window.__rowFade = { faded: {}, on: true };
        const tick = () => {
            for (const r of sheet()?.querySelectorAll("[data-run-sheet-burst-row]") ?? []) {
                if (opacity(r) < 0.99) window.__rowFade.faded[r.getAttribute("data-run-sheet-burst-row")] = true;
            }
            if (window.__rowFade.on) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return true;
    `);
    const rowsBefore = await motionEval(h, `return ${ROWS};`);
    await dagPeekPublish(h, ctx, [["task-verify-started", { taskid: "t-3" }, 0]]);
    const live = await motionEval(h, `
        await until(() => ${ROWS}.length > ${rowsBefore.length}, 10000);
        await nap(${SETTLE_MS});
        window.__rowFade.on = false;
        return { rowsAfter: ${ROWS}, faded: Object.keys(window.__rowFade.faded) };
    `);
    const added = live.rowsAfter.filter((r) => !rowsBefore.includes(r));
    rec(
        "3. a burst arriving while the timeline is open enters as a card, and no row already there moves",
        added.length > 0 && live.faded.length > 0 && live.faded.every((r) => added.includes(r)),
        JSON.stringify({ rowsBefore, ...live, added })
    );

    // 4. the goal disclosure: the title folds away as the goal grows in
    const goal = await motionEval(h, `
        const el = sheet()?.querySelector("[data-run-sheet-title]");
        if (!el) return { error: "no title" };
        const w = watchAdded((n) => (n.parentElement === el ? n : null));
        const titlePane = el.firstElementChild;
        el.click();
        await nap(120);
        const mid = { attached: titlePane?.isConnected ?? false, opacity: opacity(titlePane) };
        await nap(${SETTLE_MS});
        w.stop();
        const opened = { attr: el.getAttribute("data-run-sheet-title"), first: w.seen[0] ?? null, settled: opacity(el.lastElementChild), panes: el.children.length };
        el.click();
        await nap(${SETTLE_MS});
        return { opened, mid, goneAfter: !titlePane?.isConnected, closed: { attr: el.getAttribute("data-run-sheet-title"), panes: el.children.length } };
    `);
    rec(
        "4. the heading opens onto the goal: the goal grows in from opacity 0 to 1 while the title leaves mid-fade, and closing returns the title",
        goal?.opened?.attr === "goal" &&
            revealed(goal.opened) &&
            goal.opened.panes === 1 &&
            leftMidFade(goal) &&
            goal.closed.attr === "title" &&
            goal.closed.panes === 1,
        JSON.stringify(goal)
    );

    // 5. the spend rolls when it changes
    await setUsage(h, ctx.runId, 12_000);
    await polishNap(SETTLE_MS);
    const spend = await motionEval(h, `
        const usage = () => sheet()?.querySelector("[data-run-sheet-usage]");
        await until(() => flat(usage()) === "12k tok", 5000);
        const before = flat(usage());
        const w = watchAdded((n) => (usage()?.contains(n) && n.textContent === "48k tok" ? n : null));
        window.__motionSpend = w;
        return { before };
    `);
    await setUsage(h, ctx.runId, 48_000);
    const rolled = await motionEval(h, `
        const usage = () => sheet()?.querySelector("[data-run-sheet-usage]");
        await nap(60);
        const spans = [...(usage()?.querySelectorAll("span span") ?? [])].map((s) => s.textContent);
        await nap(${SETTLE_MS});
        window.__motionSpend.stop();
        return { first: window.__motionSpend.seen[0] ?? null, midSpans: spans, after: flat(usage()) };
    `);
    rec(
        "5. the run's spend rolls from 12k to 48k tok: the new figure enters below full opacity beside the leaving one, then reads alone",
        spend.before === "12k tok" &&
            rolled.first != null &&
            rolled.first < 1 &&
            rolled.midSpans.includes("12k tok") &&
            rolled.after === "48k tok",
        JSON.stringify({ ...spend, ...rolled })
    );

    // 6. a segment changing state recolors, and the next: line washes once
    await motionEval(h, stripSampler(0));
    const injected = await injectPageDag(h, ctx.runId, {
        tasks: { "t-1": { state: "done" } },
        next: { kind: "dispatch", taskids: ["t-2"] },
    });
    const strip = await motionEval(h, stripRead(0));
    rec(
        "6. t-1 finishing recolors its strip segment through an intermediate color on the micro beat, and the next: line washes as it changes",
        injected === "ok" &&
            strip.stateAfter !== strip.stateBefore &&
            strip.transition?.ms === "0.14s" &&
            /background-color/.test(strip.transition.property) &&
            recolored(strip) &&
            strip.colors.some((c) => c !== strip.colorBefore && c !== strip.colorAfter) &&
            strip.nextAfter !== strip.nextBefore &&
            strip.flash === "changeFlash",
        JSON.stringify({ injected, ...strip })
    );
    await h.shot(`cdp-shots/${NAME}-strip.png`);

    // 7. the same changes under reduced motion land at once
    await h.cdp("Emulation.setEmulatedMedia", REDUCE);
    ctx.reduced = true;
    await polishNap(300);
    await motionEval(h, stripSampler(1));
    const injectedReduced = await injectPageDag(h, ctx.runId, {
        tasks: { "t-2": { state: "done" } },
        next: { kind: "dispatch", taskids: ["t-3"] },
    });
    const reduced = await motionEval(h, stripRead(1));
    await h.cdp("Emulation.setEmulatedMedia", NO_MEDIA);
    ctx.reduced = false;
    rec(
        "7. under reduced motion t-2 finishing lands its new color with no intermediate frame, and the next: line changes with no wash",
        injectedReduced === "ok" &&
            reduced.stateAfter !== reduced.stateBefore &&
            reduced.transition?.property === "none" &&
            recolored(reduced) &&
            reduced.colorAfter === strip.colorAfter &&
            reduced.colors.every((c) => c === reduced.colorBefore || c === reduced.colorAfter) &&
            reduced.nextAfter !== reduced.nextBefore &&
            (reduced.flash == null || reduced.flash === "none"),
        JSON.stringify({ injectedReduced, ...reduced })
    );
    await undoPageDag(h, ctx.runId);
}

// the run finishing under the open sheet, then its dock's save: refused, then landed
async function doneSteps(h, ctx, rec) {
    await h.rpc("cancelrun", { channelid: ctx.channelId, runid: ctx.runId });
    ctx.cancelled = true;
    await polishNap(1000);
    await motionEval(h, `
        const body = () => sheet()?.querySelector("[data-run-sheet-body]");
        window.__motionBody = watchAdded((n) =>
            n.parentElement === body() && n.querySelector("[data-evidence-block], [data-jarvis-brief-sheet-state], [data-jarvis-run-report]") ? n : null
        );
        return true;
    `);
    // an engine write that read the run before this one puts its own copy back, hence the retries (seedSheetRun)
    let stored = null;
    for (let i = 0; i < 3 && stored?.status !== "done"; i++) {
        stored = await fstWriteRun(h, ctx.runId, (r) => ({ ...r, status: "done" }));
        await polishNap(300);
    }
    const body = await motionEval(h, `
        await until(() => document.querySelector('[data-run-sheet="done"]') != null, 8000);
        await nap(${SETTLE_MS});
        window.__motionBody.stop();
        const pane = [...(sheet()?.querySelector("[data-run-sheet-body]")?.children ?? [])].find((c) =>
            c.querySelector("[data-evidence-block], [data-jarvis-brief-sheet-state], [data-jarvis-run-report]")
        );
        return { done: document.querySelector('[data-run-sheet="done"]') != null, first: window.__motionBody.seen[0] ?? null, settled: opacity(pane) };
    `);
    rec(
        "8. the run finishing under the open sheet fades its done body in from opacity 0 in place of the tasks",
        stored?.status === "done" && body.done && revealed(body),
        JSON.stringify({ stored: stored?.status, ...body })
    );

    await stubProfileWrite(h, 600, true);
    const refused = await motionEval(h, `
        const dock = () => sheet()?.querySelector("[data-run-sheet-carry]");
        await until(() => button(dock(), /^Use for new runs$/) != null, 8000);
        const busy = watchAdded((n) => (n.matches('[data-crossfade="saving"]') ? n : null));
        const result = watchAdded((n) => (n.matches("[data-run-sheet-result]") ? n : null));
        button(dock(), /^Use for new runs$/)?.click();
        await nap(150);
        const label = flat(dock()?.querySelector("button"));
        await until(() => sheet()?.querySelector("[data-run-sheet-result]") != null, 4000);
        await nap(${SETTLE_MS});
        busy.stop();
        result.stop();
        const shown = sheet()?.querySelector("[data-run-sheet-result]");
        return {
            busyFirst: busy.seen[0] ?? null,
            label,
            resultFirst: result.seen[0] ?? null,
            resultSettled: opacity(shown),
            text: flat(shown),
            idle: button(dock(), /^Use for new runs$/) != null,
        };
    `);
    rec(
        "9. Use for new runs cross-fades to Saving…, and the refusal fades in under the dock from opacity 0",
        refused.busyFirst != null &&
            refused.busyFirst < 1 &&
            /Saving/.test(refused.label) &&
            refused.resultFirst != null &&
            refused.resultFirst < MOUNTED_HIDDEN &&
            refused.resultSettled === 1 &&
            /Couldn't save/.test(refused.text) &&
            refused.idle,
        JSON.stringify(refused)
    );

    await stubProfileWrite(h, 300, false);
    const saved = await motionEval(h, `
        const dock = () => sheet()?.querySelector("[data-run-sheet-carry]");
        const w = watchAdded((n) => (n.matches("[data-run-sheet-saved]") ? n : null));
        button(dock(), /^Use for new runs$/)?.click();
        await until(() => sheet()?.querySelector("[data-run-sheet-saved]") != null, 4000);
        await nap(${SETTLE_MS});
        w.stop();
        return { first: w.seen[0] ?? null, settled: opacity(sheet()?.querySelector("[data-run-sheet-saved]")) };
    `);
    await releaseRpc(h, "SetChannelProfileCommand");
    rec("10. a save that lands fades its confirmation in from opacity 0", revealed(saved), JSON.stringify(saved));
    await h.shot(`cdp-shots/${NAME}-done.png`);
}

// TaskDetail, its DecisionLog and the report view, mounted over the page and re-rendered with what changed
async function leafSteps(h, rec) {
    const mounted = await motionEval(h, `
        unmountAll();
        window.__motionDetail = ${JSON.stringify(DETAIL)};
        window.__motionHost = await mount("app/view/jarvis/taskdetail.tsx", "TaskDetail", { detail: window.__motionDetail, statusWritable: false }, { style: ${JSON.stringify(MOUNT_STYLE)} });
        await until(() => window.__motionHost.querySelector("[data-jarvis-detail-state]") != null, 4000);
        return window.__motionHost.querySelector("[data-jarvis-detail-state]") != null;
    `);
    const render = (patch) => `
        window.__motionDetail = { ...window.__motionDetail, ...${patch} };
        window.__motionHost.render({ detail: window.__motionDetail, statusWritable: false });
    `;

    const state = await motionEval(h, `
        const el = () => window.__motionHost.querySelector("[data-jarvis-detail-state]");
        const onMount = /changeFlash/.test(el()?.className ?? "");
        ${render(`{ state: "Executing the sheet" }`)}
        await nap(100);
        const flashed = { cls: /changeFlash/.test(el()?.className ?? ""), anim: getComputedStyle(el()).animationName };
        await nap(1400);
        return { onMount, flashed, after: /changeFlash/.test(el()?.className ?? ""), text: flat(el()) };
    `);
    rec(
        "11. a record's state rewritten while open washes once, never on mount",
        mounted === true &&
            !state.onMount &&
            state.flashed.cls &&
            state.flashed.anim === "changeFlash" &&
            !state.after &&
            state.text === "Executing the sheet",
        JSON.stringify({ mounted, ...state })
    );

    const body = await motionEval(h, `
        const host = window.__motionHost;
        const toggle = host.querySelector("[data-jarvis-detail-body-toggle]");
        const box = host.querySelector("[data-jarvis-detail-body]")?.parentElement?.parentElement;
        if (!toggle || !box) return { error: "no body toggle or box" };
        const heights = sampleFrames(() => Math.round(box.getBoundingClientRect().height));
        toggle.click();
        await nap(${SETTLE_MS});
        heights.stop();
        return { heights: heights.values, expanded: toggle.getAttribute("aria-expanded") };
    `);
    rec(
        "12. Show the full objective grows the body through intermediate heights instead of jumping",
        body.expanded === "true" && body.heights.length >= 3 && body.heights.at(-1) > body.heights[0],
        JSON.stringify(body)
    );

    const decisions = await motionEval(h, `
        const host = window.__motionHost;
        const card = (id) => host.querySelector('[data-jarvis-decision="' + id + '"]')?.parentElement ?? null;
        const added = watchAdded((n) => (n.firstElementChild?.matches("[data-jarvis-decision]") ? n : null));
        ${render(`{ decisions: [${JSON.stringify(D1)}, ${JSON.stringify(D2)}] }`)}
        await nap(${SETTLE_MS});
        added.stop();
        const entered = { seen: added.seen, settled: opacity(card(${JSON.stringify(D2.id)})) };
        const label = watchAdded((n) => (n.matches('[data-crossfade="superseded"]') ? n : null));
        ${render(`{ decisions: [${JSON.stringify({ ...D1, status: "superseded" })}, ${JSON.stringify(D2)}] }`)}
        await nap(${SETTLE_MS});
        label.stop();
        const chip = host.querySelector('[data-jarvis-decision="${D1.id}"] [data-crossfade="superseded"]');
        return { entered, label: { first: label.seen[0] ?? null, settled: opacity(chip), text: flat(chip) } };
    `);
    rec(
        "13. a decision logged while the log is open enters as a card from opacity 0, and only that one",
        decisions.entered.seen.length === 1 && decisions.entered.seen[0] < MOUNTED_HIDDEN && decisions.entered.settled === 1,
        JSON.stringify(decisions.entered)
    );
    rec(
        "14. a decision superseded while open cross-fades its status label in",
        decisions.label.first != null && decisions.label.first < 1 && decisions.label.settled === 1 && decisions.label.text === "superseded",
        JSON.stringify(decisions.label)
    );

    const form = await motionEval(h, `
        const host = window.__motionHost;
        const pane = () => host.querySelector("[data-jarvis-decision-form]")?.parentElement ?? null;
        const w = watchAdded((n) => (n.firstElementChild?.matches("[data-jarvis-decision-form]") ? n : null));
        host.querySelector("[data-jarvis-decision-add]")?.click();
        await nap(${SETTLE_MS});
        w.stop();
        const opened = { first: w.seen[0] ?? null, settled: opacity(pane()) };
        const leaving = pane();
        button(leaving, /^Cancel$/)?.click();
        await nap(60);
        const mid = { attached: leaving?.isConnected ?? false, opacity: opacity(leaving) };
        await nap(${SETTLE_MS});
        return { opened, mid, goneAfter: leaving != null && !leaving.isConnected, addBack: host.querySelector("[data-jarvis-decision-add]") != null };
    `);
    rec(
        "15. + Add decision grows the form in from opacity 0, and Cancel folds it away mid-fade",
        revealed(form.opened) && leftMidFade(form) && form.addBack,
        JSON.stringify(form)
    );
    await h.shot(`cdp-shots/${NAME}-record.png`);

    const report = await motionEval(h, `
        unmountAll();
        const host = await mount("app/view/jarvis/runreportview.tsx", "RunReportView", { model: null, run: { report: ${JSON.stringify(REPORT)} } }, { style: ${JSON.stringify(MOUNT_STYLE)} });
        await until(() => host.querySelector('[data-jarvis-run-report-face="structured"]') != null, 4000);
        const faces = sampleFrames(() => host.querySelectorAll("[data-jarvis-run-report-face]").length);
        const w = watchAdded((n) => (n.matches('[data-jarvis-run-report-face="raw"]') ? n : null));
        button(host, /^raw markdown$/)?.click();
        await nap(${SETTLE_MS});
        w.stop();
        faces.stop();
        const raw = host.querySelector('[data-jarvis-run-report-face="raw"]');
        const out = { first: w.seen[0] ?? null, settled: opacity(raw), faces: faces.values, pre: raw?.querySelector("pre") != null };
        unmountAll();
        return out;
    `);
    rec(
        "16. the report's raw markdown fades in where the structured face was, the two never on screen together",
        revealed(report) && report.pre && Math.max(...report.faces) === 1,
        JSON.stringify(report)
    );
}

export const motionRunSheet = {
    name: NAME,
    surface: "jarvis",
    async arrange(h) {
        await h.cdp("Emulation.setDeviceMetricsOverride", OBS_WIDE);
        return arrangeSheetDagRun(h, NAME, RUN_SHEET_POLISH_TASKS);
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        rec(
            "0. the run's sheet opened on the Brief",
            ctx.arrangeError == null && ctx.opened?.ok === true,
            ctx.arrangeError ?? JSON.stringify({ runId: ctx.runId, opened: ctx.opened })
        );
        if (ctx.arrangeError != null) return steps;
        await h.cdp("Emulation.setDeviceMetricsOverride", OBS_WIDE);
        // a phase that throws fails as one step and keeps the steps before it
        const phase = async (name, fn) => {
            try {
                await fn();
            } catch (e) {
                rec(`${name} ran to the end`, false, String(e?.stack ?? e));
            }
        };
        await phase("the sheet's moments", () => sheetSteps(h, ctx, rec));
        await phase("the done run's moments", () => doneSteps(h, ctx, rec));
        await phase("the record's and report's moments", () => leafSteps(h, rec));
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
        await step("reset the media emulation", () => h.cdp("Emulation.setEmulatedMedia", NO_MEDIA));
        await step("clear the viewport override", () => h.cdp("Emulation.clearDeviceMetricsOverride", {}));
        await step("unmount the look hosts", () => lookEval(h, "unmountAll(); return true;"));
        await step("restore the profile write", () => releaseRpc(h, "SetChannelProfileCommand"));
        if (ctx.runId) await step("undo the page dag", () => undoPageDag(h, ctx.runId));
        // a done run cannot be cancelled; the cancel before it stopped the worker
        await teardownFixtureRun(h, ctx.cancelled ? { ...ctx, runId: null } : ctx, NAME);
    },
};
