// Cockpit shell scenarios: smoke, keys, UI API, motion gaps, headers, empty state, toasts, context menu, UI drift.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SURFACE_LABEL } from "./attach.mjs";
import {
    COCKPIT,
    COCKPIT_LEAD_CARD,
    MIN_FONT_PX,
    MODELS_VIEWPORT,
    PALETTE_INPUT,
    TREE_RAIL_FIXTURE,
    TREE_RAIL_LEAD_ID,
    UI_ROUTE,
    arrangeFixtureRun,
    floorDetail,
    floorOk,
    floorStep,
    focusAgentXterm,
    git,
    lookEval,
    lookHover,
    lookKey,
    lookOpen,
    lookShot,
    openPalette,
    paintEval,
    paletteKey,
    polishNap,
    polishReload,
    polishWaitFor,
    setInputExpr,
    skipStep,
    teardownFixtureRun,
    treeRailRoster,
    waitForProjectInConfig,
} from "./scenarios-shared.mjs";
// --- exemplar: visual + DOM --------------------------------------------------------------------
// Navigate each key surface, screenshot it, and assert (a) the active nav label matches and (b) the
// content region rendered non-empty text — which catches a surface that blanks out on render. No
// arrange needed; a populated-roster visual still relies on the manual inject-live-agents path.
// Channels/Graph/Tasks merged into Jarvis and have no nav button left, so listing one here would make
// h.goto throw before any step is recorded.
const SMOKE_SURFACES = ["cockpit", "jarvis", "usage", "files", "settings", "code", "setup"];

// the rail's order and the Ctrl+1..N chords come from SURFACE_ORDER, read from its source so the steps keep one list
const AGENTS_SOURCE = fileURLToPath(new URL("../../frontend/app/view/agents/agents.tsx", import.meta.url));
const surfaceOrder = () =>
    [...readFileSync(AGENTS_SOURCE, "utf8").match(/export const SURFACE_ORDER[^=]*=\s*\[([^\]]*)\]/)[1].matchAll(/"(\w+)"/g)].map(
        (m) => m[1]
    );
const keydown = (init) => `document.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ ...init, bubbles: true })}))`;
const WHICH_KEY_TEXT = `[...document.querySelectorAll('span')].find((s) => (s.textContent || '').trim() === 'g →')?.parentElement?.innerText ?? null`;
const SMOKE_KEY_WAIT_MS = 400;

export const surfaceSmoke = {
    name: "surface-smoke",
    surface: "cockpit",
    async arrange() {
        return { cwd: mkdtempSync(join(tmpdir(), "verify-surface-smoke-")) };
    },
    async assert(h, ctx) {
        const steps = [];
        for (const surface of SMOKE_SURFACES) {
            await h.goto(surface);
            const active = await h.activeSurfaceLabel();
            const contentLen = await h.ev(
                `(() => { const n=document.querySelector('nav'); const c=n&&n.nextElementSibling; return c?(c.textContent||'').trim().length:0; })()`
            );
            const expected = SURFACE_LABEL[surface];
            steps.push({
                step: `goto ${surface} -> active nav "${expected}", content non-empty`,
                ok: active === expected && contentLen > 0,
                detail: `active=${active} contentLen=${contentLen}`,
            });
            await h.shot(`cdp-shots/surface-${surface}.png`);
        }
        // Radar is retired: the rail has one button per surface and none of them is Radar
        const railLabels = await h.ev(
            `[...document.querySelectorAll('nav button')].map((b) => b.getAttribute('aria-label') || (b.textContent || '').trim())`
        );
        const wantLabels = Object.values(SURFACE_LABEL);
        steps.push({
            step: "nav rail lists no Radar",
            ok:
                !railLabels.some((l) => /radar/i.test(l)) &&
                railLabels.length === wantLabels.length &&
                JSON.stringify([...railLabels].sort()) === JSON.stringify([...wantLabels].sort()),
            detail: `rail=${JSON.stringify(railLabels)} want=${JSON.stringify(wantLabels)}`,
        });
        const order = surfaceOrder();
        const lastLabel = SURFACE_LABEL[order[order.length - 1]];
        // Ctrl+N jumps to the Nth surface, so the last one's digit follows the order's length (8 since 95538b652)
        const lastDigit = String(order.length);
        await h.goto("cockpit");
        await h.ev(keydown({ key: lastDigit, code: `Digit${lastDigit}`, ctrlKey: true }));
        await h.ev(`new Promise((r) => setTimeout(r, ${SMOKE_KEY_WAIT_MS}))`);
        const chorded = await h.activeSurfaceLabel();
        steps.push({
            step: `Ctrl+${lastDigit} lands on the last surface`,
            ok: chorded === lastLabel,
            detail: `active=${chorded} want=${lastLabel} order=${JSON.stringify(order)}`,
        });
        await h.goto("cockpit");
        await h.ev(keydown({ key: "g", code: "KeyG" }));
        await h.ev(`new Promise((r) => setTimeout(r, ${SMOKE_KEY_WAIT_MS}))`);
        const whichKey = await h.ev(WHICH_KEY_TEXT);
        await h.ev(keydown({ key: "r", code: "KeyR" }));
        await h.ev(`new Promise((r) => setTimeout(r, ${SMOKE_KEY_WAIT_MS}))`);
        const afterGR = await h.activeSurfaceLabel();
        await h.ev(keydown({ key: "Escape", code: "Escape" }));
        steps.push({
            step: "g r does nothing",
            ok: afterGR === SURFACE_LABEL.cockpit && !/radar/i.test(whichKey ?? ""),
            detail: `active=${afterGR} whichKey=${JSON.stringify(whichKey)}`,
        });
        // B3: a notify (wsh notify / wave_notify) is spoken by the avatar, which is its only voice: the
        // bubble carries the title and leaves after 6s, and no corner toast repeats it underneath.
        await h.goto("cockpit");
        await h.rpc("notify", { title: "cdp surface-smoke", level: "info" });
        await h.ev("new Promise((r) => setTimeout(r, 600))");
        const spoken = await h.ev(`(() => ({
            bubble: document.querySelector('[data-pet-bubble]')?.textContent?.includes('cdp surface-smoke') ?? false,
            toast: !!document.querySelector('[data-notification-toast]'),
        }))()`);
        await h.ev("new Promise((r) => setTimeout(r, 7000))");
        const bubbleGone = await h.ev(`(() => !document.querySelector('[data-pet-bubble]'))()`);
        steps.push({
            step: "wsh notify -> the avatar says it once, with no toast, and the bubble leaves",
            ok: spoken.bubble === true && spoken.toast === false && bubbleGone === true,
            detail: `bubble=${spoken.bubble} toast=${spoken.toast} gone=${bubbleGone}`,
        });
        // B2: the steer input renders on a pi session card (AgentDetailsRail, Agent surface). Dev
        // runs rarely have a live pi session focused, so this is conditional: no steer input -> SKIP
        // (the manual round-trip covers it).
        await h.goto("agent");
        const steerFound = await h.ev(
            `(() => !!document.querySelector('input[placeholder^="Steer this Pi session"]'))()`
        );
        steps.push(
            steerFound
                ? { step: "steer input visible on a pi session card", ok: true, detail: "found on the Agent surface" }
                : skipStep(
                      "steer input visible on a pi session card",
                      "no pi session focused in this run - focus one before reading this as a pass (the manual round-trip covers it)"
                  )
        );
        // last: these swap the live roster for a fixture one, which the steps above must not see
        steps.push(...(await cacheMissNoticeSteps(h, ctx)));
        steps.push(await floorStep(h, `no visible text in the nav rail is under ${MIN_FONT_PX}px`, `document.querySelector("nav")`));
        return steps;
    },
    async teardown(h, ctx) {
        await teardownFixtureRun(h, ctx, "surface-smoke");
        await h.goto("cockpit"); // leave the app where a human expects it
    },
};

// A said-once notice from an agent's block (the cache miss notice): the bubble names the agent, nothing is kept
// once it leaves, and a click on it opens the agent. The titles and the long name are the canvas's own
// (.superpowers/design/cache-miss-notice).
const CACHE_MISS_LEAD = "Release checkpoint";
const CACHE_MISS_LONG_LEAD = "Arc Claude mod: usage and ask through Claude Code function hooks";
const CACHE_MISS_TITLE = "Cache miss: 85k tokens re-billed after 12m idle";
const CACHE_MISS_TWO_TITLE = "2 cache misses: 140k tokens re-billed (85k after 12m idle, 55k after a model switch)";
// treeRailRoster's lead block
const CACHE_MISS_OREF = "block:fx-blk-lead";
// the agent line is 12px text: one line is under this, two are over
const ONE_LINE_MAX_PX = 24;
const CACHE_MISS_STEPS = [
    "said-once notify from an agent's block -> the bubble names the agent and its project above the title",
    "the said-once bubble leaves -> no unread marker, and the popup does not list it",
    "a long agent name is cut on one line and the project stays inside the bubble",
    "clicking a said-once bubble opens its agent, with the bubble gone and the popup shut",
];

async function cacheMissNoticeSteps(h, ctx) {
    const steps = [];
    const rec = (step, ok, detail) => steps.push({ step, ok, detail });
    const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
    // the fixture roster is read once at boot
    const reload = async () => {
        await h.ev("location.reload()");
        await polishWaitFor(h, `!!document.querySelector("nav button")`, 30000);
        await polishWaitFor(h, `!!document.querySelector('[aria-label="Jarvis condition"]')`, 10000);
        await settle(1500);
    };
    const say = (title) =>
        h.rpc("notify", { title, level: "warn", oref: CACHE_MISS_OREF, transient: true });
    const BUBBLE = `(() => {
        const bubble = document.querySelector('[data-pet-bubble]');
        const line = bubble?.querySelector('[data-pet-bubble-agent]');
        const name = line?.querySelector('[data-pet-bubble-agent-name]');
        const project = line?.querySelector('[data-pet-bubble-agent-project]');
        if (!bubble || !line || !name || !project) return null;
        const box = bubble.getBoundingClientRect();
        const proj = project.getBoundingClientRect();
        return {
            text: bubble.textContent,
            name: name.textContent,
            project: project.textContent,
            nameCut: name.scrollWidth > name.clientWidth,
            lineHeight: Math.round(line.getBoundingClientRect().height),
            projectInside: proj.width > 0 && proj.left >= box.left && proj.right <= box.right,
        };
    })()`;
    // the roster lands a moment after boot, and the agent line with it
    const bubbleWithAgent = async () => {
        await polishWaitFor(h, `!!document.querySelector('[data-pet-bubble] [data-pet-bubble-agent]')`, 4000);
        return h.ev(BUBBLE);
    };
    const closePopup = async () => {
        await h.ev(`document.querySelector('[data-pet-peek] button[aria-label="Close Jarvis panel"]')?.click()`);
        return polishWaitFor(h, `!document.querySelector('[data-pet-peek]')`, 3000);
    };
    const openPopup = async () => {
        await h.ev(`document.querySelector('[aria-label="Jarvis condition"]')?.click()`);
        return polishWaitFor(h, `!!document.querySelector('[data-pet-peek]')`, 3000);
    };

    try {
        await arrangeFixtureRun(h, ctx, "surface-smoke", CACHE_MISS_LEAD);
        await reload();
    } catch (e) {
        // no roster agent to send from is a failure of every step, never a skip
        for (const step of CACHE_MISS_STEPS) rec(step, false, `arrange failed: ${e?.message ?? e}`);
        return steps;
    }
    await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
    await h.goto("cockpit");

    // a kept notice first, opened and shut: it clears the marker, and gives step 2 a title the popup does list
    const KEPT = "cdp surface-smoke kept";
    await h.rpc("notify", { title: KEPT, level: "info" });
    await settle(600);
    await openPopup();
    await closePopup();

    await say(CACHE_MISS_TITLE);
    const first = await bubbleWithAgent();
    await settle(400);
    await h.shot("cdp-shots/pet-cache-miss-bubble.png");
    rec(
        CACHE_MISS_STEPS[0],
        first != null &&
            first.name === CACHE_MISS_LEAD &&
            first.project === "waveterm" &&
            first.text.includes(CACHE_MISS_TITLE),
        JSON.stringify(first)
    );

    await settle(7000);
    const left = await h.ev(`(() => ({
        bubbleGone: !document.querySelector('[data-pet-bubble]'),
        unread: !!document.querySelector('[data-pet-unread]'),
    }))()`);
    const opened = await openPopup();
    await h.ev(`(() => {
        const toggle = document.querySelector('[data-pet-updates] button[aria-expanded="false"]');
        toggle?.click();
    })()`);
    await settle(500);
    const listed = await h.ev(`(() => {
        const text = document.querySelector('[data-pet-peek]')?.textContent ?? '';
        return { kept: text.includes(${JSON.stringify(KEPT)}), once: text.includes(${JSON.stringify(CACHE_MISS_TITLE)}) };
    })()`);
    await h.shot("cdp-shots/pet-cache-miss-gone.png");
    rec(
        CACHE_MISS_STEPS[1],
        left.bubbleGone === true && left.unread === false && opened === true && listed.kept === true && listed.once === false,
        JSON.stringify({ ...left, opened, listed })
    );
    await closePopup();

    writeFileSync(
        TREE_RAIL_FIXTURE,
        JSON.stringify(treeRailRoster(ctx.runId, Date.now(), CACHE_MISS_LONG_LEAD), null, 2)
    );
    await reload();
    await h.goto("cockpit");
    await say(CACHE_MISS_TWO_TITLE);
    const long = await bubbleWithAgent();
    await settle(400);
    await h.shot("cdp-shots/pet-cache-miss-long-name.png");
    rec(
        CACHE_MISS_STEPS[2],
        long != null &&
            long.name === CACHE_MISS_LONG_LEAD &&
            long.nameCut === true &&
            long.lineHeight < ONE_LINE_MAX_PX &&
            long.projectInside === true &&
            long.text.includes(CACHE_MISS_TWO_TITLE),
        JSON.stringify(long)
    );

    await say(CACHE_MISS_TITLE);
    await bubbleWithAgent();
    const clicked = await h.ev(`(() => {
        const bubble = document.querySelector('[data-pet-bubble]');
        bubble?.click();
        return !!bubble;
    })()`);
    await polishWaitFor(h, `!document.querySelector('[data-pet-bubble]')`, 3000);
    const after = await h.ev(`(() => ({
        bubbleGone: !document.querySelector('[data-pet-bubble]'),
        popup: !!document.querySelector('[data-pet-peek]'),
        header: document.querySelector('[data-agent-header]')?.textContent ?? '',
    }))()`);
    const active = await h.activeSurfaceLabel();
    let selection;
    try {
        selection = (await h.rpc("uistate", null, UI_ROUTE))?.selection ?? [];
    } catch (e) {
        selection = [`uistate failed: ${e?.message ?? e}`];
    }
    await h.shot("cdp-shots/pet-cache-miss-click.png");
    rec(
        CACHE_MISS_STEPS[3],
        clicked === true &&
            active === SURFACE_LABEL.agent &&
            selection[0] === `agent:${TREE_RAIL_LEAD_ID}` &&
            after.header.includes(CACHE_MISS_LONG_LEAD) &&
            after.bubbleGone === true &&
            after.popup === false,
        JSON.stringify({ clicked, active, selection, ...after })
    );
    return steps;
}
// --- cockpit UI API (wsh ui) ----------------------------------------------------------------------
// Calls the real FE handlers on the fixed "cockpit" route. The FE router delivers a same-window call
// locally, so the wavesrv routing hop that a real `wsh ui` takes is NOT under test here — the manual
// wsh smoke in the plan covers it; wshcmd-ui_test.go covers the CLI's own logic.
export const uiApi = {
    name: "ui-api",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        const call = async (command, data) => {
            try {
                return { value: await h.rpc(command, data, UI_ROUTE) };
            } catch (e) {
                return { error: String(e?.message ?? e) };
            }
        };
        const toastCount = () => h.ev(`document.querySelectorAll('[data-notification-toast]').length`);
        const toastWith = (text) =>
            h.ev(
                `[...document.querySelectorAll('[data-notification-toast]')].some((t) => (t.textContent || '').includes(${JSON.stringify(text)}))`
            );
        // a keystroke an earlier scenario sent would otherwise hold the first call in the busy wait
        await settle(1600);

        const s1 = await call("uistate", null);
        rec(
            "1. uistate reports the surface the harness is on, with actions",
            s1.value?.surface === "cockpit" && Array.isArray(s1.value?.actions) && s1.value.actions.length > 0,
            JSON.stringify({ surface: s1.value?.surface, actions: s1.value?.actions?.length, error: s1.error })
        );

        const r2 = await call("uireveal", { address: "surface:usage" });
        await settle(400);
        const active2 = await h.activeSurfaceLabel();
        rec(
            "2. uireveal surface:usage lands Usage",
            !r2.error && active2 === SURFACE_LABEL.usage,
            `active=${active2} error=${r2.error}`
        );

        const before3 = await toastCount();
        const r3 = await call("uireveal", { address: "run:00000000-0000-0000-0000-000000000000" });
        await settle(400);
        const after3 = await toastCount();
        rec(
            "3. uireveal of a missing run errors to the caller and pushes no toast",
            !!r3.error && after3 <= before3,
            `error=${r3.error} toasts ${before3}->${after3}`
        );

        const r4 = await call("uiinvoke", { actionid: "go:cockpit" });
        await settle(400);
        const active4 = await h.activeSurfaceLabel();
        const trail4 = await toastWith("Cockpit (home)");
        rec(
            "4. uiinvoke go:cockpit lands Cockpit and leaves a trail toast",
            !r4.error && active4 === SURFACE_LABEL.cockpit && trail4 === true,
            `active=${active4} trail=${trail4} error=${r4.error}`
        );

        const r5 = await call("uiinvoke", { actionid: "no-such-action" });
        rec(
            "5. uiinvoke of an unavailable id errors with the actions hint",
            /see wsh ui actions/.test(r5.error ?? ""),
            `error=${r5.error}`
        );

        // bare Shift has no binding, so this only marks the user as active
        await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft", modifiers: 8 });
        await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft" });
        const t0 = Date.now();
        const r6 = await call("uireveal", { address: "surface:usage" });
        const waited = Date.now() - t0;
        rec(
            "6. a reveal right after a keystroke waits out the idle window",
            !r6.error && waited >= 1300,
            `waited=${waited}ms error=${r6.error}`
        );
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit"); // leave the app where a human expects it
    },
};

export const DOC_REVIEW_LEAD_ID = "fx-doc-lead";
export const DOC_REVIEW_PANEL = `document.querySelector("[data-doc-review]")?.closest('[role="dialog"]')`;

// The Cockpit on the brief type scale (docs/superpowers/specs/2026-09-29-cockpit-polish-design.md): nothing under
// 10.5px, and the lead card leads with the Workflow icon. Same setup as agent-tree-rail: a fixture roster whose lead
// carries a real orchestrator run held in planning. No dagsubmit (see TREE_RAIL_FIXTURE), so the card has no plan
// and no bar; the bar is covered by leadcardmodel.test.ts.
const COCKPIT_POLISH_LEAD = "cockpit-polish lead";

// the first thing the lead card's header draws: an svg, or the element holding the first text
const LEAD_MARK_EXPR = `(() => {
    const header = ${COCKPIT_LEAD_CARD}?.firstElementChild;
    if (!header) return null;
    const walk = (el) => {
        for (const c of el.children) {
            if (c.tagName.toLowerCase() === "svg") return "svg";
            const text = [...c.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.data.trim());
            if (text) return "text:" + text.data.trim().slice(0, 20);
            const found = walk(c);
            if (found) return found;
        }
        return null;
    };
    return walk(header);
})()`;

export const cockpitPolish = {
    name: "cockpit-polish",
    surface: "cockpit",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-cockpit-polish-"));
        const ctx = { cwd };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            await arrangeFixtureRun(h, ctx, "cockpit-polish", COCKPIT_POLISH_LEAD);
            // the fixture roster is read once at boot
            await h.ev("location.reload()");
            await h.ev(`(async () => {
                for (let i = 0; i < 60 && !document.querySelector("nav button"); i++) {
                    await new Promise((r) => setTimeout(r, 500));
                }
            })()`);
            await h.goto("cockpit");
            // the fixture lead first renders as a plain agent card; it becomes the lead card once its run loads
            ctx.leadCard = await h.ev(`(async () => {
                for (let i = 0; i < 60; i++) {
                    const card = ${COCKPIT_LEAD_CARD};
                    if (card && (${LEAD_MARK_EXPR} === "svg" || card.textContent.includes("no plan submitted"))) {
                        return true;
                    }
                    await new Promise((r) => setTimeout(r, 250));
                }
                return false;
            })()`);
            // let the card's enter motion settle
            await new Promise((r) => setTimeout(r, 800));
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        rec(
            "0. the fixture lead renders as its run's lead card on the Cockpit",
            ctx.arrangeError == null && ctx.leadCard === true,
            ctx.arrangeError ?? `runId=${ctx.runId}`
        );

        steps.push(await floorStep(h, "1. no visible text on the Cockpit is under 10.5px", COCKPIT));

        const mark = await h.ev(LEAD_MARK_EXPR);
        rec("2. the lead card's header leads with an svg (the Workflow icon)", mark === "svg", `mark=${mark}`);

        const chips = await paintEval(h, `
            const bar = document.querySelector("[data-cockpit-hints]");
            const keys = [...(bar?.querySelectorAll("span.font-mono") ?? [])];
            return { bar: bar != null, keys: keys.length, raw: keys.filter((k) => rawOverlay(getComputedStyle(k).backgroundColor)).map((k) => k.textContent) };
        `);
        rec("3. the HintsBar's key chips have no raw white or black overlay background", chips.bar && chips.keys > 0 && chips.raw.length === 0, JSON.stringify(chips));
        return steps;
    },
    async teardown(h, ctx) {
        await teardownFixtureRun(h, ctx, "cockpit-polish");
    },
};

// The Cockpit's j/k/n/Enter are the container's own onKeyDown (usecockpitkeyboard.ts), so they work only
// while focus is inside it. Arriving from the Agent surface left focus on <body> (the palette's restore
// target, the xterm, is display:none by then) or on the nav button, and every Cockpit key was dead until a
// click. A key is dispatched at whatever holds focus, which is where a real keypress would land.
const COCKPIT_SURFACE = `document.querySelector('[data-cockpit-surface]')`;
const cockpitKeyReach = `(() => {
    const c = ${COCKPIT_SURFACE};
    if (!c) return { reached: false, active: 'no cockpit surface' };
    let reached = false;
    const probe = (e) => { if (e.key === 'j') reached = true; };
    c.addEventListener('keydown', probe, true);
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', bubbles: true, cancelable: true }));
    c.removeEventListener('keydown', probe, true);
    return { reached, active: target.tagName + (target.getAttribute('data-cockpit-surface') != null ? '[cockpit]' : '') };
})()`;

export const cockpitKeysOnArrival = {
    name: "cockpit-keys-on-arrival",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);

        await h.goto("agent");
        await h.ev(focusAgentXterm);
        const opened = await openPalette(h);
        await h.ev(setInputExpr(PALETTE_INPUT, "cockpit"));
        await polishNap(300);
        await h.ev(paletteKey("Enter"));
        await polishWaitFor(h, `!!${COCKPIT_SURFACE}`, 3000);
        await polishNap(300);
        const viaPalette = await h.ev(cockpitKeyReach);
        steps.push({
            step: "Agent -> Ctrl+P 'cockpit' -> Enter: j reaches the Cockpit",
            ok: opened === true && viaPalette.reached === true,
            detail: `palette=${opened} active=${viaPalette.active}`,
        });

        await h.goto("agent");
        await h.ev(focusAgentXterm);
        await h.goto("cockpit");
        const viaNav = await h.ev(cockpitKeyReach);
        steps.push({
            step: "Agent -> nav click Cockpit: j reaches the Cockpit",
            ok: viaNav.reached === true,
            detail: `active=${viaNav.active}`,
        });
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};

// --- motion gaps ---------------------------------------------------------------------------------
// The cockpit toast and the Setup tab panel used to cut in and out. Each check samples in-page, in one
// evaluation, because a CDP round trip per sample is slower than the animations it measures: an observer
// reads the opacity an element mounts with, and a timer reads a leaving toast mid-exit.
export const motionGaps = {
    name: "motion-gaps",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        // a keystroke an earlier scenario sent would otherwise hold the call in the busy wait
        await settle(1600);

        // 1. a toast mounts transparent and fades in. go:cockpit leaves a trail toast (see ui-api).
        await h.ev(`(() => {
            window.__motionToast = [];
            new MutationObserver((muts, obs) => {
                for (const m of muts) for (const n of m.addedNodes) {
                    if (n instanceof Element && n.matches('[data-notification-toast]')) {
                        window.__motionToast.push(getComputedStyle(n).opacity);
                        obs.disconnect();
                    }
                }
            }).observe(document.body, { childList: true, subtree: true });
        })()`);
        await h.rpc("uiinvoke", { actionid: "go:cockpit" }, UI_ROUTE);
        await settle(600);
        const enter = await h.ev(`(() => ({
            first: window.__motionToast[0] ?? null,
            settled: (() => {
                const t = [...document.querySelectorAll('[data-notification-toast]')].at(-1);
                return t ? getComputedStyle(t).opacity : null;
            })(),
        }))()`);
        rec(
            "1. a cockpit toast mounts at opacity 0 and settles at 1",
            enter.first === "0" && enter.settled === "1",
            JSON.stringify(enter)
        );
        await h.shot("cdp-shots/motion-gaps-toast.png");
        const cockpitFloor = await floorStep(h, `4. no visible text on the Cockpit is under ${MIN_FONT_PX}px`, COCKPIT);

        // 2. a dismissed toast stays attached while it fades, then leaves
        const exit = await h.ev(`(async () => {
            const t = [...document.querySelectorAll('[data-notification-toast]')].at(-1);
            if (!t) return null;
            t.click();
            await new Promise((r) => setTimeout(r, 120));
            const mid = { attached: t.isConnected, opacity: Number(getComputedStyle(t).opacity) };
            await new Promise((r) => setTimeout(r, 700));
            return { mid, goneAfter: !t.isConnected };
        })()`);
        rec(
            "2. a dismissed toast fades out while still attached, then is removed",
            exit != null && exit.mid.attached && exit.mid.opacity > 0 && exit.mid.opacity < 1 && exit.goneAfter,
            JSON.stringify(exit)
        );

        // 3. a Setup tab swap fades the new panel in instead of cutting to it
        await h.goto("setup");
        await settle(800);
        const fade = await h.ev(`(async () => {
            const seen = [];
            const obs = new MutationObserver((muts) => {
                for (const m of muts) for (const n of m.addedNodes) {
                    if (n instanceof Element && n.id === 'setup-tabpanel') seen.push(getComputedStyle(n).opacity);
                }
            });
            obs.observe(document.body, { childList: true, subtree: true });
            document.getElementById('setup-tab-skills')?.click();
            await new Promise((r) => setTimeout(r, 400));
            obs.disconnect();
            const panel = document.getElementById('setup-tabpanel');
            return {
                first: seen[0] ?? null,
                settled: panel ? getComputedStyle(panel).opacity : null,
                tab: panel?.getAttribute('aria-labelledby') ?? null,
            };
        })()`);
        rec(
            "3. switching Setup to Skills fades the panel in from 0 to 1",
            fade.first === "0" && fade.settled === "1" && fade.tab === "setup-tab-skills",
            JSON.stringify(fade)
        );
        await h.shot("cdp-shots/motion-gaps-setup.png");
        steps.push(cockpitFloor);
        return steps;
    },
    async teardown(h) {
        await h.ev(`document.getElementById('setup-tab-instructions')?.click()`);
        await h.goto("cockpit");
    },
};

// --- surface headers: one shared toolbar on every surface but Agent ------------------------------
// Each surface's SurfaceToolbar measured against the prototype canvas (Main.dc.html) at its main board
// size. Final runs this on a fresh, empty store, so arrange makes everything a step reads: a git repo at
// a long path registered as one project (Diff, Code's path fact), a fixture roster (Cockpit, the
// Sessions live fact, the Jarvis chip), and a saved Claude rate-limit snapshot (Usage).
const SURFACE_HEADERS_PROJECT = "verify-surface-headers";
const SURFACE_HEADERS_ORDER = ["cockpit", "jarvis", "code", "files", "sessions", "usage", "settings", "setup"];
const SURFACE_HEADERS_WIDE = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const SURFACE_HEADERS_NARROW = { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false };
const SURFACE_HEADERS_MIN_PATH = 120;
const TOOLBAR_HEIGHT_PX = 52;
const TOOLBAR_PAD_LEFT = "20px";
const RATE_LIMITS_KEY = "wave:ratelimits";
// a term some settings sections match and others do not: it narrows the index from 10 sections to 2
const SETTINGS_SEARCH_TERM = "font";
// Code's path fact takes the spacer's place, so it ends just short of the picker
const PATH_FACT_MAX_GAP_PX = 40;
const FETCH_BUTTON = 'button[title="Update remote-tracking refs"]';
const SESSIONS_SCAN_TIMEOUT_MS = 120_000;
// the Sessions surface runs the same scan when it mounts, and its live fact waits on it
const SESSIONS_FACT_WAIT_MS = 30_000;

// the visible toolbars in the content area (the Agent surface stays mounted under display:none)
const TOOLBAR_PROBE = `(() => {
    const content = document.querySelector('nav')?.nextElementSibling;
    if (!content) return null;
    const shown = [...content.querySelectorAll('[data-surface-toolbar]')].filter((t) => t.checkVisibility());
    const t = shown[0];
    if (!t) return { count: 0 };
    const h1 = t.querySelector(':scope > h1');
    const kids = [...t.children];
    const spacer = kids.findIndex((el) => el.tagName === 'SPAN' && el.classList.contains('flex-1') && el.childNodes.length === 0);
    const between = spacer > kids.indexOf(h1) ? kids.slice(kids.indexOf(h1) + 1, spacer) : null;
    return {
        count: shown.length,
        height: t.getBoundingClientRect().height,
        title: h1?.textContent.trim() ?? null,
        padLeft: getComputedStyle(t).paddingLeft,
        text: t.innerText.replace(/\\s+/g, ' ').trim(),
        // the spacer is the empty flex-1 span; with nothing empty between the title and it (Usage keeps its
        // filters there), a missing fact leaves no gap
        noGapBeforeSpacer: between != null && between.every((el) => el.childNodes.length > 0 && el.getBoundingClientRect().width > 0),
    };
})()`;

// the element at the popover's center and 8px above its bottom edge both belong to it: nothing clips it
const notClipped = (popoverExpr) => `(() => {
    const p = ${popoverExpr};
    if (!p) return null;
    const r = p.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const hits = [[cx, r.top + r.height / 2], [cx, r.bottom - 8]].map(([x, y]) => p.contains(document.elementFromPoint(x, y)));
    return { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], hits };
})()`;

const CODE_PICKER = `document.querySelector('[data-code-project-picker]')`;
// the picker's PopoverReveal is the last child of the picker's wrapper; closed, that child is the button itself
const CODE_PICKER_POPOVER = `(() => { const b = ${CODE_PICKER}; const p = b?.parentElement?.lastElementChild; return p && p !== b ? p : null; })()`;

async function surfaceHeadersArrange(h) {
    const ctx = { name: SURFACE_HEADERS_PROJECT };
    // a throw past this point still returns ctx, so teardown removes whatever was already made
    try {
        ctx.root = mkdtempSync(join(tmpdir(), "verify-surface-headers-"));
        const dir = join(
            ctx.root,
            "a-deliberately-long-checkout-path",
            "that-the-code-toolbar-has-to-truncate",
            "with-an-ellipsis-before-its-picker"
        );
        if (dir.length <= SURFACE_HEADERS_MIN_PATH) throw new Error(`repo path is only ${dir.length} chars: ${dir}`);
        mkdirSync(dir, { recursive: true });
        ctx.dir = dir;
        git(dir, "init", "-q", "--initial-branch=main");
        writeFileSync(join(dir, "policy.go"), "package retry\n\nfunc Budget() int {\n    return 3\n}\n");
        git(dir, "add", ".");
        git(dir, "commit", "-q", "-m", "seed the retry package");
        git(dir, "checkout", "-q", "-b", "feature");
        writeFileSync(join(dir, "policy.go"), "package retry\n\nfunc Budget() int {\n    return 8\n}\n");
        git(dir, "add", ".");
        git(dir, "commit", "-q", "-m", "raise the budget");
        // Diff shows Fetch only for a repo with a remote; a local bare one is enough and never touches the network
        const origin = join(ctx.root, "origin.git");
        git(ctx.root, "init", "-q", "--bare", origin);
        git(dir, "remote", "add", "origin", origin);
        git(dir, "push", "-q", "origin", "main");
        await h.rpc("createproject", { name: ctx.name, path: dir });
        ctx.madeProject = true;

        // Sessions counts a session live when a roster agent carries its transcript path, so the working
        // agent borrows the path of a session the archive scan already lists (read, never written). A cold scan
        // of every transcript root outlasts one CDP command, so it runs in the page and is polled
        await h.ev(`void window.TabRpcClient.wshRpcCall("getsessionsactivity", { windowdays: 30, limit: 100 }, { timeout: ${SESSIONS_SCAN_TIMEOUT_MS} }).then(
            (r) => (window.__surfaceHeadersScan = { path: (r?.sessions ?? []).find((s) => s.transcriptpath)?.transcriptpath ?? null }),
            (e) => (window.__surfaceHeadersScan = { error: String(e?.message ?? e) })
        )`);
        await polishWaitFor(h, "window.__surfaceHeadersScan != null", SESSIONS_SCAN_TIMEOUT_MS);
        const scan = await h.ev("window.__surfaceHeadersScan ?? null");
        if (scan?.error != null) throw new Error(`the sessions scan failed: ${scan.error}`);
        ctx.transcriptPath = scan?.path ?? null;
        mkdirSync(new URL(".", TREE_RAIL_FIXTURE), { recursive: true });
        writeFileSync(
            TREE_RAIL_FIXTURE,
            JSON.stringify(
                [
                    {
                        id: "fx-surface-headers-working",
                        name: "surface-headers worker",
                        project: ctx.name,
                        task: "draw the shared toolbar",
                        state: "working",
                        agent: "claude",
                        model: "opus",
                        activeMs: 240_000,
                        blockId: "fx-blk-surface-headers-working",
                        ...(ctx.transcriptPath ? { transcriptPath: ctx.transcriptPath } : {}),
                    },
                    {
                        id: "fx-surface-headers-asking",
                        name: "surface-headers asker",
                        project: ctx.name,
                        task: "pick a header order",
                        state: "asking",
                        agent: "claude",
                        model: "opus",
                        blockedMs: 60_000,
                        blockId: "fx-blk-surface-headers-asking",
                        ask: {
                            askId: "fx-surface-headers-ask",
                            oref: "block:fx-blk-surface-headers-asking",
                            questions: [
                                { header: "Order", question: "Which order?", options: [{ label: "fleet first" }, { label: "filter first" }] },
                            ],
                        },
                    },
                ],
                null,
                2
            )
        );
        ctx.wroteFixture = true;

        // the canvas's UsageBody: one reporting Claude provider with a live 5-hour window
        ctx.prevRate = await h.ev(`localStorage.getItem(${JSON.stringify(RATE_LIMITS_KEY)})`);
        const nowSec = Math.floor(Date.now() / 1000);
        const rateLimits = {
            claude: {
                fivehourpct: 62,
                fivehourreset: nowSec + 3 * 3600,
                weekpct: 41,
                weekreset: nowSec + 6 * 24 * 3600,
                capturedAt: Date.now(),
            },
        };
        await h.ev(`localStorage.setItem(${JSON.stringify(RATE_LIMITS_KEY)}, ${JSON.stringify(JSON.stringify(rateLimits))})`);

        // the fixture roster and the saved limits are read once at boot, and the project must be in the config first
        await waitForProjectInConfig(h, ctx.name);
        await polishReload(h);
    } catch (e) {
        ctx.arrangeError = String(e?.message ?? e);
    }
    return ctx;
}

async function surfaceHeadersAssert(h, ctx) {
    const steps = [];
    const run = async (step, fn) => {
        try {
            steps.push({ step, ...(await fn()) });
        } catch (e) {
            steps.push({ step, ok: false, detail: String(e?.message ?? e) });
        }
    };
    const present = (expr) => h.ev(`!!(${expr})`);
    const click = async (sel) => {
        const ok = await h.ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
        if (!ok) throw new Error(`nothing to click at ${sel}`);
    };
    // !! because an element is not returnable by value, so a bare element reads as "not yet"
    const waitOrThrow = async (expr, ms, what) => {
        if (!(await polishWaitFor(h, `!!(${expr})`, ms))) throw new Error(`${what} never appeared`);
    };
    // one visible toolbar once the outgoing surface has left
    const toolbar = async () => {
        await polishWaitFor(h, `(${TOOLBAR_PROBE})?.count === 1`, 8000);
        return h.ev(TOOLBAR_PROBE);
    };
    const toolbarOk = (t, surface) =>
        t?.count === 1 &&
        Math.abs(t.height - TOOLBAR_HEIGHT_PX) < 1 &&
        t.title === SURFACE_LABEL[surface] &&
        t.padLeft === TOOLBAR_PAD_LEFT;
    const pickCodeProject = async () => {
        const row = `document.querySelector('[data-code-picker-row=${JSON.stringify(ctx.name)}]')`;
        if (!(await present(row))) await click("[data-code-project-picker]");
        await waitOrThrow(row, 5000, `Code picker row ${ctx.name}`);
        await h.ev(`${row}.click()`);
        await waitOrThrow(`(${TOOLBAR_PROBE})?.text.includes(${JSON.stringify(ctx.dir)})`, 8000, "Code's path fact");
    };
    const pickDiffSource = async () => {
        const option = `[data-files-source-option=${JSON.stringify(ctx.name)}]`;
        await click("[data-files-source-picker]");
        await waitOrThrow(`document.querySelector(${JSON.stringify(option)})`, 5000, `Diff source ${ctx.name}`);
        await click(option);
        await waitOrThrow(`document.querySelector('[data-range-chip="compare"]')`, 8000, "Diff's range strip");
    };

    if (ctx.arrangeError != null) {
        steps.push({ step: "arrange", ok: false, detail: ctx.arrangeError });
        return steps;
    }
    await h.cdp("Emulation.setDeviceMetricsOverride", SURFACE_HEADERS_WIDE);
    await polishNap(600);

    for (const surface of SURFACE_HEADERS_ORDER) {
        await run(surface, async () => {
            await h.goto(surface);
            if (surface === "code") await pickCodeProject();
            if (surface === "files") await pickDiffSource();
            if (surface === "jarvis") {
                await waitOrThrow(`document.querySelector('[data-jarvis-region="brief"]')?.checkVisibility()`, 8000, "the Brief");
            }
            if (surface === "sessions") {
                await polishWaitFor(h, `/agents? live/i.test((${TOOLBAR_PROBE})?.text ?? '')`, SESSIONS_FACT_WAIT_MS);
            }
            const t = await toolbar();
            let ok = toolbarOk(t, surface);
            let fact = "";
            if (surface === "sessions") {
                // innerText applies text-transform, so the facts match in any case
                const live = /(^|\D)1 agent live\b/i.test(t?.text ?? "");
                ok = ok && live;
                fact = ` liveFact=${live} transcript=${ctx.transcriptPath != null}`;
            }
            if (surface === "usage") {
                const reporting = /(^|\D)1 (of \d+ )?reporting\b/i.test(t?.text ?? "");
                ok = ok && reporting;
                fact = ` reportingFact=${reporting}`;
            }
            await h.shot(`cdp-shots/surface-headers-${surface}.png`);
            return { ok, detail: JSON.stringify(t) + fact };
        });
    }

    await run("agent", async () => {
        await h.goto("agent");
        await polishNap(400);
        const t = await h.ev(TOOLBAR_PROBE);
        return { ok: t?.count === 0, detail: JSON.stringify(t) };
    });

    await run("jarvis header order", async () => {
        await h.goto("jarvis");
        await waitOrThrow(`document.querySelector('[data-jarvis-region="brief"] > header')`, 8000, "the Brief header");
        const r = await h.ev(`(() => {
            const header = document.querySelector('[data-jarvis-region="brief"] > header');
            const all = [...header.querySelectorAll('*')];
            const at = (sel) => all.indexOf(header.querySelector(sel));
            const chip = header.querySelector('[data-jarvis-brief-band="waiting"]');
            const cs = chip ? getComputedStyle(chip) : null;
            return {
                toolbar: header.hasAttribute('data-surface-toolbar'),
                order: [
                    at('[data-jarvis-brief-band="fleet"]'),
                    at('[data-jarvis-brief-filter]'),
                    at('[data-jarvis-autonomy="chip"]'),
                    at('[data-jarvis-brief-profile]'),
                    at('[data-jarvis-new-initiative]'),
                ],
                diamond: header.textContent.includes('◈'),
                chipTransform: cs?.textTransform ?? null,
                chipBorderTop: cs?.borderTopWidth ?? null,
            };
        })()`);
        const seq = r.order;
        return {
            ok:
                r.toolbar &&
                seq.every((i, n) => i >= 0 && (n === 0 || i > seq[n - 1])) &&
                !r.diamond &&
                r.chipTransform === "none" &&
                r.chipBorderTop === "0px",
            detail: JSON.stringify(r),
        };
    });

    await run("settings search filters", async () => {
        await h.goto("settings");
        const input = `document.querySelector('[data-surface-toolbar] input[placeholder="Search settings"]')`;
        await waitOrThrow(input, 5000, "the toolbar's settings search");
        const count = () => h.ev(`[...document.querySelectorAll('button[data-section]')].filter((b) => b.checkVisibility()).length`);
        const type = (text) =>
            h.ev(`(() => {
                const el = ${input};
                Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(text)});
                el.dispatchEvent(new Event('input', { bubbles: true }));
            })()`);
        const before = await count();
        await type(SETTINGS_SEARCH_TERM);
        await polishNap(400);
        const during = await count();
        await type("");
        await polishNap(300);
        const after = await count();
        return {
            ok: during > 0 && during < before && after === before,
            detail: `sections ${before} -> "${SETTINGS_SEARCH_TERM}" ${during} -> cleared ${after}`,
        };
    });

    await run("code picker not clipped", async () => {
        await h.goto("code");
        if (!(await present(CODE_PICKER_POPOVER))) await click("[data-code-project-picker]");
        await waitOrThrow(CODE_PICKER_POPOVER, 3000, "the project picker's popover");
        await polishNap(400); // the reveal finishes before anything is hit-tested
        const r = await h.ev(notClipped(CODE_PICKER_POPOVER));
        await h.shot("cdp-shots/surface-headers-code-picker.png");
        await click("[data-code-project-picker]");
        const closed = await polishWaitFor(h, `!(${CODE_PICKER_POPOVER})`, 3000);
        return { ok: r != null && r.hits.every(Boolean) && closed, detail: JSON.stringify({ ...r, closed }) };
    });

    await run("code path truncates", async () => {
        const r = await h.ev(`(() => {
            const fact = document.querySelector('[data-surface-toolbar] > h1')?.nextElementSibling;
            const picker = ${CODE_PICKER};
            if (!fact || !picker) return null;
            const cs = getComputedStyle(fact);
            return {
                factRight: Math.round(fact.getBoundingClientRect().right),
                pickerLeft: Math.round(picker.getBoundingClientRect().left),
                scrollWidth: fact.scrollWidth,
                clientWidth: fact.clientWidth,
                display: cs.display,
                textOverflow: cs.textOverflow,
                text: fact.textContent,
            };
        })()`);
        const gap = r ? r.pickerLeft - r.factRight : null;
        return {
            ok:
                r != null &&
                r.text.includes(ctx.dir) &&
                gap >= 0 &&
                gap <= PATH_FACT_MAX_GAP_PX &&
                r.scrollWidth > r.clientWidth &&
                r.display === "block" &&
                r.textOverflow === "ellipsis",
            detail: JSON.stringify({ ...r, gap }),
        };
    });

    await run("files compare at 1000px", async () => {
        await h.cdp("Emulation.setDeviceMetricsOverride", SURFACE_HEADERS_NARROW);
        await polishNap(600);
        await h.goto("files");
        await pickDiffSource();
        await click('[data-range-chip="compare"]');
        await waitOrThrow(`document.querySelector(${JSON.stringify(FETCH_BUTTON)})`, 8000, "the Fetch button");
        await polishNap(1500); // divergence, then the comparison's own change list
        const r = await h.ev(`(() => {
            const content = document.querySelector('nav')?.nextElementSibling;
            const t = content && [...content.querySelectorAll('[data-surface-toolbar]')].find((x) => x.checkVisibility());
            if (!t) return null;
            const controls = [...t.querySelectorAll('button, input, select, label')].filter((el) => el.checkVisibility());
            const overflow = controls
                .filter((el) => el.getBoundingClientRect().right > ${SURFACE_HEADERS_NARROW.width})
                .map((el) => (el.getAttribute('title') || el.textContent || el.tagName).trim().slice(0, 30));
            const fetch = t.querySelector(${JSON.stringify(FETCH_BUTTON)});
            const fr = fetch?.getBoundingClientRect();
            return {
                controls: controls.length,
                overflow,
                height: Math.round(t.getBoundingClientRect().height),
                fetchVisible: !!fetch && fetch.checkVisibility() && fr.width > 0 && fr.right <= ${SURFACE_HEADERS_NARROW.width} && fr.bottom <= ${SURFACE_HEADERS_NARROW.height},
            };
        })()`);
        await h.shot("cdp-shots/surface-headers-files-compare-narrow.png");
        await h.cdp("Emulation.setDeviceMetricsOverride", SURFACE_HEADERS_WIDE);
        await polishNap(400);
        return { ok: r != null && r.controls > 0 && r.overflow.length === 0 && r.fetchVisible, detail: JSON.stringify(r) };
    });

    // last: it clears the seeds the steps above read. An empty fixture replaces the live roster, so no agent is live
    await run("zero facts", async () => {
        writeFileSync(TREE_RAIL_FIXTURE, "[]");
        await h.ev(`localStorage.removeItem(${JSON.stringify(RATE_LIMITS_KEY)})`);
        await polishReload(h);
        const facts = {};
        for (const [surface, word] of [["sessions", /\d+ agents? live\b/i], ["usage", /\breporting\b/i]]) {
            await h.goto(surface);
            const t = await toolbar();
            facts[surface] = { ...t, factShown: word.test(t?.text ?? "") };
            await h.shot(`cdp-shots/surface-headers-${surface}-zero.png`);
        }
        return {
            ok: Object.entries(facts).every(([s, t]) => toolbarOk(t, s) && !t.factShown && t.noGapBeforeSpacer),
            detail: JSON.stringify(facts),
        };
    });
    return steps;
}

async function surfaceHeadersTeardown(h, ctx) {
    const undo = [
        ["clear the viewport override", () => h.cdp("Emulation.clearDeviceMetricsOverride")],
        [
            "restore the saved rate limits",
            () =>
                "prevRate" in ctx &&
                h.ev(
                    ctx.prevRate == null
                        ? `localStorage.removeItem(${JSON.stringify(RATE_LIMITS_KEY)})`
                        : `localStorage.setItem(${JSON.stringify(RATE_LIMITS_KEY)}, ${JSON.stringify(ctx.prevRate)})`
                ),
        ],
        ["remove the fixture roster", () => ctx.wroteFixture && rmSync(TREE_RAIL_FIXTURE, { force: true })],
        ["delete the project", () => ctx.madeProject && h.rpc("deleteproject", { name: ctx.name })],
        ["remove the repo", () => ctx.root && rmSync(ctx.root, { recursive: true, force: true, maxRetries: 3 })],
        // onto the live roster and the restored storage again
        ["reload", () => polishReload(h)],
        ["return to the cockpit", () => h.goto("cockpit")],
    ];
    const failed = [];
    for (const [what, fn] of undo) {
        try {
            await fn();
        } catch (e) {
            failed.push(`${what}: ${e?.message ?? e}`);
        }
    }
    if (failed.length > 0) throw new Error(`surface-headers teardown: ${failed.join("; ")}`);
}

export const surfaceHeaders = {
    name: "surface-headers",
    surface: "cockpit",
    arrange: surfaceHeadersArrange,
    assert: surfaceHeadersAssert,
    teardown: surfaceHeadersTeardown,
};
export const cockpitEmptyState = {
    name: "cockpit-empty-state",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        await lookOpen(h, "cockpit");
        const s = await lookEval(h, `
            const heading = () => [...document.querySelectorAll("h2")].find((x) => flat(x) === "No agents running");
            await until(() => heading() != null, 4000);
            return { heading: heading() != null, cta: button(document, /New terminal agent/) != null };
        `);
        if (!s.heading) {
            return [skipStep("an empty roster shows the cockpit's empty state", "agents are live in this profile - run it on a fresh store (final-verify.mjs)")];
        }
        await polishNap(600); // the entrance
        await h.shot(lookShot("cockpit-empty-state"));
        return [{ step: "an empty roster shows No agents running with its New terminal agent CTA", ok: s.cta, detail: JSON.stringify(s) }];
    },
    async teardown() {},
};

const LOOK_TOASTS = [
    { title: "Kill shell task", message: "Not killed: the task had already exited.", level: "error" },
    { title: "Not a design canvas board: docs/notes.html", message: "", level: "warn" },
    { title: "release scribe: opened the Diff surface", message: "", level: "info" },
];

export const notificationToasts = {
    name: "notification-toasts",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        await lookOpen(h, "cockpit");
        const shown = await lookEval(h, `
            const { pushToast } = await mod("app/cockpit/notificationstore.ts");
            for (const t of ${JSON.stringify(LOOK_TOASTS)}) pushToast(t);
            const toasts = () => [...document.querySelectorAll("[data-notification-toast]")];
            await until(() => toasts().length === ${LOOK_TOASTS.length}, 2000);
            await nap(500); // the entrance, inside the 6s the toasts live
            const avatar = document.querySelector('[aria-label="Jarvis condition"]')?.getBoundingClientRect();
            const overlaps = (r) => avatar != null && r.left < avatar.right && r.right > avatar.left && r.top < avatar.bottom && r.bottom > avatar.top;
            return {
                text: toasts().map(flat),
                levels: toasts().map((t) => t.querySelector("svg[role=img]")?.getAttribute("aria-label") ?? null),
                live: toasts()[0]?.parentElement?.getAttribute("aria-live") ?? null,
                underAvatar: toasts().filter((t) => overlaps(t.getBoundingClientRect())).length,
            };
        `);
        await h.shot(lookShot("notification-toasts"));
        const dismissed = await lookEval(h, `
            for (const t of [...document.querySelectorAll("[data-notification-toast]")]) t.click();
            return until(() => document.querySelector("[data-notification-toast]") == null, 2000);
        `);
        return [
            {
                step: "error, warn and info toasts stack in the corner, each with its title",
                ok: shown.text.length === LOOK_TOASTS.length && LOOK_TOASTS.every((t) => shown.text.some((s) => s.startsWith(t.title))),
                detail: JSON.stringify(shown.text),
            },
            {
                step: "each toast names its level on an icon, in a polite live region",
                ok: JSON.stringify([...shown.levels].sort()) === JSON.stringify(["Error", "Info", "Warning"]) && shown.live === "polite",
                detail: JSON.stringify({ levels: shown.levels, live: shown.live }),
            },
            { step: "no toast sits under the Jarvis avatar", ok: shown.underAvatar === 0, detail: `underAvatar=${shown.underAvatar}` },
            { step: "a click dismisses a toast", ok: dismissed === true, detail: `dismissed=${dismissed}` },
            ...(await toastBubbleAndBriefSteps(h)),
        ];
    },
    async teardown(h) {
        await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const pet = await mod("app/view/jarvis/petstore.ts");
            globalStore.set(pet.petBubbleAtom, null);
            if (window.__toastCorner) pet.setPetCorner(window.__toastCorner);
            globalStore.set((await mod("app/view/jarvis/briefundo.ts")).briefToastAtom, null);
        `).catch(() => {});
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT).catch(() => {});
    },
};

// F8, F17 and F19 were seen at both sizes: the bubble over the stack, the Brief's error by colour alone and unbounded,
// and a second Brief toast stranding a pending delete's Undo
const TOAST_NARROW = { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false };
const TOAST_LONG_ERROR =
    "EC-LAST-CHUNK: cannot remove the last chunk of an initiative; add another chunk first, or archive the initiative instead of deleting its only chunk";

async function toastBubbleAndBriefSteps(h) {
    const steps = [];
    for (const [name, viewport] of [["1000x700", TOAST_NARROW], ["1600x950", MODELS_VIEWPORT]]) {
        await h.cdp("Emulation.setDeviceMetricsOverride", viewport);
        try {
            await h.goto("cockpit");
            const b = await lookEval(h, `
                const { globalStore } = await mod("app/store/jotaiStore.ts");
                const pet = await mod("app/view/jarvis/petstore.ts");
                const { pushToast } = await mod("app/cockpit/notificationstore.ts");
                window.__toastCorner ??= globalStore.get(pet.petCornerAtom);
                pet.setPetCorner("bottom-right");
                globalStore.set(pet.petBubbleAtom, { id: "notify:cdp-toasts:${name}", at: Date.now(), kind: "notify", level: "info", text: "cdp notification-toasts: the bubble speaks over the corner the toast stack shares, two lines of it at least" });
                for (const t of ${JSON.stringify(LOOK_TOASTS)}) pushToast(t);
                const toasts = () => [...document.querySelectorAll("[data-notification-toast]")];
                const bubble = () => document.querySelector("[data-pet-bubble]");
                await until(() => bubble() != null && toasts().length === ${LOOK_TOASTS.length}, 3000);
                await nap(700); // the bubble's reveal and the toasts' entrance
                const br = bubble()?.getBoundingClientRect();
                const hits = (r) => br != null && r.left < br.right && r.right > br.left && r.top < br.bottom && r.bottom > br.top;
                const out = {
                    bubble: br ? [Math.round(br.top), Math.round(br.bottom), Math.round(br.height)] : null,
                    toasts: toasts().map((t) => Math.round(t.getBoundingClientRect().bottom)),
                    overlaps: toasts().filter((t) => hits(t.getBoundingClientRect())).length,
                    inView: toasts().every((t) => t.getBoundingClientRect().top >= 0),
                };
                return out;
            `);
            await h.shot(lookShot(`notification-toasts-bubble-${name}`));
            await lookEval(h, `
                const { globalStore } = await mod("app/store/jotaiStore.ts");
                globalStore.set((await mod("app/view/jarvis/petstore.ts")).petBubbleAtom, null);
                for (const t of [...document.querySelectorAll("[data-notification-toast]")]) t.click();
            `);
            steps.push({
                step: `${name}: with the pet's bubble up, the toast stack rises clear of it and stays on screen`,
                ok: b.bubble != null && b.bubble[2] > 0 && b.toasts.length === LOOK_TOASTS.length && b.overlaps === 0 && b.inView,
                detail: JSON.stringify(b),
            });

            await h.goto("jarvis");
            const e = await lookEval(h, `
                const { briefUndo } = await mod("app/view/jarvis/briefundo.ts");
                briefUndo.error(${JSON.stringify(TOAST_LONG_ERROR)});
                const toast = () => document.querySelector('[data-jarvis-brief-toast="error"]');
                await until(() => toast() != null, 3000);
                await nap(500);
                const el = toast();
                const text = [...(el?.querySelectorAll("span") ?? [])].find((s) => s.textContent.startsWith("EC-LAST-CHUNK"));
                const range = document.createRange();
                if (text) range.selectNodeContents(text);
                const lines = text ? new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size : 0;
                return {
                    icon: el?.querySelector('svg[role="img"][aria-label="Error"]') != null,
                    width: Math.round(el?.getBoundingClientRect().width ?? 0),
                    lines,
                    chars: ${TOAST_LONG_ERROR.length},
                };
            `);
            await h.shot(lookShot(`notification-toasts-brief-error-${name}`));
            steps.push({
                step: `${name}: a long Brief error names its level on an icon, wraps, and is at most 560px wide`,
                ok: e.icon && e.lines > 1 && e.width > 0 && e.width <= 560,
                detail: JSON.stringify(e),
            });
        } finally {
            await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
        }
    }

    // both toast systems keep an error past the 6 s an info toast lives
    const kept = await lookEval(h, `
        const { pushToast } = await mod("app/cockpit/notificationstore.ts");
        const { briefUndo } = await mod("app/view/jarvis/briefundo.ts");
        pushToast({ title: "cdp notification-toasts error", message: "kept", level: "error" });
        briefUndo.error("cdp notification-toasts: kept past 7 s");
        await nap(7000);
        return {
            global: document.querySelector('[data-notification-toast="error"]') != null,
            brief: document.querySelector('[data-jarvis-brief-toast="error"]') != null,
        };
    `);
    steps.push({
        step: "an error toast is still up after 7 s, in the global stack and on the Brief",
        ok: kept.global && kept.brief,
        detail: JSON.stringify(kept),
    });

    const f19 = await lookEval(h, `
        const { briefUndo, briefToastAtom, UNDO_WINDOW_MS } = await mod("app/view/jarvis/briefundo.ts");
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        for (const t of [...document.querySelectorAll("[data-notification-toast]")]) t.click();
        globalStore.set(briefToastAtom, null);
        window.__f19Commits = [];
        briefUndo.schedule(["cdp:f19:a"], "Deleted a", async () => void window.__f19Commits.push("a"));
        briefUndo.schedule(["cdp:f19:b"], "Deleted b", async () => void window.__f19Commits.push("b"));
        briefUndo.error("cdp notification-toasts: a second edit failed");
        const pending = () => document.querySelector('[data-jarvis-brief-toast="error"] [data-jarvis-toast-undo="pending"]');
        await until(() => pending() != null, 3000);
        await nap(400);
        const label = flat(pending());
        pending()?.click();
        const hidden = await until(() => document.querySelector("[data-jarvis-brief-toast]") == null, 2000);
        await nap(UNDO_WINDOW_MS + 1000);
        return { label, hidden, commits: window.__f19Commits };
    `);
    steps.push({
        step: "an error over two pending deletes shows Undo 2; clicking it hides the toast and neither delete commits",
        ok: f19.label === "Undo 2" && f19.hidden === true && f19.commits.length === 0,
        detail: JSON.stringify(f19),
    });
    return steps;
}

// every row kind the menu draws: header, accelerator, sublabel, checkbox, radio (in the submenu), separator,
// disabled and danger
const LOOK_MENU_ITEMS = [
    { type: "header", label: "auth refactor" },
    { label: "Open terminal", accel: "Enter" },
    { label: "Rename…", accel: "F2" },
    { label: "Pin to top", type: "checkbox", checked: true },
    { type: "separator" },
    {
        label: "Sort by",
        submenu: [
            { label: "Last activity", type: "radio", checked: true },
            { label: "Name", type: "radio", checked: false },
            { label: "Project", type: "radio", checked: false },
        ],
    },
    { label: "Copy session id", sublabel: "8f3a2c1e" },
    { label: "Resume", enabled: false },
    { type: "separator" },
    { label: "Kill agent", danger: true, accel: "Delete" },
];
const LOOK_MENU_AT = { x: 640, y: 240 };
const LOOK_MENU_ROW = (label) =>
    `[...document.querySelectorAll("span.whitespace-nowrap")].find((s) => s.textContent === ${JSON.stringify(label)})?.parentElement`;

export const contextMenu = {
    name: "context-menu",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        await lookOpen(h, "cockpit");
        const opened = await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { contextMenuAtom } = await mod("app/store/contextmenu.ts");
            const items = ${JSON.stringify(LOOK_MENU_ITEMS)}.map((i) => ({ ...i, click: () => {} }));
            globalStore.set(contextMenuAtom, { items, x: ${LOOK_MENU_AT.x}, y: ${LOOK_MENU_AT.y} });
            await until(() => ${LOOK_MENU_ROW("Sort by")} != null, 2000);
            const r = ${LOOK_MENU_ROW("Sort by")}.getBoundingClientRect();
            return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) };
        `);
        await lookHover(h, opened.x, opened.y);
        const sub = await lookEval(h, `
            await until(() => ${LOOK_MENU_ROW("Last activity")} != null, 2000);
            return { submenu: ${LOOK_MENU_ROW("Last activity")} != null, danger: ${LOOK_MENU_ROW("Kill agent")} != null };
        `);
        const look = await lookEval(h, `
            const row = ${LOOK_MENU_ROW("Sort by")};
            // root rows sit directly in the panel: MenuLevel renders a fragment
            const panel = row?.parentElement;
            const probe = document.createElement("div");
            probe.className = "border border-edge-strong";
            document.body.append(probe);
            const edge = getComputedStyle(probe).borderTopColor;
            probe.remove();
            return {
                label: getComputedStyle(row.querySelector("span.whitespace-nowrap")).fontFamily,
                border: panel ? getComputedStyle(panel).borderTopColor : null,
                edge,
                floor: floorWalk([panel ?? null, ${LOOK_MENU_ROW("Last activity")}?.parentElement ?? null]),
            };
        `);
        await h.shot(lookShot("context-menu"));
        return [
            {
                step: "a menu with every row kind draws them all, and hovering Sort by opens its submenu",
                ok: sub.submenu && sub.danger,
                detail: JSON.stringify({ opened, ...sub }),
            },
            {
                step: "row labels are sans and the panel has the strong floating edge",
                ok: !/mono/i.test(look.label) && look.border === look.edge,
                detail: JSON.stringify(look),
            },
            { step: `no visible text in the menu or its submenu is under ${MIN_FONT_PX}px`, ok: floorOk(look.floor), detail: floorDetail(look.floor) },
        ];
    },
    async teardown(h) {
        await lookEval(h, `(await mod("app/store/contextmenu.ts")).closeContextMenu();`);
        await lookHover(h, 1, 1);
    },
};

// --- ui-drift: what the drift pass changed that no other scenario reaches -------------------------------------------
// the UI drift polish (c98ebe7c). A view no app path shows on a fresh store is rendered through
// the app's own module (LOOK_LIB's mount) with made-up props; the
// brief toast shows on the Brief through its own atom.
const DRIFT_PLAN = ["# Drift plan", "", "Raise every label to the floor.", "", "### Task 1: Raise the floor", "", "- swap the glyphs", "- grow the pills", ""].join("\n");
const DRIFT_ASK = {
    id: "drift-ask",
    name: "drift asker",
    task: "pick a floor",
    state: "asking",
    ask: {
        questions: [
            {
                question: "Which text floor applies to the rail?",
                header: "Floor",
                options: [
                    { label: "10.5px", description: "The house floor every surface keeps" },
                    { label: "11px (Recommended)", description: "One step up, for the rail alone" },
                    { label: "12px", description: "The body size" },
                ],
            },
        ],
    },
};
const DRIFT_AGENTS = [
    { id: "drift-1", name: "drift one", task: "raise the rail", state: "idle", project: "waveterm", activity: "finished the pass", activeMs: 3_600_000 },
    { id: "drift-2", name: "drift two", task: "swap the glyphs", state: "working", project: "waveterm", activity: "reading files", activeMs: 420_000 },
];
// the ink tokens a hint may wear
const DRIFT_INKS = ["text-muted", "text-ink-faint", "text-ink-mid", "text-secondary", "text-primary", "text-ink-hi"];
const DRIFT_BADGE = 12;
// the rail's buttons: the eight surfaces (Boards joined in 48994cbcd), then Setup and Settings
const NAV_ITEMS = 10;
const DRIFT_CONTRAST = 4.5;
const DRIFT_SWITCHER = `document.querySelector('[data-project-switcher="bar"]')`;

// the center of the first element an expression finds, for a real pointer move
const lookCenter = (h, expr) =>
    h.ev(`(() => {
        const r = (${expr})?.getBoundingClientRect();
        return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
    })()`);

// opens a hand-rolled menu with its trigger, presses a real Escape and reads whether the menu closed onto its
// trigger. Each of them draws its click-catching backdrop beside the trigger while it is open.
async function driftEscape(h, step, trigger) {
    const read = `
        const t = ${trigger};
        const { escapeMenusOpenAtom } = await mod("app/hook/useEscapeClose.ts");
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const open = () => t?.parentElement?.querySelector(":scope > .fixed.inset-0") != null;
    `;
    const surface = await h.activeSurfaceLabel();
    const opened = await lookEval(h, `${read}
        if (t == null) return null;
        t.click();
        await until(open, 3000);
        await nap(300);
        return { open: open(), menus: globalStore.get(escapeMenusOpenAtom) };
    `);
    await lookKey(h, "Escape", "Escape", 27);
    const closed = await lookEval(h, `${read}
        await until(() => !open(), 2000);
        return { open: open(), menus: globalStore.get(escapeMenusOpenAtom), focused: t != null && document.activeElement === t };
    `);
    const after = await h.activeSurfaceLabel();
    return {
        step,
        ok: opened?.open === true && opened.menus > 0 && closed.open === false && closed.menus === 0 && closed.focused && after === surface,
        detail: JSON.stringify({ opened, closed, surface, after }),
    };
}

// hovers the element an expression finds and reads its background at rest and under the pointer
async function driftHover(h, expr) {
    // a pointer an earlier scenario left over the element would read its hover as rest
    await lookHover(h, 1, 1);
    await polishNap(250);
    const rest = await paintEval(h, `const el = ${expr}; return el ? getComputedStyle(el).backgroundColor : null;`);
    const at = await lookCenter(h, expr);
    if (at) await lookHover(h, at.x, at.y);
    await polishNap(250);
    const hover = await paintEval(h, `
        const el = ${expr};
        if (!el) return null;
        const c = getComputedStyle(el).backgroundColor;
        return { color: c, raw: rawOverlay(c) };
    `);
    await lookHover(h, 1, 1);
    return { rest, hover: hover?.color ?? null, raw: hover?.raw ?? null, at };
}
const hoverOk = (r) => r.rest != null && r.hover != null && r.hover !== r.rest && r.raw === false;

const DRIFT_HOST = (name) => `document.querySelector('[data-look-mount="${name}"]')`;

async function driftView(h, label, path, name, props, opts, ready = "true") {
    const s = await lookEval(h, `
        unmountAll();
        const host = await mount(${JSON.stringify(path)}, ${JSON.stringify(name)}, ${props}, ${opts});
        await until(() => ${ready}, 8000);
        await nap(300);
        return { floor: floorWalk([host]), text: flat(host).slice(0, 80) };
    `);
    await h.shot(lookShot(`ui-drift-${label}`));
    return { step: `${label} renders with no visible text under ${MIN_FONT_PX}px`, ok: floorOk(s.floor), detail: `${floorDetail(s.floor)} text=${JSON.stringify(s.text)}` };
}

export const uiDrift = {
    name: "ui-drift",
    surface: "cockpit",
    async arrange(h) {
        const dir = mkdtempSync(join(tmpdir(), "verify-ui-drift-"));
        const planPath = join(dir, "drift-plan.md");
        writeFileSync(planPath, DRIFT_PLAN);
        return { dir, planPath };
    },
    async assert(h, ctx) {
        const steps = [];
        const run = async (step, fn) => {
            try {
                steps.push(await fn());
            } catch (e) {
                steps.push({ step, ok: false, detail: String(e?.message ?? e) });
            }
        };
        await lookOpen(h, "cockpit");

        // the seven views no other scenario shows
        await run("planpreview", async () => {
            const s = await lookEval(h, `
                unmountAll();
                const props = { path: ${JSON.stringify(ctx.planPath)} };
                const open = await mount("app/view/agents/planpreview.tsx", "PlanPreview", props, { style: "width:560px" });
                const shut = await mount("app/view/agents/planpreview.tsx", "PlanPreview", props, { style: "width:560px;top:420px" });
                await until(() => /lines/.test(flat(open)) && /lines/.test(flat(shut)), 8000);
                shut.querySelector("button")?.click();
                await nap(300);
                const toggle = (host) => {
                    const b = host.querySelector("button");
                    return { svg: b?.querySelector("svg") != null, glyph: /[▼▶]/.test(flat(b)), open: host.querySelector(".max-h-\\\\[320px\\\\]") != null };
                };
                return { open: toggle(open), shut: toggle(shut), floor: floorWalk([open, shut]) };
            `);
            await h.shot(lookShot("ui-drift-planpreview"));
            steps.push({ step: `planpreview renders with no visible text under ${MIN_FONT_PX}px`, ok: floorOk(s.floor), detail: floorDetail(s.floor) });
            return {
                step: "planpreview's toggle holds an svg icon and no ▼/▶ text, open and closed",
                ok: s.open.svg && !s.open.glyph && s.open.open && s.shut.svg && !s.shut.glyph && !s.shut.open,
                detail: JSON.stringify({ open: s.open, shut: s.shut }),
            };
        });
        await run("effortcreateform", () =>
            driftView(h, "effortcreateform", "app/view/jarvis/effortcreateform.tsx", "EffortCreateForm", "{ onClose() {} }", `{ style: "width:640px" }`)
        );
        await run("recordpicker", () =>
            driftView(
                h,
                "recordpicker",
                "app/view/jarvis/recordpicker.tsx",
                "RecordPicker",
                "{ onPick() {}, onCancel() {} }",
                `{ style: "width:420px" }`,
                `${DRIFT_HOST("RecordPicker")}?.querySelector(".animate-pulse") == null`
            )
        );
        await run("aggregatepane", () =>
            driftView(
                h,
                "aggregatepane",
                "app/view/agents/aggregatepane.tsx",
                "AggregatePane",
                `{
                    base: "main",
                    head: "drift/polish",
                    form: "mergebase",
                    mergeBase: "4f1c2a9",
                    changes: {
                        files: [
                            { path: "frontend/app/view/agents/navrail.tsx", status: "M", adds: 2, dels: 2 },
                            { path: "scripts/cdp/scenarios.mjs", status: "M", adds: 140, dels: 60 },
                            { path: "frontend/app/hook/useEscapeClose.ts", status: "A", adds: 34, dels: 0 },
                        ],
                        adds: 176,
                        dels: 62,
                    },
                    selectedFile: null,
                    onSelectFile() {},
                    onSetForm() {},
                    review: null,
                }`,
                `{ style: "width:440px;height:520px;display:flex;flex-direction:column" }`
            )
        );

        // answerbar: an option at rest, under the pointer and selected
        await run("answerbar", async () => {
            const OPTION = (i) => `${DRIFT_HOST("AnswerBar")}?.querySelectorAll("button")[${i}]`;
            const props = (sel) => `{ agent: ${JSON.stringify(DRIFT_ASK)}, selections: ${sel}, numbered: true, onToggle() {}, onSubmit() {} }`;
            const s = await lookEval(h, `
                unmountAll();
                const host = await mount("app/view/agents/answerbar.tsx", "AnswerBar", ${props("{}")}, { style: "width:560px" });
                return { options: host.querySelectorAll("button").length, floor: floorWalk([host]) };
            `);
            steps.push({ step: `answerbar renders with no visible text under ${MIN_FONT_PX}px`, ok: floorOk(s.floor), detail: floorDetail(s.floor) });
            await h.shot(lookShot("ui-drift-answerbar-rest"));
            const hovered = await driftHover(h, OPTION(2));
            await lookHover(h, hovered.at?.x ?? 1, hovered.at?.y ?? 1);
            await polishNap(250);
            await h.shot(lookShot("ui-drift-answerbar-hover"));
            await lookHover(h, 1, 1);
            const selected = await paintEval(h, `
                ${DRIFT_HOST("AnswerBar")}.render(${props("{ 0: new Set([1]) }")});
                await new Promise((r) => setTimeout(r, 250));
                const c = getComputedStyle(${OPTION(1)}).backgroundColor;
                return { color: c, raw: rawOverlay(c) };
            `);
            await h.shot(lookShot("ui-drift-answerbar-selected"));
            const restRaw = await paintEval(h, `return rawOverlay(${JSON.stringify(hovered.rest ?? "")});`);
            return {
                step: "an answerbar option reads differently at rest, hovered and selected, and none is a raw white or black overlay",
                ok:
                    s.options === 3 &&
                    hoverOk(hovered) &&
                    !restRaw &&
                    selected.raw === false &&
                    selected.color !== hovered.rest &&
                    selected.color !== hovered.hover,
                detail: JSON.stringify({ options: s.options, hovered, restRaw, selected }),
            };
        });

        // the cockpit's idle and backgrounded lanes and an agent card: their hovers sit on the surface ramp
        for (const [name, path, props] of [
            ["IdleSection", "app/view/agents/idlesection.tsx", `{ agents: ${JSON.stringify([DRIFT_AGENTS[0]])}, nowAtom: J.atom(Date.now()), onOpen() {} }`],
            ["BackgroundedSection", "app/view/agents/backgroundedsection.tsx", `{ agents: ${JSON.stringify([DRIFT_AGENTS[1]])}, nowAtom: J.atom(Date.now()), onRestore() {} }`],
        ]) {
            const label = name.toLowerCase();
            await run(label, async () => {
                const s = await lookEval(h, `
                    unmountAll();
                    const J = await dep("jotai");
                    const host = await mount(${JSON.stringify(path)}, ${JSON.stringify(name)}, ${props}, { style: "width:560px" });
                    // the section header is a clickable div
                    host.querySelector(".cursor-pointer")?.click();
                    await until(() => host.querySelector('[class*="hover:bg-surface-hover"]') != null, 3000);
                    await nap(400);
                    return { floor: floorWalk([host]) };
                `);
                await h.shot(lookShot(`ui-drift-${label}`));
                steps.push({ step: `${label} renders with no visible text under ${MIN_FONT_PX}px`, ok: floorOk(s.floor), detail: floorDetail(s.floor) });
                const r = await driftHover(h, `${DRIFT_HOST(name)}?.querySelector('[class*="hover:bg-surface-hover"]')`);
                return { step: `${label}'s hovered row changes background and is no raw white or black overlay`, ok: hoverOk(r), detail: JSON.stringify(r) };
            });
        }
        await run("agentrow", async () => {
            const made = await lookEval(h, `
                unmountAll();
                const J = await dep("jotai");
                const { cardShare } = await mod("app/view/agents/cardgridlayout.ts");
                const noop = () => {};
                const { NO_LINEAGE } = await mod("app/view/agents/runlineage.ts");
                // the card reads its transcript context from the model's run lineage (2577f0f5c)
                const host = await mount("app/view/agents/agentrow.tsx", "AgentRow", {
                    model: { lineageAtom: J.atom(NO_LINEAGE) },
                    agent: ${JSON.stringify(DRIFT_AGENTS[1])},
                    nowAtom: J.atom(Date.now()),
                    isCursor: false,
                    selections: {},
                    texts: {},
                    sent: false,
                    composerOpen: false,
                    onCursor: noop, onOpen: noop, onOpenTerminal: noop, onOpenDiff: noop, onOpenComposer: noop,
                    onToggleAnswer: noop, onAnswerText: noop, onSubmitAnswer: noop, onBackground: noop,
                    share: cardShare(false, false),
                }, { style: "width:560px;height:360px;display:flex;flex-direction:column" });
                return host.querySelector('button[title="Open terminal (T)"]') != null;
            `);
            // the title tooltip host parks a hovered element's title in data-arc-title
            const r = await driftHover(
                h,
                `${DRIFT_HOST("AgentRow")}?.querySelector('button[title="Open terminal (T)"], button[data-arc-title="Open terminal (T)"]')`
            );
            return { step: "an agent card's header control changes background under the pointer and is no raw white or black overlay", ok: made && hoverOk(r), detail: JSON.stringify({ made, ...r }) };
        });

        // the nav rail at 78px with a two-digit count, in a store of its own so no live badge is touched
        await run("navrail", async () => {
            const s = await lookEval(h, `
                unmountAll();
                const J = await dep("jotai");
                const { attentionAtom } = await mod("app/view/agents/attentionstore.ts");
                const store = J.createStore();
                const items = (n, extra) => Array.from({ length: n }, (_, i) => ({ id: "drift-" + JSON.stringify(extra) + i, kind: "ask", ...extra }));
                store.set(attentionAtom, [...items(${DRIFT_BADGE}, {}), ...items(${DRIFT_BADGE}, { channelid: "drift" })]);
                const host = await mount("app/view/agents/navrail.tsx", "NavRail", { model: { surfaceAtom: J.atom("cockpit") } }, { store, style: "left:300px;top:40px;height:860px;padding:0;display:flex" });
                const nav = host.querySelector("nav");
                const labels = [...nav.querySelectorAll("button")].map((b) => [...b.children].find((c) => c.tagName === "SPAN" && !c.classList.contains("absolute") && c.querySelector("svg") == null)).filter(Boolean);
                const lines = labels.map((l) => {
                    const one = l.cloneNode();
                    one.textContent = "X";
                    l.parentElement.append(one);
                    const line = one.getBoundingClientRect().height;
                    one.remove();
                    return { text: flat(l), height: l.getBoundingClientRect().height, line };
                });
                const badges = [...nav.querySelectorAll("span.bg-asking")].map((b) => ({ text: flat(b), scroll: b.scrollWidth, client: b.clientWidth }));
                return { width: getComputedStyle(nav).width, lines, badges, floor: floorWalk([nav]) };
            `);
            await h.shot(lookShot("ui-drift-navrail"));
            const twoDigit = s.badges.filter((b) => b.text === String(DRIFT_BADGE));
            return {
                step: "the 78px nav rail keeps every label on one line, fits a two-digit count in its pill and passes the floor",
                ok:
                    s.width === "78px" &&
                    s.lines.length === NAV_ITEMS &&
                    s.lines.every((l) => l.height <= l.line + 0.5) &&
                    twoDigit.length === 2 &&
                    s.badges.every((b) => b.scroll <= b.client) &&
                    floorOk(s.floor),
                detail: JSON.stringify({ ...s, floor: floorDetail(s.floor) }),
            };
        });

        // DialogButton's key hint on the three styles
        await run("dialogbutton", async () => {
            const s = await lookEval(h, `
                unmountAll();
                const kinds = [["secondary", "Cancel", "esc"], ["primary", "Save", "⏎"], ["danger", "Delete", "⏎"]];
                const hosts = [];
                for (const [i, [variant, children, hint]] of kinds.entries()) {
                    hosts.push(await mount("app/modals/dialogbutton.tsx", "DialogButton", { variant, hint, children }, { style: "top:420px;left:" + (120 + i * 190) + "px;background:var(--color-surface-raised)" }));
                }
                const ink = (cls) => {
                    const p = document.createElement("span");
                    p.className = cls;
                    document.body.append(p);
                    const c = getComputedStyle(p).color;
                    p.remove();
                    return c;
                };
                const inks = ${JSON.stringify(DRIFT_INKS)}.map(ink);
                const lum = (rgb) => {
                    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
                    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
                };
                const over = (top, under) => [0, 1, 2].map((k) => (top[k] * top[3] + under[k] * (255 - top[3])) / 255);
                const contrast = (a, b) => {
                    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
                    return (x + 0.05) / (y + 0.05);
                };
                return hosts.map((host, i) => {
                    const b = host.querySelector("button");
                    const k = b.querySelector("kbd");
                    let opacity = 1;
                    for (let el = k; el && el !== host; el = el.parentElement) opacity = Math.min(opacity, Number(getComputedStyle(el).opacity));
                    const bg = over(rgbaOf(getComputedStyle(b).backgroundColor), [...rgbaOf(getComputedStyle(host).backgroundColor).slice(0, 3), 255]);
                    const color = getComputedStyle(k).color;
                    return {
                        variant: kinds[i][0],
                        px: parseFloat(getComputedStyle(k).fontSize),
                        opacity,
                        color,
                        ink: inks.includes(color),
                        own: color === getComputedStyle(b).color,
                        contrast: Math.round(contrast(over(rgbaOf(color), [...bg, 255]), bg) * 100) / 100,
                    };
                });
            `);
            await h.shot(lookShot("ui-drift-dialogbutton"));
            const ok = (b) =>
                b.px >= MIN_FONT_PX && b.opacity >= 1 && b.contrast >= DRIFT_CONTRAST && (b.variant === "secondary" ? b.ink : b.own);
            return {
                step: `a DialogButton's hint is at least ${MIN_FONT_PX}px at full opacity: an ink token on secondary, the button's own ink on primary and danger, at ${DRIFT_CONTRAST}:1 or more`,
                ok: s.length === 3 && s.every(ok),
                detail: JSON.stringify(s),
            };
        });

        // the tracker's status menu on a one-chunk plan
        await run("tracker menu", async () => {
            const s = await lookEval(h, `
                unmountAll();
                const row = { label: "Raise the floor", status: "active", stage: "", tone: "active", trail: [], workrefs: [] };
                const rows = [
                    { kind: "facts", id: "drift/facts", oref: "effort:drift", count: "1 chunk · 0 done" },
                    { kind: "chunk", id: "drift/c", oref: "effort:drift", row, notes: 0, next: true },
                ];
                const fields = { oid: "drift", title: "Drift", effortStatus: "active", total: 1, stages: [], canMove: () => false };
                const edits = new Proxy(fields, { get: (t, k) => (k in t ? t[k] : () => {}) });
                const host = await mount("app/view/jarvis/inlinetrackerview.tsx", "InitiativeDetail", { rows, cursor: undefined, edits, onSelectChunk() {}, onToggleStage() {} }, { style: "width:620px" });
                host.querySelector("[data-jarvis-chunk-status]")?.click();
                await until(() => host.querySelector("[data-jarvis-tracker-menu]") != null, 3000);
                await nap(400);
                return shadowVs(host.querySelector("[data-jarvis-tracker-menu]"), "shadow-popover-md");
            `);
            await h.shot(lookShot("ui-drift-tracker-menu"));
            return { step: "the tracker's status menu casts shadow-popover-md over no raw overlay", ok: s.ok === true, detail: JSON.stringify(s) };
        });
        await lookEval(h, `unmountAll();`);

        // the Brief's toast, shown through its own atom
        await run("brief toast", async () => {
            await h.goto("jarvis");
            const s = await lookEval(h, `
                const { globalStore } = await mod("app/store/jotaiStore.ts");
                const { briefToastAtom } = await mod("app/view/jarvis/briefundo.ts");
                globalStore.set(briefToastAtom, { id: Date.now(), text: "Chunk deleted", undo: () => {} });
                const toast = () => document.querySelector("[data-jarvis-brief-toast]");
                await until(() => toast() != null, 3000);
                await nap(500);
                return shadowVs(toast(), "shadow-popover-md");
            `);
            await h.shot(lookShot("ui-drift-brief-toast"));
            await lookEval(h, `
                const { globalStore } = await mod("app/store/jotaiStore.ts");
                globalStore.set((await mod("app/view/jarvis/briefundo.ts")).briefToastAtom, null);
            `);
            return { step: "the brief toast casts shadow-popover-md over no raw overlay", ok: s.ok === true, detail: JSON.stringify(s) };
        });

        // Escape closes each hand-rolled menu onto its trigger, and only the menu
        await h.goto("agent");
        await run("switcher agent", () => driftEscape(h, "Escape closes the project switcher on Agent and focuses it, staying on Agent", DRIFT_SWITCHER));
        return steps;
    },
    async teardown(h, ctx) {
        try {
            await lookHover(h, 1, 1);
            await lookEval(h, `unmountAll();`);
        } finally {
            rmSync(ctx.dir, { recursive: true, force: true });
            await h.goto("cockpit");
        }
    },
};
