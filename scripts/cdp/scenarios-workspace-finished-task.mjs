// Scenario `workspace-finished-task`: a done task's worker shows the workspace pane, never the details rail
// (docs/superpowers/plans/2026-11-27-finished-row-workspace.md, board Main). The run is the shared fixture's Done board
// (workspace-run-fixture.mjs), where every task is done and merged; t-4's ended row reads a transcript written here,
// whose reply cites a file of the temp dir by absolute path. The layer gives t-4 the board's story: 2 attempts, an
// answered ask, a sent-back round then a passed one, a passed Verify of its batch and its sealed files.

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
    MIN,
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
const T4_ASK = { askid: "fx-wft-ask", question: "Should stats count archived bookmarks?", answer: "No, only active ones." };
const ROUND_1_NOTE = "Average tags divides by zero on an empty shelf.";
const ROUND_2_NOTE = "The empty shelf now prints 0.0 and the test covers it.";
const T4_FILES = [
    { path: STATS_REL, stat: "M", add: 39, del: 1 },
    { path: "cmd/linkshelf/stats_test.go", stat: "A", add: 25, del: 0 },
];
const SECTIONS = ["brief", "asked", "review", "verify", "changes"];

// t-4's attempts, events, sealed evidence and spend on the Done board
function layer(seed, { now }) {
    const t0 = now - 31 * MIN;
    const ev = (n, m, kind, detail) => ({
        id: `fx-wft-${n}`,
        runid: RUN_ID,
        channelid: seed.run.channeloid,
        kind,
        ts: t0 + m * MIN,
        detail: JSON.stringify(detail),
    });
    const events = [
        ...seed.events,
        ev(1, 11.5, "child-ask", { taskid: "t-4", askid: T4_ASK.askid, question: T4_ASK.question }),
        ev(2, 12.5, "child-answered", { taskid: "t-4", askid: T4_ASK.askid, answer: T4_ASK.answer }),
        ev(3, 16, "task-review-failed", { taskid: "t-4", note: ROUND_1_NOTE, round: 1, final: false }),
        ev(4, 19.2, "task-review-passed", { taskid: "t-4", note: ROUND_2_NOTE }),
        ev(5, 19.8, "task-verify-passed", { taskid: "t-1", batch: ["t-1", "t-4"], ms: 410 }),
    ].sort((a, b) => a.ts - b.ts);
    const dag = { ...seed.dag, tasks: seed.dag.tasks.map((t) => (t.id === "t-4" ? { ...t, attempts: 2 } : t)) };
    const children = seed.children.map((c) =>
        c.taskid === "t-4"
            ? {
                  ...c,
                  status: "done",
                  endcommit: "9d2e4b1c3a5f7e9d0b2c4e6a8f1d3b5c7e9a0f2d",
                  evidence: {
                      capturedts: t0 + 19 * MIN,
                      hash: "fx-t-4",
                      summary: "Added linkshelf stats.",
                      files: T4_FILES,
                      addtotal: 64,
                      deltotal: 1,
                      runtimems: 6 * MIN,
                      durationms: 6 * MIN,
                  },
              }
            : c
    );
    const usage = [
        ...seed.usage,
        { role: "worker", taskid: "t-4", model: "claude-opus-5-5", input: 90_000, output: 22_000, cacheread: 290_000, cachewrite: 10_000, cachewrite1h: 0, msgs: 14 },
    ];
    return { ...seed, dag, children, events, usage };
}

// the Task tab as drawn: its head, its sections in order, the review cards' rounds, the ask, Verify and Changes lines
const readTaskTab = (h) =>
    page(
        h,
        `const tab = document.querySelector("[data-workspace-task]");
        const q = (sel) => tab?.querySelector(sel);
        return {
            state: flat(q("[data-task-state]")),
            meta: flat(q("[data-task-meta]")),
            sections: [...(tab?.querySelectorAll("[data-task-section]") ?? [])].map((s) => s.dataset.taskSection),
            brief: flat(q('[data-task-section="brief"]')),
            ask: flat(q("[data-task-ask]")),
            rounds: [...(tab?.querySelectorAll("[data-task-review]") ?? [])].map((r) => flat(r)),
            verify: flat(q('[data-task-section="verify"]')),
            changes: flat(q("[data-task-changes]")),
        };`
    );

export const workspaceFinishedTask = {
    name: NAME,
    surface: "agent",
    async arrange(h) {
        const ctx = await arrange(h, NAME, { finished: true, layer });
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

        await step("the Task tab draws t-4's head, Brief, Asked the lead, Review (Round 2 above Round 1), Verify and Changes in order", async () => {
            const t = await readTaskTab(h);
            await h.shot(SHOT(1, "task-tab"));
            const ok =
                t.state === "Merged" &&
                t.meta.startsWith("t-4 · 2 attempts · ") &&
                t.meta.includes("Opus 5.5") &&
                t.meta.endsWith("9d2e4b1") &&
                JSON.stringify(t.sections) === JSON.stringify(SECTIONS) &&
                t.brief.includes("waits on t-1 · then t-7") &&
                t.ask.includes(T4_ASK.question) &&
                t.ask.includes(T4_ASK.answer) &&
                t.rounds.length === 2 &&
                t.rounds[0].startsWith("Round 2 · passed") &&
                t.rounds[0].includes(ROUND_2_NOTE) &&
                t.rounds[1].startsWith("Round 1 · sent back") &&
                t.rounds[1].includes(ROUND_1_NOTE) &&
                t.verify.includes("ok · 0.4s") &&
                t.changes.replace(/\s+/g, "") === "2files+64−1";
            return [ok, t];
        });

        await step("Open changes makes Changes the active tab", async () => {
            const clicked = await clickAt(h, `document.querySelector("[data-workspace-task] [data-task-open-changes]")`);
            const s = await rowUntil(h, (r) => r.active === "changes" && r.changes);
            await h.shot(SHOT(1, "open-changes"));
            return [clicked && s.active === "changes" && s.changes && !s.rail, { clicked, ...s }];
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
