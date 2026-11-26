// The fixture behind the transcript-subagents-* scenarios: one claude parent ("fix-plan-parse") whose transcript spawns
// five subagents, each child with its transcript and meta file under <session>/subagents/.
//
//   turn 1  the user asks for a guide check; a background general-purpose child ("Check the plan guide is current")
//   turn 2  its completed task notification, and the parent's reply
//   turn 3  the user asks for the fix: a finished foreground Explore ("List the plan format tests", 14 tools), two
//           running background general-purpose children ("Research app store gaps" on a WebFetch, then "Audit the
//           release notes"), and a running foreground Explore ("Find where plans are parsed", on a Grep, 9 tools)
//
// The audit child's first prompt differs from its spawn's, so only its meta's toolUseId joins it. turnEnded finishes
// the foreground Explore and ends turn 3 with a reply, for an idle parent. Every time is fixed off `now`, so writing
// again with the same `now` and turnEnded only appends. The page side (arrange, teardown) runs against the dev app.

import { appendFileSync, rmSync } from "node:fs";
import {
    agentPage,
    assistantText,
    closeTabs,
    focusAgent,
    makeTab,
    pinDefaultView,
    restoreDefaultView,
    restoreRoster,
    setRoster,
    taskNotification,
    toolResult,
    toolUse,
    userText,
    writeSubagent,
    writeSubagentMeta,
    writeTranscript,
} from "./agent-page-fixtures.mjs";
import { polishWaitFor } from "./scenarios-shared.mjs";

export const PARENT_NAME = "fix-plan-parse";
export const SESSION = "fix-plan-parse";
const MODEL_ID = "claude-opus-5-5";
const VIEW_WAIT_MS = 10_000;
const SEC = 1_000;
const MIN = 60 * SEC;
const SURFACE = `document.querySelector("[data-cockpit-surface-wrap]")`;

const EXPLORE = "Explore";
const GENERAL = "general-purpose";

// each child: its id, its spawn's Agent call, and what its own transcript holds. tools counts every tool call in the
// file, the running one included; current is the running call
export const SUBAGENTS = {
    tests: {
        agentId: "fxlisttests",
        toolUseId: "toolu_fx_list_tests",
        type: EXPLORE,
        description: "List the plan format tests",
        prompt: "List the tests that cover the plan format in pkg/jarvis.",
        background: false,
        tools: 14,
    },
    find: {
        agentId: "fxfindparse",
        toolUseId: "toolu_fx_find_parse",
        type: EXPLORE,
        description: "Find where plans are parsed",
        prompt: "Find every place a plan file is parsed.",
        background: false,
        tools: 9,
        current: { name: "Grep", input: { pattern: "parsePlan(", path: "pkg/" } },
    },
    research: {
        agentId: "fxresearch",
        toolUseId: "toolu_fx_research",
        type: GENERAL,
        description: "Research app store gaps",
        prompt: "Research which app store review rules the release could trip.",
        background: true,
        tools: 5,
        current: {
            name: "WebFetch",
            input: {
                url: "https://developer.apple.com/app-store/review/guidelines/",
                prompt: "List the rules on plan files.",
            },
        },
    },
    audit: {
        agentId: "fxaudit",
        toolUseId: "toolu_fx_audit",
        type: GENERAL,
        description: "Audit the release notes",
        prompt: "Audit the release notes against the merged changes.",
        // the child's own first prompt, reworded from its spawn's
        childPrompt: "Check each release note entry against the merged pull requests.",
        background: true,
        tools: 3,
        current: { name: "Read", input: { file_path: "C:\\arc-verify-agent-fixture\\RELEASE_NOTES.md" } },
    },
    guide: {
        agentId: "fxguide",
        toolUseId: "toolu_fx_guide",
        type: GENERAL,
        description: "Check the plan guide is current",
        prompt: "Check docs/orchestrator-guide.md still matches the plan format.",
        background: true,
        tools: 6,
    },
};

// a finished child's report, and its last words
const REPORT = (sub) => `${sub.description}: done.`;
const iso = (ms) => new Date(ms).toISOString();

// the completed calls before a child's running one or its end: reads of numbered files, spaced over [from, to)
function completedCalls(sub, n, from, to) {
    const step = (to - from) / Math.max(n, 1);
    return Array.from({ length: n }, (_, i) => {
        const id = `${sub.toolUseId}_c${i}`;
        const at = from + i * step;
        return [
            toolUse(id, "Read", { file_path: `C:\\arc-verify-agent-fixture\\${sub.agentId}-${i}.go` }, { ts: iso(at) }),
            toolResult(id, `package jarvis // ${i}`, { ts: iso(at + step / 2) }),
        ];
    }).flat();
}

// a child's transcript: its prompt and calls, then (one with a current call) its running call, then (finished) a
// terminal reply. A running child finished later keeps every earlier line, so a rewrite only appends
function childLines(sub, { start, end, finished, currentAt }) {
    const lines = [userText(sub.childPrompt ?? sub.prompt, { ts: iso(start) })];
    if (currentAt == null) {
        lines.push(...completedCalls(sub, sub.tools, start + SEC, end - SEC));
    } else {
        const currentId = `${sub.toolUseId}_current`;
        lines.push(...completedCalls(sub, sub.tools - 1, start + SEC, currentAt - SEC));
        lines.push(toolUse(currentId, sub.current.name, sub.current.input, { ts: iso(currentAt) }));
        if (finished) {
            lines.push(toolResult(currentId, "ok", { ts: iso(end - SEC / 2) }));
        }
    }
    if (finished) {
        lines.push(assistantText(REPORT(sub), { ts: iso(end) }));
    }
    return lines;
}

const spawnCall = (sub, at) =>
    toolUse(
        sub.toolUseId,
        "Agent",
        {
            subagent_type: sub.type,
            description: sub.description,
            prompt: sub.prompt,
            ...(sub.background ? { run_in_background: true } : {}),
        },
        { ts: iso(at) }
    );

const launchAck = (sub, at) =>
    toolResult(sub.toolUseId, `Async agent launched successfully.\nagentId: ${sub.agentId}`, {
        ts: iso(at),
        toolUseResult: { isAsync: true, status: "async_launched", agentId: sub.agentId },
    });

const report = (sub, at) =>
    toolResult(sub.toolUseId, REPORT(sub), {
        ts: iso(at),
        toolUseResult: { status: "completed", agentId: sub.agentId },
    });

function writeChild(dir, sub, times) {
    const path = writeSubagent(dir, SESSION, sub.agentId, childLines(sub, times));
    writeSubagentMeta(dir, SESSION, sub.agentId, {
        agentType: sub.type,
        description: sub.description,
        toolUseId: sub.toolUseId,
        requestShape: sub.background ? "background" : "foreground",
        ...(times.finished ? { finished: true } : {}),
    });
    return path;
}

/** Write the parent and its five children under dir. Returns their paths, keyed like SUBAGENTS, and the `now` every
 *  time is fixed off. */
export function writeSubagentsFixture(dir, { turnEnded = false, now = Date.now() } = {}) {
    const S = SUBAGENTS;
    const t1 = now - 20 * MIN;
    const guideEnd = t1 + 6 * MIN;
    const t3 = now - 8 * MIN;
    const at = {
        tests: { spawn: t3 + 10 * SEC, end: now - 5 * MIN },
        research: { spawn: now - 4 * MIN - 50 * SEC, current: now - 30 * SEC },
        audit: { spawn: now - 4 * MIN, current: now - 20 * SEC },
        find: { spawn: now - 3 * MIN - 50 * SEC, current: now - 10 * SEC },
    };
    const findEnd = now;
    const parentLines = [
        userText("Check the plan guide is current, in the background.", { ts: iso(t1) }),
        spawnCall(S.guide, t1 + 5 * SEC),
        launchAck(S.guide, t1 + 6 * SEC),
        assistantText("The guide check runs in the background.", { ts: iso(t1 + 10 * SEC) }),
        taskNotification({
            taskId: S.guide.agentId,
            toolUseId: S.guide.toolUseId,
            status: "completed",
            summary: `Agent "${S.guide.description}" completed`,
            ts: iso(guideEnd + 2 * SEC),
        }),
        assistantText("The plan guide is current.", { ts: iso(guideEnd + 10 * SEC) }),
        userText("Fix the plan parse bug.", { ts: iso(t3) }),
        spawnCall(S.tests, at.tests.spawn),
        report(S.tests, at.tests.end + SEC),
        spawnCall(S.research, at.research.spawn),
        launchAck(S.research, at.research.spawn + SEC),
        spawnCall(S.audit, at.audit.spawn),
        launchAck(S.audit, at.audit.spawn + SEC),
        spawnCall(S.find, at.find.spawn),
    ];
    if (turnEnded) {
        parentLines.push(
            report(S.find, findEnd + SEC),
            assistantText("Plans parse in one place now.", { ts: iso(findEnd + 2 * SEC) })
        );
    }
    const parentPath = writeTranscript(dir, SESSION, parentLines);
    const paths = {
        guide: writeChild(dir, S.guide, { start: t1 + 6 * SEC, end: guideEnd, finished: true }),
        tests: writeChild(dir, S.tests, { start: at.tests.spawn + SEC, end: at.tests.end, finished: true }),
        research: writeChild(dir, S.research, { start: at.research.spawn + SEC, currentAt: at.research.current }),
        audit: writeChild(dir, S.audit, { start: at.audit.spawn + SEC, currentAt: at.audit.current }),
        find: writeChild(dir, S.find, {
            start: at.find.spawn + SEC,
            currentAt: at.find.current,
            ...(turnEnded ? { end: findEnd, finished: true } : {}),
        }),
    };
    return { parentPath, childPaths: paths, now };
}

/** Append a terminal assistant turn to a running child's transcript, which finishes it. */
export function finishSubagent(childPath) {
    appendFileSync(childPath, assistantText("Finished.", { ts: iso(Date.now()) }) + "\n");
}

const rosterEntry = (ctx, state) => ({
    id: ctx.parentId,
    name: PARENT_NAME,
    project: "waveterm",
    task: "fix the plan parse bug",
    state,
    agent: "claude",
    model: MODEL_ID,
    blockId: ctx.parentBlockId,
    transcriptPath: ctx.parentPath,
    ...(state === "idle" ? { idleSince: Date.now() } : {}),
});

/** Set the parent's roster state ("working" or "idle"). */
export const setParentState = (h, ctx, state) => setRoster(h, [rosterEntry(ctx, state)]);

/** Make the parent's tab, show it on the Agent surface in the Rendered view, with the given state. ctx holds the
 *  paths writeSubagentsFixture returned. A tab with no controller: nothing runs in it, so its process never exits. */
export async function arrangeSubagentsAgent(h, ctx, { state }) {
    await h.goto("agent");
    await pinDefaultView(h, "rendered");
    const { tabId, blockId } = await makeTab(h, ctx, {
        label: PARENT_NAME,
        blockMeta: { view: "term", controller: null },
    });
    ctx.parentId = tabId;
    ctx.parentBlockId = blockId;
    await setParentState(h, ctx, state);
    await focusAgent(h, tabId);
    if (!(await polishWaitFor(h, `${SURFACE}?.querySelector("[data-view-toggle]") != null`, VIEW_WAIT_MS))) {
        throw new Error(`the view toggle never showed for ${PARENT_NAME}`);
    }
}

/** Best-effort, so one failed step does not strand the rest; removes ctx.dir. */
export async function teardownSubagentsAgent(h, ctx) {
    const step = async (what, fn) => {
        try {
            await fn();
        } catch (e) {
            console.error(`transcript-subagents teardown: ${what} failed: ${e?.message ?? e}`);
        }
    };
    await step("close the subagent view", () =>
        agentPage(
            h,
            `const S = await mod("app/view/agents/subagentsstore.ts");
            globalStore.set(S.focusSubagentAtom, null);
            return true;`
        )
    );
    await step("restore the default view", () => restoreDefaultView(h));
    await step("restore the roster", () => restoreRoster(h));
    await step("close the fixture tab", () => closeTabs(h, ctx));
    if (ctx.dir != null) {
        await step("remove the fixture transcripts", () => rmSync(ctx.dir, { recursive: true, force: true }));
    }
    await step("go home", () => h.goto("cockpit"));
}
