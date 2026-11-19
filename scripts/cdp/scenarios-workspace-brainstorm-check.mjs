// Scenario `workspace-brainstorm-check`: the builder check's review, its approve bar and the run view in the 600px
// Brainstorm tab (docs/superpowers/plans/2026-11-19-brainstorm-tab-polish.md). WBS_KIT's fixture agent asking
// question 4; later steps rewrite the file to the check and the run.

import { WBS_KIT } from "./scenarios-workspace-brainstorm-question.mjs";

const NAME = "workspace-brainstorm-check";
const { wbsScenario, tabOpens } = WBS_KIT;

export const workspaceBrainstormCheck = wbsScenario(NAME, async (h, ctx, step) => {
    await step("the 600px Brainstorm tab shows the asking question, and the pane reads itself narrow", () => tabOpens(h, ctx));
});
