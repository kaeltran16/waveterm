// Usage surface scenarios: charts, work, attention routing and popup, workflow scan.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SURFACE_LABEL } from "./attach.mjs";
import {
    ATTN_TICK_SETTLE_MS,
    MIN_FONT_PX,
    MODELS_VIEWPORT,
    NOTES_CLIP_RESTORE,
    OBS_WIDE,
    PALETTE_INPUT,
    PALETTE_STATE,
    PEEKS_ESC,
    SURFACE_ROOT,
    TREE_RAIL_FIXTURE,
    arrangeSheetDagRun,
    channelRuns,
    clickByText,
    floorStep,
    fstWriteRun,
    notesClipStub,
    openAddressExpr,
    openPalette,
    paintEval,
    paletteKey,
    paletteStateWhen,
    polishNap,
    polishReload,
    polishWaitFor,
    restoreLocalStorage,
    seedDag,
    setInputExpr,
    teardownFixtureRun,
    usageRateLimits,
    waitForDispatch,
    waitForProjectInConfig,
    waveService,
} from "./scenarios-shared.mjs";

// The two layers added on top of the collapse order: the nav rail collapsing itself below a narrow window
// (navrailwidth.ts, the design's step 4) and the context rail leaving the flow entirely once collapsing
// both regions to strips is still not enough (jarvislayout.ts's railOverlay). jarvis-collapse-order owns
// the *order*; this owns the two widths where the new steps fire.

// One gutter, one header band (jarvis/stagemeasure.ts). The surface was assembled by merging three
// destinations, and each region kept the padding, header height and divider tone it had as its own screen:
// measured at 1500px, the Stage's stacked bands started their content at 366 (header, px-4), 382 (thread,
// max-w-[900px] px-8) and 370 (composer, px-5), the record subject added 432 (max-w-[720px] centred) over a
// full-bleed 18, and the three columns' header rules landed at y=44, 81 and 96 in two tones. Nothing here is
// derivable from a unit test — it is where the boxes actually are.
//
// The first version of this asserted one left edge across the elements carrying the shared measure's class,
// which is circular: a sealed run's header band did not carry it, kept its own px-6, and put the largest
// text on the Stage 20px left of everything else while this scenario stayed green. So the probe below finds
// bands by geometry, and the loop walks every subject kind rather than only the fixture conversation.

// --- usage charts: the meter primitives + the visx DailyChart actually render -------------------
// Class names asserted below were read off the installed packages, not guessed: @visx/axis puts
// `visx-axis visx-axis-left` on the axis group and `visx-axis-tick` on each tick, and @visx/tooltip
// puts `visx-tooltip` on the portal. Step 5 is scoped to the chart's own <svg> — a page-wide title
// query would trip over icon <title> elements that have nothing to do with the chart.
// Deterministic Usage surface: seed wave:dev-usage-buckets (the dev-only fixture the store reads)
// and wave:ratelimits (the persisted Claude quota snapshot), reload so savedRateLimitsAtom seeds from
// the snapshot, then let the Usage surface's mount load consume the historical fixture.
// Local day keys relative to "now" so the default 7-day view always has recent records.
const dayAgo = (n) => {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - n);
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${month}-${day}`;
};

const buildUsageFixture = () => {
    const buckets = [];
    // Claude/Anthropic/Opus across 16 days so All-time renders the brush.
    for (let n = 0; n < 16; n++) {
        buckets.push({
            harness: "claude",
            provider: "anthropic",
            session: "fx-claude",
            model: "claude-opus-4-8",
            day: dayAgo(n),
            input: 1000,
            output: 200,
            reasoning: 0,
            cacheread: 3000,
            cachecreate: 0,
            cachecreate1h: 0,
            msgs: 4,
        });
    }
    // Codex/OpenAI with known pricing.
    buckets.push({
        harness: "codex",
        provider: "openai",
        session: "fx-codex",
        model: "gpt-5.5",
        day: dayAgo(2),
        input: 500,
        output: 120,
        reasoning: 0,
        cacheread: 900,
        cachecreate: 0,
        cachecreate1h: 0,
        msgs: 3,
    });
    // OpenCode/OpenAI with reasoning and a REPORTED ZERO cost (present zero, not absent).
    buckets.push({
        harness: "opencode",
        provider: "openai",
        session: "fx-opencode",
        model: "gpt-5.5",
        day: dayAgo(1),
        input: 700,
        output: 150,
        reasoning: 400,
        cacheread: 900,
        cachecreate: 0,
        cachecreate1h: 0,
        reportedcostusd: 0,
        msgs: 2,
    });
    // OpenCode/OpenCode-Go with UNKNOWN pricing and non-zero reported cost (coverage < 100%). The model
    // id is deliberately synthetic: this bucket exists to exercise priceFor()'s unknown-model path, and
    // naming a real model here is what rotted the assertion last time — the bundled table gained a
    // deepseek-v4-pro row, coverage silently became 100%, and step 11 started failing.
    buckets.push({
        harness: "opencode",
        provider: "opencode-go",
        session: "fx-opencode-go",
        model: "unpriced-test-model",
        day: dayAgo(3),
        input: 2000,
        output: 500,
        reasoning: 0,
        cacheread: 0,
        cachecreate: 0,
        cachecreate1h: 0,
        reportedcostusd: 1.25,
        msgs: 5,
    });
    // Pi/OpenAI-Codex: the same model id as Codex's openai bucket but a DISTINCT provider, so the
    // harness and provider dimensions stay separate (pi -> openai-codex, codex -> openai).
    buckets.push({
        harness: "pi",
        provider: "openai-codex",
        session: "fx-pi",
        model: "gpt-5.5",
        day: dayAgo(1),
        input: 900,
        output: 200,
        reasoning: 300,
        cacheread: 1200,
        cachecreate: 400,
        cachecreate1h: 100,
        reportedcostusd: 0.42,
        msgs: 4,
    });
    buckets.push({
        harness: "pi",
        provider: "openai-codex",
        session: "fx-pi",
        model: "gpt-5.5",
        day: dayAgo(2),
        input: 400,
        output: 90,
        reasoning: 120,
        cacheread: 600,
        cachecreate: 150,
        cachecreate1h: 0,
        reportedcostusd: 0.18,
        msgs: 2,
    });
    // the directory GetUsageStatsCommand returns beside the buckets: one entry per session above
    const sessions = [...new Set(buckets.map((b) => `${b.harness}:${b.session}`))].map((key) => {
        const [harness, session] = key.split(":");
        return { harness, session, title: `${harness} fixture session` };
    });
    return { buckets, sessions };
};

// page-side helpers the usage scenarios share: every query goes through the surface's DOM contract
const USAGE_LIB = `
    const text = (el) => (el?.textContent || "").replace(/\\s+/g, " ").trim();
    const detail = () => document.querySelector("[data-usage-detail]");
    // the header's Lens and Range switches, and the Daily card's Metric switch, are Segmented groups
    const groupButton = (group, label) =>
        [...document.querySelectorAll('[aria-label="' + group + '"] button')].find((b) => text(b) === label) ?? null;
    const pressedIn = (group) =>
        text(document.querySelector('[aria-label="' + group + '"] button[aria-pressed="true"]')) || null;
    const press = (el) => {
        if (!el) return false;
        el.click();
        return true;
    };
    const until = async (ok, ms = 8000) => {
        for (let waited = 0; waited < ms && !ok(); waited += 100) {
            await new Promise((r) => setTimeout(r, 100));
        }
        return !!ok();
    };
    const chartSvg = () => document.querySelector("[data-usage-daily] svg");
    // the legend and split rows fade out over a scope change and steps move on as soon as the new ones show, so a row
    // still on its way out (motion's popLayout marks the leaving element data-motion-pop-id) is not part of the list
    const liveRows = (selector) => [...document.querySelectorAll(selector)].filter((r) => !r.closest("[data-motion-pop-id]"));
    // a legend row is swatch, model id, then "<value> · <pct>" with the value in its own span
    const legendRows = () =>
        liveRows("[data-usage-legend] [data-usage-model]").map((r) => ({
            key: r.getAttribute("data-usage-model"),
            model: text(r.children[1]),
            title: r.children[1]?.getAttribute("title") ?? null,
            value: text(r.lastElementChild?.firstElementChild),
        }));
    // a split row's only dollar figure is its spend; "$1.2K" reads as 1200
    const usdValue = (s) => {
        const m = /\\$([\\d.]+)(K?)/.exec(s);
        return m ? Number(m[1]) * (m[2] ? 1000 : 1) : NaN;
    };
    const splitRows = () =>
        liveRows("[data-usage-split] [data-usage-split-part]").map((r) => ({
            key: r.getAttribute("data-usage-split-part"),
            spend: usdValue(text(r)),
        }));
    const bySpend = (rows) =>
        rows.length > 0 && rows.every((r, i) => !Number.isNaN(r.spend) && (i === 0 || rows[i - 1].spend >= r.spend));
`;

// h.shot captures only the 1600x950 viewport and the detail scrolls, so a part below the fold is brought to
// the top before its shot
const usageScrollTo = (h, selector) =>
    h.ev(`(async () => {
        document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "start" });
        await new Promise((r) => setTimeout(r, 300));
    })()`);
const usageScrollTop = (h) => h.ev(`document.querySelector("[data-usage-detail]")?.scrollTo(0, 0)`);
const USAGE_BELOW = [
    ["[data-usage-daily]", "daily"],
    ["[data-usage-split]", "split"],
];

// a top-of-page shot named `name`, then `<name>-<suffix>` for each part below the fold, then back to the top
async function usageShots(h, name, parts = USAGE_BELOW) {
    await h.shot(`cdp-shots/${name}.png`);
    for (const [selector, suffix] of parts) {
        await usageScrollTo(h, selector);
        await h.shot(`cdp-shots/${name}-${suffix}.png`);
    }
    await usageScrollTop(h);
}

// runs `body` (statements ending in a return) on the page with USAGE_LIB in scope
const usageEv = (h, body) =>
    h.ev(`(async () => {
        ${USAGE_LIB}
        ${body}
    })()`);

export const usageCharts = {
    name: "usage-charts",
    surface: "usage",
    async arrange(h) {
        const ctx = {
            prevUsage: await h.ev(`localStorage.getItem('wave:dev-usage-buckets')`),
            prevRate: await h.ev(`localStorage.getItem('wave:ratelimits')`),
        };
        await h.ev(
            `localStorage.setItem('wave:dev-usage-buckets', ${JSON.stringify(JSON.stringify(buildUsageFixture()))})`
        );
        await h.ev(`localStorage.setItem('wave:ratelimits', ${JSON.stringify(JSON.stringify(usageRateLimits()))})`);
        // reload so savedRateLimitsAtom (module-load seeded) and the Usage surface both read the snapshot
        await h.ev("location.reload()");
        await new Promise((r) => setTimeout(r, 2500));
        return ctx;
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        await h.cdp("Emulation.setDeviceMetricsOverride", OBS_WIDE);

        // The surface fetches its stats over RPC and shows a skeleton until they land, so the chart is
        // NOT in the DOM the instant goto returns. Poll for it instead of sleeping a fixed amount —
        // the all-time scan's duration depends on how many transcripts exist.
        let ready = false;
        for (let waited = 0; waited <= 10000 && !ready; waited += 250) {
            ready =
                (await h.ev(`document.querySelectorAll("[data-usage-daily] svg .visx-axis-left .visx-axis-tick").length`)) >
                0;
            if (!ready) await settle(250);
        }
        rec("0. usage surface loaded and the chart mounted", ready, ready ? "chart present" : "timed out after 10s");

        // the Daily card's first svg is the visx chart: axis ticks and at least one bar. A bar's fill is a
        // bare harness color or a color-mix shade of it, so bars are any filled path.
        const chart = await usageEv(
            h,
            `const s = chartSvg();
            if (!s) return { found: false };
            return {
                found: true,
                leftTicks: s.querySelectorAll(".visx-axis-left .visx-axis-tick").length,
                bottomTicks: s.querySelectorAll(".visx-axis-bottom .visx-axis-tick").length,
                bars: s.querySelectorAll("path[fill]").length,
            };`
        );
        rec(
            "1. DailyChart renders a visx svg with axes and bars",
            chart.found && chart.leftTicks >= 2 && chart.bars >= 1,
            JSON.stringify(chart)
        );

        // the tokens the chart and the class bars paint with all resolve (no invented chart palette —
        // these are the pre-existing design-system tokens, so a rename would break the fills silently)
        const palette = await h.ev(`(() => {
            const cs = getComputedStyle(document.documentElement);
            const names = ["--color-cacheread","--color-accent","--color-warning","--color-success","--color-accent-200","--color-accent-800","--color-accent-300","--color-rt-opencode","--color-rt-pi"];
            return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]));
        })()`);
        rec(
            "2. the design-system tokens the chart paints with all resolve",
            Object.values(palette).every((v) => /^#[0-9a-f]{6}$/i.test(v)),
            JSON.stringify(palette)
        );

        // the Claude scope card draws one Meter bar per quota window, and the seeded claude snapshot is
        // 62%/41% so both bars must have a non-zero width
        const limits = await h.ev(`(() => {
            const cards = [...document.querySelectorAll('[data-usage-scopes] [data-usage-harness="claude"] [data-usage-limit]')];
            return cards.map((c) => {
                const fill = c.querySelector("div[style*='width']");
                return { kind: c.getAttribute("data-usage-limit"), width: fill ? fill.style.width : "" };
            });
        })()`);
        rec(
            "3. the Claude scope card renders a 5-hour and a weekly bar with a real width",
            limits.length === 2 &&
                limits.some((l) => l.kind === "fivehour") &&
                limits.some((l) => l.kind === "week") &&
                limits.every((l) => /^[0-9.]+%$/.test(l.width) && parseFloat(l.width) > 0),
            JSON.stringify(limits)
        );

        // the plan-usage meters moved from the Cockpit toolbar to the app bar, so they show on every
        // surface: here, on Usage, both seeded windows read out as a label and a percentage
        const meters = await h.ev(`(() => {
            const el = document.querySelector("[data-usage-meters]");
            return { found: !!el, inAppBar: !!el?.closest("[data-tauri-drag-region]"), text: el?.textContent ?? "" };
        })()`);
        rec(
            "3b. the app bar carries the 5-hour and weekly meters off the Cockpit",
            meters.found && meters.inAppBar && /5h\s*\d+%/.test(meters.text) && /wk\s*\d+%/.test(meters.text),
            JSON.stringify(meters)
        );

        // hovering a column opens the visx tooltip (replacing the old native title attribute). React
        // delegates pointer events from a child rect, so dispatch there rather than on the <g>.
        // the tooltip lists the hovered day's models and a total. Every seeded day has a Claude bucket, so any
        // column names claude-opus-4-8.
        const tip = await usageEv(
            h,
            `const bar = chartSvg()?.querySelector("path[fill]");
            if (!bar) return { hovered: false };
            for (const type of ["pointerover", "mouseover", "mouseenter"]) {
                bar.dispatchEvent(new MouseEvent(type, { bubbles: true }));
            }
            await until(() => document.querySelector("[data-usage-tip-total]") != null, 2000);
            const out = {
                hovered: true,
                models: [...document.querySelectorAll("[data-usage-tip-model]")].map(text),
                total: text(document.querySelector("[data-usage-tip-total]")) || null,
            };
            // leave the column so the tooltip is gone before the shots
            bar.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
            return out;`
        );
        rec(
            "4. hovering a bar opens a tooltip that lists the day's models and a total",
            tip.hovered && tip.models.some((m) => m.includes("claude-opus-4-8")) && tip.total != null,
            JSON.stringify(tip)
        );

        // no native title tooltips left on the chart itself
        const titles = await usageEv(
            h,
            `const svg = chartSvg();
            return svg ? svg.querySelectorAll("[title], title").length : -1;`
        );
        rec("5. no native title tooltips on the chart", titles === 0, String(titles));

        const tipShadow = await paintEval(h, `
            const bar = document.querySelector("[data-usage-daily] svg")?.querySelector("path[fill]");
            for (const type of ["pointerover", "mouseover", "mouseenter"]) bar?.dispatchEvent(new MouseEvent(type, { bubbles: true }));
            for (let i = 0; i < 20 && document.querySelector("[data-usage-tip-total]") == null; i++) await new Promise((r) => setTimeout(r, 100));
            const tip = document.querySelector("[data-usage-tip-total]")?.closest('[class*="shadow-popover"]') ?? null;
            const out = shadowVs(tip, "shadow-popover-sm");
            bar?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
            return out;
        `);
        rec("5b. the daily chart's tooltip casts shadow-popover-sm over no raw overlay", tipShadow.ok === true, JSON.stringify(tipShadow));

        // All usage, By provider, 7 days, loaded. The Spend metric is shot and checked between the Daily and
        // the split shots, so the parts below the fold go one by one here rather than through usageShots.
        await h.shot("cdp-shots/usage-main.png");
        await usageScrollTo(h, "[data-usage-daily]");
        await h.shot("cdp-shots/usage-main-daily.png");
        const metric = await usageEv(
            h,
            `const tokens = legendRows();
            const card = document.querySelector("[data-usage-daily]");
            const spendButton = [...(card?.querySelectorAll('[aria-label="Metric"] button') ?? [])].find(
                (b) => text(b) === "Spend"
            );
            const clicked = press(spendButton);
            await until(() => legendRows().length > 0 && legendRows().every((r) => r.value.startsWith("$")), 3000);
            // a stacked bar's height from its geometry (getBBox ignores the entrance scaleY)
            const plot = card?.querySelector("[data-usage-plot]");
            const plotH = Number(plot?.getAttribute("data-usage-plot") ?? 0);
            const tallest = Math.max(
                0,
                ...[...(plot?.querySelectorAll("[data-usage-day]") ?? [])].map((col) => {
                    const tops = [...col.querySelectorAll("path[fill]")].map((p) => p.getBBox().y);
                    return tops.length ? plotH - Math.min(...tops) : 0;
                })
            );
            return { clicked, tokens, spend: legendRows(), plotH, tallest };`
        );
        rec(
            "5b. Spend keeps the legend's Tokens order and reads every legend value in dollars",
            metric.clicked &&
                metric.tokens.length > 1 &&
                JSON.stringify(metric.spend.map((r) => r.key)) === JSON.stringify(metric.tokens.map((r) => r.key)) &&
                metric.spend.every((r) => r.value.startsWith("$")),
            JSON.stringify({ tokens: metric.tokens, spend: metric.spend })
        );
        rec(
            "5b2. on Spend the tallest stacked bar fills at least half the plot",
            metric.plotH > 0 && metric.tallest >= metric.plotH / 2,
            JSON.stringify({ plotH: metric.plotH, tallest: metric.tallest })
        );
        await h.shot("cdp-shots/usage-main-daily-spend.png");
        await usageEv(
            h,
            `const card = document.querySelector("[data-usage-daily]");
            press([...(card?.querySelectorAll('[aria-label="Metric"] button') ?? [])].find((b) => text(b) === "Tokens"));
            await until(() => legendRows().every((r) => !r.value.startsWith("$")), 3000);
            return true;`
        );
        await usageScrollTo(h, "[data-usage-split]");
        await h.shot("cdp-shots/usage-main-split.png");
        await usageScrollTop(h);

        const split = await usageEv(
            h,
            `return { rows: splitRows(), sorted: bySpend(splitRows()), total: text(document.querySelector("[data-usage-split] [data-usage-split-total]")) || null };`
        );
        rec(
            "5c. Where it goes rows are sorted by spend, under a Total row",
            split.sorted && split.total != null && split.total.startsWith("Total"),
            JSON.stringify(split)
        );

        // the Claude card: its own quota bars and its one model read out on the Daily header
        const claude = await usageEv(
            h,
            `const clicked = press(document.querySelector('[data-usage-scopes] [data-usage-harness="claude"]'));
            await until(() => detail()?.getAttribute("data-usage-detail") === "claude" && document.querySelector("[data-usage-daily-only]") != null, 3000);
            return {
                clicked,
                pressed: document.querySelector('[data-usage-scopes] [data-usage-harness="claude"]')?.getAttribute("aria-pressed") ?? null,
                scope: detail()?.getAttribute("data-usage-detail") ?? null,
                bars: [...document.querySelectorAll('[data-usage-scopes] [data-usage-harness="claude"] [data-usage-limit]')].map((c) => c.querySelector("div[style*='width']")?.style.width ?? ""),
                only: text(document.querySelector("[data-usage-daily-only]")) || null,
                legendRows: legendRows().length,
            };`
        );
        rec(
            "5d. the Claude card is pressed, with its quota bars and its one model on the Daily header",
            claude.clicked &&
                claude.pressed === "true" &&
                claude.scope === "claude" &&
                claude.bars.length === 2 &&
                claude.bars.every((w) => parseFloat(w) > 0) &&
                (claude.only ?? "").includes("claude-opus-4-8") &&
                claude.legendRows === 0,
            JSON.stringify(claude)
        );
        await usageShots(h, "usage-provider-claude");
        await usageEv(
            h,
            `press(document.querySelector('[data-usage-scopes] [data-usage-harness="all"]'));
            await until(() => detail()?.getAttribute("data-usage-detail") === "all", 3000);
            return true;`
        );

        // the Daily chart's day columns and its token total, the sum of the legend's per-model readings
        const dailyRange = `const scale = { "": 1, K: 1e3, M: 1e6, B: 1e9 };
            const tokens = legendRows().reduce((sum, r) => {
                const m = /^([\\d.]+)([KMB]?)$/.exec(r.value);
                return m ? sum + Number(m[1]) * scale[m[2]] : NaN;
            }, 0);
            return { days: document.querySelectorAll("[data-usage-daily] [data-usage-day]").length, tokens };`;
        const week = await usageEv(h, dailyRange);

        // The brush only exists on All-time with >14 days, so the default 7d window never renders it.
        const clicked = await usageEv(h, `return press(groupButton("Range", "All time"));`);
        let brush = { skipped: true };
        if (clicked) {
            for (let waited = 0; waited <= 20000; waited += 500) {
                brush = await usageEv(
                    h,
                    `const card = document.querySelector("[data-usage-daily]");
                    const chart = chartSvg();
                    if (!card || !chart || !chart.querySelector(".visx-axis-left")) return { loaded: false };
                    // the chart card's own label, NOT the first "Daily" on the page (the "Daily avg" stat card)
                    const h3 = [...card.querySelectorAll("h3")].find((x) => text(x) === "Daily");
                    return {
                        loaded: true,
                        bars: chart.querySelectorAll("path[fill]").length,
                        brushStrip: [...card.querySelectorAll("svg")].some((s) => s.querySelector(".visx-brush")),
                        brushOverlay: !!card.querySelector(".visx-brush-overlay"),
                        label: text(h3?.nextElementSibling),
                    };`
                );
                if (brush.loaded && brush.brushStrip) break;
                await settle(500);
            }
        }
        rec("6. All-time renders the brush strip under the chart", !!brush.brushStrip, JSON.stringify(brush));
        const allTime = await usageEv(h, dailyRange);
        rec(
            "6b. 7 days draws at most 7 day columns, and All time's Daily token total is larger",
            week.days > 0 && week.days <= 7 && week.tokens > 0 && allTime.tokens > week.tokens,
            JSON.stringify({ week, allTime })
        );

        // The scope bar keys each card by data-usage-harness (a text query would match the detail's own copy
        // of a provider name). Every seeded harness needs a card plus the pinned aggregate.
        const railKeys = await h.ev(
            `[...document.querySelectorAll("[data-usage-scopes] [data-usage-harness]")].map((b) => b.getAttribute("data-usage-harness"))`
        );
        rec(
            "7. the scope bar lists all, claude, codex, opencode, and pi",
            ["all", "claude", "codex", "opencode", "pi"].every((k) => railKeys.includes(k)),
            JSON.stringify(railKeys)
        );

        // select the OpenCode card, then assert only OpenCode history remains: its two models in the legend
        const openCodeState = await usageEv(
            h,
            `const clicked = press(document.querySelector('[data-usage-scopes] [data-usage-harness="opencode"]'));
            await until(() => detail()?.getAttribute("data-usage-detail") === "opencode" && legendRows().length > 0, 3000);
            const d = text(detail());
            return {
                clicked,
                models: legendRows().map((r) => r.model),
                hasReasoning: liveRows("[data-usage-split] [data-usage-split-part]").some((p) =>
                    text(p).includes("Reasoning")
                ),
                hasReportedCostLabel: d.includes("Reported cost"),
                hasEstimateLabel: d.includes("API-equivalent"),
            };`
        );
        rec(
            "8. selecting OpenCode leaves only OpenCode's gpt-5.5 and unpriced-test-model in the legend",
            openCodeState.clicked &&
                JSON.stringify([...openCodeState.models].sort()) ===
                    JSON.stringify(["gpt-5.5", "unpriced-test-model"]) &&
                !openCodeState.models.some((m) => m.startsWith("claude")),
            JSON.stringify(openCodeState)
        );
        rec(
            "9. the token-class section shows Reasoning",
            openCodeState.hasReasoning,
            `reasoning=${openCodeState.hasReasoning}`
        );
        rec(
            "10. reported cost and API-equivalent estimate are separate labels",
            openCodeState.hasReportedCostLabel && openCodeState.hasEstimateLabel,
            JSON.stringify({ reported: openCodeState.hasReportedCostLabel, estimated: openCodeState.hasEstimateLabel })
        );

        // one OpenCode bucket is intentionally unpriced, so priced-token coverage must be below 100%
        const coverage = await h.ev(`(() => {
            const owners = [...document.querySelectorAll("div")].filter(
                (d) => /% of tokens priced/.test(d.textContent || "") && d.children.length === 0
            );
            const m = owners.length ? (owners[0].textContent || "").match(/(\\d+)% of tokens priced/) : null;
            return m ? Number(m[1]) : null;
        })()`);
        rec(
            "11. pricing coverage is below 100% because one model is unpriced",
            coverage != null && coverage < 100,
            `coverage=${coverage}%`
        );

        // quota sits on each provider's own card, so it does not move with the selection: OpenCode (which
        // publishes no quota) shows "history only" and no bars while selected, Claude's card keeps its
        // two bars, and the detail draws no quota of its own on either scope
        const quotaOf = `(() => {
            const d = document.querySelector("[data-usage-detail]");
            const card = (k) => document.querySelector('[data-usage-scopes] [data-usage-harness="' + k + '"]');
            return {
                scope: d ? d.getAttribute("data-usage-detail") : null,
                detailBars: d ? d.querySelectorAll("[data-usage-limit]").length : -1,
                claudeBars: card("claude")?.querySelectorAll("[data-usage-limit]").length ?? 0,
                openCodeBars: card("opencode")?.querySelectorAll("[data-usage-limit]").length ?? -1,
                openCodeFact: (card("opencode")?.textContent || "").includes("history only"),
            };
        })()`;
        const limitsOpenCode = await h.ev(quotaOf);
        await h.ev(`(() => {
            const b = document.querySelector('[data-usage-scopes] [data-usage-harness="all"]');
            if (b) b.click();
        })()`);
        await settle(400);
        const limitsAll = await h.ev(quotaOf);
        rec(
            "12. quota stays on the provider cards whichever scope is selected",
            limitsOpenCode.scope === "opencode" &&
                limitsOpenCode.openCodeBars === 0 &&
                limitsOpenCode.openCodeFact &&
                limitsOpenCode.claudeBars === 2 &&
                limitsOpenCode.detailBars === 0 &&
                limitsAll.scope === "all" &&
                limitsAll.claudeBars === 2 &&
                limitsAll.detailBars === 0,
            JSON.stringify({ limitsOpenCode, limitsAll })
        );

        // the rail selection IS the harness filter, and it lives in the long-lived view model, so it
        // survives the surface unmounting on a nav switch
        await h.ev(`(() => {
            const b = document.querySelector('[data-usage-scopes] [data-usage-harness="opencode"]');
            if (b) b.click();
        })()`);
        await settle(400);
        await h.goto("cockpit");
        await h.goto("usage");
        await settle(600);
        const filterSurvived = await h.ev(`(() => {
            const b = document.querySelector('[data-usage-scopes] [data-usage-harness="opencode"]');
            const d = document.querySelector("[data-usage-detail]");
            return {
                pressed: b ? b.getAttribute("aria-pressed") : null,
                scope: d ? d.getAttribute("data-usage-detail") : null,
            };
        })()`);
        rec(
            "13. OpenCode selection survives a surface switch",
            filterSurvived.pressed === "true" && filterSurvived.scope === "opencode",
            JSON.stringify(filterSurvived)
        );

        // the app bar's native window controls must remain beside the plan-usage meters (step 3b)
        const appBar = await h.ev(`(() => {
            const bar = document.querySelector("[data-tauri-drag-region]");
            if (!bar) return { found: false };
            const min = !!bar.querySelector('[aria-label="Minimize"]');
            const max = !!bar.querySelector('[aria-label="Maximize"]');
            const close = !!bar.querySelector('[aria-label="Close"]');
            return { found: true, min, max, close };
        })()`);
        rec(
            "14. the app bar keeps native window controls",
            appBar.found && appBar.min && appBar.max && appBar.close,
            JSON.stringify(appBar)
        );

        // Reset the filter to All (the OpenCode filter survived the surface switch above), then read the
        // Daily legend: a heading per harness, and gpt-5.5 under Codex, OpenCode and Pi as three rows, never
        // one merged row.
        const legend = await usageEv(
            h,
            `press(document.querySelector('[data-usage-scopes] [data-usage-harness="all"]'));
            await until(() => document.querySelector('[data-usage-legend-group="pi"]') != null, 3000);
            const group = (k) => text(document.querySelector('[data-usage-legend-group="' + k + '"]')) || null;
            return {
                opencode: group("opencode"),
                pi: group("pi"),
                gpt: legendRows().filter((r) => r.model === "gpt-5.5").map((r) => r.key),
            };`
        );
        rec(
            "15. the legend has OpenCode and Pi groups, and gpt-5.5 once per harness that ran it",
            (legend.opencode ?? "").startsWith("OpenCode") &&
                (legend.pi ?? "").startsWith("Pi") &&
                legend.gpt.length === 3 &&
                new Set(legend.gpt).size === 3,
            JSON.stringify(legend)
        );

        // select the Pi card: its one model reads out on the Daily header, with Pi's provider rather than
        // Codex's openai or OpenCode's opencode-go, and no legend rows of other harnesses
        const piState = await usageEv(
            h,
            `const clicked = press(document.querySelector('[data-usage-scopes] [data-usage-harness="pi"]'));
            await until(() => detail()?.getAttribute("data-usage-detail") === "pi" && document.querySelector("[data-usage-daily-only]") != null, 3000);
            const only = document.querySelector("[data-usage-daily-only]");
            return {
                clicked,
                only: text(only) || null,
                title: only?.querySelector("[title]")?.getAttribute("title") ?? null,
                legendRows: legendRows().map((r) => r.key),
                groups: liveRows("[data-usage-legend-group]").map((g) =>
                    g.getAttribute("data-usage-legend-group")
                ),
            };`
        );
        rec(
            "16. selecting Pi leaves one model, read out on the Daily header as openai-codex/gpt-5.5, with no Codex or OpenCode rows",
            piState.clicked &&
                (piState.only ?? "").includes("gpt-5.5") &&
                piState.title === "openai-codex/gpt-5.5" &&
                piState.legendRows.length === 0 &&
                piState.groups.length === 0,
            JSON.stringify(piState)
        );

        // By provider is the default lens, and its detail page has no ranked list: that is By work's
        const lens = await usageEv(
            h,
            `return {
                lens: pressedIn("Lens"),
                options: [...document.querySelectorAll('[aria-label="Lens"] button')].map((b) => [text(b), b.getAttribute("aria-pressed")]),
                lists: document.querySelectorAll("[data-usage-detail] [data-usage-list]").length,
            };`
        );
        rec(
            "17. the Lens group shows By provider pressed, and the detail page has no ranked list",
            lens.lens === "By provider" &&
                JSON.stringify(lens.options) === JSON.stringify([["By provider", "true"], ["By work", "false"]]) &&
                lens.lists === 0,
            JSON.stringify(lens)
        );
        steps.push(await floorStep(h, `18. no visible text on the Usage surface is under ${MIN_FONT_PX}px`, SURFACE_ROOT));

        return steps;
    },
    // Restore the developer's pre-existing quota + fixture snapshots (delete only absent keys), reload so
    // savedRateLimitsAtom returns to the original value, then select the 7-day window and return to Cockpit.
    async teardown(h, ctx) {
        await h.ev(restoreLocalStorage("wave:dev-usage-buckets", ctx.prevUsage));
        await h.ev(restoreLocalStorage("wave:ratelimits", ctx.prevRate));
        await h.ev("location.reload()");
        await new Promise((r) => setTimeout(r, 2500));
        await h.goto("usage");
        await usageEv(h, `return press(groupButton("Range", "7 days"));`);
        await h.goto("cockpit");
    },
};

// --- usage-work: the Usage surface's By work lens ----------------------------------------------
// What the window's usage was spent on (docs/superpowers/specs/2026-10-08-usage-attribution-design.md): the
// project rail, the ranked list with its toggle, and the project, run and session pages, on a seeded
// {buckets, sessions} fixture. Paths use forward slashes and an upper-case drive letter, the form the surface
// normalises a project to, so data-usage-project equals what was seeded.
const USAGE_WORK_ARC = "C:/work/arc";
const USAGE_WORK_SIEM = "C:/work/siem";
const USAGE_WORK_SCRATCH = "C:/work/scratch";
// names no stored run or channel: Open run reaches the router, whose notice says so
const USAGE_WORK_RUN = "fx-usage-run";
const USAGE_WORK_CHANNEL = "fx-usage-channel";
const USAGE_WORK_GONE = "That channel no longer exists";
const USAGE_WORK_RUN_ITEM = `run:${USAGE_WORK_RUN}`;
const USAGE_WORK_SESSION_ITEM = "session:claude:fx-arc-1";
const USAGE_WORK_PI_ITEM = "session:pi:fx-pi-local";
const USAGE_WORK_PI_COST = 0.37;
const USAGE_WORK_OPUS = "claude-opus-5-5";
const USAGE_WORK_SONNET = "claude-sonnet-5-5";
const USAGE_WORK_COLLAPSED_ROWS = 8;
const USAGE_WORK_CLASSES = ["cacheRead", "reasoning", "output", "cacheWrite", "input"];

// Eleven work items. arc: an orchestrator run of four sessions on two models, a quick run, three sessions no run
// started and the pi session. siem: three sessions. scratch holds under 1% of spend, so it folds into "other
// folders" with the one session the directory does not list.
function buildUsageWorkFixture() {
    const buckets = [];
    const sessions = [];
    // units sizes a session: one unit prices at $0.125 on opus and $0.0725 on sonnet
    const add = (session, model, units, meta) => {
        buckets.push({
            harness: "claude",
            provider: "anthropic",
            model,
            session,
            day: dayAgo(1),
            input: 10_000 * units,
            output: 2_000 * units,
            reasoning: 0,
            cacheread: 100_000 * units,
            cachecreate: 5_000 * units,
            cachecreate1h: 0,
            msgs: units,
        });
        if (meta != null) sessions.push({ harness: "claude", session, ...meta });
    };
    const inRun = (role, taskid) => ({
        project: USAGE_WORK_ARC,
        runid: USAGE_WORK_RUN,
        channelid: USAGE_WORK_CHANNEL,
        rungoal: "Usage attribution fixture run",
        runmode: "orchestrator",
        role,
        ...(taskid ? { taskid } : {}),
    });
    add("fx-run-lead", USAGE_WORK_OPUS, 40, { title: "Lead session", ...inRun("lead") });
    add("fx-run-worker-1", USAGE_WORK_SONNET, 40, { title: "Wire types", ...inRun("worker", "t-1") });
    add("fx-run-worker-2", USAGE_WORK_SONNET, 30, { title: "By work lens", ...inRun("worker", "t-2") });
    add("fx-run-reviewer", USAGE_WORK_OPUS, 8, { title: "Review of wire types", ...inRun("reviewer", "t-1") });
    add("fx-quick", USAGE_WORK_OPUS, 16, {
        title: "Quick fix session",
        project: USAGE_WORK_ARC,
        runid: "fx-usage-quick",
        rungoal: "Fix the rail's truncated label",
        runmode: "quick",
    });
    add("fx-arc-1", USAGE_WORK_OPUS, 12, { title: "Trace the usage scan", project: USAGE_WORK_ARC });
    add("fx-arc-2", USAGE_WORK_SONNET, 20, { title: "Rename the bucket key", project: USAGE_WORK_ARC });
    add("fx-arc-3", USAGE_WORK_OPUS, 6, { title: "Read the price table", project: USAGE_WORK_ARC });
    add("fx-siem-1", USAGE_WORK_OPUS, 24, { title: "Detector backfill", project: USAGE_WORK_SIEM });
    add("fx-siem-2", USAGE_WORK_SONNET, 10, { title: "Kafka topic audit", project: USAGE_WORK_SIEM });
    add("fx-siem-3", USAGE_WORK_OPUS, 4, { title: "Avro schema check", project: USAGE_WORK_SIEM });
    add("fx-scratch", USAGE_WORK_SONNET, 1, { title: "Scratch note", project: USAGE_WORK_SCRATCH });
    add("fx-unlisted", USAGE_WORK_OPUS, 1, null);
    // an unpriced model that reports its own cost: the row shows that figure, marked "reported"
    buckets.push({
        harness: "pi",
        provider: "fx-local",
        model: "unpriced-test-model",
        session: "fx-pi-local",
        day: dayAgo(1),
        input: 40_000,
        output: 9_000,
        reasoning: 0,
        cacheread: 0,
        cachecreate: 0,
        cachecreate1h: 0,
        reportedcostusd: USAGE_WORK_PI_COST,
        msgs: 6,
    });
    sessions.push({ harness: "pi", session: "fx-pi-local", title: "Local model spike", project: USAGE_WORK_ARC });
    return { buckets, sessions };
}

// page-side helpers: every query is scoped to the surface's own data-* containers
const USAGE_WORK_LIB = `
    ${USAGE_LIB}
    const windowButton = (label) => groupButton("Range", label);
    const LENS_KEY = { "By provider": "provider", "By work": "work" };
    const snapshot = () => {
        const d = detail();
        const list = d?.querySelector("[data-usage-list]");
        const rows = [...(list?.querySelectorAll("[data-usage-item]") ?? [])];
        // read off the stat card's own sub line: the detail's joined text runs the card's value into it
        const share = (of) => {
            const sub = [...(d?.querySelectorAll("div") ?? [])].find(
                (el) => el.childElementCount === 0 && text(el).includes(of)
            );
            return (text(sub).match(new RegExp("[\\\\d.<]+% " + of)) ?? [null])[0];
        };
        return {
            scope: d?.getAttribute("data-usage-detail") ?? null,
            lens: LENS_KEY[pressedIn("Lens")] ?? null,
            title: text(d?.querySelector("[data-usage-head] h2")),
            sections: [...(d?.querySelectorAll("h3") ?? [])].map(text),
            list: list
                ? {
                      title: text(list.querySelector("h3")),
                      rows: rows.map((r) => r.getAttribute("data-usage-item")),
                      rowText: rows.map(text),
                      more: text(list.querySelector("[data-usage-more]")) || null,
                  }
                : null,
            split: splitRows().map((p) => p.key),
            splitBySpend: bySpend(splitRows()),
            only: d?.querySelector("[data-usage-daily-only]") != null,
            back: text(d?.querySelector("[data-usage-back]")) || null,
            openRun: text(d?.querySelector("[data-usage-open-run]")) || null,
            shares: {
                usage: share("of all usage"),
                spend: share("of all spend"),
            },
            projects: [...document.querySelectorAll("[data-usage-scopes] [data-usage-project]")].map((b) => ({
                key: b.getAttribute("data-usage-project"),
                pressed: b.getAttribute("aria-pressed") === "true",
                text: text(b),
            })),
            other: text(document.querySelector("[data-usage-scopes] [data-usage-other]")) || null,
            harnesses: [...document.querySelectorAll("[data-usage-scopes] [data-usage-harness]")].map((b) =>
                b.getAttribute("data-usage-harness")
            ),
            window: pressedIn("Range"),
        };
    };
`;

// Runs `act` (an expression that is true once it clicked what it was after), waits for `ready` (an expression
// over the snapshot `s`), and returns the page as it then stands.
const usageWorkView = (h, act, ready) =>
    h.ev(`(async () => {
        ${USAGE_WORK_LIB}
        const clicked = ${act};
        const settled = await until(() => {
            const s = snapshot();
            return ${ready};
        });
        return { clicked, settled, ...snapshot() };
    })()`);
const usageWorkClick = (selector) => `press(document.querySelector(${JSON.stringify(selector)}))`;
const usageWorkScope = (scope) => `s.scope === ${JSON.stringify(scope)}`;

export const usageWork = {
    name: "usage-work",
    surface: "usage",
    async arrange(h) {
        const ctx = { prevUsage: await h.ev(`localStorage.getItem('wave:dev-usage-buckets')`) };
        await h.ev(
            `localStorage.setItem('wave:dev-usage-buckets', ${JSON.stringify(JSON.stringify(buildUsageWorkFixture()))})`
        );
        // the lens, window and selection atoms are module state: a reload starts them at By provider, 7 days
        await h.ev("location.reload()");
        await h.ev(`(async () => {
            for (let i = 0; i < 60 && !document.querySelector("nav button"); i++) {
                await new Promise((r) => setTimeout(r, 500));
            }
        })()`);
        return ctx;
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const view = (act, ready) => usageWorkView(h, act, ready);
        const arcScope = `project:${USAGE_WORK_ARC}`;
        const openArc = () => view(usageWorkClick(`[data-usage-project="${USAGE_WORK_ARC}"]`), usageWorkScope(arcScope));
        const openRunPage = () =>
            view(usageWorkClick(`[data-usage-item="${USAGE_WORK_RUN_ITEM}"]`), usageWorkScope(USAGE_WORK_RUN_ITEM));
        const allUsage = () =>
            view(usageWorkClick('[data-usage-scopes] [data-usage-harness="all"]'), `s.scope === "all" && s.list != null`);
        const lensWork = `press(groupButton("Lens", "By work"))`;
        const openSession = () =>
            view(usageWorkClick(`[data-usage-item="${USAGE_WORK_SESSION_ITEM}"]`), usageWorkScope(USAGE_WORK_SESSION_ITEM));
        const brief = (s) =>
            JSON.stringify({ clicked: s.clicked, settled: s.settled, scope: s.scope, lens: s.lens, title: s.title });

        await h.cdp("Emulation.setDeviceMetricsOverride", OBS_WIDE);
        const loaded = await view("true", `s.lens === "provider" && s.split.length > 0`);
        rec(
            "0. the Usage surface loaded the fixture on the By provider lens",
            loaded.settled,
            JSON.stringify({ lens: loaded.lens, scope: loaded.scope, split: loaded.split })
        );

        const all = await view(lensWork, `s.lens === "work" && s.list != null`);
        const railProjects = all.projects.map((p) => p.key);
        rec(
            "1a. By work lists the two projects above 1% of spend, each with a share pill, and an other-folders line",
            all.settled &&
                JSON.stringify(railProjects) === JSON.stringify([USAGE_WORK_ARC, USAGE_WORK_SIEM]) &&
                all.projects.every((p) => /\d%/.test(p.text)) &&
                /other folders? hold/.test(all.other ?? ""),
            JSON.stringify({ projects: all.projects, other: all.other })
        );
        const splitSet = [...all.split].sort();
        rec(
            "1b. All usage has a Spent on list of eight rows, and a split by project sorted by spend",
            all.scope === "all" &&
                all.list?.title === "Spent on" &&
                all.list.rows.length === USAGE_WORK_COLLAPSED_ROWS &&
                JSON.stringify(splitSet) === JSON.stringify([USAGE_WORK_ARC, USAGE_WORK_SIEM, "other"].sort()) &&
                all.splitBySpend,
            JSON.stringify({ scope: all.scope, sections: all.sections, list: all.list?.title, rows: all.list?.rows, split: all.split, bySpend: all.splitBySpend })
        );
        await usageShots(h, "usage-work-all", [["[data-usage-list]", "list"], ...USAGE_BELOW]);

        const more = usageWorkClick("[data-usage-detail] [data-usage-more]");
        const expanded = await view(more, `(s.list?.rows.length ?? 0) > ${USAGE_WORK_COLLAPSED_ROWS}`);
        const collapsed = await view(more, `s.list?.rows.length === ${USAGE_WORK_COLLAPSED_ROWS}`);
        rec(
            "2. the toggle expands the list past eight rows and collapses it again",
            expanded.clicked && expanded.settled && collapsed.clicked && collapsed.settled,
            JSON.stringify({
                before: all.list?.more,
                expandedRows: expanded.list?.rows.length,
                expandedLabel: expanded.list?.more,
                collapsedRows: collapsed.list?.rows.length,
                collapsedLabel: collapsed.list?.more,
            })
        );

        const project = await openArc();
        rec(
            "3. a project page has its header, its share of all usage and spend, Runs and sessions, and a split by kind sorted by spend",
            project.clicked &&
                project.settled &&
                project.title === "arc" &&
                project.shares.usage != null &&
                project.shares.spend != null &&
                project.list?.title === "Runs and sessions" &&
                JSON.stringify([...project.split].sort()) === JSON.stringify(["orchestrator", "quick", "session"]) &&
                project.splitBySpend,
            JSON.stringify({ title: project.title, shares: project.shares, list: project.list?.title, rows: project.list?.rows, split: project.split, bySpend: project.splitBySpend })
        );

        // a session opened from the project's list keeps the project card pressed and comes Back to it
        const fromProject = await openSession();
        rec(
            "3b. a session opened from arc's list reads Back to arc, keeps arc pressed, and shows one model and no list",
            fromProject.clicked &&
                fromProject.settled &&
                fromProject.back === "Back to arc" &&
                fromProject.projects.some((p) => p.key === USAGE_WORK_ARC && p.pressed) &&
                fromProject.title === "Trace the usage scan" &&
                fromProject.list == null &&
                fromProject.only,
            JSON.stringify({ back: fromProject.back, title: fromProject.title, projects: fromProject.projects.map((p) => [p.key, p.pressed]), list: fromProject.list, only: fromProject.only })
        );
        await usageShots(h, "usage-work-project-session");
        await view(usageWorkClick("[data-usage-detail] [data-usage-back]"), `${usageWorkScope(arcScope)} && s.list != null`);

        const run = await openRunPage();
        const roles = ["lead", "worker", "reviewer"];
        rec(
            "4. a run page has Back to its project, Open run, its sessions with their roles, and a split by role",
            run.clicked &&
                run.settled &&
                run.back === "Back to arc" &&
                run.openRun === "Open run" &&
                run.list?.title === "Sessions in this run" &&
                run.list.rows.length === 4 &&
                roles.every((r) => run.list.rowText.some((t) => t.includes(`${r} ·`))) &&
                roles.every((r) => run.split.includes(r)),
            JSON.stringify({ back: run.back, openRun: run.openRun, list: run.list, split: run.split })
        );

        const back = await view(
            usageWorkClick("[data-usage-detail] [data-usage-back]"),
            `${usageWorkScope(arcScope)} && s.list?.title === "Runs and sessions"`
        );
        rec(
            "5. Back returns to the project page with its list",
            back.clicked && back.settled && back.back == null,
            JSON.stringify({ scope: back.scope, list: back.list?.title, rows: back.list?.rows })
        );

        const allAgain = await allUsage();
        const session = await openSession();
        rec(
            "6. a session page has no ranked list and no open button, and splits by token class",
            allAgain.settled &&
                session.clicked &&
                session.settled &&
                session.list == null &&
                session.openRun == null &&
                session.split.length > 0 &&
                session.split.every((k) => USAGE_WORK_CLASSES.includes(k)),
            JSON.stringify({ title: session.title, back: session.back, list: session.list, openRun: session.openRun, split: session.split })
        );

        // the unpriced session ranks last by estimate, so its row is past the first eight
        await allUsage();
        await view(more, `(s.list?.rows.length ?? 0) > ${USAGE_WORK_COLLAPSED_ROWS}`);
        const reported = await h.ev(`(() => {
            ${USAGE_WORK_LIB}
            const row = detail()?.querySelector(${JSON.stringify(`[data-usage-item="${USAGE_WORK_PI_ITEM}"]`)});
            if (!row) return null;
            row.scrollIntoView({ block: "center" });
            return { mark: text(row.querySelector("[data-usage-reported]")), row: text(row) };
        })()`);
        rec(
            "7. the unpriced pi session's row shows its reported cost, marked reported",
            reported?.mark === "reported" &&
                reported.row.includes(`$${USAGE_WORK_PI_COST}`) &&
                !reported.row.includes(`≈ $${USAGE_WORK_PI_COST}`),
            JSON.stringify(reported)
        );

        const selected = await openArc();
        const allTime = await view(
            `press(windowButton("All time"))`,
            `s.window === "All time" && s.scope === "all" && s.list != null`
        );
        rec(
            "8. changing the window with a project selected returns By work to All usage",
            selected.settled &&
                selected.projects.some((p) => p.pressed) &&
                allTime.clicked &&
                allTime.settled &&
                allTime.lens === "work" &&
                allTime.projects.length > 0 &&
                allTime.projects.every((p) => !p.pressed),
            JSON.stringify({
                before: { scope: selected.scope, window: selected.window },
                after: { scope: allTime.scope, window: allTime.window, lens: allTime.lens, projects: allTime.projects.map((p) => [p.key, p.pressed]) },
            })
        );
        // the same with a session drilled into: the window switch leaves it for All usage, with no Back
        const drilled = await openSession();
        const week = await view(
            `press(windowButton("7 days"))`,
            `s.window === "7 days" && s.scope === "all" && s.list != null`
        );
        rec(
            "8b. changing the window with a session open returns By work to All usage, with no Back",
            drilled.settled &&
                drilled.back != null &&
                week.clicked &&
                week.settled &&
                week.back == null &&
                week.projects.every((p) => !p.pressed),
            JSON.stringify({
                before: { scope: drilled.scope, back: drilled.back, window: drilled.window },
                after: { scope: week.scope, back: week.back, window: week.window, projects: week.projects.map((p) => [p.key, p.pressed]) },
            })
        );

        const provider = await view(
            `press(groupButton("Lens", "By provider"))`,
            `s.lens === "provider" && s.harnesses.includes("claude")`
        );
        rec(
            "9. By provider restores the harness rail",
            week.settled &&
                provider.clicked &&
                provider.settled &&
                ["all", "claude", "pi"].every((k) => provider.harnesses.includes(k)) &&
                provider.projects.length === 0 &&
                provider.list == null,
            JSON.stringify({ window: week.window, harnesses: provider.harnesses, sections: provider.sections, scope: provider.scope })
        );

        // last, because it leaves the surface or raises the router's notice
        await view(lensWork, `s.lens === "work" && s.list != null`);
        await openArc();
        const runPage = await openRunPage();
        const opened = await h.ev(`(async () => {
            ${USAGE_WORK_LIB}
            const errors = [];
            window.addEventListener("error", (e) => errors.push(String(e.message)));
            window.addEventListener("unhandledrejection", (e) => errors.push(String(e.reason?.message ?? e.reason)));
            const activeNav = () => {
                const b = [...document.querySelectorAll("nav button")].find((x) =>
                    (x.className || "").includes("text-accent-soft")
                );
                return b ? b.getAttribute("aria-label") || text(b) : null;
            };
            const toasts = () => [...document.querySelectorAll("[data-notification-toast]")].map(text);
            const from = activeNav();
            const clicked = press(detail()?.querySelector("[data-usage-open-run]"));
            const reached = await until(() => activeNav() !== from || toasts().length > 0);
            // an error thrown by the click's own handlers would have landed by now
            await new Promise((r) => setTimeout(r, 500));
            return { clicked, reached, from, surface: activeNav(), toasts: toasts(), errors };
        })()`);
        rec(
            "10. Open run goes through the router, which says the fixture's channel is gone, and nothing throws",
            runPage.settled &&
                opened.clicked &&
                opened.reached &&
                (opened.surface !== opened.from || opened.toasts.includes(USAGE_WORK_GONE)) &&
                opened.errors.length === 0,
            `${brief(runPage)} ${JSON.stringify(opened)}`
        );

        return steps;
    },
    async teardown(h, ctx) {
        await h.ev(restoreLocalStorage("wave:dev-usage-buckets", ctx.prevUsage));
        await h.ev("location.reload()");
        await new Promise((r) => setTimeout(r, 2500));
        await h.goto("cockpit");
    },
};

// --- usage-states: the Usage surface's loading, no-quota, empty-window and refresh-error states ----------
// Each is reached through the DEV fixture seam (devUsageFixture in usagestore.ts): delayMs holds the fixture
// back so the skeleton shows, an empty fixture empties the window, and { fail: true } fails the load so the
// last-good buckets stay on screen under the banner.
const USAGE_STATES_DELAY_MS = 6000;

// seeds the usage fixture, reloads so the store's module state starts over, and waits for the nav rail
async function usageReloadWith(h, fixture) {
    await h.ev(`localStorage.setItem('wave:dev-usage-buckets', ${JSON.stringify(JSON.stringify(fixture))})`);
    await h.ev("location.reload()");
    await h.ev(`(async () => {
        for (let i = 0; i < 60 && !document.querySelector("nav button"); i++) {
            await new Promise((r) => setTimeout(r, 500));
        }
    })()`);
    await h.cdp("Emulation.setDeviceMetricsOverride", OBS_WIDE);
}

export const usageStates = {
    name: "usage-states",
    surface: "usage",
    async arrange(h) {
        const ctx = {
            prevUsage: await h.ev(`localStorage.getItem('wave:dev-usage-buckets')`),
            prevRate: await h.ev(`localStorage.getItem('wave:ratelimits')`),
        };
        await h.ev(`localStorage.setItem('wave:ratelimits', ${JSON.stringify(JSON.stringify(usageRateLimits()))})`);
        // verify.mjs opens Usage next, and its mount starts the held-back load
        await usageReloadWith(h, { ...buildUsageFixture(), delayMs: USAGE_STATES_DELAY_MS });
        return ctx;
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });

        const loading = await usageEv(
            h,
            `await until(() => document.querySelector("[data-usage-skeleton]") != null, 3000);
            return {
                skeletons: document.querySelectorAll("[data-usage-skeleton]").length,
                limits: document.querySelectorAll("[data-usage-limit]").length,
                split: document.querySelector("[data-usage-split]") != null,
            };`
        );
        rec(
            "1. while the load is held back the skeleton shows under the Claude card's quota bars, with no split yet",
            loading.skeletons > 0 && loading.limits === 2 && !loading.split,
            JSON.stringify(loading)
        );
        await h.shot("cdp-shots/usage-loading.png");

        const noQuota = await usageEv(
            h,
            `const loaded = await until(() => document.querySelector("[data-usage-stats]") != null, ${USAGE_STATES_DELAY_MS + 6000});
            const clicked = press(document.querySelector('[data-usage-scopes] [data-usage-harness="pi"]'));
            await until(() => detail()?.getAttribute("data-usage-detail") === "pi", 3000);
            const pi = document.querySelector('[data-usage-scopes] [data-usage-harness="pi"]');
            // Pi's bars grow in from scaleY 0, so the shot waits for every bar's entrance to finish
            const bars = () => [...document.querySelectorAll("[data-usage-daily] [data-usage-plot] path[fill]")];
            const grown = (p) => ["none", "matrix(1, 0, 0, 1, 0, 0)"].includes(getComputedStyle(p).transform);
            const barsGrown = await until(() => bars().length > 0 && bars().every(grown), 3000);
            return {
                loaded,
                clicked,
                note: text(pi) || null,
                piBars: pi?.querySelectorAll("[data-usage-limit]").length ?? -1,
                stats: document.querySelector("[data-usage-stats]") != null,
                bars: bars().length,
                barsGrown,
            };`
        );
        rec(
            "2. the Pi card has no quota reading, and its history still shows with its bars grown",
            noQuota.loaded &&
                noQuota.clicked &&
                (noQuota.note ?? "").includes("history only") &&
                noQuota.piBars === 0 &&
                noQuota.stats &&
                noQuota.barsGrown,
            JSON.stringify(noQuota)
        );
        await h.shot("cdp-shots/usage-noquota.png");

        await usageReloadWith(h, { buckets: [], sessions: [] });
        await h.goto("usage");
        const empty = await usageEv(
            h,
            `const shown = await until(() => document.querySelector("[data-usage-empty]") != null);
            return { shown, daily: document.querySelector("[data-usage-daily]") != null };`
        );
        rec("3. an empty window says so and draws no Daily chart", empty.shown && !empty.daily, JSON.stringify(empty));
        await h.shot("cdp-shots/usage-empty.png");

        await usageReloadWith(h, buildUsageFixture());
        await h.goto("usage");
        const before = await usageEv(h, `return await until(() => document.querySelector("[data-usage-stats]") != null);`);
        // fail is read before buckets, so this alone fails the reload the next mount starts
        await h.ev(`localStorage.setItem('wave:dev-usage-buckets', ${JSON.stringify(JSON.stringify({ fail: true }))})`);
        await h.goto("cockpit");
        await h.goto("usage");
        const failed = await usageEv(
            h,
            `const banner = () => text(document.querySelector("[data-usage-scopes]")?.parentElement?.querySelector("[data-surface-error]"));
            const shown = await until(() => banner().includes("Couldn’t refresh"));
            return { shown, banner: banner(), stats: document.querySelector("[data-usage-stats]") != null };`
        );
        rec(
            "4. a failed refresh raises the banner over the last loaded usage",
            before && failed.shown && failed.stats,
            JSON.stringify({ loadedBefore: before, ...failed })
        );
        await h.shot("cdp-shots/usage-error.png");

        return steps;
    },
    async teardown(h, ctx) {
        await h.ev(restoreLocalStorage("wave:dev-usage-buckets", ctx.prevUsage));
        await h.ev(restoreLocalStorage("wave:ratelimits", ctx.prevRate));
        await h.ev("location.reload()");
        await new Promise((r) => setTimeout(r, 2500));
        await h.goto("cockpit");
    },
};

// --- the cross-channel blind spot ---------------------------------------------------------------
// The whole defect in three steps: block a run's DAG in one channel, make a DIFFERENT channel the active
// subject, then walk away to Usage and read the Jarvis nav badge. Before the attention list moved
// server-side this read zero — the badge counted only live `asking` workers, and a blocked DAG has none
// (its task stopped and it is waiting on a human), while the frontend's cross-channel list came from a
// channel snapshot refetched only on create/delete/rename/archive.
//
// The block is seeded, not reached: a deferred orchestrator run (no lead) is given a two-task plan, and once
// the first task's worker has dispatched the stored DAG is written to blocked with that task failed. The
// seeded task carries no child run id, so no later tick can re-derive its state from the worker, and a tick
// of the blocked DAG derives blocked again. Teardown cancels the run and deletes the worker's block.
//
// The poll wait is a 500ms loop rather than a flat 10s sleep so the step is not flaky at the interval
// boundary, and so a stalled poller fails HERE — distinguishable from the badge assertion failing, which
// means detection broke. The two halves of this change fail differently and must stay tellable apart.
const ATTN_BLOCKED_TASK = "t-1";
const ATTN_TASKS = [
    { id: ATTN_BLOCKED_TASK, label: "noop 1", description: "do nothing, stop immediately", deps: [], state: "" },
    { id: "t-2", label: "noop 2", description: "do nothing, stop immediately", deps: [ATTN_BLOCKED_TASK], state: "" },
];
const ATTN_DAG_STATUS = "blocked";
const ATTN_KIND = "dag-blocked";

const attnParkBlocked = (dag) => ({
    ...dag,
    status: ATTN_DAG_STATUS,
    tasks: (dag.tasks ?? []).map((t) => (t.id === ATTN_BLOCKED_TASK ? { ...t, state: "failed", runid: "" } : t)),
});
const attnFingerprint = (dag) =>
    JSON.stringify([dag?.status, (dag?.tasks ?? []).map((t) => [t.id, t.state, t.runid ?? ""])]);

export const attentionCrossChannel = {
    name: "attention-cross-channel",
    surface: "usage",
    async arrange(h) {
        const ctx = await arrangeSheetDagRun(h, "attn-probe", ATTN_TASKS);
        if (ctx.arrangeError != null) return ctx;
        try {
            // its own path: a second channel at the probe's path is the probe channel itself
            ctx.otherCwd = mkdtempSync(join(tmpdir(), "attn-other-"));
            const other = await h.rpc("createchannel", { name: "attn-other", projectpath: ctx.otherCwd });
            ctx.otherId = other.oid;
            // the dispatching tick holds the dag for as long as the spawn takes and would land over a seed made under it
            await waitForDispatch(h, ctx, ATTN_BLOCKED_TASK);
            if (!ctx.dispatched) throw new Error(`${ATTN_BLOCKED_TASK} did not dispatch in ${ctx.dispatchMs}ms`);
            ctx.dagId = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group?.oid;
            if (!ctx.dagId) throw new Error("the run has no dag");
            await seedDag(h, ctx, attnParkBlocked, attnFingerprint);
            // a tick the worker's first events started can outlast the seed's own read-back, so it is seeded again
            await new Promise((r) => setTimeout(r, ATTN_TICK_SETTLE_MS));
            await seedDag(h, ctx, attnParkBlocked, attnFingerprint);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);

        // 1. the probe channel's run holds a blocked dag, read back from the store
        const parkedStep = "1. the probe channel's run holds a blocked DAG";
        if (ctx.arrangeError != null) {
            rec(parkedStep, false, ctx.arrangeError);
            return steps;
        }
        const runId = ctx.runId;
        const group = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: runId })).group;
        const blocked = group?.tasks?.find((t) => t.id === ATTN_BLOCKED_TASK);
        rec(
            parkedStep,
            group?.status === ATTN_DAG_STATUS && blocked?.state === "failed",
            JSON.stringify({ status: group?.status, tasks: group?.tasks?.map((t) => [t.id, t.state, t.runid ?? ""]) })
        );

        // 2. the server reports it as a blocked-dag item — the backend half, asserted before any DOM reading so a
        // failure here is never mistaken for a delivery problem
        const attention = await h.rpc("getattention", null);
        const item = (attention.items || []).find((x) => x.runid === runId);
        rec(
            "2. GetAttention reports the blocked DAG with its channel and wait time",
            item != null && item.kind === ATTN_KIND && item.channelid === ctx.channelId && item.waitingsince > 0,
            JSON.stringify(item ?? { items: (attention.items || []).length })
        );

        // 3. a DIFFERENT channel is the active one, so the blocked DAG is in a non-active channel. Nothing in the
        // Brief selects a channel by hand: a load with no active channel takes the newest (loadChannels), and
        // attn-other was created after the probe.
        await h.ev("location.reload()");
        await settle(2500);
        await h.goto("jarvis");
        await settle(600);
        const newest = ((await h.rpc("getchannels", null))?.channels ?? [])[0]?.oid;
        rec(
            "3. a different channel is the active one",
            newest === ctx.otherId && ctx.otherId !== ctx.channelId,
            JSON.stringify({ newest, other: ctx.otherId, probe: ctx.channelId })
        );

        // 4. leave for a surface nowhere near Jarvis, then wait for one poll tick
        await h.goto("usage");
        await settle(400);
        const jarvisBadge = () =>
            h.ev(`(() => {
                const b = document.querySelector('nav button[aria-label="Jarvis"]');
                if (!b) return null;
                const s = [...b.querySelectorAll('span')].find((x) => /^\\d+$/.test((x.textContent || '').trim()));
                return s ? Number(s.textContent.trim()) : 0;
            })()`);
        let badge = await jarvisBadge();
        for (let i = 0; i < 30 && !(badge >= 1); i++) {
            await settle(500);
            badge = await jarvisBadge();
        }
        rec(
            "4. a poll delivered a non-empty attention list to the nav rail",
            typeof badge === "number" && badge >= 1,
            `badge=${JSON.stringify(badge)} (waited up to 15s for a 10s poll)`
        );

        // 5. the assertion the defect failed: the badge is lit from a surface that is not Jarvis, for a
        // blocked DAG in a channel that is not active
        const onUsage = await h.activeSurfaceLabel();
        rec(
            "5. the Jarvis badge counts a blocked DAG in a non-active channel, read from Usage",
            onUsage === "Usage" && badge >= 1,
            `surface=${onUsage} badge=${badge}`
        );
        await h.shot("cdp-shots/attention-cross-channel.png");

        return steps;
    },
    async teardown(h, ctx) {
        // before the fixture run's teardown, which reloads onto the roster this channel must be gone from
        if (ctx.otherId) {
            try {
                await h.rpc("deletechannel", { channelid: ctx.otherId });
            } catch (e) {
                console.error(`attention-cross-channel teardown: delete attn-other failed: ${e?.message ?? e}`);
            }
        }
        if (ctx.otherCwd) rmSync(ctx.otherCwd, { recursive: true, force: true });
        await teardownFixtureRun(h, ctx, "attention-cross-channel");
    },
};

// --- attention-popup: a new waiting item, while Arc is unfocused, shows as a bubble in a window of its own ---
// (docs/superpowers/specs/2026-10-08-attention-desktop-popup.md). The popup is a second page target on the
// CDP port, reached with h.page. "The popup window is visible" is always the window plugin's is_visible read on
// the popup's own target: the card can sit in the DOM of a hidden webview.
//
// The items are raised through the DEV attention seam (DEV_ATTENTION_ITEMS_KEY in attentionstore.ts), which
// appends them to every poll: the server raises one item per dag or run, too few to step the popup through, and
// attention-cross-channel covers the server's half. The fixture run is real, so a click lands on its sheet and its
// worker's block can raise a real ask; once dispatched its dag is set cancelled and its task lets go of the run, so
// the engine raises nothing for it and the worker's ask is the human's. Arc is made to look unfocused by
// overriding document.hasFocus on the main page, which is what the poller reads (attentionpoller.tsx); the
// override is installed for new documents before the reload, so the reloaded poller's first load sees it too.
// Each item is raised just after one of the page's own polls has landed, so it is new in the poll after it and
// the seed has the whole interval to settle.
const POPUP_URL = "popup.html";
const POPUP_LABEL = "attention-popup";
const POPUP_CARD = `document.querySelector("button[data-attention-popup]")`;
const POPUP_AVATAR = `document.querySelector("canvas[data-attention-popup-avatar]")`;
// POPUP_AVATAR_PX in frontend/app/view/agents/attentionpopup.ts
const POPUP_AVATAR_PX = 96;
// a dag the engine's tick leaves alone and the attention list holds nothing for
const POPUP_LIFTED_STATUS = "cancelled";
// DEV_ATTENTION_ITEMS_KEY in frontend/app/view/agents/attentionstore.ts
const POPUP_ITEMS_KEY = "wave:dev-attention-items";
// BUBBLE_MS in frontend/app/view/jarvis/bubblecard.tsx: how long a bubble stays up
const POPUP_BUBBLE_MS = 6000;
const POPUP_LEAVE_SLACK_MS = 3000;
// POPUP_MARGIN in frontend/app/view/agents/attentionpopup.ts, in logical px
const POPUP_MARGIN = 16;
// physical px: the popup rounds its size and its position to the scale factor
const POPUP_EDGE_TOLERANCE = 2;
// one 10s poll and room for it to land
const POPUP_RAISE_WAIT_MS = 15_000;
const POPUP_OPEN_WAIT_MS = 5000;
const POPUP_HIDE_WAIT_MS = 3000;
const POPUP_FOCUS_HIDE_MS = 2000;
const POPUP_QUIET_MS = 12_000;
// the items the scenario raises; only the first is a task of the fixture run's dag, whose one worker it needs
const POPUP_TASK_IDS = ["t-1", "t-2", "t-3", "t-4"];
const POPUP_LABELS = POPUP_TASK_IDS.map((_, i) => `noop ${i + 1}`);
const POPUP_TASKS = [{ id: POPUP_TASK_IDS[0], label: POPUP_LABELS[0], description: "do nothing, stop immediately", deps: [], state: "" }];
const POPUP_QUESTION = "Which port should the popup probe use?";
const POPUP_FLASH_REFUSED = /request_user_attention|not allowed|Permissions associated/i;

const popupSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// one blocked-dag item per id, on the fixture run, as the server words one (pkg/jarvis/attention.go)
const popupItem = (ctx, id) => ({
    key: `dag-blocked:popup-${id}`,
    kind: "dag-blocked",
    taskid: id,
    channelid: ctx.channelId,
    runid: ctx.runId,
    source: "attention-popup fixture",
    text: `The group is blocked: ${id} (${POPUP_LABELS[POPUP_TASK_IDS.indexOf(id)]})`,
    action: "Review",
    waitingsince: ctx.raisedAt,
    phaseidx: 0,
});

// what every poll from now on appends: exactly these ids' items, in this order
const popupRaise = (h, ctx, ids) => {
    ctx.raisedAt ??= Date.now();
    ctx.raised = ids.map((id) => popupItem(ctx, id));
    return h.ev(`localStorage.setItem(${JSON.stringify(POPUP_ITEMS_KEY)}, ${JSON.stringify(JSON.stringify(ctx.raised))})`);
};

// runs in every new document of the main page: Arc reads as unfocused, and what the page logs as an error is
// kept. fireAndForget (frontend/util/util.ts) reports a refused window call through console.log.
const POPUP_UNFOCUS_SCRIPT = `(() => {
    document.hasFocus = () => false;
    window.__popupErrors = [];
    const text = (a) => {
        if (a instanceof Error) return a.message;
        if (typeof a === "string") return a;
        try {
            return JSON.stringify(a);
        } catch {
            return String(a);
        }
    };
    const keep = (line) => window.__popupErrors.push(line.slice(0, 400));
    for (const level of ["error", "log"]) {
        const write = console[level].bind(console);
        console[level] = (...args) => {
            if (level === "error" || args[0] === "fireAndForget error") keep(args.map(text).join(" "));
            write(...args);
        };
    }
    window.addEventListener("unhandledrejection", (e) => keep("unhandledrejection " + text(e.reason)));
})()`;

// counts the page's own attention polls and keeps the keys of the last one. The poller passes no opts and the
// harness's h.rpc always passes an object, which is how the two are told apart.
const POPUP_COUNT_POLLS = `(() => {
    const c = window.TabRpcClient;
    if (!c) return false;
    if (c.__popupCounted) return true;
    const call = c.wshRpcCall.bind(c);
    window.__popupPolls = 0;
    c.wshRpcCall = (command, data, opts) => {
        const p = call(command, data, opts);
        if (command === "getattention" && opts == null) {
            p.then(
                (r) => {
                    window.__popupPolled = (r?.items ?? []).map((i) => i.key);
                    window.__popupPolls++;
                },
                () => {}
            );
        }
        return p;
    };
    c.__popupCounted = true;
    return true;
})()`;

// the keys the page's next poll delivered, once the poller has acted on them; null when none landed
const popupNextPoll = (h) =>
    h.ev(`(async () => {
        const from = window.__popupPolls;
        if (typeof from !== "number") return null;
        for (let i = 0; i < 56 && window.__popupPolls === from; i++) await new Promise((r) => setTimeout(r, 250));
        if (window.__popupPolls === from) return null;
        await new Promise((r) => setTimeout(r, 300));
        return window.__popupPolled;
    })()`);

const POPUP_STATE = `(async () => ({
    card: ${POPUP_CARD} != null,
    visible: await window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: ${JSON.stringify(POPUP_LABEL)} }),
}))()`;

// everything steps 3 and 4 judge, in one read: the bubble is up for BUBBLE_MS only
const POPUP_DETAIL = `(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const label = ${JSON.stringify(POPUP_LABEL)};
    const card = ${POPUP_CARD};
    const [visible, position, size, monitor] = await Promise.all([
        invoke("plugin:window|is_visible", { label }),
        invoke("plugin:window|outer_position", { label }),
        invoke("plugin:window|outer_size", { label }),
        invoke("plugin:window|primary_monitor"),
    ]);
    const text = (el) => (el ? (el.textContent || "").trim() : null);
    // the card's label and text lines carry no marker of their own: they are its unmarked children, in that order
    const plain = card
        ? [...card.children].filter(
              (c) => !c.hasAttribute("data-attention-popup-agent") && !c.hasAttribute("data-attention-popup-more")
          )
        : [];
    const name = card?.querySelector("[data-attention-popup-agent-name]");
    // the visible card is the marked button's parent: it carries the border, the background and the shadow.
    // Its parent is the row (card and avatar) the window places in the corner.
    const box = (el) => {
        const r = el?.getBoundingClientRect();
        return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null;
    };
    return {
        card: card != null,
        visible,
        hasFocus: document.hasFocus(),
        position,
        size,
        rowRect: box(card?.parentElement.parentElement),
        cardRect: box(card?.parentElement),
        avatarRect: box(${POPUP_AVATAR}),
        monitor,
        label: text(plain[0]),
        name: text(name),
        text: text(plain[1]),
        more: text(card?.querySelector("[data-attention-popup-more]")),
        background: card ? getComputedStyle(card.parentElement).backgroundColor : null,
        color: name ? getComputedStyle(name).color : null,
    };
})()`;

const popupShown = (s) => s.card === true && s.visible === true;
const popupGone = (s) => s.card === false && s.visible === false;

// polls the popup's own target until its state satisfies want; the last state read, whether it did, and the wait
async function popupUntil(popup, want, ms) {
    const start = Date.now();
    let state;
    do {
        state = await popup.ev(POPUP_STATE).catch((e) => ({ error: String(e?.message ?? e) }));
        if (want(state)) return { ...state, ok: true, ms: Date.now() - start };
        await popupSleep(150);
    } while (Date.now() - start < ms);
    return { ...state, ok: false, ms: Date.now() - start };
}

// how far, in physical px, the row's right and bottom edges are from where the 16px rule puts them. The row's
// rect is in the popup page's logical px, from the window's corner; the window's shadow room reaches past it.
function popupEdgeError(d) {
    const scale = d?.monitor?.scaleFactor;
    const area = d?.monitor?.workArea;
    if (!scale || !area || !d.position || !d.rowRect) return null;
    const right = d.position.x + d.rowRect.right * scale;
    const bottom = d.position.y + d.rowRect.bottom * scale;
    return {
        right: area.position.x + area.size.width - right - POPUP_MARGIN * scale,
        bottom: area.position.y + area.size.height - bottom - POPUP_MARGIN * scale,
    };
}

// both avatars' scenes once each wears posture. The popup's scene outlives its card, so a stale one from an earlier
// bubble is waited out rather than read; the last pair read either way.
const POPUP_FACE_WAIT_MS = 2000;
async function popupFaces(h, popup, posture) {
    const read = async (ev) => JSON.parse((await ev("JSON.stringify(window.__jarvisAvatarScene ?? null)")) ?? "null");
    const start = Date.now();
    let faces;
    do {
        faces = { popup: await read(popup.ev), main: await read(h.ev) };
        if (faces.popup?.posture === posture && faces.main?.posture === posture) break;
        await popupSleep(150);
    } while (Date.now() - start < POPUP_FACE_WAIT_MS);
    const pick = (s) => s && { expression: s.expression, posture: s.posture, renderer: s.renderer };
    return { popup: pick(faces.popup), main: pick(faces.main) };
}

// postureFor (frontend/app/view/jarvis/petcondition.ts) over the whole attention list, as petsignals.ts counts it:
// an escalation another run left in the dev store outranks the fixture's own ask
const POPUP_POSTURE_RANK = [
    ["escalation", "escalation"],
    ["ask", "blocked-worker"],
];
const popupPostureFor = (items) => POPUP_POSTURE_RANK.find(([kind]) => items.some((i) => i.kind === kind))?.[1] ?? "none";

const popupSameFace = (f, posture) =>
    f.popup?.renderer === "canvas" &&
    f.popup.posture === posture &&
    f.main?.posture === posture &&
    f.popup.expression === f.main.expression;

// polls the main page until a popup click has brought it to the run's sheet on Jarvis, focused
async function popupLanded(h, ctx, since) {
    let landed;
    do {
        landed = { surface: await h.activeSurfaceLabel(), ...(await h.ev(POPUP_MAIN_STATE)) };
        if (landed.surface === SURFACE_LABEL.jarvis && landed.sheet === ctx.runId && landed.focused === true) break;
        await popupSleep(200);
    } while (Date.now() - since < POPUP_OPEN_WAIT_MS);
    return landed;
}

const popupLandedOk = (before, landed, ctx) =>
    before.surface === SURFACE_LABEL.usage &&
    before.sheet !== ctx.runId &&
    landed.surface === SURFACE_LABEL.jarvis &&
    landed.sheet === ctx.runId &&
    landed.focused === true;

// the whole list the page holds now: the server's items and the seam's
const popupAttention = async (h, ctx) => [...((await h.rpc("getattention", null)).items || []), ...(ctx.raised ?? [])];

// the block of the fixture run's one dispatched worker. Its tab is read as an object: no wshrpc command returns a tab.
async function popupWorkerBlock(h, ctx) {
    ctx.workerSeen = [];
    for (const run of await channelRuns(h, ctx.channelId)) {
        for (const phase of run.phases || []) {
            for (const oref of phase.workerorefs || []) {
                const tab = await waveService(h, "object", "GetObject", [oref]).catch((e) => ({
                    error: String(e?.message ?? e),
                }));
                ctx.workerSeen.push({ run: run.id, oref, blockids: tab?.blockids, error: tab?.error });
                if (tab?.blockids?.[0]) return tab.blockids[0];
            }
        }
    }
    return null;
}

const POPUP_MAIN_STATE = `(async () => ({
    sheet: document.querySelector('[data-jarvis-brief-sheet] > header [data-run-id]')?.getAttribute('data-run-id') ?? null,
    focused: await window.__TAURI_INTERNALS__.invoke("plugin:window|is_focused", { label: "main" }),
}))()`;

export const attentionPopup = {
    name: "attention-popup",
    surface: "usage",
    async arrange(h) {
        const ctx = await arrangeSheetDagRun(h, "attention-popup", POPUP_TASKS);
        if (ctx.arrangeError != null) return ctx;
        try {
            // the dispatching tick holds the dag for as long as the spawn takes and would land over a seed made under it
            await waitForDispatch(h, ctx, POPUP_TASK_IDS[0]);
            if (!ctx.dispatched) throw new Error(`${POPUP_TASK_IDS[0]} did not dispatch in ${ctx.dispatchMs}ms`);
            ctx.dagId = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group?.oid;
            if (!ctx.dagId) throw new Error("the run has no dag");
            // the task lets go of its run, so the worker's ask (steps 12 to 14) is the human's, not the lead's
            await seedDag(
                h,
                ctx,
                (dag) => ({ ...dag, status: POPUP_LIFTED_STATUS, tasks: (dag.tasks ?? []).map((t) => ({ ...t, runid: "" })) }),
                (dag) => JSON.stringify([dag?.status, (dag?.tasks ?? []).map((t) => t.runid ?? "")])
            );
            // the worker's tab can trail the task's run id
            for (let i = 0; i < 20 && !ctx.workerBlockId; i++) {
                ctx.workerBlockId = await popupWorkerBlock(h, ctx);
                if (!ctx.workerBlockId) await popupSleep(500);
            }
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const [first, second, third, fourth] = POPUP_TASK_IDS;

        const builtStep = "1. a run holds a one-task DAG whose task dispatched, set aside so the engine raises nothing for it";
        if (ctx.arrangeError != null) {
            rec(builtStep, false, ctx.arrangeError);
            return steps;
        }
        const built = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group;
        rec(
            builtStep,
            built?.tasks?.length === POPUP_TASKS.length && built.status === POPUP_LIFTED_STATUS && ctx.dispatched === true,
            JSON.stringify({ dispatchMs: ctx.dispatchMs, status: built?.status, tasks: built?.tasks?.map((t) => [t.id, t.state]) })
        );

        // 2. unfocused from the reloaded page's first load on, then the first item, raised after a poll has landed
        const raisedStep = "2. with the main page reporting no focus, a poll raises the popup for the first item";
        let popup;
        try {
            popup = ctx.popup = await h.page(POPUP_URL);
        } catch (e) {
            rec(raisedStep, false, String(e?.message ?? e));
            return steps;
        }
        ctx.unfocusScript = (
            await h.cdp("Page.addScriptToEvaluateOnNewDocument", { source: POPUP_UNFOCUS_SCRIPT })
        ).identifier;
        await h.ev("location.reload()");
        let counting = false;
        for (let i = 0; i < 120 && !counting; i++) {
            // the reload destroys the execution context, which is not an answer either way
            counting = await h
                .ev(`!!document.querySelector("nav button") && ${POPUP_COUNT_POLLS}`)
                .catch(() => false);
            if (!counting) await popupSleep(250);
        }
        await h.goto("usage");
        const settled = await popupNextPoll(h);
        // a vite fallback serves the cockpit's index.html at any path, so the url alone does not say which page loaded
        const page = await popup.ev(`({
            cockpit: !!document.querySelector("nav button"),
            entry: !!document.querySelector('script[src*="popup"]'),
            card: ${POPUP_CARD} != null,
        })`);
        const before = { surface: await h.activeSurfaceLabel(), ...(await h.ev(POPUP_MAIN_STATE)) };
        const unfocused = await h.ev("document.hasFocus()");
        await popupRaise(h, ctx, [first]);
        const raised = await popupUntil(popup, popupShown, POPUP_RAISE_WAIT_MS);

        // steps 3 to 7 read and click inside the bubble's lifetime, and are judged after
        let gate = null;
        let gateFaces = null;
        let gatePosture = null;
        if (raised.ok) {
            await popup.shot("cdp-shots/attention-popup-gate.png");
            gate = await popup.ev(POPUP_DETAIL);
            gatePosture = popupPostureFor(await popupAttention(h, ctx));
            gateFaces = await popupFaces(h, popup, gatePosture);
            await popup.shot("cdp-shots/attention-popup-avatar.png");
            await popup.ev(`${POPUP_CARD}?.click()`);
        }
        const clickedAt = Date.now();
        const gateItem = ctx.raised.find((i) => i.taskid === first);
        rec(
            raisedStep,
            counting &&
                Array.isArray(settled) &&
                gateItem != null &&
                !settled.includes(gateItem.key) &&
                unfocused === false &&
                page.cockpit === false &&
                page.entry === true &&
                page.card === false &&
                raised.ok,
            JSON.stringify({ counting, settledPoll: settled, gate: gateItem?.key, unfocused, page, raised })
        );
        if (!raised.ok) return steps;

        const edges = popupEdgeError(gate);
        rec(
            "3. the popup reads Review, the item's source and its text, themed, its row 16px inside the work area's corner",
            gate.label === "Review" &&
                gate.name === gateItem?.source &&
                gate.text === gateItem?.text &&
                gate.text.includes(POPUP_LABELS[0]) &&
                gate.more === null &&
                !["rgba(0, 0, 0, 0)", "transparent", null].includes(gate.background) &&
                !["rgb(0, 0, 0)", null].includes(gate.color) &&
                edges != null &&
                Math.abs(edges.right) <= POPUP_EDGE_TOLERANCE &&
                Math.abs(edges.bottom) <= POPUP_EDGE_TOLERANCE,
            JSON.stringify({
                label: gate.label,
                name: gate.name,
                text: gate.text,
                more: gate.more,
                background: gate.background,
                color: gate.color,
                edgeErrorPx: edges,
                position: gate.position,
                size: gate.size,
                rowRect: gate.rowRect,
                workArea: gate.monitor?.workArea,
                scale: gate.monitor?.scaleFactor,
            })
        );
        rec(
            "4. the popup did not take focus while it was showing",
            gate.visible === true && gate.card === true && gate.hasFocus === false,
            JSON.stringify({ visible: gate.visible, hasFocus: gate.hasFocus })
        );
        rec(
            "5. the popup's avatar wears the main window's face while the item stands, drawn on the 2D canvas",
            gateFaces != null && popupSameFace(gateFaces, gatePosture),
            JSON.stringify({ expected: gatePosture, faces: gateFaces })
        );
        const card = gate.cardRect;
        const avatar = gate.avatarRect;
        rec(
            "6. the avatar is 96px, right of the card, its bottom edge level with the card's",
            card != null &&
                avatar != null &&
                Math.abs(avatar.width - POPUP_AVATAR_PX) <= 0.5 &&
                Math.abs(avatar.height - POPUP_AVATAR_PX) <= 0.5 &&
                avatar.left > card.right &&
                Math.abs(avatar.bottom - card.bottom) <= 1,
            JSON.stringify({ card, avatar })
        );

        const landed = await popupLanded(h, ctx, clickedAt);
        rec(
            "7. a click on the card opens the run's sheet on Jarvis and brings the main window forward",
            popupLandedOk(before, landed, ctx),
            JSON.stringify({ before, landed, runId: ctx.runId })
        );

        const closed = await popupUntil(popup, popupGone, POPUP_HIDE_WAIT_MS);
        rec("8. after the click the popup holds no card and its window is hidden", closed.ok, JSON.stringify(closed));

        // 9. the override is still on this document: no reload since step 2. Two items new in one poll make one bubble.
        const stillUnfocused = await h.ev("document.hasFocus()");
        await popupNextPoll(h);
        await popupRaise(h, ctx, [first, second, third]);
        const more = await popupUntil(popup, popupShown, POPUP_RAISE_WAIT_MS);
        const moreAt = Date.now();
        let moreCard = null;
        if (more.ok) {
            await popup.shot("cdp-shots/attention-popup-more.png");
            moreCard = await popup.ev(POPUP_DETAIL);
        }
        // the list is in rank order, so the first of the two is the one the bubble names
        const fresh = ctx.raised.filter((i) => [second, third].includes(i.taskid));
        rec(
            "9. two items new in one poll raise one popup naming the first, with +1 more waiting",
            stillUnfocused === false &&
                more.ok &&
                fresh.length === 2 &&
                moreCard?.label === "Review" &&
                moreCard?.text === fresh[0].text &&
                moreCard?.more === "+1 more waiting" &&
                moreCard?.visible === true,
            JSON.stringify({
                unfocused: stillUnfocused,
                raised: more,
                first: fresh[0]?.text,
                card: moreCard && { label: moreCard.label, text: moreCard.text, more: moreCard.more },
            })
        );

        const leaveBy = POPUP_BUBBLE_MS + POPUP_LEAVE_SLACK_MS;
        const left = more.ok
            ? await popupUntil(popup, popupGone, Math.max(0, moreAt + leaveBy - Date.now()))
            : { ok: false, why: "no popup to leave" };
        rec(
            "10. with nothing clicked, the popup leaves by itself within BUBBLE_MS plus 3s",
            left.ok,
            JSON.stringify({ ...left, sinceShownMs: Date.now() - moreAt, limitMs: leaveBy })
        );

        // 11. a fresh popup, raised the way step 9's was, for the last item; its avatar is clicked instead of its card
        await h.goto("usage");
        const avatarBefore = { surface: await h.activeSurfaceLabel(), ...(await h.ev(POPUP_MAIN_STATE)) };
        await popupNextPoll(h);
        await popupRaise(h, ctx, POPUP_TASK_IDS);
        const avatarRaised = await popupUntil(popup, popupShown, POPUP_RAISE_WAIT_MS);
        const avatarClickedAt = Date.now();
        let avatarClicked = false;
        if (avatarRaised.ok) {
            avatarClicked = await popup.ev(`(() => {
                const avatar = ${POPUP_AVATAR};
                avatar?.click();
                return avatar != null;
            })()`);
        }
        const avatarLanded = avatarRaised.ok ? await popupLanded(h, ctx, avatarClickedAt) : null;
        const avatarClosed = avatarRaised.ok
            ? await popupUntil(popup, popupGone, POPUP_HIDE_WAIT_MS)
            : { ok: false, why: "no popup to click" };
        rec(
            "11. a click on the avatar lands where a card click does, and the popup hides",
            avatarRaised.ok && avatarClicked && popupLandedOk(avatarBefore, avatarLanded, ctx) && avatarClosed.ok,
            JSON.stringify({
                raised: avatarRaised,
                clicked: avatarClicked,
                before: avatarBefore,
                landed: avatarLanded,
                closed: avatarClosed,
            })
        );

        // 12 to 14. an ask on the fixture run's worker block, raised with the seam's items lifted so the ask is the only
        // waiting kind; Arc gaining focus hides the bubble well inside BUBBLE_MS
        const askStep = "12. an ask raises a popup reading Asking you, the worker's name and the question";
        const askFaceStep =
            "13. the ask popup's avatar wears the main window's face, blocked-worker unless another run's waiting outranks it, drawn on the 2D canvas";
        const focusStep = "14. the popup leaves when Arc gains focus";
        if (!ctx.workerBlockId) {
            rec(askStep, false, `the fixture run has no worker block to raise an ask on: ${JSON.stringify(ctx.workerSeen)}`);
            rec(askFaceStep, false, "no popup to read");
            rec(focusStep, false, "no popup to hide");
        } else {
            const askORef = `block:${ctx.workerBlockId}`;
            await popupRaise(h, ctx, []);
            await popupNextPoll(h);
            await h.rpc("ask", {
                oref: askORef,
                questions: [{ header: "Port", question: POPUP_QUESTION, options: [{ label: "9222" }, { label: "9223" }] }],
            });
            ctx.askORef = askORef;
            const asked = await popupUntil(popup, popupShown, POPUP_RAISE_WAIT_MS);
            const askedAt = Date.now();
            let askCard = null;
            let askFaces = null;
            let askPosture = null;
            let askOthers = null;
            let hidden = { ok: false, why: "no popup to hide" };
            if (asked.ok) {
                await popup.shot("cdp-shots/attention-popup-ask.png");
                askCard = await popup.ev(POPUP_DETAIL);
                const waiting = (await h.rpc("getattention", null)).items || [];
                askPosture = popupPostureFor(waiting);
                askOthers = waiting
                    .filter((i) => i.runid !== ctx.runId && i.kind === "escalation")
                    .map((i) => [i.kind, i.runid]);
                askFaces = await popupFaces(h, popup, askPosture);
                await popup.shot("cdp-shots/attention-popup-avatar-ask.png");
                await h.ev(`window.dispatchEvent(new Event("focus"))`);
                hidden = await popupUntil(popup, popupGone, POPUP_FOCUS_HIDE_MS);
            }
            const sinceShownMs = Date.now() - askedAt;
            const askItem = ((await h.rpc("getattention", null)).items || []).find((i) => i.key === `ask:${askORef}`);
            rec(
                askStep,
                asked.ok &&
                    askItem?.kind === "ask" &&
                    askCard?.label === "Asking you" &&
                    askCard?.name === askItem.source &&
                    askCard?.text === askItem.text &&
                    askCard?.text.includes(POPUP_QUESTION) &&
                    askCard?.more === null,
                JSON.stringify({
                    raised: asked,
                    item: askItem && { kind: askItem.kind, source: askItem.source, text: askItem.text },
                    card: askCard && { label: askCard.label, name: askCard.name, text: askCard.text, more: askCard.more },
                })
            );
            rec(
                askFaceStep,
                askFaces != null && askPosture !== "none" && popupSameFace(askFaces, askPosture),
                JSON.stringify({ expected: askPosture, outrankedBy: askOthers, faces: askFaces })
            );
            rec(
                focusStep,
                hidden.ok && sinceShownMs < POPUP_BUBBLE_MS,
                JSON.stringify({ ...hidden, sinceShownMs, bubbleMs: POPUP_BUBBLE_MS })
            );
        }

        // 15. focused again, a new item raises nothing: the items, lifted for the ask, stand again
        await h.cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier: ctx.unfocusScript });
        ctx.unfocusScript = null;
        await h.ev("delete document.hasFocus");
        let focused = await h.ev("document.hasFocus()");
        if (!focused) {
            // the dev app's window is behind another under the harness
            await h.cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
            ctx.focusEmulated = true;
            focused = await h.ev("document.hasFocus()");
        }
        await popupNextPoll(h);
        await popupRaise(h, ctx, POPUP_TASK_IDS);
        // the poll after the raise is the one that carries the items
        const reported = (await popupNextPoll(h)) != null && ctx.raised.some((item) => item.taskid === fourth);
        const quietFrom = Date.now();
        let noise = null;
        while (noise == null && Date.now() - quietFrom < POPUP_QUIET_MS) {
            const s = await popup.ev(POPUP_STATE);
            if (s.card || s.visible) noise = { ...s, afterMs: Date.now() - quietFrom };
            else await popupSleep(500);
        }
        rec(
            "15. with Arc focused, a new item raises no popup within one poll",
            focused === true && reported && noise == null,
            JSON.stringify({ focused, emulated: ctx.focusEmulated === true, reported, noise, watchedMs: Date.now() - quietFrom })
        );
        if (ctx.focusEmulated) {
            await h.cdp("Emulation.setFocusEmulationEnabled", { enabled: false });
            ctx.focusEmulated = false;
        }

        // 16. the flash shares the popup's condition, so every popup above also asked for one
        const errors = (await h.ev("window.__popupErrors")) ?? null;
        const refused = (errors ?? []).filter((line) => POPUP_FLASH_REFUSED.test(line));
        const direct = await h.ev(`(async () => {
            const invoke = window.__TAURI_INTERNALS__.invoke;
            try {
                await invoke("plugin:window|request_user_attention", { label: "main", value: { type: "Informational" } });
                await invoke("plugin:window|request_user_attention", { label: "main", value: null });
                return "accepted";
            } catch (e) {
                return "refused: " + String(e?.message ?? e);
            }
        })()`);
        rec(
            "16. the taskbar flash request is accepted in the dev app",
            Array.isArray(errors) && refused.length === 0 && direct === "accepted",
            `CDP cannot see the taskbar button itself: this checks only that the request is accepted. ${JSON.stringify({
                direct,
                refused,
                pageErrors: errors?.length ?? null,
            })}`
        );
        return steps;
    },
    async teardown(h, ctx) {
        const undo = [
            [
                "restore document.hasFocus",
                async () => {
                    if (ctx.unfocusScript) {
                        await h.cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier: ctx.unfocusScript });
                    }
                    await h.ev("delete document.hasFocus");
                },
            ],
            [
                "turn focus emulation off",
                () => ctx.focusEmulated && h.cdp("Emulation.setFocusEmulationEnabled", { enabled: false }),
            ],
            ["clear the ask", () => ctx.askORef && h.rpc("agentaskclear", ctx.askORef)],
            ["clear the seam's items", () => h.ev(`localStorage.removeItem(${JSON.stringify(POPUP_ITEMS_KEY)})`)],
            // the app's own hide: the main window gaining focus
            ["hide the popup", () => h.ev(`window.dispatchEvent(new Event("focus"))`)],
            ["close the popup's session", () => ctx.popup?.close()],
            // the worker holds the temp dir open until its block goes
            ["delete the worker's block", () => ctx.workerBlockId && h.rpc("deleteblock", { blockid: ctx.workerBlockId })],
        ];
        for (const [what, fn] of undo) {
            try {
                await fn();
            } catch (e) {
                console.error(`attention-popup teardown: ${what} failed: ${e?.message ?? e}`);
            }
        }
        await teardownFixtureRun(h, ctx, "attention-popup");
    },
};

// The Cockpit's "need you" count leaves out an ask Jarvis already answered, and the answer card can sit in any
// channel: the count reads every channel's messages (channelMessagesAtom), not the active channel's. A fixture
// roster holds the one asking agent; the card is posted into the older of two channels, the one a load never
// selects.
const NEEDS_YOU_AGENT_ID = "fx-needs-you";
const NEEDS_YOU_ASK_ID = "fx-needs-you-ask";

export const cockpitNeedsYouCrossChannel = {
    name: "cockpit-needs-you-cross-channel",
    surface: "cockpit",
    async arrange(h) {
        const ctx = { channelIds: [], cwds: [] };
        try {
            for (const name of ["needs-you-answered", "needs-you-newest"]) {
                const cwd = mkdtempSync(join(tmpdir(), `${name}-`));
                ctx.cwds.push(cwd);
                ctx.channelIds.push((await h.rpc("createchannel", { name, projectpath: cwd })).oid);
            }
            mkdirSync(new URL(".", TREE_RAIL_FIXTURE), { recursive: true });
            writeFileSync(
                TREE_RAIL_FIXTURE,
                JSON.stringify(
                    [
                        {
                            id: NEEDS_YOU_AGENT_ID,
                            name: "needs-you worker",
                            project: "waveterm",
                            task: "wait on an answer",
                            state: "asking",
                            agent: "claude",
                            model: "opus",
                            blockedMs: 60_000,
                            blockId: "fx-blk-needs-you",
                            ask: {
                                askId: NEEDS_YOU_ASK_ID,
                                oref: "block:fx-blk-needs-you",
                                questions: [
                                    { header: "Port", question: "Which port?", options: [{ label: "9222" }, { label: "9223" }] },
                                ],
                            },
                        },
                    ],
                    null,
                    2
                )
            );
            ctx.wroteFixture = true;
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        const openStep = "1. the Cockpit counts the fixture's asking agent as needing you";
        if (ctx.arrangeError != null) {
            rec(openStep, false, ctx.arrangeError);
            return steps;
        }
        // the header's count, read off the words beside it; null while the header is not there
        const needYou = () =>
            h.ev(`(() => {
                const s = [...document.querySelectorAll('span')].find((x) => /^\\s*\\d+\\s*need you\\s*$/.test(x.textContent || ''));
                return s ? Number(s.textContent.match(/\\d+/)[0]) : null;
            })()`);
        const reloadToCockpit = async () => {
            await h.ev("location.reload()");
            await settle(2500);
            await h.goto("cockpit");
            await settle(800);
        };

        await reloadToCockpit();
        const before = await needYou();
        rec(openStep, before === 1, `need you=${JSON.stringify(before)}`);

        // 2. the answer card goes into the older channel; the newest is the one a load would select
        const [answeredIn, newest] = ctx.channelIds;
        const listed = ((await h.rpc("getchannels", null))?.channels ?? []).sort((a, b) => b.createdts - a.createdts);
        const posted = await h.rpc("postchannelmessage", {
            channelid: answeredIn,
            kind: "jarvis-answered",
            author: "jarvis",
            text: 'Answered → "9222"',
            // the fields a card must carry to be read as one (parseCardData)
            data: JSON.stringify({
                askId: NEEDS_YOU_ASK_ID,
                askORef: "block:fx-blk-needs-you",
                question: "Which port?",
                options: [{ label: "9222" }, { label: "9223" }],
                choice: 0,
            }),
        });
        rec(
            "2. Jarvis's answer card is stored in a channel that is not the newest",
            posted?.kind === "jarvis-answered" && listed[0]?.oid === newest && answeredIn !== newest,
            JSON.stringify({ posted: posted?.oid, answeredIn, newest: listed[0]?.oid })
        );

        // 3. the agent is still asking, and the count drops: the card was read from a channel nothing selected
        await reloadToCockpit();
        const after = await needYou();
        rec("3. the answered ask no longer counts as needing you", after === 0, `need you=${JSON.stringify(after)}`);
        await h.shot("cdp-shots/cockpit-needs-you-cross-channel.png");
        return steps;
    },
    async teardown(h, ctx) {
        if (ctx.wroteFixture) rmSync(TREE_RAIL_FIXTURE, { force: true });
        for (const id of ctx.channelIds) {
            try {
                await h.rpc("deletechannel", { channelid: id });
            } catch (e) {
                console.error(`cockpit-needs-you-cross-channel teardown: delete ${id} failed: ${e?.message ?? e}`);
            }
        }
        for (const cwd of ctx.cwds) rmSync(cwd, { recursive: true, force: true });
        // onto the live roster again, and settled: the next scenario's first act is a nav click
        await h.ev("location.reload()");
        await h.ev("new Promise((r) => setTimeout(r, 2500))");
    },
};

// Usage > Workflow (workflow-scan Main.dc.html and States.dc.html), each lens state seeded on a deferred quick run's
// own record. No step clicks an enabled Scan workflow button: that starts a real Opus agent.
const WFS_PROJECT = "verify-workflow-scan";
const WFS_LENS = (kind) => `document.querySelector('[data-workflow-lens="${kind}"]')`;
const WFS_SCAN_BUTTON = `document.querySelector('[data-workflow-scan-button]')`;
const WFS_SEND = `document.querySelector('[data-workflow-send]')`;
const WFS_DETAIL = (kind) => `document.querySelector('[data-workflow-detail="${kind}"]')`;
const WFS_CARD = (id) => `document.querySelector('[data-workflow-card="${id}"]')`;
const WFS_COUNT = (sel) => `document.querySelectorAll(${JSON.stringify(sel)}).length`;
const WFS_DAY_MS = 24 * 60 * 60 * 1000;

// a made-up run id per quote, except p1's first, which is the fixture run itself so its link opens a run that exists
function wfsPattern(ctx, id, title, runs, days, projects, texts) {
    const quotes = texts.map((text, i) => ({
        runid: id === "p1" && i === 0 ? ctx.runId : `${`f0${id}${i}`.padEnd(8, "0")}-0000-4000-8000-000000000000`,
        project: WFS_PROJECT,
        date: "2026-10-2" + i,
        text,
    }));
    return { id, title, fixtarget: "AGENTS.md · Plans", runs, days, projects, quotes };
}

function wfsScan(ctx, extra) {
    const now = Date.now();
    const survivors = [
        wfsPattern(ctx, "p1", "Final's dev app starts on an empty store; scenarios read data it lacks", 4, 2, [{ name: WFS_PROJECT, runs: 4 }], [
            "Final runs on a fresh empty store (final-verify.mjs gives it a new ARC_DEV_DATA_DIR).",
            "It also expects the modal to open in Project scope, but a fresh final store has no projects.",
            "The scenario read the project list, and the final store had none to read.",
            "Step 3 found no runs: the store Final booted was empty.",
        ]),
        wfsPattern(
            ctx,
            "p2",
            "A skipped red step is filed under Differs from plan, not Not verified",
            11,
            7,
            [
                { name: "cyber_anomaly_detector", runs: 7 },
                { name: "cyber_assistant", runs: 2 },
                { name: WFS_PROJECT, runs: 2 },
            ],
            [
                "Red step skipped: I wrote the tests and then the implementation, and ran Maven once afterwards.",
                "Step 2 (watch the tests fail first) was not run on its own: the implementation was written first",
                "The failing run was skipped; the tests were written after the change.",
            ]
        ),
        wfsPattern(ctx, "p3", "Plans put whole-package runs in task steps; no reviewer flags them", 7, 4, [{ name: WFS_PROJECT, runs: 7 }], [
            "I ran Step 9's package-wide verify.mjs, although the worker instructions say to skip whole-package runs.",
            "Step 4 says to run `go test ./pkg/jarvis` for the whole package.",
        ]),
        wfsPattern(ctx, "p4", "Untracked plan copy blocks the land", 12, 6, [{ name: WFS_PROJECT, runs: 12 }], [
            "The land was held: an untracked copy of the plan sits in the tree.",
        ]),
        wfsPattern(ctx, "p5", "Held-store EPERM line reported", 7, 5, [{ name: WFS_PROJECT, runs: 7 }], [
            "EPERM on the held store was reported as a failure again.",
        ]),
    ];
    return {
        state: "picking",
        stage: "checking",
        project: WFS_PROJECT,
        windowdays: 14,
        fromts: now - 14 * WFS_DAY_MS,
        tots: now,
        runs: 47,
        projects: 4,
        candidates: 7,
        kept: 5,
        dropped: 0,
        survivors,
        underfloor: [
            wfsPattern(ctx, "u1", "Plan reviewer cites the wrong spec section", 2, 2, [{ name: WFS_PROJECT, runs: 2 }], [
                "The reviewer quoted a section the spec does not have.",
            ]),
            wfsPattern(ctx, "u2", "Setup junction left behind after cleanup", 1, 1, [{ name: WFS_PROJECT, runs: 1 }], [
                "The node_modules junction was still there after worktree cleanup.",
            ]),
        ],
        verdicts: [
            {
                id: "p1",
                verdict: "suggest",
                file: "AGENTS.md",
                where: "Plans the engine runs",
                fixproject: WFS_PROJECT,
                edit: "+ That app starts on a fresh, empty store: a scenario arranges every record it reads.",
            },
            {
                id: "p2",
                verdict: "suggest",
                file: "pkg/orchestrate/engine.go",
                where: "workerContract",
                fixproject: "waveterm",
                edit: "+ A step the task asked for that you skipped goes under Not verified.",
            },
            {
                id: "p3",
                verdict: "suggest",
                file: "pkg/orchestrate/planreview.go",
                where: "Tests lens",
                fixproject: WFS_PROJECT,
                edit: "- no whole-package runs\n+ no task step runs a whole package, the full suite or the plan's Verify;",
                declinedat: 4,
            },
            { id: "p4", verdict: "covered", note: "8bc284e7" },
            { id: "p5", verdict: "covered", note: "f93850e9" },
        ],
        ...extra,
    };
}

// writes the run's record and waits for the lens to draw the state it maps to
async function wfsSeed(h, ctx, kind, change) {
    await fstWriteRun(h, ctx.runId, (run) => change({ ...run, status: ctx.status }));
    return polishWaitFor(h, `!!${WFS_LENS(kind)}`, 10000);
}

async function wfsHeaderEnabled(h) {
    return h.ev(`${WFS_SCAN_BUTTON} ? !${WFS_SCAN_BUTTON}.disabled : null`);
}

// the stage column as [label, phase, fact]
const WFS_STAGES = `[...document.querySelectorAll('[data-workflow-stage]')].map((s) => [
    s.getAttribute('data-workflow-stage'),
    s.getAttribute('data-phase'),
    s.querySelector('[data-workflow-stage-fact]')?.textContent.trim() ?? null,
])`;
const WFS_ELAPSED = `document.querySelector('[data-workflow-elapsed]')?.textContent.trim() ?? null`;
const WFS_ELAPSED_FORMAT = /^\d+s$|^\d+m \d{2}s$/;

const wfsPhases = (stages) => JSON.stringify((stages ?? []).map((s) => s[1]));
const wfsFact = (stages, label) => (stages ?? []).find((s) => s[0] === label)?.[2] ?? null;

// the head row and its status: text of the status element for the view kind, null when absent
async function wfsHead(h, kind) {
    return h.ev(`({
        head: !!document.querySelector('[data-workflow-head]'),
        headText: document.querySelector('[data-workflow-head]')?.innerText ?? null,
        status: document.querySelector('[data-workflow-status="${kind}"]')?.innerText ?? null,
        elapsed: ${WFS_ELAPSED},
    })`);
}

// a scan at the given stage; the lens kind stays scanning across stages, so the wait is on the stage's own pane
async function wfsSeedScanning(h, ctx, stage, extra) {
    const seeded = await wfsSeed(h, ctx, "scanning", (run) => ({
        ...run,
        workflowscan: wfsScan(ctx, { state: "scanning", stage, ...extra }),
    }));
    const pane = await polishWaitFor(h, `!!${WFS_DETAIL(stage)}`, 10000);
    return seeded && pane;
}

export const workflowScan = {
    name: "workflow-scan",
    surface: "usage",
    async arrange(h) {
        const ctx = { cwd: mkdtempSync(join(tmpdir(), "verify-workflow-scan-")) };
        try {
            const wslist = await h.rpc("workspacelist", null);
            const ch = await h.rpc("createchannel", { name: WFS_PROJECT, projectpath: ctx.cwd });
            ctx.channelId = ch.oid;
            const created = await h.rpc("createrun", {
                channelid: ctx.channelId,
                workspaceid: wslist[0].workspacedata.oid,
                goal: "verify workflow-scan: do nothing",
                runtime: "claude",
                model: "opus",
                mode: "quick",
                deferstart: true,
            });
            ctx.runId = created.run.id;
            ctx.landPath = created.run.landpath;
            ctx.status = created.run.status;
            // lands on the Brief, which installs __openAddress, and re-primes the boot-primed channel list
            await polishReload(h);
            // the fixture channel is the active one, so it is the home project the Scan button starts in
            ctx.openedChannel = await h.ev(openAddressExpr(`channel:${ctx.channelId}`));
            ctx.opened = await h.ev(openAddressExpr(`workflowscan:${ctx.runId}`));
            ctx.shown = await polishWaitFor(h, `!!${WFS_LENS("idle")}`, 10000);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok: !!ok, detail });
        const shot = (name) => h.shot(`cdp-shots/workflow-scan-${name}.png`);
        rec(
            "0. workflowscan:<runid> opened Usage > Workflow on the fixture run",
            ctx.arrangeError == null && ctx.opened?.ok === true && ctx.shown,
            ctx.arrangeError ?? JSON.stringify({ runId: ctx.runId, opened: ctx.opened, shown: ctx.shown })
        );
        if (ctx.arrangeError != null) return steps;

        // 1. idle, no scan yet: the fixture run has no workflowscan field
        const idle = await h.ev(`(() => {
            const lens = ${WFS_LENS("idle")};
            return lens && {
                big: !!lens.querySelector('[data-workflow-idle-scan]'),
                line: (lens.innerText || '').includes('last 14 days · every project'),
                last: !!lens.querySelector('[data-workflow-last]'),
            };
        })()`);
        const idleHeader = await wfsHeaderEnabled(h);
        await shot("idle");
        rec(
            "1. idle: the big Scan workflow button and the window line show, and the header button is enabled",
            idle?.big && idle.line && !idle.last && idleHeader === true,
            JSON.stringify({ idle, header: idleHeader })
        );

        // 2. scanning at the checking stage: the kept patterns under the Opus pane, a ticking clock
        const scanning = await wfsSeedScanning(h, ctx, "checking", { verdicts: [], kept: 5 });
        const stages = await h.ev(WFS_STAGES);
        const scanningHead = await wfsHead(h, "scanning");
        const scanningHeader = await wfsHeaderEnabled(h);
        const keptView = await h.ev(`(() => {
            const pane = ${WFS_DETAIL("checking")};
            const kept = (id) => pane?.querySelector('[data-workflow-kept="' + id + '"]')?.innerText ?? '';
            return {
                rows: pane ? pane.querySelectorAll('[data-workflow-kept]').length : 0,
                p1: kept("p1"),
                p2: kept("p2"),
                text: pane?.innerText ?? '',
            };
        })()`);
        await polishNap(2200);
        const elapsedLater = await h.ev(WFS_ELAPSED);
        await shot("scanning");
        rec(
            "2. scanning at Opus checks files: three stages done, the head row with a ticking clock, five kept rows, the header button disabled",
            scanning &&
                stages?.length === 5 &&
                wfsPhases(stages) === JSON.stringify(["done", "done", "done", "now", "todo"]) &&
                stages[3][0] === "Opus checks files" &&
                scanningHead.head &&
                scanningHead.status != null &&
                WFS_ELAPSED_FORMAT.test(scanningHead.elapsed ?? "") &&
                WFS_ELAPSED_FORMAT.test(elapsedLater ?? "") &&
                elapsedLater !== scanningHead.elapsed &&
                keptView.rows === 5 &&
                keptView.p1.includes("#verify-workflow-scan") &&
                keptView.p2.includes("3 projects") &&
                keptView.text.includes("2 under 3 runs set aside") &&
                wfsFact(stages, "Sonnet patterns") === "7 named" &&
                scanningHeader === false,
            JSON.stringify({ scanning, stages, head: scanningHead, elapsedLater, keptView, header: scanningHeader })
        );

        // 2a. scanning at the patterns stage
        const early = await wfsSeedScanning(h, ctx, "patterns");
        const earlyStages = await h.ev(WFS_STAGES);
        const earlyText = await h.ev(`${WFS_DETAIL("patterns")}?.innerText ?? ''`);
        await shot("scanning-early");
        rec(
            "2a. scanning at Sonnet patterns: the first stage done, the pane says what Sonnet reads",
            early &&
                wfsPhases(earlyStages) === JSON.stringify(["done", "now", "todo", "todo", "todo"]) &&
                earlyText.includes("Sonnet reads 47 runs from 4 projects"),
            JSON.stringify({ early, earlyStages, earlyText })
        );

        // 2b. scanning at the read stage, before the counts exist
        const reading = await wfsSeedScanning(h, ctx, "read", { runs: 0, projects: 0 });
        const readHead = await wfsHead(h, "scanning");
        await shot("scanning-read");
        rec(
            "2b. scanning at the read stage: the head row shows no run count, the read pane shows",
            reading && readHead.head && !(readHead.headText ?? "").includes("runs"),
            JSON.stringify({ reading, head: readHead })
        );

        // 2c. scanning at the recount stage
        const recounting = await wfsSeedScanning(h, ctx, "recount");
        const recountStages = await h.ev(WFS_STAGES);
        const recountText = await h.ev(`${WFS_DETAIL("recount")}?.innerText ?? ''`);
        await shot("scanning-recount");
        rec(
            "2c. scanning at Recount: two stages done, the pane names the pattern count",
            recounting &&
                wfsPhases(recountStages) === JSON.stringify(["done", "done", "now", "todo", "todo"]) &&
                recountText.includes("Recounting 7 patterns"),
            JSON.stringify({ recounting, recountStages, recountText })
        );

        // 3. picking: three suggestions, one raised again, one with its fix in another project
        const picking = await wfsSeed(h, ctx, "picking", (run) => ({ ...run, workflowscan: wfsScan(ctx) }));
        const cards = await h.ev(`({
            cards: ${WFS_COUNT("[data-workflow-card]")},
            raised: ${WFS_COUNT("[data-workflow-raised]")},
            copy: ${WFS_COUNT("[data-workflow-copy]")},
            applyOnElsewhere: !!${WFS_CARD("p2")}?.querySelector('[data-workflow-pick="apply"]'),
            send: ${WFS_SEND}?.textContent ?? null,
        })`);
        const pickingHeader = await wfsHeaderEnabled(h);
        const pickingHead = await wfsHead(h, "picking");
        await shot("picking");
        rec(
            "3. picking: head row with 3 to decide and no clock, three cards, one raised again, Copy for #project instead of Apply on the other project's fix; header disabled",
            picking &&
                pickingHead.head &&
                (pickingHead.status ?? "").includes("3 to decide") &&
                pickingHead.elapsed == null &&
                cards.cards === 3 &&
                cards.raised === 1 &&
                cards.copy === 1 &&
                !cards.applyOnElsewhere &&
                pickingHeader === false,
            JSON.stringify({ picking, cards, head: pickingHead, header: pickingHeader })
        );
        await h.ev(`document.querySelector('[data-workflow-covered-toggle]')?.click()`);
        const covered = await polishWaitFor(h, `${WFS_COUNT('[data-workflow-filed="covered"]')} === 2`, 3000);
        await shot("picking-covered");
        rec("3a. Already covered › expands its two rows in place", covered, JSON.stringify({ covered }));
        await h.ev(`document.querySelector('[data-workflow-under-toggle]')?.click()`);
        const under = await polishWaitFor(h, `${WFS_COUNT('[data-workflow-filed="under"]')} === 2`, 3000);
        await shot("picking-under");
        rec("3b. Under 3 runs › expands its two rows in place", under, JSON.stringify({ under }));

        // 4. Copy for #project: the stub stands in for the clipboard, which a window without OS focus refuses
        await h.ev(notesClipStub(false));
        ctx.clipStubbed = true;
        await h.ev(`document.querySelector('[data-workflow-copy="p2"]')?.click()`);
        const copied = await polishWaitFor(h, `document.querySelector('[data-workflow-copy="p2"]')?.textContent.trim() === 'Copied'`, 3000);
        const clip = await h.ev(`window.__notesClip ?? null`);
        await shot("copied");
        rec("4. Copy for #waveterm shows Copied", copied, JSON.stringify({ copied, clip }));

        // 5. Apply one card, Drop another: the reason field shows and the send waits for a reason
        await h.ev(`${WFS_CARD("p3")}?.querySelector('[data-workflow-pick="apply"]')?.click()`);
        await h.ev(`${WFS_CARD("p1")}?.querySelector('[data-workflow-pick="drop"]')?.click()`);
        const reasonShown = await polishWaitFor(h, `!!document.querySelector('[data-workflow-reason="p1"]')`, 3000);
        const before = await h.ev(`({ label: ${WFS_SEND}?.textContent.trim(), disabled: ${WFS_SEND}?.disabled })`);
        await h.ev(setInputExpr(`document.querySelector('[data-workflow-reason="p1"]')`, "covered by the Final store notes"));
        const enabled = await polishWaitFor(h, `${WFS_SEND}?.disabled === false`, 3000);
        await shot("drop-reason");
        rec(
            "5. Drop shows a reason field; the button reads Apply 1, decline 1 and is disabled until a reason is typed",
            reasonShown && before?.label === "Apply 1, decline 1" && before.disabled === true && enabled,
            JSON.stringify({ reasonShown, before, enabled })
        );

        // 6. send: the picks are stored and the state is applying before the delivery, which the fixture's missing
        // agent fails
        await h.ev(`${WFS_SEND}?.click()`);
        let stored = null;
        for (let i = 0; i < 40; i++) {
            const ws = (await waveService(h, "object", "GetObject", [`run:${ctx.runId}`]))?.workflowscan;
            stored = { state: ws?.state, picks: ws?.picks ?? [] };
            if (stored.state === "applying" && stored.picks.length === 2) break;
            await polishNap(250);
        }
        const deliveryError = await polishWaitFor(h, `!!${WFS_LENS("applying")}?.querySelector('[data-workflow-send-error]')`, 10000);
        const errorText = await h.ev(`document.querySelector('[data-workflow-send-error]')?.textContent ?? null`);
        const applyingHeader = await wfsHeaderEnabled(h);
        const applyingHead = await wfsHead(h, "applying");
        const applyingStages = await h.ev(WFS_STAGES);
        const applyingPane = await h.ev(`({
            text: ${WFS_DETAIL("applying")}?.innerText ?? '',
            error: !!${WFS_DETAIL("applying")}?.querySelector('[data-workflow-send-error]'),
        })`);
        await shot("applying");
        const wantPicks = [
            { id: "p1", pick: "drop", reason: "covered by the Final store notes" },
            { id: "p3", pick: "apply" },
        ];
        rec(
            "6. sent: the record holds the picks and applying, the applying pane holds the delivery error and the sent line, the head reads applying your picks, the header stays disabled",
            stored?.state === "applying" &&
                JSON.stringify(stored.picks) === JSON.stringify(wantPicks) &&
                deliveryError &&
                applyingPane.error &&
                applyingPane.text.includes("Apply 1, decline 1 sent") &&
                wfsPhases(applyingStages) === JSON.stringify(["done", "done", "done", "done", "now"]) &&
                (applyingHead.status ?? "").includes("applying your picks") &&
                applyingHead.elapsed == null &&
                applyingHeader === false,
            JSON.stringify({ stored, deliveryError, errorText, head: applyingHead, applyingStages, applyingPane, header: applyingHeader })
        );

        // 7. done, with a commit and a row per pick
        const commit = "3f9c2d1e8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d";
        const done = await wfsSeed(h, ctx, "done", (run) => ({
            ...run,
            status: "done",
            endcommit: commit,
            workflowscan: wfsScan(ctx, {
                state: "applying",
                picks: [
                    { id: "p1", pick: "apply" },
                    { id: "p3", pick: "apply" },
                    { id: "p2", pick: "drop", reason: "the fix lives in waveterm" },
                ],
            }),
        }));
        const doneView = await h.ev(`({
            commit: document.querySelector('[data-workflow-commit]')?.textContent.trim() ?? null,
            rows: [...document.querySelectorAll('[data-workflow-done-row]')].map((r) => r.getAttribute('data-workflow-done-row')),
        })`);
        const doneHeader = await wfsHeaderEnabled(h);
        const doneHead = await wfsHead(h, "done");
        const doneStages = await h.ev(WFS_STAGES);
        const doneInPane = await h.ev(`!!${WFS_DETAIL("done")}?.querySelector('[data-workflow-commit]')`);
        await shot("done");
        rec(
            "7. done: all five stages done with their facts, the commit and three rows in the pane, the head reads done, and the header button enabled",
            done &&
                doneView.commit === commit.slice(0, 8) &&
                JSON.stringify(doneView.rows) === JSON.stringify(["applied", "applied", "declined"]) &&
                doneInPane &&
                wfsPhases(doneStages) === JSON.stringify(["done", "done", "done", "done", "done"]) &&
                wfsFact(doneStages, "Opus checks files") === "3 suggested · 2 covered" &&
                wfsFact(doneStages, "Your picks") === "2 applied · 1 declined" &&
                (doneHead.status ?? "").includes("done") &&
                doneHead.elapsed == null &&
                doneHeader === true,
            JSON.stringify({ done, doneView, doneInPane, doneStages, head: doneHead, header: doneHeader })
        );
        const runSheetOpen = `(() => {
            const sheet = document.querySelector('[data-run-sheet]');
            return !!sheet && (sheet.innerText || '').includes('verify workflow-scan');
        })()`;
        await h.ev(`document.querySelector('[data-workflow-open-diff]')?.click()`);
        const diffSheet = await polishWaitFor(h, runSheetOpen, 10000);
        const diffSurface = await h.activeSurfaceLabel();
        await shot("open-in-diff");
        rec(
            "7a. Open in Diff opens the scan run's sheet on the Brief",
            diffSheet && diffSurface === SURFACE_LABEL.jarvis,
            JSON.stringify({ diffSheet, diffSurface })
        );
        await h.goto("usage");
        const back = await polishWaitFor(h, `!!${WFS_LENS("done")}`, 5000);
        const repicking = await wfsSeed(h, ctx, "picking", (run) => ({ ...run, endcommit: "", workflowscan: wfsScan(ctx) }));
        await h.ev(`document.querySelector('[data-workflow-quote-run="${ctx.runId}"]')?.click()`);
        const quoteSheet = await polishWaitFor(h, runSheetOpen, 10000);
        const quoteSurface = await h.activeSurfaceLabel();
        await shot("open-quote-run");
        rec(
            "7b. back on Usage > Workflow, a quote's run id opens that run",
            back && repicking && quoteSheet && quoteSurface === SURFACE_LABEL.jarvis,
            JSON.stringify({ back, repicking, quoteSheet, quoteSurface })
        );
        await h.goto("usage");

        // 8. nothing to suggest, with the Not raised list
        const nothing = await wfsSeed(h, ctx, "nothing", (run) => ({
            ...run,
            status: "done",
            workflowscan: wfsScan(ctx, {
                verdicts: [
                    { id: "p1", verdict: "covered", note: "AGENTS.md" },
                    { id: "p2", verdict: "covered", note: "8bc284e7" },
                    { id: "p3", verdict: "declined", declinedat: 7 },
                    { id: "p4", verdict: "covered", note: "8bc284e7" },
                    { id: "p5", verdict: "covered", note: "f93850e9" },
                ],
            }),
        }));
        const notRaised = await h.ev(`(() => {
            const pane = ${WFS_DETAIL("nothing")};
            return {
                title: (${WFS_LENS("nothing")}?.innerText || '').includes('Nothing to suggest'),
                rows: [...document.querySelectorAll('[data-workflow-filed]')].map((r) => r.getAttribute('data-workflow-filed')),
                inPane: pane ? pane.querySelectorAll('[data-workflow-filed]').length : 0,
                heading: (pane?.innerText || '').includes('Not raised'),
            };
        })()`);
        const nothingHead = await wfsHead(h, "nothing");
        const nothingStages = await h.ev(WFS_STAGES);
        await shot("nothing");
        rec(
            "8. nothing to suggest: one pane holds the Not raised heading and the covered, declined and under-floor rows, the head reads done",
            nothing &&
                notRaised.title &&
                JSON.stringify(notRaised.rows) ===
                    JSON.stringify(["covered", "covered", "covered", "covered", "declined", "under", "under"]) &&
                notRaised.inPane === notRaised.rows.length &&
                notRaised.heading &&
                wfsFact(nothingStages, "Your picks") === "none to pick" &&
                (nothingHead.status ?? "").includes("done"),
            JSON.stringify({ nothing, notRaised, nothingStages, head: nothingHead })
        );

        // 9. a cancelled run left in scanning blocks nothing
        const cancelled = await wfsSeed(h, ctx, "idle", (run) => ({
            ...run,
            status: "cancelled",
            workflowscan: wfsScan(ctx, { state: "scanning", stage: "patterns" }),
        }));
        const cancelledLast = await h.ev(`document.querySelector('[data-workflow-last="cancelled"]')?.textContent.trim() ?? null`);
        const cancelledHeader = await wfsHeaderEnabled(h);
        const cancelledChrome = await h.ev(`({ head: ${WFS_COUNT("[data-workflow-head]")}, stage: ${WFS_COUNT("[data-workflow-stage]")} })`);
        await shot("cancelled");
        rec(
            "9. a cancelled run left scanning shows as idle with its last: line, no head row or stage rows, and the header button is enabled",
            cancelled &&
                /^last: \d\d-\d\d · cancelled$/.test(cancelledLast ?? "") &&
                cancelledChrome.head === 0 &&
                cancelledChrome.stage === 0 &&
                cancelledHeader === true,
            JSON.stringify({ cancelled, cancelledLast, chrome: cancelledChrome, header: cancelledHeader })
        );

        // 10. failed: idle, with the last: line and the error
        const failure = "the Sonnet reply had no json block";
        const failed = await wfsSeed(h, ctx, "idle", (run) => ({
            ...run,
            workflowscan: wfsScan(ctx, { state: "failed", error: failure }),
        }));
        const failedLast = await h.ev(`document.querySelector('[data-workflow-last="failed"]')?.textContent.trim() ?? null`);
        const failedHeader = await wfsHeaderEnabled(h);
        const failedChrome = await h.ev(`({ head: ${WFS_COUNT("[data-workflow-head]")}, stage: ${WFS_COUNT("[data-workflow-stage]")} })`);
        await shot("failed");
        rec(
            "10. failed shows as idle with its last: line and the error, no head row or stage rows",
            failed &&
                (failedLast ?? "").includes("failed") &&
                (failedLast ?? "").includes(failure) &&
                failedChrome.head === 0 &&
                failedChrome.stage === 0 &&
                failedHeader === true,
            JSON.stringify({ failed, failedLast, chrome: failedChrome, header: failedHeader })
        );
        return steps;
    },
    async teardown(h, ctx) {
        await teardownFixtureRun(
            h,
            ctx,
            "workflow-scan",
            ctx.clipStubbed ? { what: "restore the clipboard", fn: () => h.ev(NOTES_CLIP_RESTORE) } : undefined
        );
    },
};

// The ways into Usage > Workflow (workflow-scan Palette.dc.html): the palette's Start row, the project action, and the
// Needs you item in the palette and on the Brief. Steps 1 and 2 never fire the row or the action: that starts a real
// Opus agent, so their start calls are unit-tested. A registered project, not a bare channel: only a registered one
// is listed under Projects.
const WFE_PROJECT = "verify-workflow-scan-entry";
const WFE_SCAN_ECHO = "Starts a scan, opens Usage › Workflow";
// one 10s attention poll and room for it to land
const WFE_ATTENTION_WAIT_MS = 15_000;
const WFE_LENS_PRESSED = `[...document.querySelectorAll('[role="group"][aria-label="Lens"] button[aria-pressed="true"]')].map((b) => b.textContent.trim())`;

// moves the palette's selection down until it sits on a row the predicate takes
async function wfeSelect(h, ok) {
    let state = await h.ev(PALETTE_STATE);
    for (let i = 0; i < 30 && state != null && !ok(state.selected ?? ""); i++) {
        await h.ev(paletteKey("ArrowDown"));
        await polishNap(100);
        state = await h.ev(PALETTE_STATE);
    }
    return state;
}

// Usage with the Workflow lens pressed, drawing the seeded run's picking state
async function wfeOnWorkflowLens(h) {
    const shown = await polishWaitFor(h, `!!${WFS_LENS("picking")}`, 10000);
    return { shown, pressed: await h.ev(WFE_LENS_PRESSED) };
}

export const workflowScanEntry = {
    name: "workflow-scan-entry",
    surface: "jarvis",
    async arrange(h) {
        const ctx = { cwd: mkdtempSync(join(tmpdir(), "verify-workflow-scan-entry-")) };
        try {
            await h.rpc("createproject", { name: WFE_PROJECT, path: ctx.cwd });
            ctx.project = WFE_PROJECT;
            await waitForProjectInConfig(h, WFE_PROJECT);
            const norm = (p) => (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
            const channels = (await h.rpc("getchannels", null))?.channels ?? [];
            ctx.channelId = channels.find((c) => norm(c.projectpath) === norm(ctx.cwd))?.oid;
            if (!ctx.channelId) throw new Error("createproject made no channel at the project's path");
            const wslist = await h.rpc("workspacelist", null);
            const created = await h.rpc("createrun", {
                channelid: ctx.channelId,
                workspaceid: wslist[0].workspacedata.oid,
                goal: "verify workflow-scan-entry: do nothing",
                runtime: "claude",
                model: "opus",
                mode: "quick",
                deferstart: true,
            });
            ctx.runId = created.run.id;
            ctx.landPath = created.run.landpath;
            ctx.status = created.run.status;
            // the channel and project lists are boot-primed
            await polishReload(h);
            // the fixture project is the active one, so it is the palette's home project
            ctx.openedChannel = await h.ev(openAddressExpr(`channel:${ctx.channelId}`));
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok: !!ok, detail });
        const shot = (name) => h.shot(`cdp-shots/workflow-scan-entry-${name}.png`);
        if (ctx.arrangeError != null) {
            rec("0. a registered project with one deferred quick run was made", false, ctx.arrangeError);
            return steps;
        }
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);

        // 1. the Start row, typed for and selected but never run
        const opened = await openPalette(h);
        await h.ev(setInputExpr(PALETTE_INPUT, "scan"));
        await paletteStateWhen(h, (s) => s.groups.some((g) => g.label === "Start" && g.rows.some((r) => r.startsWith("Scan workflow"))), 5000);
        const typed = await wfeSelect(h, (sel) => sel.startsWith("Scan workflow") && sel.includes(`#${WFE_PROJECT}`));
        const startGroup = typed?.groups.find((g) => g.label === "Start");
        await shot("start-row");
        rec(
            "1. typing scan shows the Scan workflow Start row in the home project, verb Start and its echo",
            opened &&
                (startGroup?.rows ?? []).some((r) => r.startsWith("Scan workflow") && r.includes(`#${WFE_PROJECT}`)) &&
                (typed?.selected ?? "").includes("Start") &&
                (typed?.text ?? "").includes(WFE_SCAN_ECHO),
            JSON.stringify({ opened, selected: typed?.selected, groups: typed?.groups })
        );

        // 2. the project's actions, drilled into but never run
        await h.ev(setInputExpr(PALETTE_INPUT, ""));
        await h.ev(setInputExpr(PALETTE_INPUT, "p:"));
        await paletteStateWhen(h, (s) => s.token === "Projects", 2000);
        await h.ev(setInputExpr(PALETTE_INPUT, WFE_PROJECT));
        await paletteStateWhen(h, (s) => (s.selected ?? "").includes(`#${WFE_PROJECT}`) && s.chip, 8000);
        await h.ev(paletteKey("ArrowRight"));
        const acts = await paletteStateWhen(h, (s) => s.drill != null && s.groups.some((g) => g.label === "Steer"), 3000);
        const steer = acts?.groups.find((g) => g.label === "Steer")?.rows ?? [];
        const newRunAt = steer.findIndex((r) => r.startsWith("New run in it"));
        await shot("project-actions");
        rec(
            "2. Projects › #fixture lists Scan workflow right after New run in it",
            (acts?.drill ?? "").includes(`#${WFE_PROJECT}`) && newRunAt >= 0 && (steer[newRunAt + 1] ?? "").startsWith("Scan workflow"),
            JSON.stringify({ drill: acts?.drill, groups: acts?.groups })
        );
        await h.ev(PEEKS_ESC);
        await polishWaitFor(h, `!${PALETTE_INPUT}`, 2000);

        // 3. a scan waiting on picks is a Needs you review, opening Usage › Workflow
        await fstWriteRun(h, ctx.runId, (run) => ({ ...run, status: ctx.status, workflowscan: wfsScan(ctx, { project: WFE_PROJECT }) }));
        await openPalette(h);
        await h.ev(setInputExpr(PALETTE_INPUT, "n:"));
        const needs = await paletteStateWhen(
            h,
            (s) => s.token === "Needs you" && s.groups.some((g) => g.label.startsWith("Reviews") && g.rows.some((r) => r.includes("workflow scan"))),
            WFE_ATTENTION_WAIT_MS
        );
        // the group label carries its count: "Reviews · 1"
        const reviewRow = needs?.groups.find((g) => g.label.startsWith("Reviews"))?.rows.find((r) => r.includes("workflow scan"));
        await wfeSelect(h, (sel) => sel.includes("workflow scan"));
        await shot("needs-row");
        await h.ev(paletteKey("Enter"));
        const fromPalette = await wfeOnWorkflowLens(h);
        await shot("needs-opened");
        rec(
            "3. the seeded picking run is a workflow scan row under Needs you › Reviews, opening Usage with Workflow pressed",
            reviewRow != null && fromPalette.shown && JSON.stringify(fromPalette.pressed) === JSON.stringify(["Workflow"]),
            JSON.stringify({ reviewRow, groups: needs?.groups, ...fromPalette })
        );

        // 4. the same item in the Brief's attention queue; the lens is set back first, so the click has to press it
        await h.ev(clickByText(`document.querySelector('[role="group"][aria-label="Lens"]')`, "button", "By provider"));
        await polishWaitFor(h, `!document.querySelector('[data-workflow-lens]')`, 3000);
        await h.goto("jarvis");
        const queueRow = `[...document.querySelectorAll('[data-jarvis-brief-row="queue"]')].find((r) => /workflow scan/.test(r.innerText || ''))`;
        // the queue's rows sit behind its summary's disclosure
        const summary = `document.querySelector('[data-jarvis-brief-attention-summary]')`;
        await polishWaitFor(h, `/workflow scan/.test(${summary}?.innerText || '')`, WFE_ATTENTION_WAIT_MS);
        await h.ev(`${summary}?.getAttribute('aria-expanded') === 'false' && ${summary}.click()`);
        const listed = await polishWaitFor(h, `!!${queueRow}`, 5000);
        const queueText = await h.ev(`(${queueRow})?.innerText?.replace(/\\s+/g, ' ').trim() ?? null`);
        await shot("brief-row");
        await h.ev(`${queueRow}?.click()`);
        const fromBrief = await wfeOnWorkflowLens(h);
        await shot("brief-opened");
        rec(
            "4. the Brief's attention queue lists a workflow scan row, opening Usage › Workflow",
            listed && fromBrief.shown && JSON.stringify(fromBrief.pressed) === JSON.stringify(["Workflow"]),
            JSON.stringify({ listed, queueText, ...fromBrief })
        );
        return steps;
    },
    async teardown(h, ctx) {
        await h.ev(PEEKS_ESC).catch(() => {});
        await teardownFixtureRun(h, ctx, "workflow-scan-entry", {
            what: "delete the project",
            fn: () => (ctx.project ? h.rpc("deleteproject", { name: ctx.project }) : null),
        });
    },
};
