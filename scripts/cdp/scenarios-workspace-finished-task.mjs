// Scenario `workspace-finished-task`: a done task's worker shows the workspace pane, never the details rail
// (docs/superpowers/plans/2026-11-27-finished-row-workspace.md, board Main). The run is the shared fixture's Done board
// (workspace-run-fixture.mjs), where every task is done and merged; t-4's ended row reads a transcript written here,
// whose reply cites a file of the temp dir by absolute path.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assistantText, focusAgent, userText, writeTranscript } from "./agent-page-fixtures.mjs";
import { polishWaitFor } from "./scenarios-shared.mjs";
import {
    arrange,
    childRunId,
    clickAt,
    endedRowId,
    focusRow,
    page,
    RAIL_VISIBLE_KEY,
    RUN_ID,
    rowUntil,
    seedTranscriptPath,
    stepper,
    teardown,
    WAIT_MS,
} from "./workspace-run-fixture.mjs";

const NAME = "workspace-finished-task";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
const T4 = endedRowId("t-4");
const TASK_KEY = `task:${RUN_ID}:t-4`;
const STATS_REL = "cmd/linkshelf/stats.go";
const STATS_LINE = 12;

export const workspaceFinishedTask = {
    name: NAME,
    surface: "agent",
    async arrange(h) {
        const ctx = await arrange(h, NAME, { finished: true });
        if (ctx.arrangeError != null) return ctx;
        try {
            const stats = join(ctx.dir, "linkshelf", STATS_REL);
            mkdirSync(join(stats, ".."), { recursive: true });
            writeFileSync(stats, Array.from({ length: 30 }, (_, i) => `// line ${i + 1}`).join("\n"));
            ctx.stats = stats.replace(/\\/g, "/");
            const transcript = writeTranscript(join(ctx.dir, "t-4"), `${NAME}-t-4`, [
                userText("Add a linkshelf stats subcommand."),
                assistantText(`Done. The command registers in \`${ctx.stats}:${STATS_LINE}\`.`),
            ]);
            await seedTranscriptPath(h, childRunId("t-4"), transcript);
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
        const focusId = () => page(h, `return globalStore.get(agentsModel().focusIdAtom) ?? null;`);

        await step("focusing t-4's ended row shows no details rail and the pane, Task · t-4 active and Changes unseen", async () => {
            await focusRow(h, ctx, T4);
            const s = await rowUntil(h, (r) => r.task === "t-4" && r.pane === "open");
            await h.shot(SHOT(1, "seeded"));
            const ok =
                !s.rail &&
                s.ended &&
                s.pane === "open" &&
                JSON.stringify(s.tabs) === JSON.stringify([TASK_KEY, "changes"]) &&
                s.labels[0] === "Task · t-4" &&
                s.active === TASK_KEY &&
                JSON.stringify(s.unseen) === JSON.stringify(["changes"]) &&
                s.task === "t-4";
            return [ok, s];
        });

        await step("a file link in its transcript opens a File tab beside the Task tab", async () => {
            const link = `[...document.querySelectorAll("[data-agent-center] [data-file-link]")].find((l) => l.getAttribute("data-file-link") === ${JSON.stringify(ctx.stats)})`;
            const drawn = await polishWaitFor(h, `${link} != null`, WAIT_MS);
            const clicked = drawn && (await clickAt(h, link));
            const fileKey = `file:${ctx.stats}`;
            const s = await rowUntil(h, (r) => r.active?.toLowerCase() === fileKey.toLowerCase());
            await h.shot(SHOT(2, "file-tab"));
            const ok = clicked && !s.rail && s.tabs.length === 3 && s.tabs[0] === TASK_KEY && s.active?.toLowerCase() === fileKey.toLowerCase();
            return [ok, { drawn, clicked, ...s }];
        });

        await step("after closing every tab, focusing another row and back leaves no pane, and no rail", async () => {
            await page(
                h,
                `const M = await mod("app/view/agents/workspacemodel.ts");
                for (const t of [...ws(${JSON.stringify(T4)}).tabs]) W.closeWorkspaceTab(${JSON.stringify(T4)}, M.tabKey(t));
                return true;`
            );
            await rowUntil(h, (r) => r.pane == null);
            await focusAgent(h, ctx.leadId);
            await focusRow(h, ctx, T4);
            const s = await rowUntil(h, (r) => r.ended);
            await h.shot(SHOT(3, "closed-stays-closed"));
            return [s.ended && s.pane == null && s.tabs.length === 0 && !s.rail, s];
        });

        await step("↑ run lands on the lead and leaves the rail setting as it was, with no rail opened", async () => {
            const before = await h.ev(`localStorage.getItem(${JSON.stringify(RAIL_VISIBLE_KEY)})`);
            const clicked = await clickAt(h, `document.querySelector("[data-agent-center] [data-ended-to-run]")`);
            const landed = await polishWaitFor(h, `!document.querySelector("[data-agent-center] [data-ended-to-run]")`, WAIT_MS);
            const focus = await focusId();
            const s = await rowUntil(h, () => true, 0);
            await h.shot(SHOT(4, "to-run"));
            const ok = clicked && landed && focus === ctx.leadId && s.railSetting === before && !s.rail;
            return [ok, { clicked, landed, focus, lead: ctx.leadId, before, ...s }];
        });
        return steps;
    },
    teardown: (h, ctx) => teardown(h, ctx, NAME),
};
