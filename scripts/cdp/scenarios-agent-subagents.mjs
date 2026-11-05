// Agent review scenario `agent-subagents` (F8, F20): an idle claude agent whose transcript holds a background Agent
// spawn, answered only by its async launch ack, and the child's own file under <name>/subagents/ holding a
// SubagentHandback call. The roster is a page fixture over a real tab with no controller (a fake block id would fail
// its terminal's resync and read "failed to start"); both transcripts live in a temp dir teardown removes.

import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    agentPage,
    assistantText,
    closeTabs,
    focusAgent,
    makeTab,
    restoreRoster,
    setRoster,
    taskNotification,
    toolResult,
    toolUse,
    userText,
    writeSubagent,
    writeTranscript,
} from "./agent-page-fixtures.mjs";
import { polishWaitFor } from "./scenarios-shared.mjs";

const NAME = "agent-subagents";
const PARENT_NAME = "subagents parent";
const SESSION = "parent";
const SPAWN_ID = "toolu_bg_survey";
const CHILD_ID = "bgsurvey";
const CHILD_TYPE = "Explore";
const CHILD_PROMPT = "survey the agent tree for stale rows";
const CHILD_READ = "agenttree.tsx";
const HANDBACK = "subagenthandback";
const LOAD_WAIT_MS = 10_000;
// the parent's re-read is debounced 4s behind its stream's next poll
const FINISH_WAIT_MS = 20_000;

const HEADER_PILL = `document.querySelector("[data-agent-header] [data-agent-state-pill]")`;
const RAIL = `document.querySelector('aside[aria-label="Agent details"]')`;
const flatOf = (expr) => `((${expr})?.textContent ?? "").replace(/\\s+/g, " ").trim()`;

// the subagent's row in the Agent tree, its dot's fill beside the working color, both as the browser computes them
const treeSub = `(() => {
    const tree = document.querySelector("[data-agent-tree]");
    const label = tree && [...tree.querySelectorAll("div")].find(
        (d) => d.children.length === 0 && d.textContent.trim() === ${JSON.stringify(CHILD_TYPE)}
    );
    const row = label?.closest(".rounded-\\\\[9px\\\\]");
    const dot = row?.querySelector("span.rounded-full");
    if (!dot) return { row: false };
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--color-accent)";
    document.body.appendChild(probe);
    const want = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { row: true, fill: getComputedStyle(dot).backgroundColor, want, text: row.textContent.trim() };
})()`;

const railHasResume = `[...(${RAIL}?.querySelectorAll("button") ?? [])].some((b) => b.textContent.trim() === "Resume")`;
const railSubState = `(() => {
    const rail = ${RAIL};
    const label = rail && [...rail.querySelectorAll("div")].find(
        (d) => d.children.length === 0 && d.textContent.trim() === ${JSON.stringify(CHILD_TYPE)}
    );
    const row = label?.closest(".rounded-\\\\[10px\\\\]");
    return row ? row.lastElementChild?.textContent.trim() ?? null : null;
})()`;
const INTERIOR = `document.querySelector('button[title="Back to parent (Esc)"]')?.parentElement?.parentElement`;

function writeFixture(dir) {
    const parentPath = writeTranscript(dir, SESSION, [
        userText("survey the tree in the background"),
        toolUse(SPAWN_ID, "Agent", {
            subagent_type: CHILD_TYPE,
            description: "survey the tree",
            prompt: CHILD_PROMPT,
            run_in_background: true,
        }),
        toolResult(SPAWN_ID, "Async agent launched successfully", {
            toolUseResult: { isAsync: true, status: "async_launched", agentId: CHILD_ID },
        }),
        assistantText("The survey runs in the background; I will report when it lands."),
    ]);
    // the child's last record is a tool result, so its file reads as still working
    const childPath = writeSubagent(dir, SESSION, CHILD_ID, [
        userText(CHILD_PROMPT),
        toolUse("toolu_child_read", "Read", { file_path: `C:\\arc-verify-agent-fixture\\${CHILD_READ}` }),
        toolResult("toolu_child_read", "export function AgentTree() {}"),
        toolUse("toolu_child_handback", "SubagentHandback", { description: "hand the survey back" }),
        toolResult("toolu_child_handback", "handed back"),
    ]);
    return { parentPath, childPath };
}

export default function (_kit) {
    return [
        {
            name: NAME,
            surface: "agent",
            async arrange(h) {
                const ctx = { dir: mkdtempSync(join(tmpdir(), "verify-agent-subagents-")) };
                // a throw past this point still returns ctx, so teardown undoes whatever was already set
                try {
                    Object.assign(ctx, writeFixture(ctx.dir));
                    await h.goto("agent");
                    const { tabId, blockId } = await makeTab(h, ctx, { label: PARENT_NAME });
                    ctx.parentId = tabId;
                    ctx.prevRail = await agentPage(
                        h,
                        `const R = await mod("app/view/agents/railstore.ts");
                        const prev = globalStore.get(R.railVisibleAtom);
                        globalStore.set(R.railVisibleAtom, true);
                        return prev;`
                    );
                    await setRoster(h, [
                        {
                            id: tabId,
                            name: PARENT_NAME,
                            project: "waveterm",
                            task: "survey the tree",
                            state: "idle",
                            agent: "claude",
                            model: "opus",
                            idleSince: Date.now() - 30_000,
                            blockId,
                            transcriptPath: ctx.parentPath,
                        },
                    ]);
                    await focusAgent(h, tabId);
                } catch (e) {
                    ctx.arrangeError = String(e?.message ?? e);
                }
                return ctx;
            },
            async assert(h, ctx) {
                const steps = [];
                const rec = (step, ok, detail) => steps.push({ step, ok, detail });
                if (ctx.arrangeError != null) {
                    rec("arrange the fixture agent", false, ctx.arrangeError);
                    return steps;
                }

                await polishWaitFor(h, `${flatOf(HEADER_PILL)} === "standing by"`, LOAD_WAIT_MS);
                const pill1 = await h.ev(flatOf(HEADER_PILL));
                const resume1 = await h.ev(railHasResume);
                await h.shot("cdp-shots/agent-subagents-1-standing-by.png");
                rec(
                    "1. a running background subagent holds the header at standing by, and the rail offers no Resume",
                    pill1 === "standing by" && !resume1,
                    JSON.stringify({ pill: pill1, resume: resume1 })
                );

                await polishWaitFor(h, `${treeSub}.row`, LOAD_WAIT_MS);
                const sub2 = await h.ev(treeSub);
                await h.shot("cdp-shots/agent-subagents-2-tree-working.png");
                rec(
                    "2. the tree row shows the subagent working",
                    sub2.row && sub2.fill === sub2.want,
                    JSON.stringify(sub2)
                );

                appendFileSync(
                    ctx.parentPath,
                    taskNotification({
                        taskId: CHILD_ID,
                        toolUseId: SPAWN_ID,
                        status: "completed",
                        summary: "Agent \"survey the tree\" completed",
                    }) + "\n"
                );
                await polishWaitFor(
                    h,
                    `${flatOf(HEADER_PILL)} === "idle" && ${railSubState} === "success"`,
                    FINISH_WAIT_MS
                );
                const pill3 = await h.ev(flatOf(HEADER_PILL));
                const sub3 = await h.ev(railSubState);
                const resume3 = await h.ev(railHasResume);
                await h.shot("cdp-shots/agent-subagents-3-finished.png");
                rec(
                    "3. its completed task notification turns the header idle and the subagent done",
                    pill3 === "idle" && sub3 === "success",
                    JSON.stringify({ pill: pill3, subagent: sub3, resume: resume3 })
                );

                await agentPage(
                    h,
                    `const S = await mod("app/view/agents/subagentsstore.ts");
                    globalStore.set(S.focusSubagentAtom, {
                        parentId: ${JSON.stringify(ctx.parentId)},
                        agentId: ${JSON.stringify(CHILD_ID)},
                        transcriptPath: ${JSON.stringify(ctx.childPath)},
                        label: ${JSON.stringify(CHILD_TYPE)},
                    });
                    return true;`
                );
                await polishWaitFor(
                    h,
                    `${flatOf(INTERIOR)}.includes(${JSON.stringify(CHILD_READ)}) && ${flatOf(RAIL)}.includes("Tools used")`,
                    LOAD_WAIT_MS
                );
                const interior = await h.ev(flatOf(INTERIOR));
                const rail = await h.ev(flatOf(RAIL));
                await h.shot("cdp-shots/agent-subagents-4-interior.png");
                rec(
                    "4. the subagent interior and its Tools used leave out the SubagentHandback call",
                    interior.includes(CHILD_READ) &&
                        !interior.toLowerCase().includes(HANDBACK) &&
                        rail.includes("Tools used") &&
                        !rail.toLowerCase().includes(HANDBACK),
                    JSON.stringify({ interior: interior.slice(0, 200), rail: rail.slice(0, 300) })
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
                await step("close the subagent interior", () =>
                    agentPage(
                        h,
                        `const S = await mod("app/view/agents/subagentsstore.ts");
                        globalStore.set(S.focusSubagentAtom, null);
                        return true;`
                    )
                );
                await step("restore the roster", () => restoreRoster(h));
                await step("close the fixture tab", () => closeTabs(h, ctx));
                if (ctx.prevRail !== undefined) {
                    await step("restore the rail", () =>
                        agentPage(
                            h,
                            `const R = await mod("app/view/agents/railstore.ts");
                            globalStore.set(R.railVisibleAtom, ${JSON.stringify(ctx.prevRail)});
                            return true;`
                        )
                    );
                }
                await step("remove the fixture transcripts", () => rmSync(ctx.dir, { recursive: true, force: true }));
                await step("go home", () => h.goto("cockpit"));
            },
        },
    ];
}
