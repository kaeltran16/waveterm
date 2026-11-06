// The project Overview's Activity region (frontend/app/view/agents/projectactivity.tsx), checked inside the scenario
// scenarios-project-overview.mjs. It starts and ends with the modal open on ctx.project, restores in a finally
// whatever it installed, and names its steps "project-overview: <Board> board, activity: <state>".
//
// Every state is driven by the usage store's DEV fixture (wave:dev-usage-buckets): a usage reply whose sessions sit
// in ctx.dir, with delayMs for loading and fail for the failure. Each step seeds it, reopens the modal so the region
// re-reads, and puts the previous value back in its finally.
import { closeOverview, openOverview, pageEval, shot } from "./project-overview-kit.mjs";
import { lookHover, restoreLocalStorage } from "./scenarios-shared.mjs";

const FIXTURE_KEY = "wave:dev-usage-buckets";
const WEEKS = 53;
const BUSY_WEEKS = 40;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const dayDate = (n) => {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - n);
    return d;
};
const dayKey = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayAgo = (n) => dayKey(dayDate(n));
// the app's formatTokens (agentsviewmodel.ts)
const fmt = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const tipTitle = (n) => {
    const d = dayDate(n);
    return `${DAY_NAMES[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
};

const bucket = (session, day, tokens) => ({
    harness: "claude",
    provider: "anthropic",
    model: "claude-opus-4-5",
    day,
    session,
    input: tokens,
    output: 0,
    reasoning: 0,
    cacheread: 0,
    cachecreate: 0,
    cachecreate1h: 0,
    msgs: 4,
});

// one session a day over the last BUSY_WEEKS weeks, skipping every fifth day, the oldest day included; two of the
// last week's sessions belong to runs
function busyFixture(dir) {
    const buckets = [];
    const sessions = [];
    const byAgo = new Map();
    for (let i = 0; i < BUSY_WEEKS * 7; i++) {
        if (i % 5 === 2) continue;
        const tokens = 8000 + ((i * 37) % 90) * 1000;
        const id = `ov-busy-${i}`;
        buckets.push(bucket(id, dayAgo(i), tokens));
        const runid = i === 1 ? "ov-run-a" : i === 3 ? "ov-run-b" : undefined;
        sessions.push({ harness: "claude", session: id, title: `busy ${i}`, project: dir, ...(runid ? { runid } : {}) });
        byAgo.set(i, tokens);
    }
    const oldest = BUSY_WEEKS * 7 - 1;
    let total = 0;
    let weekTokens = 0;
    let weekSessions = 0;
    for (const [ago, t] of byAgo) {
        total += t;
        if (ago < 7) {
            weekTokens += t;
            weekSessions += 1;
        }
    }
    return {
        reply: { buckets, sessions },
        total,
        oldest,
        byAgo,
        weekLine: `${fmt(weekTokens)} tokens · ${weekSessions} sessions · 2 runs`,
    };
}

// the Quiet board: two sessions on Tuesday and Thursday of the week three weeks back, nothing since
function quietFixture(dir) {
    const back = dayDate(21);
    const mondayAgo = 21 + ((back.getDay() + 6) % 7);
    const days = [mondayAgo - 1, mondayAgo - 3];
    const tokens = [20_000, 18_000];
    return {
        reply: {
            buckets: days.map((ago, i) => bucket(`ov-quiet-${i}`, dayAgo(ago), tokens[i])),
            sessions: days.map((_, i) => ({ harness: "claude", session: `ov-quiet-${i}`, project: dir })),
        },
        days: days.map(dayAgo),
        total: tokens[0] + tokens[1],
    };
}

const seed = (h, value) => h.ev(`localStorage.setItem('${FIXTURE_KEY}', ${JSON.stringify(JSON.stringify(value))})`);

async function reopen(h, ctx) {
    await closeOverview(h);
    return openOverview(h, ctx.project);
}

// the region's reads, from inside the open modal
const REGION = `
    const region = () => overview()?.querySelector('[data-overview-region="activity"]');
    const cells = () => [...(region()?.querySelectorAll("[data-activity-day]") ?? [])];
    const cell = (day) => region()?.querySelector('[data-activity-day="' + day + '"]');
    const headCount = () => flat(region()?.querySelector("section > div")?.children[1]);
    const tip = () => region()?.querySelector('[role="tooltip"]');
    const grid = () => region()?.querySelector('[role="group"]');
    const box = (el) => { const b = el?.getBoundingClientRect(); return b && { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom), x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; };
`;
const regionEval = (h, body) => pageEval(h, `${REGION} ${body}`);

// the centre of the day's cell, scrolled into view, for a real pointer move
const cellCentre = (h, day) =>
    regionEval(h, `
        cell(${JSON.stringify(day)})?.scrollIntoView({ block: "nearest" });
        await nap(150);
        return box(cell(${JSON.stringify(day)}));
    `);

async function hoverDay(h, day) {
    const c = await cellCentre(h, day);
    if (c == null) return null;
    await lookHover(h, 1, 1);
    await lookHover(h, c.x, c.y);
    return regionEval(h, `
        await until(() => tip() != null, 2000);
        return { cell: box(cell(${JSON.stringify(day)})), tip: box(tip()), region: box(region()), text: flat(tip()) };
    `);
}

export async function steps(h, ctx) {
    const steps = [];
    const prev = await h.ev(`localStorage.getItem('${FIXTURE_KEY}')`);
    const busy = busyFixture(ctx.dir);
    try {
        // Main board: a busy calendar
        await seed(h, busy.reply);
        const opened = await reopen(h, ctx);
        const firstDay = dayAgo(busy.oldest);
        const main = await regionEval(h, `
            const drawn = await until(() => cells().length > 0, 8000);
            const all = cells();
            const before = all.filter((c) => c.dataset.state === "before").map((c) => c.dataset.activityDay);
            return {
                drawn,
                count: all.length,
                head: headCount(),
                lastWeek: flat(region()?.querySelector("[data-activity-lastweek]")),
                legend: flat(region()?.querySelector("[data-activity-legend]")),
                beforeCount: before.length,
                beforeAllEarlier: before.every((d) => d < ${JSON.stringify(firstDay)}),
                firstState: cell(${JSON.stringify(firstDay)})?.dataset.state,
                dayBeforeFirst: cell(${JSON.stringify(dayAgo(busy.oldest + 1))})?.dataset.state,
                colored: all.filter((c) => c.dataset.level && c.dataset.level !== "0").length,
            };
        `);
        await shot(h, "activity-busy");
        steps.push({
            step: "project-overview: Main board, activity: a busy calendar with its total, last 7 days and legend",
            ok:
                opened?.shown === true &&
                main?.drawn === true &&
                main.count === WEEKS * 7 &&
                main.head === `${fmt(busy.total)} tokens` &&
                main.lastWeek === `last 7 days ${busy.weekLine}` &&
                main.legend === "lessmorebefore Arc tracked it" &&
                main.beforeCount > 0 &&
                main.beforeAllEarlier === true &&
                main.firstState === "tracked" &&
                main.dayBeforeFirst === "before" &&
                main.colored === busy.byAgo.size,
            detail: JSON.stringify({ main, want: { total: fmt(busy.total), week: busy.weekLine, firstDay } }),
        });

        // Main board: hover shows the tooltip beside the cell; the arrow keys move the focused day
        // a day well left of the columns where the tooltip flips
        const hoverAgo = 200 + (busy.byAgo.has(200) ? 0 : 1);
        const hovered = await hoverDay(h, dayAgo(hoverAgo));
        await shot(h, "activity-tooltip");
        const wantLine = `${fmt(busy.byAgo.get(hoverAgo))} tokens · 1 session`;
        await lookHover(h, 1, 1);
        const keys = await regionEval(h, `
            await until(() => tip() == null, 2000);
            const today = cells().find((c) => c.tabIndex === 0);
            today?.focus();
            await nap(100);
            const start = document.activeElement?.dataset.activityDay;
            document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
            await nap(200);
            return { start, after: document.activeElement?.dataset.activityDay, tip: flat(tip()) };
        `);
        await shot(h, "activity-keys");
        steps.push({
            step: "project-overview: Main board, activity: hover shows the day's tooltip, ArrowLeft moves the focused day",
            ok:
                hovered?.text === `${tipTitle(hoverAgo)}${wantLine}` &&
                hovered.tip.left >= hovered.cell.right &&
                keys?.start === dayAgo(0) &&
                keys.after === dayAgo(7) &&
                keys.tip.startsWith(tipTitle(7)),
            detail: JSON.stringify({ hovered, keys, want: { title: tipTitle(hoverAgo), line: wantLine } }),
        });
        await regionEval(h, `document.activeElement?.blur();`);

        // Main board: near the right edge the tooltip opens to the cell's left, inside the region
        const edgeAgo = 16;
        const edge = await hoverDay(h, dayAgo(edgeAgo));
        await shot(h, "activity-tooltip-flipped");
        await lookHover(h, 1, 1);
        steps.push({
            step: "project-overview: Main board, activity: in the last 5 columns the tooltip flips to the cell's left",
            ok:
                edge != null &&
                edge.tip != null &&
                edge.tip.right <= edge.cell.left &&
                edge.tip.left >= edge.region.left &&
                edge.tip.right <= edge.region.right &&
                edge.text.startsWith(tipTitle(edgeAgo)),
            detail: JSON.stringify(edge),
        });

        // Main board: loading shows skeleton lines, no count and no grid
        await seed(h, { ...busy.reply, delayMs: 4000 });
        await reopen(h, ctx);
        const loading = await regionEval(h, `
            await nap(300);
            return {
                skeletons: region()?.querySelectorAll(".animate-pulse").length ?? 0,
                cells: cells().length,
                head: headCount(),
            };
        `);
        await shot(h, "activity-loading");
        steps.push({
            step: "project-overview: Main board, activity: loading shows skeleton lines",
            ok: loading?.skeletons > 0 && loading.cells === 0 && loading.head === "",
            detail: JSON.stringify(loading),
        });

        // Quiet board: two sessions three weeks back, nothing since
        const quiet = quietFixture(ctx.dir);
        await seed(h, quiet.reply);
        await reopen(h, ctx);
        const q = await regionEval(h, `
            await until(() => cells().length > 0, 8000);
            const all = cells();
            const seeded = ${JSON.stringify(quiet.days)};
            const first = seeded.slice().sort()[0];
            const since = all.filter((c) => c.dataset.state !== "future" && c.dataset.activityDay > first && !seeded.includes(c.dataset.activityDay));
            const before = all.filter((c) => c.dataset.activityDay < first);
            return {
                head: headCount(),
                seededLevels: seeded.map((d) => cell(d)?.dataset.level),
                sinceTrackedZero: since.length > 0 && since.every((c) => c.dataset.state === "tracked" && c.dataset.level === "0"),
                beforeDashed: before.length > 0 && before.every((c) => c.dataset.state === "before"),
                lastWeek: flat(region()?.querySelector("[data-activity-lastweek]")),
                legend: region()?.querySelector("[data-activity-legend]") != null,
            };
        `);
        await shot(h, "activity-quiet");
        steps.push({
            step: "project-overview: Quiet board, activity: two old sessions colored, tracked days since at 0, earlier dashed",
            ok:
                q?.head === `${fmt(quiet.total)} tokens` &&
                q.seededLevels.every((l) => l != null && l !== "0") &&
                q.sinceTrackedZero === true &&
                q.beforeDashed === true &&
                q.lastWeek === "last 7 days no sessions" &&
                q.legend === true,
            detail: JSON.stringify(q),
        });

        // Failures board: a failed read shows the alert; Retry with a good fixture draws the calendar
        await seed(h, { fail: true });
        await reopen(h, ctx);
        const failed = await regionEval(h, `
            await until(() => region()?.querySelector('[role="alert"]') != null, 8000);
            return { alert: flat(region()?.querySelector('[role="alert"]')), head: headCount(), cells: cells().length };
        `);
        await shot(h, "activity-failed");
        await seed(h, busy.reply);
        const retried = await regionEval(h, `
            [...(region()?.querySelectorAll("button") ?? [])].find((b) => flat(b) === "Retry")?.click();
            const drawn = await until(() => cells().length > 0, 8000);
            return { drawn, alert: region()?.querySelector('[role="alert"]') != null, head: headCount() };
        `);
        await shot(h, "activity-retried");
        steps.push({
            step: "project-overview: Failures board, activity: a failed read names its reason; Retry draws the calendar",
            ok:
                failed?.alert === "Could not read activity: dev usage fixture: fail.Retry" &&
                failed.head === "" &&
                failed.cells === 0 &&
                retried?.drawn === true &&
                retried.alert === false &&
                retried.head === `${fmt(busy.total)} tokens`,
            detail: JSON.stringify({ failed, retried }),
        });
    } finally {
        await h.ev(restoreLocalStorage(FIXTURE_KEY, prev));
        await reopen(h, ctx).catch(() => {});
    }
    return steps;
}

export async function cleanup(_h, _ctx) {}
