// Scenario `workspace-run-activity`: the Run tab's Activity view (docs/superpowers/plans/2026-11-18-run-tab-polish.md;
// boards Main and Done). The run and the lead that links it are the shared fixture's (workspace-run-fixture.mjs).
// The expected rows are the fixture's events grouped by hand: one phase of one task within 3m is one row, newest first,
// and the 3.4m between Lead started and Plan reviewed is the one quiet gap.

import { polishNap } from "./scenarios-shared.mjs";
import { ANSWERED_A, ANSWERED_Q, arrange, clickAt, openRunTab, page, pickView, reseed, RUN_TAB, SETTLE_MS, stepper, teardown } from "./workspace-run-fixture.mjs";

const NAME = "workspace-run-activity";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
const ACTIVITY = `${RUN_TAB}?.querySelector("[data-workspace-run-activity]")`;
const LIVE_EVENTS = 23;
const DONE_EVENTS = 43;
// a row by its task ("dag" for a run-level row), a gap as "gap", in drawn order
const MAIN_ROWS = ["t-5", "t-5", "t-6", "t-2", "t-2", "t-3", "t-4", "t-1", "t-1", "t-1", "t-2", "t-5", "t-6", "dag", "gap", "dag", "dag"];
// t-6's failure, t-3's open question and t-1's answered one
const ATTENTION_ROWS = ["t-6", "t-3", "t-1"];
const ATTENTION_EVENTS = 6;
const T3_EVENTS = 2;
const FADED = "0.2";

// the Activity view as drawn: the strip's ticks, the filters, the rows and gaps in order, the now marker
const readActivity = (h) =>
    page(
        h,
        `const view = ${ACTIVITY};
        const q = (sel) => view?.querySelector(sel);
        const filter = (id) => {
            const b = q('[data-timeline-filter="' + id + '"]');
            return b ? { on: b.getAttribute("aria-pressed") === "true", label: flat(b), count: flat(b.querySelector("[data-timeline-filter-count]")) || null } : null;
        };
        return {
            drawn: view != null,
            ticks: [...(view?.querySelectorAll("[data-timeline-strip] rect") ?? [])].map((r) => ({ task: r.dataset.tickTask ?? "", opacity: r.getAttribute("opacity") })),
            stripEnd: flat(q("[data-timeline-strip-end]")),
            filters: { all: filter("all"), task: filter("task"), attention: filter("attention") },
            rows: [...(view?.querySelectorAll("[data-timeline-row], [data-timeline-gap]") ?? [])].map((el) =>
                el.matches("[data-timeline-gap]") ? "gap" : el.dataset.timelineTask ?? "dag"
            ),
            titles: [...(view?.querySelectorAll("[data-timeline-row]") ?? [])].map((el) => flat(el)),
            gap: flat(q("[data-timeline-gap]")),
            now: flat(q("[data-timeline-now]")),
            open: [...(view?.querySelectorAll("[data-timeline-row-detail]") ?? [])].map((d) => ({ entries: d.children.length, text: flat(d) })),
            chrome: /Lifecycle|Relaunch lead/.test(view?.textContent ?? ""),
        };`
    );

const clickFilter = async (h, id) => {
    await h.ev(`${ACTIVITY}?.querySelector('[data-timeline-filter="${id}"]')?.click()`);
    await polishNap(SETTLE_MS);
};

export const workspaceRunActivity = {
    name: NAME,
    surface: "agent",
    arrange: (h) => arrange(h, NAME),
    async assert(h, ctx) {
        const { steps, rec, step } = stepper();
        if (ctx.arrangeError != null) {
            rec(`${NAME}: arrange`, false, ctx.arrangeError);
            return steps;
        }

        // Main board
        await step("Activity: strip with ticks, All / Task / Attention with counts, grouped rows newest first, a quiet gap, now marker (Main board)", async () => {
            const opened = await openRunTab(h);
            const t = await pickView(h, "activity");
            const a = await readActivity(h);
            await h.shot(SHOT(1, "activity"));
            const f = a.filters;
            const ok =
                opened &&
                t.view === "activity" &&
                a.ticks.length === LIVE_EVENTS &&
                f.all?.on === true &&
                f.all.count === String(LIVE_EVENTS) &&
                f.task?.label === "Task" &&
                f.task.count == null &&
                f.attention?.count === String(ATTENTION_EVENTS) &&
                JSON.stringify(a.rows) === JSON.stringify(MAIN_ROWS) &&
                a.gap.endsWith("3m quiet") &&
                a.now.startsWith("now ·") &&
                a.stripEnd.startsWith("now ") &&
                !a.chrome;
            return [ok, { opened, view: t.view, ticks: a.ticks.length, filters: f, rows: a.rows, gap: a.gap, now: a.now, stripEnd: a.stripEnd, chrome: a.chrome }];
        });

        await step("Attention keeps only the asked and failed groups", async () => {
            await clickFilter(h, "attention");
            const a = await readActivity(h);
            await h.shot(SHOT(2, "attention"));
            const ok = a.filters.attention?.on === true && JSON.stringify(a.rows) === JSON.stringify(ATTENTION_ROWS);
            return [ok, { filters: a.filters, rows: a.rows, titles: a.titles }];
        });

        await step("a row's task pill filters to that task and fades the strip's other ticks", async () => {
            await clickFilter(h, "all");
            const clicked = await clickAt(h, `${ACTIVITY}?.querySelector('[data-timeline-row][data-timeline-task="t-3"] [data-timeline-task-pill]')`);
            await polishNap(SETTLE_MS);
            const a = await readActivity(h);
            await h.shot(SHOT(3, "task"));
            const own = a.ticks.filter((k) => k.task === "t-3");
            const others = a.ticks.filter((k) => k.task !== "t-3");
            const ok =
                clicked &&
                a.filters.task?.on === true &&
                a.filters.task.label.startsWith("Task · t-3") &&
                a.filters.task.count === String(T3_EVENTS) &&
                JSON.stringify(a.rows) === JSON.stringify(["t-3"]) &&
                a.open.length === 0 &&
                own.length === T3_EVENTS &&
                own.every((k) => k.opacity !== FADED) &&
                others.length === LIVE_EVENTS - T3_EVENTS &&
                others.every((k) => k.opacity === FADED);
            return [ok, { clicked, filters: a.filters, rows: a.rows, open: a.open.length, own, faded: others.filter((k) => k.opacity === FADED).length }];
        });

        await step("a row opens to its events, saying what was asked and answered", async () => {
            await clickFilter(h, "all");
            // t-1's oldest row: spawned, asked, answered
            const clicked = await clickAt(h, `[...(${ACTIVITY}?.querySelectorAll('[data-timeline-row][data-timeline-task="t-1"]') ?? [])].at(-1)`);
            await polishNap(SETTLE_MS);
            const a = await readActivity(h);
            await h.shot(SHOT(4, "open"));
            const text = a.open[0]?.text ?? "";
            const ok =
                clicked &&
                a.open.length === 1 &&
                a.open[0].entries === 3 &&
                /Question answered/.test(text) &&
                text.includes(ANSWERED_Q) &&
                text.includes(ANSWERED_A) &&
                !a.chrome;
            return [ok, { clicked, open: a.open }];
        });

        // Done board
        await step("finished run: the timeline ends at DAG complete with no now marker (Done board)", async () => {
            await reseed(h, ctx, { finished: true });
            await pickView(h, "tasks");
            await pickView(h, "activity");
            const a = await readActivity(h);
            await h.shot(SHOT(5, "done"));
            const ok =
                a.ticks.length === DONE_EVENTS &&
                a.filters.all?.count === String(DONE_EVENTS) &&
                a.rows[0] === "dag" &&
                a.titles[0].startsWith("DAG complete") &&
                a.now === "" &&
                a.stripEnd.startsWith("ended ") &&
                !a.chrome;
            return [ok, { ticks: a.ticks.length, all: a.filters.all, first: a.titles[0], now: a.now, stripEnd: a.stripEnd, chrome: a.chrome }];
        });

        return steps;
    },
    teardown: (h, ctx) => teardown(h, ctx, NAME),
};
