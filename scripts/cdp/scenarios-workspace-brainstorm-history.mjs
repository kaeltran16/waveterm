// Scenario `workspace-brainstorm-history`: the 600px Brainstorm tab's "Decided so far" history and its removed view
// (docs/superpowers/plans/2026-11-19-brainstorm-tab-polish.md). WBS_KIT's fixture agent asking question 4 with three
// decided; the removed view's copy names the tab here, while brainstorm-mode's step 12c keeps the Terminal center's
// switch.

import { rmSync } from "node:fs";
import { RBS_KIT } from "./scenarios-rendered-brainstorm.mjs";
import { WBS_KIT } from "./scenarios-workspace-brainstorm-question.mjs";

const NAME = "workspace-brainstorm-history";
const { polishWaitFor, writeFile, BS_POLL_WAIT_MS, WAIT_MS } = RBS_KIT;
const { wbsScenario, tabOpens, ASKING, BS_IN_TAB } = WBS_KIT;

export const workspaceBrainstormHistory = wbsScenario(NAME, async (h, ctx, step) => {
    await step("the 600px Brainstorm tab shows the asking question, and the pane reads itself narrow", () => tabOpens(h, ctx));

    await step("the removed brainstorm file names the tab", async () => {
        rmSync(ctx.file, { force: true });
        const removed = await polishWaitFor(h, `${BS_IN_TAB}?.getAttribute("data-brainstorm-view") === "removed"`, BS_POLL_WAIT_MS);
        const gone = await h.ev(`(${BS_IN_TAB}?.querySelector("[data-brainstorm-gone]")?.innerText ?? "").replace(/\\s+/g, " ").trim()`);
        // the file back, so a later step starts from the question again
        writeFile(ctx, ASKING);
        const back = await polishWaitFor(h, `${BS_IN_TAB}?.querySelector('[data-brainstorm-option="2"]') != null`, BS_POLL_WAIT_MS + WAIT_MS);
        return [
            removed && gone === `It is no longer at ${ctx.file}. The Brainstorm tab disappears once you close it.` && back,
            { removed, gone, file: ctx.file, back },
        ];
    });
});
