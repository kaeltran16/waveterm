// Scenario `workspace-run`: the workspace pane's Run tab, its head and Tasks view (docs/superpowers/plans/
// 2026-11-18-run-tab-polish.md; boards Main and Done). The run and the lead that links it are the shared fixture's
// (workspace-run-fixture.mjs).

import { CTRL, polishNap } from "./scenarios-shared.mjs";
import {
    arrange,
    clickAt,
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
    TAB_KEY,
    teardown,
    TITLE,
} from "./workspace-run-fixture.mjs";

const NAME = "workspace-run";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
// openref's refusal once the peek finds no run on the server
const RUN_GONE = "That run no longer exists";
const MAIN_LINE = `2/8 tasks · 9m · ${SHORT_ID} · plan 2026-11-17-stats-dedupe.md`;
const MAIN_SPEND = "Spent ~$2.10 · Tokens 1.2M · Worker time 14m";
const DONE_LINE = `8/8 tasks · 31m · ${SHORT_ID} · plan 2026-11-17-stats-dedupe.md · landed 4c1e9a2`;
const DONE_SPEND = "Spent ~$6.40 · Tokens 3.4M · Worker time 41m";

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

        return steps;
    },
    teardown: (h, ctx) => teardown(h, ctx, NAME),
};
