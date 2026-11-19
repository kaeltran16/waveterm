// Scenario `workspace-brainstorm-cards`: the transcript's brainstorm cards while the 600px Brainstorm tab shows
// (docs/superpowers/plans/2026-11-19-brainstorm-tab-polish.md). WBS_KIT's fixture agent asking question 4.

import { WBS_KIT } from "./scenarios-workspace-brainstorm-question.mjs";

const NAME = "workspace-brainstorm-cards";
const { wbsScenario, tabOpens } = WBS_KIT;

export const workspaceBrainstormCards = wbsScenario(NAME, async (h, ctx, step) => {
    await step("the 600px Brainstorm tab shows the asking question, and the pane reads itself narrow", () => tabOpens(h, ctx));
});
