// Scenario `workspace-finished-final`: the Final stage's row and an ended verifier show the workspace pane with the
// Final tab, never the details rail; an ended plan reviewer shows neither (docs/superpowers/plans/
// 2026-11-27-finished-row-workspace.md, boards Final and Verifier). The run is the shared fixture's Done board
// (workspace-run-fixture.mjs), layered here with round 1's verifier run and a plan reviewer that gave its verdict.

import { polishNap } from "./scenarios-shared.mjs";
import {
    arrange,
    endedRowId,
    FINAL_ROW_ID,
    focusRow,
    RUN_ID,
    rowUntil,
    seedTranscriptPath,
    SETTLE_MS,
    stepper,
    teardown,
} from "./workspace-run-fixture.mjs";

const NAME = "workspace-finished-final";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
const FINAL_KEY = `final:${RUN_ID}`;
const VERIFIER_RUN = "fx-workspace-run-verifier";
const REVIEWER_RUN = "fx-workspace-run-plan-reviewer";
const VERIFIER_ROW = endedRowId(`verifier:${VERIFIER_RUN}`);
const REVIEWER_ROW = endedRowId(`review:${REVIEWER_RUN}`);

const layer = (seed) => {
    seed.dag.final = { ...seed.dag.final, verifierrunid: VERIFIER_RUN };
    seed.dag.planreview = { ...seed.dag.planreview, reviewers: [{ lens: "full", state: "passed", runid: REVIEWER_RUN }] };
    return seed;
};

// a DOM key event at the focused element, as the keybinding dispatcher on window hears it: CDP's key events often
// never reach the WebView
const pressKey = (h, key, code) =>
    h.ev(`(() => {
        const target = document.activeElement ?? document.body;
        const init = { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, bubbles: true, cancelable: true };
        target.dispatchEvent(new KeyboardEvent("keydown", init));
        target.dispatchEvent(new KeyboardEvent("keyup", init));
        return true;
    })()`);

const seeded = (r) => JSON.stringify(r.tabs) === JSON.stringify([FINAL_KEY, "changes"]) && r.active === FINAL_KEY;

export const workspaceFinishedFinal = {
    name: NAME,
    surface: "agent",
    async arrange(h) {
        const ctx = await arrange(h, NAME, { finished: true, layer });
        if (ctx.arrangeError != null) return ctx;
        try {
            // neither session's transcript is looked up on the server, which has no page-only run
            await seedTranscriptPath(h, VERIFIER_RUN, "");
            await seedTranscriptPath(h, REVIEWER_RUN, "");
        } catch (err) {
            ctx.arrangeError = String(err?.message ?? err);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const { steps, rec, step } = stepper();
        if (ctx.arrangeError != null) {
            rec(`${NAME}: arrange`, false, ctx.arrangeError);
            return steps;
        }

        await step("the Final row shows no details rail and the pane, Final active and Changes unseen, beside the stage's steps", async () => {
            await focusRow(h, ctx, FINAL_ROW_ID);
            const s = await rowUntil(h, (r) => r.final === RUN_ID && r.pane === "open");
            await h.shot(SHOT(1, "final-row"));
            const ok =
                !s.rail &&
                s.finalPane &&
                s.pane === "open" &&
                seeded(s) &&
                s.labels[0] === "Final" &&
                JSON.stringify(s.unseen) === JSON.stringify(["changes"]) &&
                s.final === RUN_ID;
            return [ok, s];
        });

        await step("d collapses the Final row's pane to its strip, and no rail opens", async () => {
            await pressKey(h, "d", "KeyD");
            const s = await rowUntil(h, (r) => r.pane === "strip");
            await h.shot(SHOT(2, "collapsed"));
            await pressKey(h, "d", "KeyD");
            await polishNap(SETTLE_MS);
            return [s.pane === "strip" && !s.rail, s];
        });

        await step("the ended verifier's row opens its Final tab, with no details rail", async () => {
            await focusRow(h, ctx, VERIFIER_ROW);
            const s = await rowUntil(h, (r) => r.final === RUN_ID && r.pane === "open");
            await h.shot(SHOT(3, "verifier"));
            return [!s.rail && s.ended && seeded(s) && s.final === RUN_ID, s];
        });

        await step("an ended plan reviewer's row shows its transcript with neither the rail nor the pane", async () => {
            await focusRow(h, ctx, REVIEWER_ROW);
            await polishNap(SETTLE_MS);
            const s = await rowUntil(h, (r) => r.pane == null && !r.finalPane);
            await h.shot(SHOT(4, "plan-reviewer"));
            const center = await h.ev(`(document.querySelector("[data-agent-center]")?.textContent ?? "").includes("No transcript found")`);
            return [!s.rail && s.pane == null && s.tabs.length === 0 && center, { ...s, center }];
        });
        return steps;
    },
    teardown: (h, ctx) => teardown(h, ctx, NAME),
};
