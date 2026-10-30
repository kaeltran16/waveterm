// Cockpit shell scenarios: smoke, keys, doc review, shell and monitor tasks, modals, tooltips, UI drift.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SURFACE_LABEL } from "./attach.mjs";
import {
    COCKPIT,
    COCKPIT_LEAD_CARD,
    LOOK_TOOLTIP_STYLE,
    MIN_FONT_PX,
    MODELS_VIEWPORT,
    PALETTE,
    PALETTE_INPUT,
    RAIL_VISIBLE_KEY,
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
    restoreLocalStorage,
    setInputExpr,
    skipStep,
    teardownFixtureRun,
    tooltipLookOk,
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
        await h.goto("cockpit");
        await h.ev(keydown({ key: "7", code: "Digit7", ctrlKey: true }));
        await h.ev(`new Promise((r) => setTimeout(r, ${SMOKE_KEY_WAIT_MS}))`);
        const chorded = await h.activeSurfaceLabel();
        steps.push({
            step: "Ctrl+7 lands on the last surface",
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

// A lead's Plan review ask opens as the review dialog over whatever agent is focused (git show a4b5bd4f:
// docs/superpowers/plans/2026-09-30-doc-review-dialog.md). Same setup as agent-tree-rail, with a roster of a working agent and a lead
// asking a Plan review whose plan the scenario writes. The working agent comes in through its Cockpit card, so
// the Agent surface never defaults onto the lead and spends its one auto-open before step 4. Nothing is answered:
// the fixture ask has no live block.
const DOC_REVIEW_LEAD = "doc-review lead";
const DOC_REVIEW_LEAD_ID = "fx-doc-lead";
const DOC_REVIEW_WORKER = "doc-review worker";
const DOC_REVIEW_WORKER_ID = "fx-doc-worker";
const DOC_REVIEW_HEADING = "Doc review fixture plan";
const DOC_REVIEW_DECISIONS = [
    "The dialog opens over any focused agent",
    "Esc hides it and the ask stays open",
    "It auto-opens once on the lead",
];
const DOC_REVIEW_TAG_TITLE = "Open the plan review";
const DOC_REVIEW_CHIP = "Plan review";
const DOC_REVIEW_PANEL = `document.querySelector("[data-doc-review]")?.closest('[role="dialog"]')`;

function docReviewRoster(runId, docPath, decisions = DOC_REVIEW_DECISIONS, header = DOC_REVIEW_CHIP) {
    return [
        {
            id: DOC_REVIEW_WORKER_ID,
            name: DOC_REVIEW_WORKER,
            project: "waveterm",
            task: "keep working",
            state: "working",
            agent: "claude",
            model: "opus",
            activeMs: 90_000,
            blockId: "fx-blk-doc-worker",
            // the Cockpit leaves an agent with nothing to show off its grid (cardHasContent)
            previousInfo: [{ kind: "message", text: "Working through the fixture task." }],
        },
        {
            id: DOC_REVIEW_LEAD_ID,
            name: DOC_REVIEW_LEAD,
            project: "waveterm",
            task: "verify doc review",
            state: "asking",
            agent: "claude",
            model: "opus",
            blockedMs: 60_000,
            runId,
            blockId: "fx-blk-doc-lead",
            ask: {
                askId: `fx-doc-review-${Date.now()}`,
                oref: "block:fx-blk-doc-lead",
                questions: [
                    {
                        header,
                        question: [docPath, ...decisions.map((d) => `- ${d}`)].join("\n"),
                        options: [{ label: "Approve" }, { label: "Request changes" }],
                    },
                ],
            },
        },
    ];
}

// the lead's row in the Agent tree, found by its name leaf as agent-tree-rail does
const docReviewTreeRow = (name) => `(() => {
    const tree = document.querySelector("[data-agent-tree]");
    const leaf = tree && [...tree.querySelectorAll("div")].find(
        (d) => d.textContent.trim() === ${JSON.stringify(name)} && d.children.length === 0
    );
    return leaf ? leaf.closest(".cursor-pointer") : null;
})()`;

// polls a boolean page expression; resolves to its last value
const docReviewWait = (h, expr, ms = 5000) =>
    h.ev(`(async () => {
        const t0 = performance.now();
        for (;;) {
            const v = !!(${expr});
            if (v || performance.now() - t0 > ${ms}) return v;
            await new Promise((r) => setTimeout(r, 150));
        }
    })()`);

// Escape where the user's focus is, so ModalShell's window listener sees it the way a keypress would reach it
const docReviewEscape = (h) =>
    h.ev(`(document.activeElement || document.body).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })
    )`);

const docReviewHeaderNames = (h) =>
    h.ev(`(() => {
        const t = document.querySelector("[data-agent-header]")?.textContent ?? "";
        return { worker: t.includes(${JSON.stringify(DOC_REVIEW_WORKER)}), lead: t.includes(${JSON.stringify(DOC_REVIEW_LEAD)}) };
    })()`);

// focus the lead through its tree row with nothing editable focused, so auto-open is allowed to fire
const docReviewFocusRow = (h, name) =>
    h.ev(`(() => {
        document.activeElement?.blur?.();
        document.querySelector("[data-cockpit-surface-wrap]")?.focus();
        const row = ${docReviewTreeRow(name)};
        if (!row) return false;
        row.click();
        return true;
    })()`);

// the doc-review roster with its lead asking under header, on a plan this writes; the cockpit shows the worker's card
async function arrangeDocReview(h, name, header) {
    const cwd = mkdtempSync(join(tmpdir(), `verify-${name}-`));
    const ctx = { cwd };
    try {
        await arrangeFixtureRun(h, ctx, name, DOC_REVIEW_LEAD);
        ctx.specPath = join(cwd, "doc-review-plan.md");
        writeFileSync(
            ctx.specPath,
            `# ${DOC_REVIEW_HEADING}\n\nA small plan the doc-review scenario writes for the dialog to render.\n`
        );
        writeFileSync(
            TREE_RAIL_FIXTURE,
            JSON.stringify(docReviewRoster(ctx.runId, ctx.specPath, DOC_REVIEW_DECISIONS, header), null, 2)
        );
        // the fixture roster is read once at boot
        await h.ev("location.reload()");
        await h.ev(`(async () => {
            for (let i = 0; i < 60 && !document.querySelector("nav button"); i++) {
                await new Promise((r) => setTimeout(r, 500));
            }
        })()`);
        await h.goto("cockpit");
        ctx.rosterLoaded = await docReviewWait(
            h,
            `document.querySelector('[data-cockpit-surface] [data-agent-id="${DOC_REVIEW_WORKER_ID}"]')`,
            15000
        );
    } catch (e) {
        ctx.arrangeError = String(e?.message ?? e);
    }
    return ctx;
}

export const docReview = {
    name: "doc-review",
    surface: "cockpit",
    arrange: (h) => arrangeDocReview(h, "doc-review", DOC_REVIEW_CHIP),
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const nap = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        const dialogOpen = () => h.ev(`!!${DOC_REVIEW_PANEL}`);
        const dialogGone = (ms) => docReviewWait(h, `!${DOC_REVIEW_PANEL}`, ms);
        if (ctx.arrangeError != null || !ctx.rosterLoaded) {
            return [{ step: "0. the fixture roster loaded", ok: false, detail: ctx.arrangeError ?? "no worker card" }];
        }

        // the card's terminal button focuses the worker and switches to the Agent surface in one step
        const opened = await h.ev(`(() => {
            const b = document.querySelector(
                '[data-cockpit-surface] [data-agent-id="${DOC_REVIEW_WORKER_ID}"] button[title="Open terminal (T)"]'
            );
            if (!b) return false;
            b.click();
            return true;
        })()`);
        const tagged = await docReviewWait(
            h,
            `${docReviewTreeRow(DOC_REVIEW_LEAD)}?.querySelector('button[title="${DOC_REVIEW_TAG_TITLE}"]')`
        );
        await nap(500);
        const names1 = await docReviewHeaderNames(h);
        const anyDialog1 = await h.ev(`!!document.querySelector('[role="dialog"]')`);
        rec(
            "1. on the working agent: no dialog, and the lead's tree row has the review tag",
            opened && names1.worker && !anyDialog1 && tagged,
            JSON.stringify({ opened, header: names1, dialog: anyDialog1, tagged })
        );

        await h.ev(`${docReviewTreeRow(DOC_REVIEW_LEAD)}?.querySelector('button[title="${DOC_REVIEW_TAG_TITLE}"]')?.click()`);
        const open2 = await docReviewWait(h, DOC_REVIEW_PANEL);
        // the document is read over RPC, so its heading lands after the panel
        await docReviewWait(h, `${DOC_REVIEW_PANEL}?.querySelector("h1")`);
        const panel2 = await h.ev(`(() => {
            const p = ${DOC_REVIEW_PANEL};
            if (!p) return null;
            return {
                heading: p.querySelector("h1")?.textContent.trim() ?? null,
                items: p.querySelectorAll("ol > li").length,
            };
        })()`);
        const names2 = await docReviewHeaderNames(h);
        await h.shot("cdp-shots/doc-review-dialog.png");
        rec(
            "2. the tag opens the dialog over the working agent: the plan on the left, 3 findings on the right",
            open2 &&
                panel2?.heading === DOC_REVIEW_HEADING &&
                panel2?.items === DOC_REVIEW_DECISIONS.length &&
                names2.worker &&
                !names2.lead,
            JSON.stringify({ panel: panel2, header: names2 })
        );

        await docReviewEscape(h);
        const gone3 = await dialogGone(3000);
        const names3 = await docReviewHeaderNames(h);
        rec(
            "3. Escape hides the dialog and leaves the working agent focused",
            gone3 && names3.worker && !names3.lead,
            JSON.stringify({ gone: gone3, header: names3 })
        );

        const clicked4 = await docReviewFocusRow(h, DOC_REVIEW_LEAD);
        const auto4 = await docReviewWait(h, DOC_REVIEW_PANEL);
        const names4 = await docReviewHeaderNames(h);
        rec(
            "4a. focusing the lead with nothing editable focused opens the dialog by itself",
            clicked4 && auto4 && names4.lead,
            JSON.stringify({ clicked: clicked4, open: auto4, header: names4 })
        );

        await docReviewEscape(h);
        const gone4 = await dialogGone(3000);
        await docReviewFocusRow(h, DOC_REVIEW_WORKER);
        await nap(400);
        await docReviewFocusRow(h, DOC_REVIEW_LEAD);
        await nap(1200);
        const reopened = await dialogOpen();
        const names4b = await docReviewHeaderNames(h);
        rec(
            "4b. after Escape, refocusing the lead does not reopen it",
            gone4 && !reopened && names4b.lead,
            JSON.stringify({ gone: gone4, reopened, header: names4b })
        );

        const chipped = await h.ev(`(() => {
            const b = [...(document.querySelector("[data-agent-header]")?.querySelectorAll("button") ?? [])]
                .find((x) => x.textContent.trim() === ${JSON.stringify(DOC_REVIEW_CHIP)});
            if (!b) return false;
            b.click();
            return true;
        })()`);
        const open4 = await docReviewWait(h, DOC_REVIEW_PANEL);
        rec("4c. the header chip reopens it", chipped && open4, JSON.stringify({ chip: chipped, open: open4 }));
        await docReviewEscape(h);
        await dialogGone(3000);
        return steps;
    },
    async teardown(h, ctx) {
        await teardownFixtureRun(h, ctx, "doc-review");
    },
};

// A quick run's worker asks a Plan approval (BuildQuickPrompt), not the lead's round-2 Plan review: the same dialog
// opens on it, with the approval's own words. Same roster as doc-review, its lead asking under the other header.
const DOC_APPROVAL_CHIP = "Plan approval";
const DOC_APPROVAL_TITLE = "Approve this plan?";

export const docReviewApproval = {
    name: "doc-review-approval",
    surface: "cockpit",
    arrange: (h) => arrangeDocReview(h, "doc-review-approval", DOC_APPROVAL_CHIP),
    async assert(h, ctx) {
        if (ctx.arrangeError != null || !ctx.rosterLoaded) {
            return [{ step: "0. the fixture roster loaded", ok: false, detail: ctx.arrangeError ?? "no worker card" }];
        }
        // auto-open fires only on the Agent surface, which the worker card's terminal button switches to
        await h.ev(`document.querySelector(
            '[data-cockpit-surface] [data-agent-id="${DOC_REVIEW_WORKER_ID}"] button[title="Open terminal (T)"]'
        )?.click()`);
        await docReviewWait(h, docReviewTreeRow(DOC_REVIEW_LEAD));
        const clicked = await docReviewFocusRow(h, DOC_REVIEW_LEAD);
        const open = await docReviewWait(h, DOC_REVIEW_PANEL);
        await docReviewWait(h, `${DOC_REVIEW_PANEL}?.querySelector("h1")`);
        const panel = await h.ev(`(() => {
            const p = ${DOC_REVIEW_PANEL};
            if (!p) return null;
            const head = p.querySelector("[data-doc-review]")?.textContent ?? "";
            return {
                eyebrow: head.includes(${JSON.stringify(DOC_APPROVAL_CHIP)}) && !head.includes("round 2 failed"),
                title: head.includes(${JSON.stringify(DOC_APPROVAL_TITLE)}),
                list: p.textContent.includes("Key decisions"),
                items: p.querySelectorAll("ol > li").length,
            };
        })()`);
        await h.shot("cdp-shots/doc-review-approval.png");
        await docReviewEscape(h);
        await docReviewWait(h, `!${DOC_REVIEW_PANEL}`, 3000);
        const chip = await h.ev(`[...(document.querySelector("[data-agent-header]")?.querySelectorAll("button") ?? [])]
            .some((x) => x.textContent.trim() === ${JSON.stringify(DOC_APPROVAL_CHIP)})`);
        return [
            {
                step: "1. focusing the lead opens its Plan approval with the approval's eyebrow, title and decisions",
                ok:
                    clicked &&
                    open &&
                    panel?.eyebrow &&
                    panel?.title &&
                    panel?.list &&
                    panel?.items === DOC_REVIEW_DECISIONS.length,
                detail: JSON.stringify({ clicked, open, panel }),
            },
            { step: "2. the header chip reads Plan approval", ok: chip, detail: JSON.stringify({ chip }) },
        ];
    },
    async teardown(h, ctx) {
        await teardownFixtureRun(h, ctx, "doc-review-approval");
    },
};

// Quoting passages of the reviewed document (docs/superpowers/plans/2026-10-05-highlight-to-quote.md): a selection
// in the document opens a note field, notes collect in the rail and travel with either answer. Same roster as
// doc-review, on the mockup's document and decisions. Selections, typing and keys are made in the page, since CDP
// input does not reliably reach the WebView. Nothing is delivered: the fixture ask has no live block, so a send
// shows the cockpit's own sent lock.
const DOC_NOTES_HEADING = "Highlight-to-quote in the review dialog";
const DOC_NOTES_FIELD = "A note field opens under the selection";
const DOC_NOTES_STAYS = "The passage stays highlighted in the document until its note is removed.";
const DOC_NOTES_REWORD = "A note can be reworded on the right afterwards.";
const DOC_NOTES_ORDER = "in document order";
const DOC_NOTES_CUT = "A long passage is cut to its first and last lines.";
const DOC_NOTES_KEYBOARD = "Selecting with the keyboard";
const DOC_NOTES_LAST = "The last round ends when every note is applied.";
// one token on a fenced block's second line, so a selection up to it crosses the block's header and a line number
const DOC_NOTES_FENCE = "quotedfence";
// enough one-line paragraphs after the mockup's text that the document pane scrolls
const DOC_NOTES_FILLER_ROUNDS = 16;
const DOC_NOTES_SPEC = [
    `# ${DOC_NOTES_HEADING}`,
    "## Goal",
    "Request changes is free text that points at nothing, so a change request has to describe the passage it means. Selecting a passage in the document and writing a note on it lets the answer carry the passage with it.",
    "## Gesture",
    `Select text in the document. ${DOC_NOTES_FIELD}: Enter adds the passage and what you wrote to your notes on the right, under the decisions, Esc drops it. ${DOC_NOTES_STAYS} ${DOC_NOTES_REWORD}`,
    "## Delivery",
    `Request changes sends each note as the quoted passage followed by what you wrote, ${DOC_NOTES_ORDER}, through the ask's own answer path. Approve sends them too, after the approval. ${DOC_NOTES_CUT} The whole answer is one message to the lead.`,
    "## Out of scope",
    `The Code surface's markdown preview and the run report. Quoting from the decisions list on the right. ${DOC_NOTES_KEYBOARD}: the passage is picked with the mouse, then everything after is keys.`,
    `\`\`\`ts\nalpha\n${DOC_NOTES_FENCE}\n\`\`\``,
    "## Review rounds",
    ...Array.from(
        { length: DOC_NOTES_FILLER_ROUNDS },
        (_, i) => `Round ${i + 1}: the lead applies the quoted notes and asks for the review again.`
    ),
    DOC_NOTES_LAST,
].join("\n\n");
const DOC_NOTES_DECISIONS = [
    "Quoting is built on the dialog's own light renderer; the shared Code-preview renderer is left alone.",
    "Highlights are painted over the rendered text, not wrapped into it, so the markdown output is untouched.",
    "Notes are kept per ask, survive hiding the dialog, and are cleared once the ask is answered.",
    "Approve carries any notes with it, and its button shows how many. Nothing you wrote is dropped.",
];
const DOC_NOTES_DECISIONS_CROWDED = [
    ...DOC_NOTES_DECISIONS,
    "A selection that crosses a code block or a table quotes its text only.",
    "Notes are sent in document order, not the order they were written.",
    "The same gesture works in the plan review; its findings are not quotable.",
    "A passage quoted twice makes two notes.",
    "Selecting inside the decisions list does nothing.",
];
const DOC_NOTES_STAYS_NOTE = "Keep it highlighted after sending too, until the lead picks it up.";
const DOC_NOTES_CUT_NOTE = "Don't cut it. Send the whole passage.";
const DOC_NOTES_REWORD_NOTE = "Clicking a note should scroll the document to its passage.";
const DOC_NOTES_REWORD_EDIT = "Scroll the document to the passage when its note is clicked.";
// the Crowded board's notes, in document order
const DOC_NOTES_CROWDED = [
    [DOC_NOTES_FIELD, "Open it above when the selection is near the bottom."],
    [DOC_NOTES_STAYS, DOC_NOTES_STAYS_NOTE],
    [DOC_NOTES_REWORD, DOC_NOTES_REWORD_NOTE],
    [DOC_NOTES_ORDER, "Yes. Not the order I wrote them in."],
    [DOC_NOTES_CUT, DOC_NOTES_CUT_NOTE],
    [DOC_NOTES_KEYBOARD, ""],
];
// the order they are written in
const DOC_NOTES_WRITTEN = [4, 1, 5, 0, 3, 2];
const DOC_NOTES_LIST_CAP = 300;
const DOC_NOTES_PANEL_WIDTH = 1240;
const DOC_NOTES_RAIL_WIDTH = 460;
const DOC_NOTES_EMPTY = "No note yet";

// page-side helpers, prefixed to every evaluated body. Every query is under the dialog panel.
const DOC_NOTES_LIB = `
    const panel = () => ${DOC_REVIEW_PANEL};
    const docRoot = () => panel()?.querySelector("[data-doc-review-doc]");
    const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
    const ranges = (name) => CSS.highlights.get(name)?.size ?? 0;
    const box = (r) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
    const ownText = (el) =>
        [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join("").trim();
    const textNode = (root, passage) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const at = n.nodeValue.indexOf(passage);
            if (at >= 0) return { node: n, at };
        }
        return null;
    };
    const rangeOf = (passage) => {
        const hit = docRoot() && textNode(docRoot(), passage);
        if (!hit) return null;
        const range = document.createRange();
        range.setStart(hit.node, hit.at);
        range.setEnd(hit.node, hit.at + passage.length);
        return range;
    };
    const selectRange = (range) => {
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        docRoot().dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    };
    const select = (passage) => {
        const range = rangeOf(passage);
        if (!range) return null;
        selectRange(range);
        return box(range.getBoundingClientRect());
    };
    const type = (input, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const key = (el, k, mods) =>
        el.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: k, bubbles: true, cancelable: true, ...mods }));
    const fieldInput = () => panel()?.querySelector("[data-doc-note-field] input");
    const rowOf = (passage) =>
        [...panel().querySelectorAll("[data-doc-note-row]")].find((r) => r.textContent.includes(passage));
    const button = (label) => [...panel().querySelectorAll("button")].find((b) => ownText(b) === label);
    const addNote = async (passage, note) => {
        select(passage);
        await settle();
        const input = fieldInput();
        if (!input) return false;
        if (note) {
            type(input, note);
            await settle();
        }
        key(input, "Enter");
        await settle();
        return true;
    };
    const state = () => {
        const p = panel();
        if (!p) return { open: false };
        const notes = p.querySelector("[data-doc-notes]");
        const toggle = notes?.querySelector("[data-doc-notes-toggle]");
        const list = toggle?.nextElementSibling;
        const field = p.querySelector("[data-doc-note-field]");
        const decisions = p.querySelector("ol")?.parentElement;
        return {
            open: true,
            panel: box(p.getBoundingClientRect()),
            panelWidth: p.offsetWidth,
            railWidth: decisions?.parentElement.offsetWidth ?? null,
            heading: p.querySelector("[data-doc-review-doc] h1")?.textContent.trim() ?? null,
            items: p.querySelectorAll("ol > li").length,
            decisions: decisions ? { client: decisions.clientHeight, scroll: decisions.scrollHeight } : null,
            header: toggle?.querySelector("span")?.textContent.trim() ?? null,
            expanded: toggle?.getAttribute("aria-expanded") ?? null,
            list: list ? { client: list.clientHeight, scroll: list.scrollHeight } : null,
            rows: [...(notes?.querySelectorAll("[data-doc-note-row]") ?? [])].map((row) => {
                const edit = row.querySelector('button[aria-label="Edit this note"]');
                const input = row.querySelector("input");
                return {
                    open: row.getAttribute("data-open") === "true",
                    passage: (edit ?? row.firstElementChild)?.firstElementChild?.textContent ?? null,
                    note: input ? input.value : (edit?.children[1]?.textContent ?? null),
                    input: !!input,
                    locked: edit?.disabled ?? false,
                    remove: !!row.querySelector('button[aria-label="Remove this note"]'),
                };
            }),
            field: field ? box(field.getBoundingClientRect()) : null,
            fieldFocused: !!field && document.activeElement === field.querySelector("input"),
            quoted: ranges("doc-review-quoted"),
            pending: ranges("doc-review-pending"),
            buttons: [...p.querySelectorAll("button")].map(ownText).filter(Boolean),
            sent: [...p.querySelectorAll("span")].find((s) => s.textContent.startsWith("Sent: "))?.textContent ?? null,
        };
    };
`;

// runs a body in the page (it may await, and set out), lets React settle, and resolves to the dialog's state
const docNotesAct = (h, body = "") =>
    h.ev(`(async () => {
        ${DOC_NOTES_LIB}
        let out = null;
        ${body}
        await settle();
        return { ...state(), out };
    })()`);

const docNotesJson = (v) => JSON.stringify(v);

// what a step's detail keeps of the dialog's state
const docNotesBrief = (s, out) =>
    JSON.stringify({
        open: s.open,
        header: s.header,
        rows: (s.rows ?? []).map((r) => [r.passage, r.note, r.open ? "open" : r.locked ? "locked" : "compact"]),
        field: s.field != null,
        quoted: s.quoted,
        pending: s.pending,
        buttons: s.buttons,
        sent: s.sent,
        ...out,
    });

// the fixture roster is read once at boot
async function docNotesReload(h, ctx, decisions) {
    writeFileSync(TREE_RAIL_FIXTURE, JSON.stringify(docReviewRoster(ctx.runId, ctx.specPath, decisions), null, 2));
    await h.ev("location.reload()");
    await h.ev(`(async () => {
        for (let i = 0; i < 60 && !document.querySelector("nav button"); i++) {
            await new Promise((r) => setTimeout(r, 500));
        }
    })()`);
    await h.goto("cockpit");
    return docReviewWait(
        h,
        `document.querySelector('[data-cockpit-surface] [data-agent-id="${DOC_REVIEW_WORKER_ID}"]')`,
        15000
    );
}

const docNotesTag = `${docReviewTreeRow(DOC_REVIEW_LEAD)}?.querySelector('button[title="${DOC_REVIEW_TAG_TITLE}"]')`;

// through the lead's tree tag, and resolved once the document is rendered and the panel has stopped scaling
async function docNotesOpenByTag(h) {
    const tagged = await docReviewWait(h, docNotesTag);
    await h.ev(`${docNotesTag}?.click()`);
    const open = await docReviewWait(h, DOC_REVIEW_PANEL);
    const rendered = await docReviewWait(h, `${DOC_REVIEW_PANEL}?.querySelector("[data-doc-review-doc] h1")`);
    await h.ev(`new Promise((r) => setTimeout(r, 500))`);
    return tagged && open && rendered;
}

// from the Cockpit: the worker's card leads to the Agent surface without spending the lead's auto-open
async function docNotesOpen(h) {
    await h.ev(`document.querySelector(
        '[data-cockpit-surface] [data-agent-id="${DOC_REVIEW_WORKER_ID}"] button[title="Open terminal (T)"]'
    )?.click()`);
    return docNotesOpenByTag(h);
}

export const docReviewNotes = {
    name: "doc-review-notes",
    surface: "cockpit",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-doc-review-notes-"));
        const ctx = { cwd };
        try {
            await arrangeFixtureRun(h, ctx, "doc-review-notes", DOC_REVIEW_LEAD);
            ctx.specPath = join(cwd, "2026-10-05-highlight-to-quote-design.md");
            writeFileSync(ctx.specPath, `${DOC_NOTES_SPEC}\n`);
            // the panel and rail widths asserted below need the room, and verify.mjs restores its own pin after
            await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
            ctx.rosterLoaded = await docNotesReload(h, ctx, DOC_NOTES_DECISIONS);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok: !!ok, detail });
        const has = (s, label) => (s.buttons ?? []).includes(label);
        const passages = (s) => (s.rows ?? []).map((r) => r.passage);
        if (ctx.arrangeError != null || !ctx.rosterLoaded) {
            return [{ step: "0. the fixture roster loaded", ok: false, detail: ctx.arrangeError ?? "no worker card" }];
        }

        const opened1 = await docNotesOpen(h);
        const s1 = await docNotesAct(h);
        rec(
            "1. the dialog is open on the fixture spec: 4 decisions, no notes, Approve and Request changes, 1240 wide with a 460 rail",
            opened1 &&
                s1.heading === DOC_NOTES_HEADING &&
                s1.items === DOC_NOTES_DECISIONS.length &&
                s1.header == null &&
                s1.rows.length === 0 &&
                has(s1, "Approve") &&
                has(s1, "Request changes") &&
                s1.panelWidth === DOC_NOTES_PANEL_WIDTH &&
                s1.railWidth === DOC_NOTES_RAIL_WIDTH,
            docNotesBrief(s1, {
                opened: opened1,
                heading: s1.heading,
                items: s1.items,
                panelWidth: s1.panelWidth,
                railWidth: s1.railWidth,
            })
        );

        const s2 = await docNotesAct(h, `out = select(${docNotesJson(DOC_NOTES_STAYS)});`);
        rec(
            "2. selecting a passage opens the note field under it, focused, and tints the passage",
            s2.out != null && s2.field != null && s2.field.top >= s2.out.bottom && s2.fieldFocused && s2.pending === 1,
            docNotesBrief(s2, { selection: s2.out, fieldRect: s2.field, focused: s2.fieldFocused })
        );

        const s3 = await docNotesAct(
            h,
            `type(fieldInput(), ${docNotesJson(DOC_NOTES_STAYS_NOTE)});
            await settle();
            key(fieldInput(), "Enter");`
        );
        rec(
            "3. a note and Enter: the field closes, the rail lists the note, the passage stays painted, the footer counts it, nothing is sent",
            s3.open &&
                s3.field == null &&
                s3.header === "Your notes · 1" &&
                s3.rows.length === 1 &&
                s3.rows[0].passage === DOC_NOTES_STAYS &&
                s3.rows[0].note === DOC_NOTES_STAYS_NOTE &&
                s3.quoted === 1 &&
                s3.pending === 0 &&
                has(s3, "Approve with 1 note") &&
                has(s3, "Request changes · 1 note") &&
                s3.sent == null,
            docNotesBrief(s3)
        );
        const draft3 = await docNotesAct(
            h,
            `select(${docNotesJson(DOC_NOTES_CUT)});
            await settle();
            type(fieldInput(), ${docNotesJson(DOC_NOTES_CUT_NOTE)});`
        );
        await h.shot("cdp-shots/doc-review-notes-main.png");
        rec(
            "3b. the Main board: one kept note, and the field open with a draft under a second, tinted passage",
            draft3.field != null && draft3.pending === 1 && draft3.quoted === 1 && draft3.rows.length === 1,
            docNotesBrief(draft3)
        );

        const s4 = await docNotesAct(h, `key(fieldInput(), "Escape");`);
        rec(
            "4. Escape in the field drops it and leaves the note and the dialog",
            s4.open && s4.field == null && s4.rows.length === 1 && s4.pending === 0,
            docNotesBrief(s4)
        );

        const s4b = await docNotesAct(
            h,
            `const from = textNode(docRoot(), ${docNotesJson(DOC_NOTES_KEYBOARD)});
            const to = textNode(docRoot(), ${docNotesJson(DOC_NOTES_FENCE)});
            const range = document.createRange();
            range.setStart(from.node, from.at);
            range.setEnd(to.node, to.at + ${DOC_NOTES_FENCE.length});
            selectRange(range);
            await settle();
            key(fieldInput(), "Enter");`
        );
        const removed4b = await docNotesAct(
            h,
            `rowOf(${docNotesJson(DOC_NOTES_FENCE)})?.querySelector('button[aria-label="Remove this note"]')?.click();`
        );
        rec(
            "4b. a passage quoted through a fenced code block is painted, and removing its note unpaints it",
            s4b.rows.length === 2 &&
                s4b.rows[1].passage.endsWith(`keys. alpha ${DOC_NOTES_FENCE}`) &&
                s4b.quoted === 2 &&
                removed4b.rows.length === 1 &&
                removed4b.quoted === 1,
            docNotesBrief(s4b, { afterRemove: removed4b.quoted })
        );

        const s5 = await docNotesAct(
            h,
            `const from = textNode(docRoot(), ${docNotesJson(DOC_NOTES_REWORD)});
            const to = textNode(panel().querySelector("ol"), ${docNotesJson(DOC_NOTES_DECISIONS[0])});
            const range = document.createRange();
            range.setStart(from.node, from.at);
            range.setEnd(to.node, to.at + 7);
            selectRange(range);
            out = { selected: getSelection().toString().length, endsInDoc: docRoot().contains(range.endContainer) };`
        );
        await h.ev("getSelection().removeAllRanges()");
        rec(
            "5. a selection that starts in the document and ends in the decisions opens nothing",
            s5.out.selected > 0 && !s5.out.endsInDoc && s5.field == null && s5.pending === 0,
            docNotesBrief(s5, s5.out)
        );

        const s6 = await docNotesAct(
            h,
            `const scroller = docRoot().parentElement;
            const pane = scroller.getBoundingClientRect();
            scroller.scrollTop += rangeOf(${docNotesJson(DOC_NOTES_LAST)}).getBoundingClientRect().bottom - pane.bottom;
            await settle();
            out = {
                scrolls: scroller.scrollHeight > scroller.clientHeight,
                scrollTop: scroller.scrollTop,
                paneBottom: pane.bottom,
                selection: select(${docNotesJson(DOC_NOTES_LAST)}),
            };`
        );
        await h.shot("cdp-shots/doc-review-notes-flip.png");
        const inside6 =
            s6.field != null &&
            s6.field.top >= s6.panel.top &&
            s6.field.bottom <= s6.panel.bottom &&
            s6.field.left >= s6.panel.left &&
            s6.field.right <= s6.panel.right;
        rec(
            "6. with no room below, the field opens above a selection at the pane's bottom edge, inside the dialog",
            s6.out.scrolls && s6.out.scrollTop > 0 && s6.field != null && s6.field.bottom <= s6.out.selection.top && inside6,
            docNotesBrief(s6, { ...s6.out, fieldRect: s6.field, panelRect: s6.panel })
        );
        const dropped6 = await docNotesAct(h, `key(fieldInput(), "Escape"); docRoot().parentElement.scrollTop = 0;`);

        await docReviewEscape(h);
        const gone7 = await docReviewWait(h, `!${DOC_REVIEW_PANEL}`, 3000);
        const reopened7 = await docNotesOpenByTag(h);
        const s7 = await docNotesAct(h);
        rec(
            "7. Escape hides the dialog; reopened, the note is still listed and its passage painted again",
            dropped6.field == null &&
                gone7 &&
                reopened7 &&
                s7.rows.length === 1 &&
                s7.rows[0].passage === DOC_NOTES_STAYS &&
                s7.rows[0].note === DOC_NOTES_STAYS_NOTE &&
                s7.quoted === 1,
            docNotesBrief(s7, { gone: gone7, reopened: reopened7 })
        );

        const request8 = await docNotesAct(h, `button("Request changes · 1 note")?.click();`);
        const s8 = await docNotesAct(
            h,
            `const send = button("Send 1 note to the lead");
            out = { textarea: panel().querySelector("#doc-review-note")?.value ?? null, enabled: !!send && !send.disabled };
            send?.click();`
        );
        await h.shot("cdp-shots/doc-review-notes-request-sent.png");
        const locked8 = await docNotesAct(
            h,
            `const row = rowOf(${docNotesJson(DOC_NOTES_STAYS)});
            row?.querySelector('button[aria-label="Edit this note"]')?.click();
            row?.querySelector('button[aria-label="Remove this note"]')?.click();
            await settle();
            select(${docNotesJson(DOC_NOTES_CUT)});`
        );
        await h.ev("getSelection().removeAllRanges()");
        rec(
            "8. Request changes with the textarea empty sends the one note: the sent line counts it, the row locks, a selection opens nothing",
            has(request8, "Send 1 note to the lead") &&
                s8.out.textarea === "" &&
                s8.out.enabled &&
                s8.sent === "Sent: Request changes, with 1 note" &&
                locked8.sent === s8.sent &&
                locked8.rows.length === 1 &&
                locked8.rows[0].locked &&
                !locked8.rows[0].remove &&
                !locked8.rows[0].open &&
                locked8.field == null &&
                locked8.pending === 0,
            docNotesBrief(locked8, s8.out)
        );

        // a new askId, so the sent lock is gone; the reload empties the notes too
        const loaded9 = await docNotesReload(h, ctx, DOC_NOTES_DECISIONS_CROWDED);
        const opened9 = loaded9 && (await docNotesOpen(h));
        const fresh9 = await docNotesAct(h);
        const written9 = DOC_NOTES_WRITTEN.map((i) => DOC_NOTES_CROWDED[i]);
        const s9 = await docNotesAct(
            h,
            `out = { added: [] };
            for (const [passage, note] of ${docNotesJson(written9)}) out.added.push(await addNote(passage, note));
            rowOf(${docNotesJson(DOC_NOTES_REWORD)})?.querySelector('button[aria-label="Edit this note"]')?.click();`
        );
        await h.shot("cdp-shots/doc-review-notes-crowded.png");
        const open9 = s9.rows.filter((r) => r.open);
        rec(
            "9. the Crowded board: six notes in document order, one empty, one open, the list capped at 300 and the decisions scrolling above it",
            opened9 &&
                fresh9.items === DOC_NOTES_DECISIONS_CROWDED.length &&
                fresh9.rows.length === 0 &&
                s9.out.added.every(Boolean) &&
                docNotesJson(passages(s9)) === docNotesJson(DOC_NOTES_CROWDED.map(([passage]) => passage)) &&
                s9.rows.at(-1).note === DOC_NOTES_EMPTY &&
                open9.length === 1 &&
                open9[0].passage === DOC_NOTES_REWORD &&
                open9[0].input &&
                open9[0].note === DOC_NOTES_REWORD_NOTE &&
                s9.rows.filter((r) => r.input).length === 1 &&
                s9.list.client <= DOC_NOTES_LIST_CAP &&
                s9.list.scroll > s9.list.client &&
                s9.decisions.scroll > s9.decisions.client &&
                s9.quoted === DOC_NOTES_CROWDED.length &&
                has(s9, "Approve with 6 notes") &&
                has(s9, "Request changes · 6 notes"),
            docNotesBrief(s9, {
                opened: opened9,
                items: fresh9.items,
                startedWith: fresh9.rows.length,
                list: s9.list,
                decisions: s9.decisions,
            })
        );

        const openInput = `panel().querySelector('[data-doc-note-row][data-open="true"] input')`;
        const s10 = await docNotesAct(
            h,
            `type(${openInput}, ${docNotesJson(DOC_NOTES_REWORD_EDIT)});
            await settle();
            key(${openInput}, "Enter");`
        );
        const esc10 = await docNotesAct(
            h,
            `rowOf(${docNotesJson(DOC_NOTES_REWORD)})?.querySelector('button[aria-label="Edit this note"]')?.click();
            await settle();
            out = { reopened: !!${openInput} };
            key(${openInput}, "Escape");`
        );
        const reworded = (s) => s.rows.find((r) => r.passage === DOC_NOTES_REWORD)?.note;
        rec(
            "10. in the open row, Enter keeps the new note and closes the row, Escape closes it; neither sends nor hides the dialog",
            s10.open &&
                !s10.rows.some((r) => r.open) &&
                reworded(s10) === DOC_NOTES_REWORD_EDIT &&
                s10.sent == null &&
                esc10.out.reopened &&
                esc10.open &&
                !esc10.rows.some((r) => r.open) &&
                reworded(esc10) === DOC_NOTES_REWORD_EDIT &&
                esc10.sent == null,
            docNotesBrief(esc10, { afterEnter: s10.rows.map((r) => r.open), reopened: esc10.out.reopened })
        );

        const toggle = `panel().querySelector("[data-doc-notes-toggle]").click();`;
        const collapsed11 = await docNotesAct(h, toggle);
        const expanded11 = await docNotesAct(h, toggle);
        const remove = `panel().querySelector('[data-doc-note-row] button[aria-label="Remove this note"]')`;
        const five11 = await docNotesAct(h, `${remove}.click();`);
        const none11 = await docNotesAct(h, `for (let i = 0; i < 10 && ${remove}; i++) { ${remove}.click(); await settle(); }`);
        const kept = [DOC_NOTES_CROWDED[4], DOC_NOTES_CROWDED[1]];
        const two11 = await docNotesAct(h, `for (const [passage, note] of ${docNotesJson(kept)}) await addNote(passage, note);`);
        rec(
            "11. the header collapses and expands the list; removing a note drops its row and its highlight, removing all drops the section",
            collapsed11.expanded === "false" &&
                collapsed11.rows.length === 0 &&
                collapsed11.header === "Your notes · 6" &&
                expanded11.expanded === "true" &&
                expanded11.rows.length === 6 &&
                five11.rows.length === 5 &&
                five11.quoted === 5 &&
                has(five11, "Approve with 5 notes") &&
                none11.header == null &&
                none11.rows.length === 0 &&
                none11.quoted === 0 &&
                has(none11, "Approve") &&
                has(none11, "Request changes") &&
                docNotesJson(passages(two11)) === docNotesJson([DOC_NOTES_STAYS, DOC_NOTES_CUT]),
            docNotesBrief(two11, {
                collapsed: [collapsed11.expanded, collapsed11.rows.length],
                expanded: [expanded11.expanded, expanded11.rows.length],
                afterOne: [five11.rows.length, five11.quoted, five11.buttons],
                afterAll: [none11.header, none11.quoted, none11.buttons],
            })
        );

        const s12 = await docNotesAct(
            h,
            `button("Request changes · 2 notes")?.click();
            await settle();
            const area = panel().querySelector("#doc-review-note");
            const send = button("Send 2 notes to the lead");
            out = {
                label: panel().querySelector('label[for="doc-review-note"]')?.textContent ?? null,
                placeholder: area?.placeholder ?? null,
                value: area?.value ?? null,
                enabled: !!send && !send.disabled,
            };`
        );
        await h.shot("cdp-shots/doc-review-notes-request.png");
        const cancel12 = await docNotesAct(h, `button("Cancel")?.click();`);
        rec(
            "12. Request changes with notes: the textarea is optional and Send 2 notes is enabled while it is empty; Cancel returns",
            s12.out.label === "Anything beyond your 2 notes?" &&
                s12.out.placeholder === "Optional" &&
                s12.out.value === "" &&
                s12.out.enabled &&
                has(cancel12, "Approve with 2 notes") &&
                has(cancel12, "Request changes · 2 notes") &&
                cancel12.sent == null,
            docNotesBrief(cancel12, s12.out)
        );

        // ctrl+enter while the field holds a draft: the draft joins the notes, then the answer leaves
        const s13 = await docNotesAct(
            h,
            `select(${docNotesJson(DOC_NOTES_ORDER)});
            await settle();
            type(fieldInput(), ${docNotesJson(DOC_NOTES_CROWDED[3][1])});
            await settle();
            out = { focusInField: document.activeElement === fieldInput() };
            key(document.activeElement || document.body, "Enter", { ctrlKey: true });`
        );
        await h.shot("cdp-shots/doc-review-notes-sent.png");
        const locked13 = await docNotesAct(
            h,
            `for (const row of panel().querySelectorAll("[data-doc-note-row]")) {
                row.querySelector('button[aria-label="Edit this note"]')?.click();
                row.querySelector('button[aria-label="Remove this note"]')?.click();
            }
            await settle();
            select(${docNotesJson(DOC_NOTES_REWORD)});`
        );
        await h.ev("getSelection().removeAllRanges()");
        const order13 = docNotesJson([DOC_NOTES_STAYS, DOC_NOTES_ORDER, DOC_NOTES_CUT]);
        rec(
            "13. Ctrl+Enter with a draft in the field adds it and approves: the sent line counts 3 notes, the rows lock, a selection opens nothing",
            s13.out.focusInField &&
                s13.sent === "Sent: Approve, with 3 notes" &&
                s13.field == null &&
                docNotesJson(passages(s13)) === order13 &&
                s13.rows[1].note === DOC_NOTES_CROWDED[3][1] &&
                locked13.sent === s13.sent &&
                docNotesJson(passages(locked13)) === order13 &&
                locked13.rows.every((r) => r.locked && !r.remove && !r.open) &&
                locked13.field == null &&
                locked13.pending === 0,
            docNotesBrief(locked13, s13.out)
        );

        await docReviewEscape(h);
        await docReviewWait(h, `!${DOC_REVIEW_PANEL}`, 3000);
        return steps;
    },
    async teardown(h, ctx) {
        await teardownFixtureRun(h, ctx, "doc-review-notes");
    },
};

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

// --- shell-tasks: an idle agent with a background shell task still running reads standing by -----------
// docs/superpowers/plans/2026-10-12-shell-task-standing-by.md. A plain fixture agent, idle past the 5-minute grace
// window, whose transcript starts five Bash background tasks in the record shapes claude writes: four running (output
// with lines, an empty output, an output path that does not exist, output redirected to a /tmp log) and one failed,
// which is not listed: a task that ended is gone however it ended. Standing by is all that keeps its
// card on the grid, so finishing the four running tasks parks it in the Idle section. A second agent, idle a minute,
// holds one failed task and nothing running: its card is the plain Finished band with no chip. A third
// agent starts working with no tasks: steps 7-9 start a task and turn it idle right behind it, as a Stop does.
const SHELL_AGENT = { id: "fx-shell-tasks", name: "shell-tasks agent" };
const SHELL_FAILED_AGENT = { id: "fx-shell-failed", name: "shell-failed agent" };
const SHELL_STOP_AGENT = { id: "fx-shell-stop", name: "shell-stop agent" };
const SHELL_STOP_TASKS = [
    { id: "bshserve", description: "serve the preview", output: ["preview on :4173"] },
    { id: "bshwatch", description: "watch the preview build", output: [] },
];
const SHELL_TASKS = [
    { id: "bshlines", description: "tail the dev server log", output: ["vite v6 dev server", "ready on :5173", "GET / 200"] },
    { id: "bshempty", description: "watch the test suite", output: [] },
    { id: "bshgone", description: "poll the build queue", output: null },
    // its command sends stdout to a Git Bash /tmp file, so claude's own output file stays empty
    { id: "bshredir", description: "run the dev app into a log", output: ["dev app booting", "wavesrv ready"], redirect: true },
    {
        id: "bshfail",
        description: "run the migration check",
        output: ["checking 12 migrations", "migration 0042 is out of order", "[exited with code 1]"],
        failed: true,
    },
];
const SHELL_ONLY_FAILED = {
    id: "bshlint",
    description: "lint the changed files",
    output: ["2 problems", "[exited with code 1]"],
    failed: true,
};
const SHELL_RUNNING = SHELL_TASKS.filter((t) => !t.failed);
const SHELL_APPENDED_LINE = "GET /health 200";
const SHELL_LIB = `
    const until = async (fn, n = 80) => {
        for (let i = 0; i < n && !fn(); i++) {
            await new Promise((r) => setTimeout(r, 250));
        }
        return !!fn();
    };
    const text = (el) => (el?.innerText ?? "").replace(/\\s+/g, " ").trim();
    // the band label is uppercased by CSS, which innerText reports
    const band = (el) => text(el).toLowerCase();
    const card =(id) => document.querySelector('[data-cockpit-surface] [data-agent-id="' + id + '"]');
    const tree = () => document.querySelector("[data-agent-tree]");
    const treeRow = (name) => {
        const leaf = [...(tree()?.querySelectorAll("div") ?? [])].find(
            (d) => d.textContent.trim() === name && d.children.length === 0
        );
        return leaf ? leaf.closest(".cursor-pointer") : null;
    };
    const tasksChip = (name) => treeRow(name)?.querySelector('button[aria-label$="shell tasks"]') ?? null;
    const taskRow = (id) => tree()?.querySelector('[data-shell-task="' + id + '"]') ?? null;
    const taskRowIds = () => [...(tree()?.querySelectorAll("[data-shell-task]") ?? [])].map((r) => r.getAttribute("data-shell-task"));
    const peek = () => document.querySelector("[data-shell-task-peek]");
    // the first dot in a card header or a tree row is the agent's own
    const dot = (el) => {
        const d = el?.querySelector("span.rounded-full");
        return d ? { bg: d.style.backgroundColor, pulse: d.classList.contains("pulse-dot") } : null;
    };
    // the Agent surface header holds one dot, the focused agent's
    const header = () => document.querySelector("[data-agent-header]");
    const headerDot = () => ({
        name: text(header()).includes(${JSON.stringify(SHELL_AGENT.name)}),
        dot: dot(header()),
        pill: text(header()?.querySelector("[data-agent-state-pill]")),
    });
    const finishedRows = (name) =>
        [...(document.querySelector('aside[aria-label="Events"]')?.querySelectorAll('[role="button"]') ?? [])]
            .map(text)
            .filter((t) => t.includes(name) && t.includes("finished"));
`;

// the file a redirect task's command writes to: /tmp in Git Bash is the user's temp dir, which wavesrv resolves
function shellRedirectFile(task, outDir) {
    const name = `${basename(outDir)}-${task.id}.log`;
    return { shellPath: `/tmp/${name}`, path: join(tmpdir(), name) };
}

function shellTaskStart(task, outDir, timestamp) {
    const toolUseId = `toolu_${task.id}`;
    const command = task.redirect ? `./${task.id}.sh > ${shellRedirectFile(task, outDir).shellPath} 2>&1` : `./${task.id}.sh`;
    const use = {
        type: "assistant",
        timestamp,
        message: {
            role: "assistant",
            content: [
                {
                    type: "tool_use",
                    id: toolUseId,
                    name: "Bash",
                    input: { command, description: task.description, run_in_background: true },
                },
            ],
        },
    };
    const start = {
        type: "user",
        timestamp,
        message: {
            role: "user",
            content: [
                {
                    tool_use_id: toolUseId,
                    type: "tool_result",
                    content: `Command running in background with ID: ${task.id}. Output is being written to: ${join(outDir, `${task.id}.output`)}. You will be notified when it completes. To check interim output, use Read on that file path.`,
                    is_error: false,
                },
            ],
        },
        toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: task.id },
    };
    return [use, start];
}

// the queue-operation enqueue claude writes when a background task ends
function shellTaskFinish(task, outDir, status, summary) {
    return {
        type: "queue-operation",
        operation: "enqueue",
        timestamp: new Date().toISOString(),
        content: [
            "<task-notification>",
            `<task-id>${task.id}</task-id>`,
            `<tool-use-id>toolu_${task.id}</tool-use-id>`,
            `<output-file>${join(outDir, `${task.id}.output`)}</output-file>`,
            `<status>${status}</status>`,
            `<summary>${summary}</summary>`,
            "</task-notification>",
        ].join("\n"),
    };
}

function writeShellTranscript(cwd, name, tasks) {
    const started = new Date(Date.now() - 8 * 60_000).toISOString();
    const records = [{ type: "user", cwd, timestamp: started, message: { role: "user", content: `verify ${name}` } }];
    for (const t of tasks) {
        records.push(...shellTaskStart(t, cwd, started));
        const outFile = t.redirect ? shellRedirectFile(t, cwd).path : join(cwd, `${t.id}.output`);
        if (t.output != null) writeFileSync(outFile, t.output.map((l) => l + "\n").join(""));
        if (t.redirect) writeFileSync(join(cwd, `${t.id}.output`), "");
        if (t.failed) {
            records.push(shellTaskFinish(t, cwd, "failed", `Background command "${t.description}" failed with exit code 1`));
        }
    }
    const transcript = join(cwd, `${name}.jsonl`);
    writeFileSync(transcript, records.map((r) => JSON.stringify(r) + "\n").join(""));
    return transcript;
}

export const shellTasksScenario = {
    name: "shell-tasks",
    surface: "cockpit",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-shell-tasks-"));
        const ctx = { cwd, prevRail: await h.ev(`localStorage.getItem(${JSON.stringify(RAIL_VISIBLE_KEY)})`) };
        try {
            ctx.transcript = writeShellTranscript(cwd, "shell-tasks", SHELL_TASKS);
            const failedTranscript = writeShellTranscript(cwd, "shell-failed", [SHELL_ONLY_FAILED]);
            ctx.stopTranscript = writeShellTranscript(cwd, "shell-stop", []);
            const now = Date.now();
            const agent = (a, transcriptPath, idleSince, task) => ({
                id: a.id,
                name: a.name,
                project: "verify-shell-tasks",
                task,
                activity: task,
                state: "idle",
                idleSince,
                agent: "claude",
                model: "opus",
                blockId: `fx-blk-${a.id}`,
                transcriptPath,
            });
            mkdirSync(new URL(".", TREE_RAIL_FIXTURE), { recursive: true });
            writeFileSync(
                TREE_RAIL_FIXTURE,
                JSON.stringify(
                    [
                        // past IDLE_GRACE_MS: only standing by keeps this card on the grid
                        agent(SHELL_AGENT, ctx.transcript, now - 8 * 60_000, "start the dev server and stand by"),
                        agent(SHELL_FAILED_AGENT, failedTranscript, now - 60_000, "lint the changed files"),
                        { ...agent(SHELL_STOP_AGENT, ctx.stopTranscript, undefined, "build the preview"), state: "working" },
                    ],
                    null,
                    2
                )
            );
            ctx.wroteFixture = true;
            // the agent rail is off by default and persisted, and the fixture roster is read once at boot
            await h.ev(`localStorage.setItem(${JSON.stringify(RAIL_VISIBLE_KEY)}, "true")`);
            await h.ev("location.reload()");
            await h.ev(`(async () => {
                for (let i = 0; i < 60 && !document.querySelector("nav button"); i++) {
                    await new Promise((r) => setTimeout(r, 500));
                }
            })()`);
            await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
            await h.goto("cockpit");
            ctx.loaded = await h.ev(`(async () => {
                ${SHELL_LIB}
                const ok = await until(() => band(card(${JSON.stringify(SHELL_AGENT.id)})).includes("standing by"));
                return { ok, card: text(card(${JSON.stringify(SHELL_AGENT.id)})).slice(0, 300) };
            })()`);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const main = JSON.stringify(SHELL_AGENT.id);
        const mainName = JSON.stringify(SHELL_AGENT.name);
        rec(
            "0. the fixture agent idle past the grace window is on the grid, standing by",
            ctx.arrangeError == null && ctx.loaded?.ok === true,
            ctx.arrangeError ?? JSON.stringify(ctx.loaded)
        );
        if (ctx.arrangeError != null) return steps;

        const centerOf = (expr) =>
            h.ev(`(() => {
                ${SHELL_LIB}
                const el = ${expr};
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            })()`);

        // 1. Main: the card band, its still accent dot, and the chip's hover list
        const band = await h.ev(`(() => {
            ${SHELL_LIB}
            const c = card(${main});
            return {
                text: text(c),
                label: band(c),
                dot: dot(c),
                chip: text(c?.querySelector("[data-shell-tasks-chip]")),
                finished: finishedRows(${mainName}),
            };
        })()`);
        const chipAt = await centerOf(`card(${main})?.querySelector("[data-shell-tasks-chip]")`);
        if (chipAt) await h.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: chipAt.x, y: chipAt.y });
        const list = await h.ev(`(async () => {
            ${SHELL_LIB}
            const l = () => card(${main})?.querySelector("[data-shell-tasks-list]");
            await until(() => l() != null, 20);
            await new Promise((r) => setTimeout(r, 300));
            return text(l());
        })()`);
        await h.shot("cdp-shots/shell-tasks-main.png");
        await h.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 940 });
        rec(
            "1. Main: the card reads Standing by with 4 shell tasks running, its dot accent and still, the chip lists the four running and not the failed one, no finished event yet",
            band.label.includes("standing by") &&
                band.label.includes("4 shell tasks running") &&
                !band.label.includes("finished") &&
                band.dot?.bg === "var(--color-accent)" &&
                band.dot?.pulse === false &&
                band.chip === "4 shell tasks" &&
                SHELL_RUNNING.every((t) => list.includes(t.description)) &&
                !list.includes(SHELL_TASKS.find((t) => t.failed).description) &&
                band.finished.length === 0,
            JSON.stringify({ ...band, text: band.text.slice(0, 200), label: undefined, list })
        );

        const other = await h.ev(`(() => {
            ${SHELL_LIB}
            const c = card(${JSON.stringify(SHELL_FAILED_AGENT.id)});
            return { text: text(c), label: band(c), dot: dot(c), chip: text(c?.querySelector("[data-shell-tasks-chip]")) };
        })()`);
        rec(
            "1b. an idle agent with only a failed task shows the plain Finished band, a muted dot and no shell tasks chip",
            other.label.includes("finished") &&
                !other.label.includes("standing by") &&
                other.dot?.bg === "var(--color-muted)" &&
                other.dot?.pulse === false &&
                other.chip === "",
            JSON.stringify({ ...other, text: other.text.slice(0, 200), label: undefined })
        );

        // 2. TreeCollapsed: the tree row folded, no task rows
        await h.goto("agent");
        const folded = await h.ev(`(async () => {
            ${SHELL_LIB}
            if (!(await until(() => tasksChip(${mainName}) != null))) return { ok: false, why: "no shell tasks chip in the tree" };
            treeRow(${mainName}).click();
            if (tasksChip(${mainName}).getAttribute("aria-expanded") === "true") tasksChip(${mainName}).click();
            await until(() => taskRowIds().length === 0, 20);
            await new Promise((r) => setTimeout(r, 400));
            const chip = tasksChip(${mainName});
            await until(() => headerDot().name, 20);
            return {
                ok: true,
                chip: text(chip),
                expanded: chip.getAttribute("aria-expanded"),
                rows: taskRowIds(),
                dot: dot(treeRow(${mainName})),
                header: headerDot(),
            };
        })()`);
        await h.shot("cdp-shots/shell-tasks-tree-collapsed.png");
        rec(
            "2. TreeCollapsed: the row's chip reads 4 shell tasks, folded, with no task rows and a still accent dot",
            folded.ok === true &&
                folded.chip.includes("4 shell tasks") &&
                folded.expanded === "false" &&
                folded.rows.length === 0 &&
                folded.dot?.bg === "var(--color-accent)" &&
                folded.dot?.pulse === false,
            JSON.stringify(folded)
        );
        rec(
            "2b. the Agent surface header of the standing-by agent: an accent, still dot and a standing by pill",
            folded.header?.name === true &&
                folded.header.dot?.bg === "var(--color-accent)" &&
                folded.header.dot?.pulse === false &&
                folded.header.pill === "standing by",
            JSON.stringify(folded.header)
        );

        // 3. TreeExpanded: the four running tasks' rows, none for the failed one
        const expanded = await h.ev(`(async () => {
            ${SHELL_LIB}
            tasksChip(${mainName})?.click();
            await until(() => taskRowIds().length === ${SHELL_RUNNING.length}, 20);
            await new Promise((r) => setTimeout(r, 400));
            return {
                expanded: tasksChip(${mainName})?.getAttribute("aria-expanded"),
                rows: taskRowIds().map((id) => ({ id, lines: (taskRow(id)?.innerText ?? "").split("\\n").map((s) => s.trim()).filter(Boolean) })),
            };
        })()`);
        await h.shot("cdp-shots/shell-tasks-tree-expanded.png");
        const sub = (id) => expanded.rows.find((r) => r.id === id)?.lines[1] ?? "";
        rec(
            "3. TreeExpanded: four running task rows, and no row for the failed task",
            expanded.expanded === "true" &&
                expanded.rows.length === SHELL_RUNNING.length &&
                SHELL_RUNNING.every((t) => /^running · /.test(sub(t.id))) &&
                !expanded.rows.some((r) => r.id === "bshfail"),
            JSON.stringify(expanded)
        );

        // 3b. Kill: a row's X shows on hover; right-click offers its output and Kill task. The fixture block has
        // no live job, so the kill reaches wavesrv and comes back refused: a toast, and the row stays
        const killAt = await centerOf(`taskRow("bshlines")`);
        if (killAt) await h.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: killAt.x, y: killAt.y });
        const kill = await h.ev(`(async () => {
            ${SHELL_LIB}
            const x = () => taskRow("bshlines")?.querySelector("[data-shell-task-kill]");
            await until(() => x() != null && getComputedStyle(x()).opacity === "1", 20);
            const hovered = x() ? getComputedStyle(x()).opacity : null;
            const other = taskRow(${JSON.stringify(SHELL_RUNNING.find((t) => t.id !== "bshlines").id)})?.querySelector("[data-shell-task-kill]");
            const unhovered = other ? getComputedStyle(other).opacity : null;
            return { label: x()?.getAttribute("aria-label"), hovered, unhovered };
        })()`);
        await h.shot("cdp-shots/shell-tasks-kill-hover.png");
        const menu = await h.ev(`(async () => {
            ${SHELL_LIB}
            const r = taskRow("bshlines").getBoundingClientRect();
            taskRow("bshlines").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 10 }));
            const item = (label) => [...document.querySelectorAll("span.whitespace-nowrap")].find((el) => el.textContent === label)?.parentElement;
            await until(() => item("Kill task") != null, 20);
            return ["Show output", "Kill task"].filter((l) => item(l) != null);
        })()`);
        await h.shot("cdp-shots/shell-tasks-kill-menu.png");
        const killed = await h.ev(`(async () => {
            ${SHELL_LIB}
            const item = (label) => [...document.querySelectorAll("span.whitespace-nowrap")].find((el) => el.textContent === label)?.parentElement;
            item("Kill task")?.click();
            const toast = () => [...document.querySelectorAll("[data-notification-toast]")].find((t) => t.textContent.includes("Kill shell task"));
            await until(() => toast() != null, 40);
            const msg = text(toast());
            toast()?.click();
            return { toast: msg, rowStays: taskRow("bshlines") != null, menuClosed: item("Kill task") == null };
        })()`);
        rec(
            "3b. Kill: the X shows on the hovered row only; right-click offers Show output and Kill task; a refused kill toasts and keeps the row",
            kill.label === "Kill tail the dev server log" &&
                kill.hovered === "1" &&
                kill.unhovered === "0" &&
                menu.join(",") === "Show output,Kill task" &&
                killed.toast?.includes("Not killed") &&
                killed.rowStays === true &&
                killed.menuClosed === true,
            JSON.stringify({ kill, menu, killed })
        );

        // 4. Interactive: the output opens in a peek beside the tree, re-reads live, and every way it closes
        const clickRow = (id) =>
            h.ev(`(async () => {
                ${SHELL_LIB}
                taskRow(${JSON.stringify(id)})?.click();
                await new Promise((r) => setTimeout(r, 400));
            })()`);
        const peekState = (id, want) =>
            h.ev(`(async () => {
                ${SHELL_LIB}
                const want = ${JSON.stringify(want ?? null)};
                await until(() => peek()?.getAttribute("data-shell-task-peek") === ${JSON.stringify(id)} && (want == null || text(peek()).includes(want)), 40);
                await new Promise((r) => setTimeout(r, 300));
                const p = peek();
                if (!p) return null;
                const lines = p.innerText.split("\\n").map((s) => s.trim()).filter(Boolean);
                return {
                    id: p.getAttribute("data-shell-task-peek"),
                    text: text(p),
                    state: text(p.querySelector("[data-shell-task-state]")),
                    footer: lines.at(-1) ?? "",
                    besideTree: p.getBoundingClientRect().left >= (tree()?.getBoundingClientRect().right ?? Infinity),
                    headerShown: header()?.checkVisibility() === true,
                    rowOpen: taskRow(${JSON.stringify(id)})?.classList.contains("bg-accentbg") ?? false,
                };
            })()`);
        const peekGone = () =>
            h.ev(`(async () => {
                ${SHELL_LIB}
                return await until(() => peek() == null, 20);
            })()`);
        // Escape where the user's focus is, so the keybinding dispatcher's window listener sees it as a keypress
        const escape = () =>
            h.ev(`(document.activeElement || document.body).dispatchEvent(
                new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })
            )`);
        const closeButton = () => h.ev(`document.querySelector('[data-shell-task-peek] button[aria-label="Close output"]')?.click()`);

        await clickRow("bshlines");
        const lines = await peekState("bshlines", "ready on :5173");
        await h.shot("cdp-shots/shell-tasks-peek-lines.png");
        rec(
            "4a. Interactive: the running task's output opens in a peek beside the tree, the terminal still showing, state running, footer last 64 KB · live, its row highlighted",
            lines?.id === "bshlines" &&
                SHELL_TASKS[0].output.every((l) => lines.text.includes(l)) &&
                lines.state === "running" &&
                lines.footer.endsWith("last 64 KB · live") &&
                lines.besideTree === true &&
                lines.headerShown === true &&
                lines.rowOpen === true,
            JSON.stringify(lines)
        );

        appendFileSync(join(ctx.cwd, "bshlines.output"), SHELL_APPENDED_LINE + "\n");
        const live = await peekState("bshlines", SHELL_APPENDED_LINE);
        rec(
            "4b. a line appended to a running task's output appears in the open peek",
            live?.text.includes(SHELL_APPENDED_LINE) === true,
            JSON.stringify(live?.text)
        );

        await clickRow("bshlines");
        const toggled = await peekGone();
        await clickRow("bshlines");
        await peekState("bshlines");
        await closeButton();
        const closed = await peekGone();
        await clickRow("bshlines");
        await peekState("bshlines");
        await escape();
        const escaped = await peekGone();
        // Esc closes only the peek: agent:back would have left the Agent surface for Cockpit
        const stayed = await h.ev(`(() => { ${SHELL_LIB} return tree()?.checkVisibility() === true; })()`);
        await clickRow("bshlines");
        await peekState("bshlines");
        // the peek dismisses on pointerdown, so a real press: on the agent's own row, outside the peek and its task row
        const outside = await centerOf(`treeRow(${JSON.stringify(SHELL_AGENT.name)})`);
        if (outside) {
            await h.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: outside.x, y: outside.y });
            for (const type of ["mousePressed", "mouseReleased"]) {
                await h.cdp("Input.dispatchMouseEvent", { type, x: outside.x, y: outside.y, button: "left", clickCount: 1 });
            }
        }
        const pressedOut = await peekGone();
        await clickRow("bshlines");
        await peekState("bshlines");
        const folding = await h.ev(`(async () => {
            ${SHELL_LIB}
            tasksChip(${mainName})?.click();
            const gone = await until(() => peek() == null, 20);
            tasksChip(${mainName})?.click();
            await until(() => taskRowIds().length === ${SHELL_RUNNING.length}, 20);
            await new Promise((r) => setTimeout(r, 400));
            return gone;
        })()`);
        // the Agent surface stays mounted off-screen, so a peek left open would float over the next surface
        await clickRow("bshlines");
        await peekState("bshlines");
        await h.goto("cockpit");
        const leftSurface = await peekGone();
        await h.goto("agent");
        const notBack = await h.ev(`(async () => {
            ${SHELL_LIB}
            await new Promise((r) => setTimeout(r, 600));
            return peek() == null;
        })()`);
        rec(
            "4c. the peek closes on re-clicking its row, the close button, Esc (staying on Agent), a press outside, folding the chip, and leaving the surface",
            toggled && closed && escaped && stayed && pressedOut && folding && leftSurface && notBack,
            JSON.stringify({ toggled, closed, escaped, stayed, pressedOut, folding, leftSurface, notBack })
        );

        await clickRow("bshempty");
        const empty = await peekState("bshempty", "No output yet.");
        await h.shot("cdp-shots/shell-tasks-peek-empty.png");
        rec(
            "4d. the empty task's peek reads No output yet. (running, live)",
            empty?.text.includes("No output yet.") === true &&
                empty.state === "running" &&
                empty.footer.endsWith("last 64 KB · live"),
            JSON.stringify(empty)
        );

        // 5. a missing output file reads as no output, not an error
        await clickRow("bshgone");
        const gone = await peekState("bshgone", "No output yet.");
        await h.shot("cdp-shots/shell-tasks-peek-missing.png");
        rec(
            "5. the task whose output file does not exist reads No output yet., with no error text",
            gone?.text.includes("No output yet.") === true && !/error|enoent|no such file|cannot|failed/i.test(gone.text),
            JSON.stringify(gone)
        );

        // 5a. a command that redirects its stdout leaves claude's output file empty; the peek reads the redirect target
        const redirTask = SHELL_TASKS.find((t) => t.redirect);
        await clickRow(redirTask.id);
        const redir = await peekState(redirTask.id, redirTask.output.at(-1));
        await h.shot("cdp-shots/shell-tasks-peek-redirect.png");
        rec(
            "5a. the task whose command redirects to a /tmp log shows that log's lines, not No output yet. (running)",
            redir != null &&
                redirTask.output.every((l) => redir.text.includes(l)) &&
                !redir.text.includes("No output yet.") &&
                redir.state === "running",
            JSON.stringify(redir)
        );
        await closeButton();
        await peekGone();

        const resume = await h.ev(`(async () => {
            ${SHELL_LIB}
            const rail = () => document.querySelector('aside[aria-label="Agent details"]');
            await until(() => text(rail()).includes(${mainName}), 20);
            return { rail: rail() != null, resume: [...(rail()?.querySelectorAll("button") ?? [])].some((b) => text(b) === "Resume") };
        })()`);
        rec(
            "5b. the agent details rail offers no Resume nudge while the agent stands by",
            resume.rail === true && resume.resume === false,
            JSON.stringify(resume)
        );

        // 6. Finish: the three running tasks end; standing by ends and the card parks in the Idle section
        await h.goto("cockpit");
        appendFileSync(
            ctx.transcript,
            SHELL_RUNNING.map((t) => JSON.stringify(shellTaskFinish(t, ctx.cwd, "completed", "completed (exit code 0)")) + "\n").join("")
        );
        const parked = await h.ev(`(async () => {
            ${SHELL_LIB}
            // the 5s poll is what reads the finish records of an idle agent
            const left = await until(() => card(${main}) == null, 120);
            const idleName = () =>
                [...(document.querySelector("[data-cockpit-surface]")?.querySelectorAll("b") ?? [])].some((b) => text(b) === ${mainName});
            if (!idleName()) {
                const header = [...(document.querySelector("[data-cockpit-surface]")?.querySelectorAll("h2") ?? [])].find((e) => e.textContent.trim() === "Idle");
                header?.click();
            }
            const listed = await until(idleName, 20);
            await until(() => finishedRows(${mainName}).length > 0, 20);
            await new Promise((r) => setTimeout(r, 800));
            return { left, listed, finished: finishedRows(${mainName}) };
        })()`);
        await h.shot("cdp-shots/shell-tasks-finished.png");
        rec(
            "6. Finish: the card leaves the grid for the Idle section, with exactly one finished event tagged idle",
            parked.left === true &&
                parked.listed === true &&
                parked.finished.length === 1 &&
                /\bidle\b/.test(parked.finished[0]),
            JSON.stringify(parked)
        );


        await h.goto("agent");
        const after = await h.ev(`(async () => {
            ${SHELL_LIB}
            await until(() => treeRow(${mainName}) != null, 20);
            if (!headerDot().name) treeRow(${mainName})?.click();
            await until(() => tasksChip(${mainName}) == null, 20);
            await until(() => headerDot().name, 20);
            await new Promise((r) => setTimeout(r, 600));
            return {
                chip: tasksChip(${mainName}) == null ? null : text(tasksChip(${mainName})),
                rows: taskRowIds().filter((id) => ${JSON.stringify(SHELL_TASKS.map((t) => t.id))}.includes(id)),
                dot: dot(treeRow(${mainName})),
                header: headerDot(),
            };
        })()`);
        await h.shot("cdp-shots/shell-tasks-tree-finished.png");
        rec(
            "6b. the tree has no shell tasks chip and no task rows, and the dot is no longer accent",
            after.chip === null &&
                after.rows.length === 0 &&
                after.dot != null &&
                after.dot.bg !== "var(--color-accent)" &&
                after.dot.pulse === false,
            JSON.stringify(after)
        );
        rec(
            "6c. after the finish the Agent surface header dot is no longer accent and its pill reads idle",
            after.header?.name === true &&
                after.header.dot != null &&
                after.header.dot.bg !== "var(--color-accent)" &&
                after.header.pill === "idle",
            JSON.stringify(after.header)
        );

        // 7. A Stop right behind a background start: the agent turns idle before the shell-task read lands, and
        // the hold keeps the card and the rail from playing a finish in between. The observer sees every commit.
        const stop = JSON.stringify(SHELL_STOP_AGENT.id);
        const stopName = JSON.stringify(SHELL_STOP_AGENT.name);
        const startTask = (t) => {
            writeFileSync(join(ctx.cwd, `${t.id}.output`), t.output.map((l) => l + "\n").join(""));
            const recs = shellTaskStart(t, ctx.cwd, new Date().toISOString());
            appendFileSync(ctx.stopTranscript, recs.map((r) => JSON.stringify(r) + "\n").join(""));
        };
        const SETTLE = `'[class*="animate-[settle"]'`;
        await h.goto("cockpit");
        startTask(SHELL_STOP_TASKS[0]);
        const stopped = await h.ev(`(async () => {
            ${SHELL_LIB}
            const fx = window.__cockpitRosterFixture;
            if (fx == null) return { ok: false, why: "no __cockpitRosterFixture seam" };
            if (!(await until(() => card(${stop}) != null, 40))) return { ok: false, why: "no card for the working agent" };
            const bands = new Set();
            let settled = false;
            const look = () => {
                const c = card(${stop});
                if (c == null) return;
                const b = band(c);
                bands.add(b.includes("standing by") ? "standing by" : b.includes("finished") ? "finished" : "other");
                if (c.matches(${SETTLE}) || c.querySelector(${SETTLE})) settled = true;
            };
            const mo = new MutationObserver(look);
            mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
            fx.patch(${stop}, { state: "idle", idleSince: Date.now() });
            const standing = await until(() => band(card(${stop})).includes("standing by"), 40);
            await new Promise((r) => setTimeout(r, 1500));
            mo.disconnect();
            look();
            return { ok: true, standing, bands: [...bands], settled, finished: finishedRows(${stopName}) };
        })()`);
        await h.shot("cdp-shots/shell-tasks-stop-standing.png");
        rec(
            "7. a Stop right behind a background start goes straight to standing by: no Finished band, no settle, no finished event",
            stopped.ok === true &&
                stopped.standing === true &&
                !stopped.bands.includes("finished") &&
                stopped.settled === false &&
                stopped.finished.length === 0,
            JSON.stringify(stopped)
        );

        // 8. Its task ends inside the idle grace window: the card stays on the grid and its band returns to Finished
        appendFileSync(
            ctx.stopTranscript,
            JSON.stringify(shellTaskFinish(SHELL_STOP_TASKS[0], ctx.cwd, "completed", "completed (exit code 0)")) + "\n"
        );
        const regraced = await h.ev(`(async () => {
            ${SHELL_LIB}
            const finishedBand = () => band(card(${stop})).includes("finished") && !band(card(${stop})).includes("standing by");
            // the 5s poll is what reads the finish record of an idle agent
            const back = await until(finishedBand, 120);
            await until(() => finishedRows(${stopName}).length > 0, 20);
            await new Promise((r) => setTimeout(r, 800));
            return { back, band: band(card(${stop})).slice(0, 200), finished: finishedRows(${stopName}) };
        })()`);
        await h.shot("cdp-shots/shell-tasks-stop-finished.png");
        rec(
            "8. the task ending inside the grace window returns the card's band to Finished, with exactly one finished event",
            regraced.back === true && regraced.finished.length === 1,
            JSON.stringify(regraced)
        );

        // 9. The same Stop race on the Agent surface: neither the tree row nor the header pill settles before the read
        await h.goto("agent");
        const working = await h.ev(`(async () => {
            ${SHELL_LIB}
            window.__cockpitRosterFixture?.patch(${stop}, { state: "working", idleSince: undefined });
            if (!(await until(() => treeRow(${stopName}) != null, 40))) return { ok: false, why: "no tree row" };
            treeRow(${stopName}).click();
            return { ok: await until(() => text(header()).includes(${stopName}), 20) };
        })()`);
        startTask(SHELL_STOP_TASKS[1]);
        const treeStop = working.ok
            ? await h.ev(`(async () => {
                  ${SHELL_LIB}
                  let row = false;
                  let pill = false;
                  const look = () => {
                      if (treeRow(${stopName})?.matches(${SETTLE})) row = true;
                      if (header()?.querySelector("[data-agent-state-pill]")?.matches(${SETTLE})) pill = true;
                  };
                  const mo = new MutationObserver(look);
                  mo.observe(document.body, { subtree: true, childList: true, attributes: true });
                  window.__cockpitRosterFixture.patch(${stop}, { state: "idle", idleSince: Date.now() });
                  const standing = await until(() => dot(treeRow(${stopName}))?.bg === "var(--color-accent)", 40);
                  await new Promise((r) => setTimeout(r, 1500));
                  mo.disconnect();
                  look();
                  return {
                      ok: true,
                      standing,
                      rowSettled: row,
                      pillSettled: pill,
                      pill: text(header()?.querySelector("[data-agent-state-pill]")),
                  };
              })()`)
            : working;
        await h.shot("cdp-shots/shell-tasks-stop-tree.png");
        rec(
            "9. on the Agent surface the same Stop settles neither the tree row nor the header pill, which reads standing by",
            treeStop.ok === true &&
                treeStop.standing === true &&
                treeStop.rowSettled === false &&
                treeStop.pillSettled === false &&
                treeStop.pill === "standing by",
            JSON.stringify(treeStop)
        );
        return steps;
    },
    async teardown(h, ctx) {
        // teardownFixtureRun removes the fixture roster, reloads onto the live roster and deletes the temp dir with
        // the transcripts and output files; a redirect task's log sits outside it
        for (const t of SHELL_TASKS.filter((t) => t.redirect)) rmSync(shellRedirectFile(t, ctx.cwd).path, { force: true });
        await teardownFixtureRun(h, ctx, "shell-tasks", {
            what: "restore the rail's visibility",
            fn: () => h.ev(restoreLocalStorage(RAIL_VISIBLE_KEY, ctx.prevRail)),
        });
    },
};

// --- monitor-tasks: Claude Code Monitor tasks beside shell tasks in the Agent tree, the peek and the card ----------
// docs/superpowers/plans/2026-10-27-monitor-tasks.md, boards Main / PeekOutput / PeekEmpty. Two fixture agents idle
// past the grace window: one with a shell task, two live monitors and three that ended (expired, stream ended,
// TaskStop), which must not list; one with a persistent monitor. Only standing by keeps their cards on the grid.
const MONITOR_AGENT = { id: "fx-monitor-tasks", name: "monitor-tasks agent" };
const MONITOR_PERSIST_AGENT = { id: "fx-monitor-persistent", name: "monitor-persistent agent" };
const MIN = 60_000;
const MONITOR_SHELL = { id: "bmtshell", description: "serve the preview", output: ["preview on :4173"] };
const MONITOR_STRAY_LINE = "grep: warning: stray \\ before -";
const MONITORS = [
    {
        id: "bmtevents",
        description: "final-verify PASS/FAIL lines",
        command: 'tail -f final-verify.log | grep --line-buffered -E "PASS|FAIL\\-"',
        startedAgo: 12 * MIN,
        timeoutMs: 30 * MIN,
        events: [
            { ago: 10 * MIN, lines: ["PASS surface-smoke"] },
            { ago: 7 * MIN, lines: ["FAIL shell-tasks", "3b. Kill: the X shows on the hovered row only"] },
            { ago: 4 * MIN, lines: ["PASS shell-tasks"] },
            { ago: 1.5 * MIN, lines: ["PASS monitor-tasks"] },
        ],
        output: "stray",
    },
    {
        id: "bmtquiet",
        description: "errors in waveapp.log",
        command: 'tail -f waveapp.log | grep --line-buffered "error"',
        startedAgo: 2 * MIN,
        timeoutMs: 30 * MIN,
        events: [],
        output: "empty",
    },
    {
        id: "bmtexpired",
        description: "tail the old build log",
        command: "tail -f build.log",
        startedAgo: 40 * MIN,
        timeoutMs: 30 * MIN,
        events: [],
    },
    {
        id: "bmtended",
        description: "watch the deploy stream",
        command: "./deploy-stream.sh",
        startedAgo: 35 * MIN,
        timeoutMs: 60 * MIN,
        events: [],
        endedAgo: 30 * MIN,
    },
    {
        id: "bmtstopped",
        description: "poll the review queue",
        command: "./review-queue.sh",
        startedAgo: 25 * MIN,
        timeoutMs: 60 * MIN,
        events: [],
        stoppedAgo: 20 * MIN,
    },
];
const MONITOR_LIVE = MONITORS.filter((m) => m.output != null);
const MONITOR_GONE = MONITORS.filter((m) => m.output == null);
const MONITOR_PERSIST = {
    id: "bmtpersist",
    description: "watch the CI queue",
    command: "./ci-queue.sh",
    startedAgo: 45 * MIN,
    timeoutMs: 30 * MIN,
    persistent: true,
    events: [
        { ago: 30 * MIN, lines: ["build 812 queued"] },
        { ago: 3 * MIN, lines: ["build 813 queued"] },
    ],
};
const MONITOR_LIB = `
    // the agent row's fold chip for its task list, whatever kinds it holds
    const chip = (name) =>
        [...(treeRow(name)?.querySelectorAll("button[aria-label]") ?? [])].find((b) =>
            /^(Show|Hide) (shell tasks|monitors|tasks)$/.test(b.getAttribute("aria-label"))
        ) ?? null;
    const sub = (id) => text(taskRow(id)?.querySelector("[data-task-sub]"));
    const left = (id) => taskRow(id)?.querySelector("[data-monitor-left]") ?? null;
    const mark = (id) => taskRow(id)?.querySelector("svg[aria-label]")?.getAttribute("aria-label") ?? null;
    const tab = (name) => peek()?.querySelector('[data-peek-tab="' + name + '"]') ?? null;
    const footer = () => text(peek()?.querySelector("[data-peek-footer]"));
    const menuItem = (label) =>
        [...document.querySelectorAll("span.whitespace-nowrap")].find((el) => el.textContent === label)?.parentElement;
`;

// claude writes a monitor's output under its temp dir, keyed by the transcript's project dir and session
function monitorOutFile(transcript, id) {
    return join(tmpdir(), "claude", basename(dirname(transcript)), basename(transcript, ".jsonl"), "tasks", `${id}.output`);
}

function monitorNotification(m, body) {
    return [
        "<task-notification>",
        `<task-id>${m.id}</task-id>`,
        `<summary>Monitor event: "${m.description}"</summary>`,
        `<event>${body}</event>`,
        "If this event is something the user would act on now, send a PushNotification. Routine or benign output doesn't need one.",
        "</task-notification>",
    ].join("\n");
}

// the assistant Monitor tool_use and the user record of its start result
function monitorTaskStart(m, now) {
    const toolUseId = `toolu_${m.id}`;
    const timestamp = new Date(now - m.startedAgo).toISOString();
    const input = { description: m.description, timeout_ms: m.timeoutMs, command: m.command };
    if (m.persistent) input.persistent = true;
    const use = {
        type: "assistant",
        timestamp,
        message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "Monitor", input }] },
    };
    const start = {
        type: "user",
        timestamp,
        message: {
            role: "user",
            content: [
                {
                    tool_use_id: toolUseId,
                    type: "tool_result",
                    content: `Monitor started (task ${m.id}, expires in ${m.timeoutMs / MIN}m unless the source ends first; events arrive as notifications.)`,
                },
            ],
        },
        toolUseResult: { taskId: m.id, timeoutMs: m.timeoutMs, persistent: m.persistent === true },
    };
    return [use, start];
}

// every event is written twice: the queue-operation enqueue, then the user record a turn delivers it in
function monitorEvent(m, ev, now) {
    const content = monitorNotification(m, ev.lines.join("\n"));
    return [
        { type: "queue-operation", operation: "enqueue", timestamp: new Date(now - ev.ago).toISOString(), content },
        { type: "user", timestamp: new Date(now - ev.ago + 1000).toISOString(), message: { role: "user", content } },
    ];
}

// a stream-ended notification, or the TaskStop tool_use and its success result
function monitorEnd(m, transcript, now) {
    if (m.stoppedAgo != null) {
        const timestamp = new Date(now - m.stoppedAgo).toISOString();
        const toolUseId = `toolu_stop_${m.id}`;
        const message = `Successfully stopped task: ${m.id} (${m.command})`;
        return [
            {
                type: "assistant",
                timestamp,
                message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "TaskStop", input: { task_id: m.id } }] },
            },
            {
                type: "user",
                timestamp,
                message: {
                    role: "user",
                    content: [{ tool_use_id: toolUseId, type: "tool_result", content: JSON.stringify({ message, task_id: m.id }) }],
                },
                toolUseResult: { message, task_id: m.id, command: m.command },
            },
        ];
    }
    return [
        {
            type: "queue-operation",
            operation: "enqueue",
            timestamp: new Date(now - m.endedAgo).toISOString(),
            content: [
                "<task-notification>",
                `<task-id>${m.id}</task-id>`,
                `<tool-use-id>toolu_${m.id}</tool-use-id>`,
                `<output-file>${monitorOutFile(transcript, m.id)}</output-file>`,
                "<status>completed</status>",
                `<summary>Monitor "${m.description}" stream ended</summary>`,
                "</task-notification>",
            ].join("\n"),
        },
    ];
}

function writeMonitorTranscript(cwd, name, shellTasks, monitors) {
    const now = Date.now();
    const transcript = join(cwd, `${name}.jsonl`);
    const records = [];
    for (const t of shellTasks) {
        records.push(...shellTaskStart(t, cwd, new Date(now - 14 * MIN).toISOString()));
        writeFileSync(join(cwd, `${t.id}.output`), t.output.map((l) => l + "\n").join(""));
    }
    for (const m of monitors) {
        records.push(...monitorTaskStart(m, now));
        for (const ev of m.events) records.push(...monitorEvent(m, ev, now));
        if (m.endedAgo != null || m.stoppedAgo != null) records.push(...monitorEnd(m, transcript, now));
        if (m.output != null) {
            const out = monitorOutFile(transcript, m.id);
            mkdirSync(dirname(out), { recursive: true });
            const lines = m.output === "stray" ? [MONITOR_STRAY_LINE, ...m.events.flatMap((e) => e.lines)] : [];
            writeFileSync(out, lines.map((l) => l + "\n").join(""));
        }
    }
    // a real transcript is in time order; the shell task's start lands between the monitors'
    records.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const first = { type: "user", cwd, timestamp: new Date(now - 50 * MIN).toISOString(), message: { role: "user", content: `verify ${name}` } };
    writeFileSync(transcript, [first, ...records].map((r) => JSON.stringify(r) + "\n").join(""));
    return transcript;
}

export const monitorTasksScenario = {
    name: "monitor-tasks",
    surface: "cockpit",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-monitor-tasks-"));
        const ctx = { cwd, prevRail: await h.ev(`localStorage.getItem(${JSON.stringify(RAIL_VISIBLE_KEY)})`) };
        try {
            ctx.transcript = writeMonitorTranscript(cwd, "monitor-tasks", [MONITOR_SHELL], MONITORS);
            const persistTranscript = writeMonitorTranscript(cwd, "monitor-persistent", [], [MONITOR_PERSIST]);
            const now = Date.now();
            const agent = (a, transcriptPath, task) => ({
                id: a.id,
                name: a.name,
                project: "verify-monitor-tasks",
                task,
                activity: task,
                state: "idle",
                // past IDLE_GRACE_MS: only standing by keeps these cards on the grid
                idleSince: now - 8 * MIN,
                agent: "claude",
                model: "opus",
                blockId: `fx-blk-${a.id}`,
                transcriptPath,
            });
            mkdirSync(new URL(".", TREE_RAIL_FIXTURE), { recursive: true });
            writeFileSync(
                TREE_RAIL_FIXTURE,
                JSON.stringify(
                    [
                        agent(MONITOR_AGENT, ctx.transcript, "watch final-verify and stand by"),
                        agent(MONITOR_PERSIST_AGENT, persistTranscript, "watch the CI queue"),
                    ],
                    null,
                    2
                )
            );
            ctx.wroteFixture = true;
            // the agent rail is off by default and persisted, and the fixture roster is read once at boot
            await h.ev(`localStorage.setItem(${JSON.stringify(RAIL_VISIBLE_KEY)}, "true")`);
            await h.ev("location.reload()");
            await h.ev(`(async () => {
                for (let i = 0; i < 60 && !document.querySelector("nav button"); i++) {
                    await new Promise((r) => setTimeout(r, 500));
                }
            })()`);
            await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
            await h.goto("cockpit");
            ctx.loaded = await h.ev(`(async () => {
                ${SHELL_LIB}
                const ok = await until(() =>
                    ${JSON.stringify([MONITOR_AGENT.id, MONITOR_PERSIST_AGENT.id])}.every((id) => band(card(id)).includes("standing by"))
                );
                return { ok, card: text(card(${JSON.stringify(MONITOR_AGENT.id)})).slice(0, 300) };
            })()`);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const mainName = JSON.stringify(MONITOR_AGENT.name);
        const persistName = JSON.stringify(MONITOR_PERSIST_AGENT.name);
        const liveIds = [MONITOR_SHELL.id, ...MONITOR_LIVE.map((m) => m.id)];
        rec(
            "0. both fixture agents idle past the grace window are on the grid, standing by",
            ctx.arrangeError == null && ctx.loaded?.ok === true,
            ctx.arrangeError ?? JSON.stringify(ctx.loaded)
        );
        if (ctx.arrangeError != null) return steps;

        const centerOf = (expr) =>
            h.ev(`(() => {
                ${SHELL_LIB}
                ${MONITOR_LIB}
                const el = ${expr};
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            })()`);
        const hover = async (expr) => {
            const at = await centerOf(expr);
            if (at) await h.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
            return at;
        };
        const unhover = () => h.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 940 });

        // 1. Main: one list under the agent, shell task first, the ended monitors gone, both agents standing by
        await h.goto("agent");
        const rows = await h.ev(`(async () => {
            ${SHELL_LIB}
            ${MONITOR_LIB}
            const ids = ${JSON.stringify(liveIds)};
            const all = ${JSON.stringify([...liveIds, ...MONITOR_GONE.map((m) => m.id)])};
            await until(() => chip(${mainName}) != null && ids.every((id) => taskRow(id) != null));
            await new Promise((r) => setTimeout(r, 400));
            const c = chip(${mainName});
            return {
                chip: text(c),
                expanded: c?.getAttribute("aria-expanded") ?? null,
                rows: taskRowIds().filter((id) => all.includes(id)),
                kinds: ids.map((id) => taskRow(id)?.getAttribute("data-task-kind") ?? null),
                marks: ids.map(mark),
                // the title tooltip host parks a hovered element's title in data-arc-title
                titles: ids.map((id) => taskRow(id)?.getAttribute("title") ?? taskRow(id)?.getAttribute("data-arc-title") ?? null),
                subs: Object.fromEntries(ids.map((id) => [id, sub(id)])),
                left: ids.slice(1).map((id) => text(left(id))),
                dots: [dot(treeRow(${mainName})), dot(treeRow(${persistName}))],
            };
        })()`);
        await h.shot("cdp-shots/monitor-tasks-1.png");
        rec(
            "1. Main: the chip reads 3 tasks, open; rows bmtshell, bmtevents, bmtquiet with Terminal / Radio marks and their commands as titles; the expired, ended and stopped monitors are absent; both agents' dots accent",
            rows.chip === "3 tasks" &&
                rows.expanded === "true" &&
                rows.rows.join(",") === liveIds.join(",") &&
                rows.kinds.join(",") === "shell,monitor,monitor" &&
                rows.marks.join(",") === "Shell task,Monitor,Monitor" &&
                rows.titles.join("\n") === [`./${MONITOR_SHELL.id}.sh`, ...MONITOR_LIVE.map((m) => m.command)].join("\n") &&
                rows.subs.bmtevents.startsWith("4 events ·") &&
                rows.subs.bmtquiet.startsWith("no events yet ·") &&
                rows.left.every((l) => /^(\d+m|<1m) left$/.test(l)) &&
                rows.dots.every((d) => d?.bg === "var(--color-accent)"),
            JSON.stringify(rows)
        );

        // 2. Persistent and folded: no time left on a persistent monitor; the chip folds and unfolds its rows
        const persist = await h.ev(`(async () => {
            ${SHELL_LIB}
            ${MONITOR_LIB}
            const id = ${JSON.stringify(MONITOR_PERSIST.id)};
            await until(() => chip(${persistName}) != null && taskRow(id) != null);
            const before = { chip: text(chip(${persistName})), sub: sub(id), left: left(id) != null };
            chip(${persistName})?.click();
            await until(() => taskRow(id) == null, 20);
            await new Promise((r) => setTimeout(r, 400));
            const folded = {
                expanded: chip(${persistName})?.getAttribute("aria-expanded") ?? null,
                label: chip(${persistName})?.getAttribute("aria-label") ?? null,
                row: taskRow(id) != null,
            };
            return { before, folded };
        })()`);
        await h.shot("cdp-shots/monitor-tasks-2.png");
        const unfolded = await h.ev(`(async () => {
            ${SHELL_LIB}
            ${MONITOR_LIB}
            const id = ${JSON.stringify(MONITOR_PERSIST.id)};
            chip(${persistName})?.click();
            await until(() => taskRow(id) != null, 20);
            return { expanded: chip(${persistName})?.getAttribute("aria-expanded") ?? null, row: taskRow(id) != null };
        })()`);
        rec(
            "2. Persistent: the chip reads 1 monitor, the row reads persistent · 2 events with no time left; the chip folds (Show monitors, rows gone) and unfolds",
            persist.before.chip === "1 monitor" &&
                persist.before.sub.startsWith("persistent · 2 events") &&
                persist.before.left === false &&
                persist.folded.expanded === "false" &&
                persist.folded.label === "Show monitors" &&
                persist.folded.row === false &&
                unfolded.expanded === "true" &&
                unfolded.row === true,
            JSON.stringify({ persist, unfolded })
        );

        // 3. Stop: the hovered monitor's X and menu use the monitor copy. The fixture block has no live job, so the
        // stop reaches wavesrv and comes back refused: a toast, and the row stays
        await hover(`taskRow("bmtquiet")`);
        const stopX = await h.ev(`(async () => {
            ${SHELL_LIB}
            const x = () => taskRow("bmtquiet")?.querySelector("[data-shell-task-kill]");
            await until(() => x() != null && getComputedStyle(x()).opacity === "1", 20);
            return {
                label: x()?.getAttribute("aria-label") ?? null,
                title: x()?.getAttribute("title") ?? x()?.getAttribute("data-arc-title") ?? null,
                opacity: x() ? getComputedStyle(x()).opacity : null,
            };
        })()`);
        await h.shot("cdp-shots/monitor-tasks-3.png");
        const menu = await h.ev(`(async () => {
            ${SHELL_LIB}
            ${MONITOR_LIB}
            const r = taskRow("bmtquiet").getBoundingClientRect();
            taskRow("bmtquiet").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 10 }));
            await until(() => menuItem("Stop monitor") != null, 20);
            return ["Show output", "Hide output", "Stop monitor", "Kill task"].filter((l) => menuItem(l) != null);
        })()`);
        const stopped = await h.ev(`(async () => {
            ${SHELL_LIB}
            ${MONITOR_LIB}
            menuItem("Stop monitor")?.click();
            const toast = () => [...document.querySelectorAll("[data-notification-toast]")].find((t) => t.textContent.includes("Stop monitor"));
            await until(() => toast() != null, 40);
            const msg = text(toast());
            toast()?.click();
            await new Promise((r) => setTimeout(r, 400));
            return { toast: msg, rowStays: taskRow("bmtquiet") != null, menuClosed: menuItem("Stop monitor") == null };
        })()`);
        await unhover();
        rec(
            "3. Stop: the hovered monitor's X reads Stop errors in waveapp.log; right-click offers Show output and Stop monitor; a refused stop toasts Stop monitor / Not stopped and keeps the row",
            stopX.label === "Stop errors in waveapp.log" &&
                stopX.opacity === "1" &&
                menu.join(",") === "Show output,Stop monitor" &&
                stopped.toast?.includes("Not stopped") &&
                stopped.rowStays === true &&
                stopped.menuClosed === true,
            JSON.stringify({ stopX, menu, stopped })
        );

        const clickRow = (id) =>
            h.ev(`(async () => {
                ${SHELL_LIB}
                taskRow(${JSON.stringify(id)})?.click();
                await new Promise((r) => setTimeout(r, 400));
            })()`);
        // a monitor row always toggles its peek: a second click closes it
        const closePeek = (id) =>
            h.ev(`(async () => {
                ${SHELL_LIB}
                if (peek()?.getAttribute("data-shell-task-peek") === ${JSON.stringify(id)}) taskRow(${JSON.stringify(id)})?.click();
                return await until(() => peek() == null, 20);
            })()`);
        const peekState = (id, want) =>
            h.ev(`(async () => {
                ${SHELL_LIB}
                ${MONITOR_LIB}
                const want = ${JSON.stringify(want ?? null)};
                await until(() => peek()?.getAttribute("data-shell-task-peek") === ${JSON.stringify(id)} && (want == null || text(peek()).includes(want)), 40);
                await new Promise((r) => setTimeout(r, 300));
                const p = peek();
                if (!p) return null;
                const tablist = p.querySelector('[role="tablist"]');
                const tabState = (name) => (tab(name) ? { text: text(tab(name)), role: tab(name).getAttribute("role"), selected: tab(name).getAttribute("aria-selected") } : null);
                const expires = p.querySelector("[data-monitor-expires]");
                return {
                    id: p.getAttribute("data-shell-task-peek"),
                    text: text(p),
                    mark: p.querySelector("[data-peek-mark]")?.getAttribute("data-peek-mark") ?? null,
                    state: text(p.querySelector("[data-shell-task-state]")),
                    command: p.querySelector("[data-monitor-command]") ? text(p.querySelector("[data-monitor-command]")) : null,
                    tablist: tablist ? tablist.getAttribute("aria-label") : null,
                    events: tabState("events"),
                    output: tabState("output"),
                    eventTimes: [...p.querySelectorAll("[data-monitor-event]")].map((e) => text(e.querySelector("[data-monitor-event-time]"))),
                    footer: footer(),
                    expires: expires ? { text: text(expires), title: expires.getAttribute("title") } : null,
                };
            })()`);
        const selectTab = (name) =>
            h.ev(`(async () => {
                ${SHELL_LIB}
                ${MONITOR_LIB}
                tab(${JSON.stringify(name)})?.click();
                await until(() => tab(${JSON.stringify(name)})?.getAttribute("aria-selected") === "true", 20);
            })()`);

        // 4. Events peek: the monitor's header, command line, tabs, one row per event and the expiry footer
        const evMon = MONITORS[0];
        await clickRow(evMon.id);
        const events = await peekState(evMon.id, evMon.events.at(-1).lines[0]);
        await h.shot("cdp-shots/monitor-tasks-4.png");
        rec(
            "4. Events peek: Radio mark, watching, a $ command line, the Monitor view tablist on Events 4, four timed events, a footer of 4 events · and expires in …m",
            events?.mark === "monitor" &&
                events.state === "watching" &&
                events.command?.startsWith("$ ") &&
                events.tablist === "Monitor view" &&
                events.events?.role === "tab" &&
                events.events.selected === "true" &&
                events.events.text === `Events ${evMon.events.length}` &&
                events.eventTimes.length === evMon.events.length &&
                events.eventTimes.every((t) => /^\d\d:\d\d:\d\d$/.test(t)) &&
                evMon.events.every((e) => e.lines.every((l) => events.text.includes(l))) &&
                events.footer.startsWith(`${evMon.events.length} events ·`) &&
                /^expires in \d+m$/.test(events.expires?.text ?? "") &&
                /^expires \d\d:\d\d:\d\d$/.test(events.expires?.title ?? ""),
            JSON.stringify(events)
        );

        // 5. Output peek: the output file's tail, its stray grep warning included
        await selectTab("output");
        const output = await peekState(evMon.id, "grep: warning: stray");
        await h.shot("cdp-shots/monitor-tasks-5.png");
        rec(
            "5. Output peek: the Output tab selected, the body holds the grep warning and the event lines, the footer names bmtevents.output and last 64 KB",
            output?.output?.selected === "true" &&
                output.events?.selected === "false" &&
                output.text.includes("grep: warning: stray") &&
                evMon.events.every((e) => e.lines.every((l) => output.text.includes(l))) &&
                output.footer.includes(`${evMon.id}.output`) &&
                output.footer.includes("last 64 KB"),
            JSON.stringify(output)
        );
        await closePeek(evMon.id);

        // 6. Empty peek: a monitor with no events yet, and its empty output file
        const quiet = MONITORS[1];
        await clickRow(quiet.id);
        const empty = await peekState(quiet.id, "No events yet.");
        await h.shot("cdp-shots/monitor-tasks-6.png");
        await selectTab("output");
        const emptyOut = await peekState(quiet.id, "No output yet.");
        rec(
            "6. Empty peek: Events 0 reads No events yet. with a footer of watching since; its Output tab reads No output yet.",
            empty?.events?.text === "Events 0" &&
                empty.events.selected === "true" &&
                empty.text.includes("No events yet.") &&
                empty.eventTimes.length === 0 &&
                empty.footer.startsWith("watching since") &&
                emptyOut?.output?.selected === "true" &&
                emptyOut.text.includes("No output yet."),
            JSON.stringify({ empty, emptyOut: emptyOut && { output: emptyOut.output, text: emptyOut.text } })
        );
        await closePeek(quiet.id);

        // 7. Shell peek: a shell task keeps its plain output peek, with the Terminal mark
        await clickRow(MONITOR_SHELL.id);
        const shell = await peekState(MONITOR_SHELL.id, MONITOR_SHELL.output[0]);
        await h.shot("cdp-shots/monitor-tasks-7.png");
        rec(
            "7. Shell peek: the Terminal mark, running, no tablist and no command line",
            shell?.mark === "shell" && shell.state === "running" && shell.tablist === null && shell.command === null,
            JSON.stringify(shell)
        );
        await closePeek(MONITOR_SHELL.id);

        // 8. Cockpit card: the band and chip count both kinds; the hover list marks each running or watching
        await h.goto("cockpit");
        const main = JSON.stringify(MONITOR_AGENT.id);
        const cards = await h.ev(`(async () => {
            ${SHELL_LIB}
            await until(() => card(${main})?.querySelector("[data-shell-tasks-chip]") != null, 40);
            return {
                label: band(card(${main})),
                chip: text(card(${main})?.querySelector("[data-shell-tasks-chip]")),
                persistChip: text(card(${JSON.stringify(MONITOR_PERSIST_AGENT.id)})?.querySelector("[data-shell-tasks-chip]")),
            };
        })()`);
        await hover(`card(${main})?.querySelector("[data-shell-tasks-chip]")`);
        const list = await h.ev(`(async () => {
            ${SHELL_LIB}
            const l = () => card(${main})?.querySelector("[data-shell-tasks-list]");
            await until(() => l() != null, 20);
            await new Promise((r) => setTimeout(r, 300));
            return text(l());
        })()`);
        await h.shot("cdp-shots/monitor-tasks-8.png");
        await unhover();
        const count = (word) => (list.match(new RegExp("\\b" + word + "\\b", "g")) ?? []).length;
        rec(
            "8. Cockpit card: the band reads 3 tasks running, the chip 3 tasks; its list holds the three live tasks, watching twice and running once, none of the ended monitors; the persistent agent's chip reads 1 monitor",
            cards.label.includes("3 tasks running") &&
                cards.chip === "3 tasks" &&
                [MONITOR_SHELL, ...MONITOR_LIVE].every((t) => list.includes(t.description)) &&
                count("watching") === 2 &&
                count("running") === 1 &&
                MONITOR_GONE.every((m) => !list.includes(m.description)) &&
                cards.persistChip === "1 monitor",
            JSON.stringify({ ...cards, list })
        );
        return steps;
    },
    async teardown(h, ctx) {
        // teardownFixtureRun deletes the temp dir with the transcripts and the shell task's output; the monitors'
        // output files sit under claude's temp dir, keyed by that temp dir's name
        rmSync(join(tmpdir(), "claude", basename(ctx.cwd)), { recursive: true, force: true });
        await teardownFixtureRun(h, ctx, "monitor-tasks", {
            what: "restore the rail's visibility",
            fn: () => h.ev(restoreLocalStorage(RAIL_VISIBLE_KEY, ctx.prevRail)),
        });
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
// --- component looks: one scenario per component last deliberately designed in Jul-Aug 2026 --------------------
// Each shows one component in a populated state, for its polish to be verified against (effort cca9c053). A state
// the app reaches through a real path (a palette action, a hover, a seeded record) is reached that way; one that only
// arises from live data (a toast, a modal push, a menu) is set through the app's own module, imported from the URL
// the app loaded it from so the import is the app's instance. graphgutter is shown by git-history.
const lookClosePopModals = (h) =>
    lookEval(h, `
        const { modalsModel } = await mod("app/store/modalmodel.ts");
        while (modalsModel.hasOpenModals()) modalsModel.popModal();
    `);

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

export const newProjectModal = {
    name: "new-project-modal",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        await lookOpen(h, "cockpit");
        const opened = await openPalette(h);
        await h.ev(setInputExpr(PALETTE_INPUT, "New project"));
        await polishNap(300);
        const picked = await h.ev(`(() => {
            const b = [...(${PALETTE}?.querySelectorAll('button[data-idx]') ?? [])].find((x) => /^New project/.test((x.textContent || '').trim()));
            b?.click();
            return b != null;
        })()`);
        const empty = await lookEval(h, `
            await until(() => /New project/.test(flat(dialog())) && dialog()?.querySelector("input") != null, 3000);
            await nap(400);
            const create = button(dialog(), /^Create project/);
            return {
                open: dialog() != null,
                createDisabled: create?.disabled ?? null,
                cancel: button(dialog(), /^Cancel/) != null,
                createText: flat(create),
                heading: flat(dialog()?.querySelector("h2")),
                closeLabelled: dialog()?.querySelector('button[aria-label="Close"]') != null,
            };
        `);
        await h.shot(lookShot("new-project-modal"));
        steps.push({
            step: "palette New project opens the modal with Create project disabled until both fields are filled",
            ok: opened && picked && empty.open && empty.createDisabled === true && empty.cancel,
            detail: JSON.stringify({ opened, picked, ...empty }),
        });
        // the submit hint is this platform's chord: no ⌘ glyph off macOS
        const macHint = /⌘/.test(empty.createText ?? "");
        steps.push({
            step: "the title is a heading, the close button is labelled, and the submit hint names this platform's key",
            ok: empty.heading === "New project" && empty.closeLabelled && macHint === (process.platform === "darwin"),
            detail: JSON.stringify({ heading: empty.heading, closeLabelled: empty.closeLabelled, createText: empty.createText }),
        });
        await h.ev(setInputExpr(`document.querySelector('[role="dialog"] input[placeholder="my-service"]')`, "billing-api"));
        await h.ev(setInputExpr(`document.querySelector('[role="dialog"] input[placeholder="~/code/my-service"]')`, "~/code/billing-api"));
        const filled = await lookEval(h, `
            await nap(200);
            return { createDisabled: button(dialog(), /^Create project/)?.disabled ?? null };
        `);
        await h.shot(lookShot("new-project-modal-filled"));
        steps.push({ step: "with a name and a path, Create project is enabled", ok: filled.createDisabled === false, detail: JSON.stringify(filled) });
        const floor = await lookEval(h, `return floorWalk([dialog()]);`);
        steps.push({ step: `no visible text in the New project modal is under ${MIN_FONT_PX}px`, ok: floorOk(floor), detail: floorDetail(floor) });
        return steps;
    },
    async teardown(h) {
        await lookEval(h, `button(dialog(), /^Cancel/)?.click();`);
    },
};

const LOOK_TOOL_COMMAND = "npm test -- --run frontend/app/view/agents";
const LOOK_TOOL_ACTION = {
    kind: "action",
    verb: "ran",
    target: LOOK_TOOL_COMMAND,
    outcome: "fail",
    durationMs: 48_200,
    detail: {
        kind: "bash",
        command: LOOK_TOOL_COMMAND,
        exit: 1,
        output: [
            "> waveterm@0.14.22 test",
            "> vitest --run frontend/app/view/agents",
            "",
            " ✓ frontend/app/view/agents/agentsviewmodel.test.ts (212 tests) 410ms",
            " ✓ frontend/app/view/agents/cardgridlayout.test.ts (48 tests) 61ms",
            " ✓ frontend/app/view/agents/difflayout.test.ts (37 tests) 44ms",
            " ✓ frontend/app/view/agents/navrailwidth.test.ts (6 tests) 9ms",
            " ❯ frontend/app/view/agents/runmodel.test.ts (91 tests | 1 failed) 133ms",
            "   × steerTarget > picks the current phase's lead 12ms",
            "",
            " FAIL  frontend/app/view/agents/runmodel.test.ts > steerTarget > picks the current phase's lead",
            "AssertionError: expected undefined to deeply equal { id: 'w-1', name: 'lane 1' }",
            "",
            " ❯ frontend/app/view/agents/runmodel.test.ts:418:37",
            "    416|     const run = runWith({ status: \"running\", phases: [phase(\"w-1\")] });",
            "    417|     const agents = [agent(\"w-1\")];",
            "    418|     expect(steerTarget(run, agents)).toEqual({ id: \"w-1\", name: \"lane 1\" });",
            "       |                                     ^",
            "",
            " Test Files  1 failed | 23 passed (24)",
            "      Tests  1 failed | 1180 passed (1181)",
            "   Duration  47.91s",
        ].join("\n"),
    },
};

export const toolDetailModal = {
    name: "tool-detail-modal",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        await lookOpen(h, "cockpit");
        const s = await lookEval(h, `
            const { modalsModel } = await mod("app/store/modalmodel.ts");
            modalsModel.pushModal("AgentToolDetailModal", { action: ${JSON.stringify(LOOK_TOOL_ACTION)} });
            await until(() => /steerTarget/.test(flat(dialog())), 3000);
            await nap(400);
            const text = flat(dialog());
            const verb = [...dialog().querySelectorAll("span")].find((s) => s.className.includes("uppercase"));
            return {
                open: dialog() != null,
                failMark: dialog().querySelector('[role="img"][aria-label="Failed"]') != null,
                closeLabelled: dialog().querySelector('button[aria-label="Close"]') != null,
                verbPx: verb ? getComputedStyle(verb).fontSize : null,
                target: text.includes(${JSON.stringify(LOOK_TOOL_COMMAND)}),
                duration: /48(\\.\\d)?s/.test(text),
                head: text.slice(0, 80),
            };
        `);
        await h.shot(lookShot("tool-detail-modal"));
        return [
            {
                step: "a failed tool call over the inline budget opens the full-detail modal: fail mark, verb, target, duration and output",
                ok: s.open && s.failMark && s.target,
                detail: JSON.stringify(s),
            },
            {
                step: "the close button is labelled and the verb is at the 10.5px floor",
                ok: s.closeLabelled && s.verbPx === "10.5px",
                detail: JSON.stringify(s),
            },
        ];
    },
    async teardown(h) {
        await lookClosePopModals(h);
    },
};

const LOOK_MESSAGE = "The vault sync finished. 3 notes were pulled from the remote.";

export const messageModal = {
    name: "message-modal",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        await lookOpen(h, "cockpit");
        const shown = await lookEval(h, `
            const { modalsModel } = await mod("app/store/modalmodel.ts");
            modalsModel.pushModal("MessageModal", { children: ${JSON.stringify(LOOK_MESSAGE)} });
            await until(() => flat(dialog()).includes(${JSON.stringify(LOOK_MESSAGE)}), 3000);
            await nap(400);
            return { open: dialog() != null, ok: button(dialog(), /^OK/) != null };
        `);
        await h.shot(lookShot("message-modal"));
        const closed = await lookEval(h, `
            button(dialog(), /^OK/)?.click();
            return until(() => dialog() == null, 2000);
        `);
        return [
            { step: "a pushed MessageModal shows its message with one OK button", ok: shown.open && shown.ok, detail: JSON.stringify(shown) },
            { step: "OK closes it", ok: closed === true, detail: `closed=${closed}` },
        ];
    },
    async teardown(h) {
        await lookClosePopModals(h);
    },
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
        ];
    },
    async teardown() {},
};

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

// the Events rail's collapsed glyph is the Tooltip primitive's live use on a surface every profile has
const LOOK_EVENTS_RAIL = `document.querySelector('aside[aria-label="Events"]')`;

export const cockpitRailTooltip = {
    name: "cockpit-rail-tooltip",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        await lookOpen(h, "cockpit");
        // the expanded rail's heading is the text the floor raised; collapsing hides it
        const floor = await lookEval(h, `return floorWalk([${LOOK_EVENTS_RAIL}]);`);
        const floorDone = { step: `no visible text in the expanded Events rail is under ${MIN_FONT_PX}px`, ok: floorOk(floor), detail: floorDetail(floor) };
        const glyph = await lookEval(h, `
            const rail = () => ${LOOK_EVENTS_RAIL};
            rail()?.querySelector('button[aria-label="Collapse panel"]')?.click();
            const strip = () => rail()?.querySelector('button[aria-label="Events"]');
            await until(() => strip() != null, 3000);
            await nap(500); // the rail's width slide
            const r = strip()?.getBoundingClientRect();
            return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
        `);
        if (glyph == null) {
            return [{ step: "collapsing the Events rail leaves its glyph", ok: false, detail: "no collapsed Events glyph" }, floorDone];
        }
        await lookHover(h, glyph.x, glyph.y);
        const tip = await lookEval(h, `
            const tip = () => [...document.body.querySelectorAll("div")].find(
                (d) => flat(d) === "Events" && d.style.opacity === "1" && !${LOOK_EVENTS_RAIL}?.contains(d)
            );
            await until(() => tip() != null, 2000);
            await nap(200);
            return { shown: tip() != null };
        `);
        const look = await h.ev(LOOK_TOOLTIP_STYLE);
        await h.shot(lookShot("cockpit-rail-tooltip"));
        return [
            { step: "hovering the collapsed Events glyph shows its Events tooltip", ok: tip.shown, detail: JSON.stringify({ glyph, ...tip }) },
            { step: "the tooltip is a bordered 11.5px surface with a popover shadow", ok: tooltipLookOk(look), detail: JSON.stringify(look) },
            floorDone,
        ];
    },
    async teardown(h) {
        await lookHover(h, 1, 1);
        await lookEval(h, `${LOOK_EVENTS_RAIL}?.querySelector('button[aria-label="Events"]')?.click();`);
    },
};

// The title host (element/titletooltip.tsx) on whichever titled control the cockpit shows uncovered: it is the
// mechanism under test, not one control's text, so the scenario does not pin a title that may move.
const LOOK_TITLED = `(() => {
    const ok = (el) => {
        if (el.closest(".monaco-editor, .xterm")) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4 || r.bottom > innerHeight || r.right > innerWidth) return false;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return hit != null && (hit === el || el.contains(hit));
    };
    const all = [...document.querySelectorAll('[title]:not([title=""])')].filter(ok);
    return { hover: all[0] ?? null, focus: all.find((el) => el.matches("button, a[href], [tabindex]")) ?? null };
})()`;

export const titleTooltip = {
    name: "title-tooltip",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        await lookOpen(h, "cockpit");
        const target = await lookEval(h, `
            await nap(600);
            const el = ${LOOK_TITLED}.hover;
            if (el == null) return null;
            el.setAttribute("data-look-title", "");
            const r = el.getBoundingClientRect();
            // somewhere to move off to that no title covers
            let away = null;
            for (let y = innerHeight - 40; y > 0 && away == null; y -= 37) {
                for (let x = innerWidth / 2; x < innerWidth && away == null; x += 53) {
                    const hit = document.elementFromPoint(x, y);
                    if (hit != null && hit.closest("[title], [data-arc-title]") == null) away = { x: Math.round(x), y: Math.round(y) };
                }
            }
            return { title: el.getAttribute("title"), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), away };
        `);
        if (target == null) return [skipStep("hovering a titled control shows its title in the house tooltip", "no uncovered titled control on the cockpit")];
        await lookHover(h, target.x, target.y);
        const shown = await lookEval(h, `
            const tip = () => document.querySelector("[data-title-tooltip]");
            await until(() => tip() != null, 2000);
            const el = document.querySelector("[data-look-title]");
            return { tip: tip()?.innerText ?? null, titleWhileHovered: el?.getAttribute("title") ?? null };
        `);
        const look = await h.ev(LOOK_TOOLTIP_STYLE);
        await h.shot(lookShot("title-tooltip"));
        steps.push({
            step: "hovering a titled control shows its title in the house tooltip, with the native one held back",
            ok: shown.tip === target.title && shown.titleWhileHovered === null && tooltipLookOk(look),
            detail: JSON.stringify({ target, ...shown, look }),
        });

        await lookHover(h, target.away?.x ?? 1, target.away?.y ?? 1);
        const left = await lookEval(h, `
            await until(() => document.querySelector("[data-title-tooltip]") == null, 2000);
            const el = document.querySelector("[data-look-title]");
            return { gone: document.querySelector("[data-title-tooltip]") == null, title: el?.getAttribute("title") ?? null, parked: el?.hasAttribute("data-arc-title") ?? null };
        `);
        steps.push({
            step: "moving off hides the tooltip and gives the control its title back",
            ok: left.gone && left.title === target.title && left.parked === false,
            detail: JSON.stringify(left),
        });

        // a key first, so the focus that follows counts as keyboard focus (:focus-visible)
        await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 });
        await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 });
        const focused = await lookEval(h, `
            const el = ${LOOK_TITLED}.focus;
            if (el == null) return null;
            el.focus();
            await until(() => document.querySelector("[data-title-tooltip]") != null, 2000);
            const out = { title: el.getAttribute("title"), tip: document.querySelector("[data-title-tooltip]")?.innerText ?? null };
            el.blur();
            return out;
        `);
        steps.push(
            focused == null
                ? skipStep("keyboard focus on a titled control shows the tooltip and keeps the title", "no focusable titled control on the cockpit")
                : {
                      step: "keyboard focus on a titled control shows the tooltip and keeps the title for screen readers",
                      ok: focused.tip != null && focused.tip === focused.title,
                      detail: JSON.stringify(focused),
                  }
        );
        return steps;
    },
    async teardown(h) {
        await lookHover(h, 1, 1);
        await h.ev(`document.querySelector("[data-look-title]")?.removeAttribute("data-look-title")`);
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
            ["IdleSection", "app/view/agents/idlesection.tsx", `{ agents: ${JSON.stringify([DRIFT_AGENTS[0]])}, onOpen() {} }`],
            ["BackgroundedSection", "app/view/agents/backgroundedsection.tsx", `{ agents: ${JSON.stringify([DRIFT_AGENTS[1]])}, onRestore() {} }`],
        ]) {
            const label = name.toLowerCase();
            await run(label, async () => {
                const s = await lookEval(h, `
                    unmountAll();
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
                const host = await mount("app/view/agents/agentrow.tsx", "AgentRow", {
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
                    s.lines.length === 9 &&
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
