// Scenario `workspace-run-graph`: the Run tab's Graph view (docs/superpowers/plans/2026-11-18-run-tab-polish.md;
// boards Main, Graph and Done). The run and the lead that links it are the shared fixture's (workspace-run-fixture.mjs).

import { arrange, openRunTab, pickView, RUN_TAB, stepper, teardown } from "./workspace-run-fixture.mjs";

const NAME = "workspace-run-graph";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
const GRAPH = `${RUN_TAB}?.querySelector("[data-workspace-run-graph]")`;

export const workspaceRunGraph = {
    name: NAME,
    surface: "agent",
    arrange: (h) => arrange(h, NAME),
    async assert(h, ctx) {
        const { steps, rec, step } = stepper();
        if (ctx.arrangeError != null) {
            rec(`${NAME}: arrange`, false, ctx.arrangeError);
            return steps;
        }

        await step("the segmented control opens Graph on the Main fixture", async () => {
            const opened = await openRunTab(h);
            const t = await pickView(h, "graph");
            const drawn = await h.ev(`${GRAPH} != null`);
            await h.shot(SHOT(1, "graph"));
            return [opened && t.view === "graph" && t.indicator === "graph" && drawn, { opened, view: t.view, fill: t.indicator, drawn }];
        });

        return steps;
    },
    teardown: (h, ctx) => teardown(h, ctx, NAME),
};
