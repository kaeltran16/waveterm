// Agent review scenario `agent-streams` (F1): the shell owns the transcript streams and the shell-task tracking, so
// the Agent surface fills its tree chip and its rail's Tools used without the Cockpit ever opening, and a Cockpit
// visit and return ends nothing. The fixture roster holds one working claude agent whose transcript is a temp
// file holding a few tool calls and a running run_in_background Bash call. Nothing runs and nothing is written
// into ~/.claude/projects.

import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    agentPage,
    assistantText,
    focusAgent,
    restoreRoster,
    setRoster,
    toolResult,
    toolUse,
    userText,
    writeTranscript,
} from "./agent-page-fixtures.mjs";
import { polishWaitFor, RAIL_VISIBLE_KEY } from "./scenarios-shared.mjs";

const NAME = "agent-streams";
const PROJECT = "fx-streams";
const SHELL_TASK_ID = "bstreams01";
const NARRATION = "Streams fixture: reading the config before the edit.";
const WAIT_MS = 10_000;

const TREE_ROW = (id) => `document.querySelector('[data-agent-tree] [data-tree-agent="${id}"]')`;
const RAIL = `document.querySelector('aside[aria-label="Agent details"]')`;
const COCKPIT_CARD = (id) => `document.querySelector('[data-cockpit-surface] [data-agent-id="${id}"]')`;

// the tree row's chips and the rail's Tools used verbs, as the page shows them
const seen = (id) => `(() => {
    const flat = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
    const rail = ${RAIL};
    // a Tools used chip is the verb, then its count as "×n"
    const verbs = !flat(rail).includes("Tools used")
        ? []
        : [...rail.querySelectorAll("span.rounded-sm")]
              .filter((chip) => flat(chip.lastElementChild).startsWith("×"))
              .map((chip) => flat(chip.firstElementChild));
    return { row: flat(${TREE_ROW(id)}), rail: !!rail, verbs };
})()`;
const hasChip = (s) => s.row.includes("1 shell task");

const toolCall = (id, name, input, result) => [toolUse(id, name, input), toolResult(id, result)];

export default function (_kit) {
    return [
        {
            name: NAME,
            surface: "agent",
            async arrange(h) {
                const tag = Date.now().toString(36);
                const ctx = {
                    id: `fx-streams-${tag}`,
                    dir: mkdtempSync(join(tmpdir(), "verify-agent-streams-")),
                    prevRail: await h.ev(`localStorage.getItem(${JSON.stringify(RAIL_VISIBLE_KEY)})`),
                };
                // a throw past this point still returns ctx, so teardown removes whatever was already made
                try {
                    ctx.path = writeTranscript(ctx.dir, `streams-${tag}`, [
                        userText("Start the dev server and tidy the config."),
                        assistantText(NARRATION),
                        ...toolCall("toolu_read1", "Read", { file_path: "C:/fx/config.ts" }, "export const a = 1;"),
                        ...toolCall("toolu_edit1", "Edit", { file_path: "C:/fx/config.ts" }, "edited"),
                        toolUse("toolu_bg1", "Bash", {
                            command: "npm run dev",
                            description: "dev server",
                            run_in_background: true,
                        }),
                        toolResult("toolu_bg1", `Command running in background with ID: ${SHELL_TASK_ID}.`, {
                            toolUseResult: { backgroundTaskId: SHELL_TASK_ID },
                        }),
                    ]);
                    // the rail's visibility is read from storage at boot; a fresh page proves no earlier Cockpit
                    // visit started this agent's stream, and the fixture agent exists only after leaving the
                    // Cockpit the page lands on
                    await h.ev(`localStorage.setItem(${JSON.stringify(RAIL_VISIBLE_KEY)}, "true")`);
                    await h.reload();
                    await h.goto("agent");
                    await setRoster(h, [
                        {
                            id: ctx.id,
                            name: `streams-${tag}`,
                            project: PROJECT,
                            task: "",
                            state: "working",
                            agent: "claude",
                            model: "opus",
                            activeMs: 60_000,
                            // no blockId: a made-up block fails its controller resync and reads failed to start
                            transcriptPath: ctx.path,
                        },
                    ]);
                    await focusAgent(h, ctx.id);
                } catch (e) {
                    ctx.arrangeError = String(e?.message ?? e);
                }
                return ctx;
            },
            async assert(h, ctx) {
                const steps = [];
                const rec = (step, ok, detail) => steps.push({ step, ok, detail });
                if (ctx.arrangeError != null) {
                    rec(`${NAME}: arrange`, false, ctx.arrangeError);
                    return steps;
                }
                const until = (cond) => polishWaitFor(h, `((s) => ${cond})(${seen(ctx.id)})`, WAIT_MS);
                const append = (...lines) => appendFileSync(ctx.path, lines.join("\n") + "\n");

                await until(`s.row.includes("1 shell task") && ["read", "edited", "ran"].every((v) => s.verbs.includes(v))`);
                const first = await h.ev(seen(ctx.id));
                await h.shot("cdp-shots/agent-streams-1-no-cockpit.png");
                rec(
                    "1. without a Cockpit visit, the tree row shows 1 shell task and the rail's Tools used lists the calls",
                    hasChip(first) && ["read", "edited", "ran"].every((v) => first.verbs.includes(v)),
                    JSON.stringify(first)
                );

                append(...toolCall("toolu_grep1", "Grep", { pattern: "dev server" }, "config.ts:1"));
                await until(`s.verbs.includes("grep")`);
                const second = await h.ev(seen(ctx.id));
                await h.shot("cdp-shots/agent-streams-2-appended.png");
                rec(
                    "2. a line appended to the transcript reaches the rail on the Agent surface",
                    second.verbs.includes("grep"),
                    JSON.stringify(second)
                );

                await h.goto("cockpit");
                const carded = await polishWaitFor(
                    h,
                    `(${COCKPIT_CARD(ctx.id)}?.textContent ?? "").includes(${JSON.stringify(NARRATION)})`,
                    WAIT_MS
                );
                await h.shot("cdp-shots/agent-streams-3-cockpit-card.png");
                await h.goto("agent");
                await focusAgent(h, ctx.id);
                append(...toolCall("toolu_glob1", "Glob", { pattern: "**/*.ts" }, "config.ts"));
                await until(`s.row.includes("1 shell task") && s.verbs.includes("glob")`);
                const back = await h.ev(seen(ctx.id));
                await h.shot("cdp-shots/agent-streams-3-back.png");
                rec(
                    "3. after a Cockpit visit (its card showed the transcript) and back, the chip and Tools used stay and the stream still delivers",
                    carded && hasChip(back) && ["read", "edited", "ran", "grep", "glob"].every((v) => back.verbs.includes(v)),
                    JSON.stringify({ carded, ...back })
                );
                return steps;
            },
            // best-effort, so one failed step does not strand the rest
            async teardown(h, ctx) {
                const step = async (what, fn) => {
                    try {
                        await fn();
                    } catch (e) {
                        console.error(`${NAME} teardown: ${what} failed: ${e?.message ?? e}`);
                    }
                };
                await step("restore the roster", () => restoreRoster(h));
                await step("drop the focus", () =>
                    agentPage(h, `globalStore.set(agentsModel().focusIdAtom, undefined); return true;`)
                );
                await step("restore the rail preference", () =>
                    h.ev(
                        ctx.prevRail == null
                            ? `localStorage.removeItem(${JSON.stringify(RAIL_VISIBLE_KEY)})`
                            : `localStorage.setItem(${JSON.stringify(RAIL_VISIBLE_KEY)}, ${JSON.stringify(ctx.prevRail)})`
                    )
                );
                await step("remove the temp transcript", () => rmSync(ctx.dir, { recursive: true, force: true }));
                await step("go home", () => h.goto("cockpit"));
            },
        },
    ];
}
