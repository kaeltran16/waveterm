// Scenario `workspace-run`: the workspace pane's Run tab, its head and Tasks view (docs/superpowers/plans/
// 2026-11-18-run-tab-polish.md; boards Main and Done). The run and the lead that links it are the shared fixture's
// (workspace-run-fixture.mjs).

import { CTRL, polishNap } from "./scenarios-shared.mjs";
import {
    arrange,
    clickAt,
    FINAL_SHOTS,
    MAIN_DOTS,
    OPEN_RUN,
    openRunTab,
    page,
    PANE,
    pickView,
    readHead,
    reseed,
    RUN_ID,
    SETTLE_MS,
    SHORT_ID,
    stepper,
    T6_FAIL,
    TAB_KEY,
    TASK_IDS,
    TASKS,
    teardown,
    TITLE,
    VERIFY_CMD,
} from "./workspace-run-fixture.mjs";

const NAME = "workspace-run";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
// openref's refusal once the peek finds no run on the server
const RUN_GONE = "That run no longer exists";
const MAIN_LINE = `2/8 tasks · 9m · ${SHORT_ID} · plan 2026-11-17-stats-dedupe.md`;
const MAIN_SPEND = "Spent ~$2.10 · Tokens 1.2M · Worker time 14m";
const DONE_LINE = `8/8 tasks · 31m · ${SHORT_ID} · plan 2026-11-17-stats-dedupe.md · landed 4c1e9a2`;
const DONE_SPEND = "Spent ~$6.40 · Tokens 3.4M · Worker time 41m";
const T1_LEAD = "Added per-host counters and a linkshelf stats backend, with 9 tests.";
const T1_FILES = [["internal/stats/counters.go", "+120", "−4"], ["internal/stats/counters_test.go", "+64", "−8"]];
const VERIFYING_LEAD = "Merged. The plan's Verify is running in the project checkout.";
const REVIEWING_LEAD = "Finished with a commit. A reviewer is judging it against the task and the spec.";
const DECIDING = "The lead is deciding: retry, escalate, skip or send back.";
const PULSING = new Set(["working", "asked"]);
const FINAL_WAITS = "waits for every task";
// the Main board's state word per task: none on merged and plainly running rows; t-2's Verify time is a prefix
const MAIN_WORDS = ["", "verifying ", "asked the lead", "", "reviewing", "failed", "waits on t-3, t-4", "queued"];

// the Tasks view's box as drawn: its stage rows, and per task row its dot, whether it pulses, and its state word
const readTasks = (h) =>
    page(
        h,
        `const box = document.querySelector("[data-workspace-run] [data-workspace-run-tasks]");
        const stage = (key) => {
            const row = box?.querySelector('[data-workspace-run-stage="' + key + '"]');
            return row ? { text: flat(row), word: flat(row.querySelector("[data-stage-word]")), dot: row.querySelector("[data-row-dot]")?.dataset.rowDot } : null;
        };
        const children = [...(box?.children ?? [])];
        return {
            order: children.map((c) => c.dataset.workspaceRunStage ?? c.dataset.workspaceRunTask ?? null),
            review: stage("planreview"),
            final: stage("final"),
            rows: [...(box?.querySelectorAll("[data-workspace-run-task]") ?? [])].map((r) => {
                const dot = r.querySelector(":scope > button [data-row-dot]");
                return {
                    id: r.dataset.workspaceRunTask,
                    dot: dot?.dataset.rowDot ?? null,
                    pulse: dot?.classList.contains("pulse-dot") ?? false,
                    word: flat(r.querySelector(":scope > button [data-task-state]")),
                };
            }),
        };`
    );

// opens a task's row by a real click, and reads its body once the reveal settles
async function openTask(h, id) {
    const row = `document.querySelector('[data-workspace-run] [data-workspace-run-task="${id}"] > button')`;
    const clicked = await clickAt(h, row);
    await polishNap(SETTLE_MS);
    const body = await page(
        h,
        `const row = document.querySelector('[data-workspace-run] [data-workspace-run-task="${id}"]');
        const b = row?.querySelector("[data-task-body]");
        const q = (sel) => flat(b?.querySelector(sel));
        return {
            expanded: row?.querySelector(":scope > button")?.getAttribute("aria-expanded") ?? null,
            lead: q("[data-body-lead]"),
            ran: b?.querySelector("[data-body-ran]") ? { cmd: q("[data-body-ran] [data-ran-command]"), running: b.querySelector('[data-body-ran] [aria-label="Running"]') != null } : null,
            files: [...(b?.querySelectorAll("[data-body-file]") ?? [])].map((f) => [...f.children].map((c) => flat(c)).filter(Boolean)),
            failure: b?.querySelector("[data-body-failure]")?.textContent ?? "",
            deciding: q("[data-body-deciding]"),
            reviewer: q("[data-body-reviewer]"),
            merged: q("[data-body-merged]"),
            depends: q("[data-body-depends]"),
            openAgent: b?.querySelector("[data-open-agent]") != null,
            openChanges: b?.querySelector("[data-open-changes]") != null,
        };`
    );
    return { clicked, ...body };
}

export const workspaceRun = {
    name: NAME,
    surface: "agent",
    arrange: (h) => arrange(h, NAME),
    async assert(h, ctx) {
        const { steps, rec, step } = stepper();
        if (ctx.arrangeError != null) {
            rec(`${NAME}: arrange`, false, ctx.arrangeError);
            return steps;
        }
        const LEAD = JSON.stringify(ctx.leadId);

        // the peek loads the run from the server, which has no page-only run: it starts, then is refused, and the cache
        // now reads the run as gone, so the step puts the run back at a newer version
        await step("Ctrl+click on the run card's Answer in the run peeks the run and opens no tab", async () => {
            await page(
                h,
                `const P = await mod("app/view/jarvis/peekstore.ts");
                window.__wrPeeks = [];
                window.__wrPeekOff = globalStore.sub(P.peekItemAtom, () => {
                    const item = globalStore.get(P.peekItemAtom);
                    if (item) window.__wrPeeks.push(item.target);
                });
                return true;`
            );
            const clicked = await clickAt(h, OPEN_RUN, CTRL);
            await polishNap(SETTLE_MS);
            const r = await page(
                h,
                `const P = await mod("app/view/jarvis/peekstore.ts");
                const T = await mod("app/cockpit/notificationstore.ts");
                const refused = (t) => t.title === ${JSON.stringify(RUN_GONE)};
                await until(() => globalStore.get(T.toastsAtom).some(refused));
                globalStore.get(T.toastsAtom).filter(refused).forEach((t) => T.dismissToast(t.id));
                window.__wrPeekOff();
                const out = { tabs: ws(${LEAD}).tabs.length, peeks: window.__wrPeeks, pane: ${PANE} != null };
                delete window.__wrPeeks;
                delete window.__wrPeekOff;
                P.closePeek();
                return out;`
            );
            await reseed(h, ctx, { now: ctx.now });
            await polishNap(SETTLE_MS);
            const peeked = r.peeks.some((t) => t.kind === "run" && t.runId === RUN_ID);
            return [clicked && r.tabs === 0 && !r.pane && peeked, r];
        });

        // Main board
        await step("head: title, Live, facts line, Spent / Tokens / Worker time line, 8-segment strip, segmented Tasks 8 | Activity N | Graph (Main board)", async () => {
            const opened = await openRunTab(h);
            const t = await readHead(h);
            await h.shot(SHOT(1, "head"));
            const ok =
                opened &&
                t.pane === "open" &&
                t.active === TAB_KEY &&
                t.run === RUN_ID &&
                t.head.startsWith(TITLE) &&
                t.state === "live" &&
                t.stateText === "Live" &&
                t.line === MAIN_LINE &&
                t.spend === MAIN_SPEND &&
                JSON.stringify(t.strip) === JSON.stringify(MAIN_DOTS) &&
                JSON.stringify(t.views) === JSON.stringify(["Tasks8", "Activity23", "Graph"]) &&
                t.view === "tasks" &&
                t.indicator === "tasks" &&
                !t.needs &&
                !t.totals;
            return [ok, t];
        });

        await step("the segmented control switches to Activity and Graph and back, the active fill moving", async () => {
            // the fill's x on every frame of each swap: more than two distinct values is a slide, not a jump
            const swap = (view) =>
                page(
                    h,
                    `const fill = () => document.querySelector("[data-workspace-run] [data-run-view-indicator]");
                    const xs = sampleFrames(() => { const r = fill()?.getBoundingClientRect(); return r ? Math.round(r.x) : null; });
                    document.querySelector('[data-workspace-run] [data-run-view="${view}"]').click();
                    await nap(${SETTLE_MS});
                    xs.stop();
                    return xs.values;`
                );
            const runs = [];
            for (const view of ["activity", "graph", "tasks"]) {
                const xs = await swap(view);
                const t = await readHead(h);
                runs.push({ view, xs, shown: t.view, fill: t.indicator });
            }
            const ok = runs.every((r) => r.shown === r.view && r.fill === r.view && r.xs.length >= 3);
            return [ok, runs];
        });

        await step("Tasks: Plan review row, 8 task rows with their dots (merged, working pulsing, asked pulsing, failed, waits) and state words, Final verification row (Main board)", async () => {
            const t = await readTasks(h);
            await h.shot(SHOT(3, "tasks"));
            const ok =
                JSON.stringify(t.order) === JSON.stringify(["planreview", ...TASK_IDS, "final"]) &&
                t.review?.word === "passed" &&
                t.review?.dot === "merged" &&
                t.final?.word === FINAL_WAITS &&
                t.final?.dot === "waits" &&
                JSON.stringify(t.rows.map((r) => r.dot)) === JSON.stringify(MAIN_DOTS) &&
                t.rows.every((r) => r.pulse === PULSING.has(r.dot)) &&
                t.rows.every((r, i) => (MAIN_WORDS[i].endsWith(" ") ? r.word.startsWith(MAIN_WORDS[i]) : r.word === MAIN_WORDS[i]));
            return [ok, t];
        });

        await step("t-1 opens to its summary, two files with counts, review passed · merged, Open agent and Open changes; Open changes opens the Changes tab", async () => {
            const b = await openTask(h, "t-1");
            await h.shot(SHOT(4, "t1-open"));
            const opened = await clickAt(h, `document.querySelector('[data-workspace-run-task="t-1"] [data-open-changes]')`);
            await polishNap(SETTLE_MS);
            const tabs = await page(
                h,
                `const w = ws(${LEAD});
                const changes = w.tabs.find((t) => t.kind === "changes");
                return { active: w.active ?? null, kinds: w.tabs.map((t) => t.kind), selected: changes?.selected ?? null, drawn: document.querySelector("[data-workspace-tab=changes]") != null };`
            );
            // back to the Run tab, so the steps after read it
            await clickAt(h, `document.querySelector('[data-workspace-tab="${TAB_KEY}"] [role="tab"]')`);
            await polishNap(SETTLE_MS);
            const ok =
                b.clicked &&
                b.expanded === "true" &&
                b.lead === T1_LEAD &&
                JSON.stringify(b.files) === JSON.stringify(T1_FILES) &&
                /^review passed · merged \d\d:\d\d$/.test(b.merged) &&
                b.openAgent &&
                b.openChanges &&
                opened &&
                tabs.kinds.includes("changes") &&
                tabs.selected === T1_FILES[0][0] &&
                tabs.drawn;
            return [ok, { body: b, tabs }];
        });

        await step("t-2 opens to the merged-and-verifying body with its running Ran step; t-5 to the reviewing body with reviewer started … ago", async () => {
            const t2 = await openTask(h, "t-2");
            const t5 = await openTask(h, "t-5");
            await h.shot(SHOT(5, "t2-t5-open"));
            const ok =
                t2.lead === VERIFYING_LEAD &&
                t2.ran?.cmd === VERIFY_CMD &&
                t2.ran.running &&
                t2.files.length === 2 &&
                t2.openChanges &&
                t5.lead === REVIEWING_LEAD &&
                t5.files.length === 2 &&
                /^reviewer started \S+ ago$/.test(t5.reviewer);
            return [ok, { t2, t5 }];
        });

        await step("t-6 opens to its failure output; t-7 to its description and depends on t-3, t-4; t-8 to its description and waits for a free worker", async () => {
            const t6 = await openTask(h, "t-6");
            const t7 = await openTask(h, "t-7");
            const t8 = await openTask(h, "t-8");
            await h.shot(SHOT(6, "t6-t8-open"));
            const desc = (id) => TASKS.find((t) => t.id === id).description;
            const ok =
                t6.failure === T6_FAIL &&
                t6.deciding === DECIDING &&
                !t6.openChanges &&
                t7.lead === desc("t-7") &&
                t7.depends === "depends on t-3, t-4" &&
                !t7.openAgent &&
                t8.lead === desc("t-8") &&
                t8.depends === "depends on t-1 · waits for a free worker";
            return [ok, { t6, t7, t8 }];
        });

        // Done board
        await step("finished run: Done pill, facts line ends landed 4c1e9a2, the Spent line, every strip segment green (Done board)", async () => {
            await reseed(h, ctx, { finished: true });
            await polishNap(SETTLE_MS);
            const t = await pickView(h, "tasks");
            await h.shot(SHOT(2, "done"));
            const ok =
                t.state === "done" &&
                t.stateText === "Done" &&
                t.line === DONE_LINE &&
                t.spend === DONE_SPEND &&
                t.strip.length === 8 &&
                t.strip.every((d) => d === "merged") &&
                !t.dot;
            return [ok, t];
        });

        await step("finished run: every row merged, Final verification passed · 6 scenarios (Done board; the fixture's final stage carries 6 shots)", async () => {
            const t = await readTasks(h);
            await h.shot(SHOT(7, "done-tasks"));
            const ok =
                t.rows.length === TASK_IDS.length &&
                t.rows.every((r) => r.dot === "merged" && !r.pulse && r.word === "") &&
                t.review?.word === "passed" &&
                t.final?.word === `passed · ${FINAL_SHOTS} scenarios` &&
                t.final?.dot === "merged";
            return [ok, t];
        });

        return steps;
    },
    teardown: (h, ctx) => teardown(h, ctx, NAME),
};
