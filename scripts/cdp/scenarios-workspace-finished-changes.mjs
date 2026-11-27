// Scenario `workspace-finished-changes`: the Changes tab a done task's worker opens with, behind its Task tab
// (docs/superpowers/plans/2026-11-27-finished-row-workspace.md, board Main's Changes). The run is the shared fixture's
// Done board (workspace-run-fixture.mjs).

import {
    arrange,
    clickAt,
    endedRowId,
    focusRow,
    rowUntil,
    stepper,
    teardown,
} from "./workspace-run-fixture.mjs";

const NAME = "workspace-finished-changes";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
const T4 = endedRowId("t-4");

export const workspaceFinishedChanges = {
    name: NAME,
    surface: "agent",
    arrange: (h) => arrange(h, NAME, { finished: true }),
    async assert(h, ctx) {
        const { steps, rec, step } = stepper();
        if (ctx.arrangeError != null) {
            rec(`${NAME}: arrange`, false, ctx.arrangeError);
            return steps;
        }

        await step("on t-4's row, clicking the Changes tab shows the Changes tab body", async () => {
            await focusRow(h, ctx, T4);
            await rowUntil(h, (r) => r.task === "t-4");
            const clicked = await clickAt(h, `document.querySelector('[data-workspace-tab="changes"] [role="tab"]')`);
            const s = await rowUntil(h, (r) => r.active === "changes" && r.changes);
            await h.shot(SHOT(1, "changes"));
            return [clicked && !s.rail && s.active === "changes" && s.changes && s.unseen.length === 0, { clicked, ...s }];
        });
        return steps;
    },
    teardown: (h, ctx) => teardown(h, ctx, NAME),
};
