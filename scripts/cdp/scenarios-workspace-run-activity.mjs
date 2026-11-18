// Scenario `workspace-run-activity`: the Run tab's Activity view (docs/superpowers/plans/2026-11-18-run-tab-polish.md;
// boards Main and Done). The run and the lead that links it are the shared fixture's (workspace-run-fixture.mjs).

import { arrange, openRunTab, pickView, RUN_TAB, stepper, teardown } from "./workspace-run-fixture.mjs";

const NAME = "workspace-run-activity";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
const ACTIVITY = `${RUN_TAB}?.querySelector("[data-workspace-run-activity]")`;

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

        await step("the segmented control opens Activity on the Main fixture", async () => {
            const opened = await openRunTab(h);
            const t = await pickView(h, "activity");
            const drawn = await h.ev(`${ACTIVITY} != null`);
            await h.shot(SHOT(1, "activity"));
            return [opened && t.view === "activity" && t.indicator === "activity" && drawn, { opened, view: t.view, fill: t.indicator, drawn }];
        });

        return steps;
    },
    teardown: (h, ctx) => teardown(h, ctx, NAME),
};
