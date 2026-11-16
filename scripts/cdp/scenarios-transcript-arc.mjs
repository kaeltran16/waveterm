// Scenario `transcript-arc`: Arc's own messages in a transcript (arcmessagerow.tsx): the run and task briefs, the
// lead's wakes (plan review, a worker's question, recovery, Final failed, run finished, an unknown one), the Waited
// fold before a wake, the brainstorm judge's result, pane actions and the builder check, a pane pick left as the
// human's bubble, and compact wakes at 380 px.

import { clearTranscript, prose, ROOT, showTranscript, user, waitSeam } from "./transcript-fixture.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.UTC(2026, 10, 16, 9, 0, 0);
const S = 1000;
const M = 60 * S;
const WIDE = 736;
const NARROW = 380;
const CLICK_SETTLE_MS = 400;
const RUN = "run-arc";
const CHANNEL = "ch-arc";
const LEAD = { channelId: CHANNEL, role: { kind: "lead", runId: RUN } };
const WORKER = { channelId: CHANNEL, role: { kind: "worker", leadRunId: RUN, taskId: "t-2" } };
const BS_DIR = "C:/demo/.superpowers/brainstorm/run-memory";
const BS_FILE = `${BS_DIR}/brainstorm.json`;
const BRAINSTORM = { brainstormFile: BS_FILE };
const status = (t) => `wsh jarvis dag status ${t}`;

const GOAL = "Goal: add, subtract, multiply and truncate modules with tests";
const RUN_SEED = {
    [`arc-run:${RUN}`]: {
        goal: GOAL,
        planSkill: "arc:plan",
        autonomous: true,
        tasks: [
            { id: "t-1", label: "add module", state: "done" },
            { id: "t-2", label: "subtract module", state: "done" },
            { id: "t-3", label: "multiply module", state: "done" },
            { id: "t-4", label: "truncate", state: "done" },
        ],
    },
};

const runEvent = (kind, ts, detail) => ({ id: `${kind}-${ts}`, runid: RUN, channelid: CHANNEL, ts, kind, detail: JSON.stringify(detail) });

const FINDING_1 = "Task 3 changes writeLaunchPrompt to take the skill, but its only caller is pkg/jarvis/run.go:297 and no task lists run.go.";
const FINDING_2 = "Task 4 renames the design-session prompt, but scripts/cdp-e2e-runs-piece4.mjs:92 asserts the old text.";
const PLAN_FAILED = `wake: plan review failed in round 1: [Second pass] 1) ${FINDING_1} 2) ${FINDING_2} Passed: Full review. Revise the plan (put spec changes to the human) and run \`wsh jarvis dag submit\` again.`;
const ASK_QUESTION = "When truncate shortens a string, should the result end with … or with three dots?";
const DEFECT_1 = "boards-draw · step 4: the arrow stays at the x/y it was drawn at when its box glides";
const DEFECT_2 = "boards-surface · step 2: at 1280 px the empty-state text runs under the toolbar";
const DEFECT_LAST = "boards-draw · step 4: the arrow follows the box, but its label stays behind";
const FINAL_SHA = "3a7f1c2";
const FINAL_SHA_LAST = "59c03d0";
const CONFLICT_FILE = "frontend/app/view/boards/boards.tsx";
const FAIL_LINE = "FAIL frontend/app/view/boards/boardsdraw.test.ts";
const UNKNOWN_WAKE = "wake: the human reran the final stage of round 1; its failure was outside the code. Drop any fix plan for it.";
const PANE_PICK = "One Final at a time";

const brainstormFile = {
    v: 1,
    title: "Memory pressure during runs",
    spec: "docs/superpowers/specs/2026-11-12-run-memory-pressure-design.md",
    question: {
        n: 3,
        text: "How should a run keep its memory under the machine's limit?",
        part: "approach",
        options: [
            { label: "One Final at a time", detail: "three overlapping verifies were the peak; one queue removes it", pick: true },
            { label: "Memory gate", detail: "kept as the second option" },
            { label: "Shared node_modules", detail: "kept as the third option" },
        ],
        judge: {
            kind: "weighed",
            added: [],
            dropped: [
                { name: "Lower parallelism", reason: "width barely moves wall time, and this would slow every run" },
                { name: "Sonnet workers", reason: "the A/B kept Opus for quality" },
            ],
        },
    },
    working: null,
    parts: [{ id: "approach", title: "Approach", state: "guess", body: "x" }],
    history: [],
    done: false,
    check: {
        yours: [{ q: "should the run say so in the attention banner?" }],
        calls: [{ text: "queue order is FIFO" }],
        answered: ["verify waits are logged"],
    },
    run: null,
};
const BS_SEED = { [`brainstorm:${BS_FILE}`]: brainstormFile };

// named { entries, seed?, runEvents?, ctx?, compact?, width? } the boards scenario composes (transcript-boards)
export const fixtures = {
    runBrief: {
        ctx: LEAD,
        seed: RUN_SEED,
        entries: [
            user(`# Lead this run\n\n${GOAL}\n\nWrite the plan with arc:plan, then submit it with \`wsh jarvis dag submit\`.`, T0),
            prose("Reading the repo before writing the plan.", T0 + 20 * S),
        ],
    },
    taskBrief: {
        ctx: WORKER,
        seed: RUN_SEED,
        entries: [
            user("You are the worker for task t-2 of the plan: subtract module, with tests, in src/subtract.js.", T0),
            prose("Subtract is in src/subtract.js with four tests; the suite passes.", T0 + 40 * S),
        ],
    },
    planReview: {
        ctx: LEAD,
        runEvents: {
            [RUN]: [
                runEvent("plan-reviewed", T0 + 5 * M + 10 * S, { state: "passed", round: 2 }),
                runEvent("task-spawned", T0 + 5 * M + 15 * S, { taskid: "t-1" }),
                runEvent("task-spawned", T0 + 5 * M + 16 * S, { taskid: "t-2" }),
                runEvent("task-spawned", T0 + 5 * M + 17 * S, { taskid: "t-4" }),
            ],
        },
        entries: [
            user(PLAN_FAILED, T0),
            prose("Both findings are right. Adding run.go to Task 3 and the e2e script to Task 4, then resubmitting.", T0 + 20 * S),
            prose("Resubmitted.", T0 + 5 * M),
            user(`wake: task t-1 passed review with a note for later tasks: multiply imports add from src/add.js. ${status("t-1")}`, T0 + 5 * M + 30 * S),
            prose("The plan passed on round 2. Workers are on t-1, t-2 and t-4; t-3 waits for t-1.", T0 + 5 * M + 40 * S),
        ],
    },
    asks: {
        ctx: LEAD,
        runEvents: { [RUN]: [runEvent("child-ask", T0, { taskid: "t-4", question: ASK_QUESTION })] },
        entries: [user("wake: 1 question waiting. wsh jarvis dag asks", T0 + 6 * S), prose("Answering t-4.", T0 + 10 * S)],
    },
    recovery: {
        ctx: LEAD,
        entries: [
            user("wake: task t-5 never started: no worker process 5m after spawn. wsh jarvis dag retry t-5", T0),
            prose("Nothing ran, so nothing is lost. Retrying it.", T0 + 5 * S),
            user(`wake: merge conflict landing lane ending at task t-6 in ${CONFLICT_FILE}. ${status("t-6")}`, T0 + 20 * S),
            prose("Resolving the toolbar conflict.", T0 + 25 * S),
            user(
                `wake: task t-4 may be stuck: the same test has failed for 14 minutes. Tell it (\`wsh jarvis dag tell t-4 "…"\`), retry, escalate, or let it run. ${status("t-4")}`,
                T0 + 40 * S
            ),
            prose("That is a product call, so it goes to you.", T0 + 45 * S),
            user(`wake: task t-7 failed (tests): ${FAIL_LINE}, retry spent. ${status("t-7")}`, T0 + 60 * S),
            prose("Both attempts failed on the same hit-test bug. Escalating to Opus.", T0 + 65 * S),
        ],
    },
    finalFail: {
        ctx: LEAD,
        runEvents: {
            [RUN]: [
                runEvent("task-merged", T0 + 20 * M, { taskid: "t-14" }),
                runEvent("task-merged", T0 + 25 * M, { taskid: "t-15" }),
                runEvent("final-ended", T0 + 37 * M, { round: 2, outcome: "failed" }),
            ],
        },
        entries: [
            user(
                `wake: the final stage failed on the merged result in round 1. Write a fix plan and run \`wsh jarvis dag submit --round --plan <fix plan>\`. Put it to the human if the fix is a product call:\n${DEFECT_1}\n${DEFECT_2}`,
                T0
            ),
            prose("Both are real. A fix round with one task per defect.", T0 + 30 * S),
            user(
                `wake: the final stage failed on the merged result in round 2, the last. Put it to the human, and say that completing will not merge the branch:\n${DEFECT_LAST}`,
                T0 + 30 * S + 38 * M
            ),
            prose("No round is left. Completing the run; the branch stays unmerged until you decide.", T0 + 31 * S + 38 * M),
        ],
    },
    // the wakes the engine writes now, naming the commit and the total; finalFail above keeps the older form (no sha,
    // no total) as an old transcript does, and transcript-boards composes it
    finalFailEngine: {
        ctx: LEAD,
        runEvents: {
            [RUN]: [
                runEvent("task-merged", T0 + 20 * M, { taskid: "t-14" }),
                runEvent("task-merged", T0 + 25 * M, { taskid: "t-15" }),
                runEvent("final-ended", T0 + 37 * M, { round: 3, outcome: "failed" }),
            ],
        },
        entries: [
            user(
                `wake: the final stage failed on the merged result ${FINAL_SHA} in round 1 of 3. Write a fix plan and run \`wsh jarvis dag submit --round --plan <fix plan>\`. Put it to the human if the fix is a product call:\n${DEFECT_1}\n${DEFECT_2}`,
                T0
            ),
            prose("Both are real. A fix round with one task per defect.", T0 + 30 * S),
            user(
                `wake: the final stage failed on the merged result ${FINAL_SHA_LAST} in round 3 of 3, the last. Put it to the human, and say that completing will not merge the branch:\n${DEFECT_LAST}`,
                T0 + 30 * S + 38 * M
            ),
            prose("No round is left. Completing the run; the branch stays unmerged until you decide.", T0 + 31 * S + 38 * M),
        ],
    },
    runFinished: {
        ctx: LEAD,
        seed: RUN_SEED,
        runEvents: { [RUN]: [runEvent("final-ended", T0 - 10 * S, { round: 1, outcome: "passed" })] },
        entries: [
            user("wake: run finished. wsh jarvis dag status", T0),
            prose("All four modules landed and Final passed on the merged result.", T0 + 10 * S),
        ],
    },
    judge: {
        ctx: BRAINSTORM,
        seed: BS_SEED,
        entries: [
            prose("I see five ways to keep a run under memory; the judge weighs them blind.", T0),
            user(`brainstorm: judged ${BS_DIR}/judge.json`, T0 + 2 * M),
            prose("Question 3 is in the pane with the judge's pick.", T0 + 2 * M + 10 * S),
        ],
    },
    paneActions: {
        ctx: BRAINSTORM,
        seed: BS_SEED,
        entries: [
            prose("Written into Approach.", T0),
            user("brainstorm: confirm every guess", T0 + 30 * S),
            user("brainstorm: settle keep approach, scope; confirm builder; then: brainstorm: check", T0 + 40 * S),
            user(`brainstorm: builder questions ${BS_DIR}/builder-check.md`, T0 + 4 * M),
            prose("One question is yours, and it's in the pane.", T0 + 4 * M + 10 * S),
        ],
    },
    panePick: {
        ctx: BRAINSTORM,
        seed: BS_SEED,
        entries: [prose("Question 3 is in the pane with the judge's pick.", T0), user(PANE_PICK, T0 + 30 * S)],
    },
    unknownWake: {
        ctx: LEAD,
        entries: [user(UNKNOWN_WAKE, T0), prose("Dropping the fix plan; waiting for the stage.", T0 + 5 * S)],
    },
    compactWakes: {
        ctx: LEAD,
        compact: true,
        width: NARROW,
        runEvents: { [RUN]: [runEvent("plan-reviewed", T0 + 50 * S, { state: "passed", round: 2 })] },
        entries: [
            user(PLAN_FAILED, T0),
            prose("Both are right; resubmitting.", T0 + 20 * S),
            user(
                [
                    "wake: task t-5 never started: no worker process 5m after spawn. wsh jarvis dag retry t-5",
                    `wake: task t-3's worker exited without reporting complete. ${status("t-3")}`,
                    "Since your last wake:",
                    "t-1 landed",
                ].join("\n"),
                T0 + 55 * S
            ),
        ],
    },
};

const probe = (body) => `(() => { const root = document.querySelector(${JSON.stringify(ROOT)}); if (!root) return null; ${body} })()`;

const MESSAGES = probe(`
    const textOf = (el) => (el.innerText || '').replace(/\\s+/g, ' ').trim();
    return [...root.querySelectorAll('[data-arc-message]')].map((el) => ({
        kind: el.getAttribute('data-arc-message'),
        line: el.getAttribute('data-brainstorm-line'),
        text: textOf(el),
        parts: [...el.querySelectorAll('[data-wake-part]')].map((p) => p.getAttribute('data-wake-part')),
        expanded: [...el.querySelectorAll('[aria-expanded]')].map((b) => b.getAttribute('aria-expanded')),
        findings: el.querySelectorAll('[data-finding]').length,
        defects: el.querySelectorAll('[data-defect]').length,
        waited: el.querySelector('[data-waited]') ? textOf(el.querySelector('[data-waited]')) : null,
        waitedEvents: el.querySelectorAll('[data-waited-event]').length,
        briefText: !!el.querySelector('[data-brief-text]'),
        kept: el.querySelectorAll('[data-judge-kept]').length,
        dropped: [...el.querySelectorAll('[data-judge-dropped]')].map((d) => getComputedStyle(d.firstElementChild).textDecorationLine),
        counts: el.querySelector('[data-builder-counts]') ? textOf(el.querySelector('[data-builder-counts]')) : null,
        pane: [...el.querySelectorAll('[data-pane-action]')].map((p) => p.getAttribute('data-pane-action')),
        loadError: !!el.querySelector('[data-load-error]'),
        overflows: el.scrollWidth > el.clientWidth + 1,
        inBubble: !!el.closest('[data-user-bubble]'),
    }));
`);

const BUBBLES = probe(`return [...root.querySelectorAll('[data-user-bubble]')].map((el) => (el.innerText || '').trim());`);

// clicks the first toggle of the nth Arc message matching sel
const click = (n, sel) =>
    probe(`const el = root.querySelectorAll('[data-arc-message]')[${n}]?.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true;`);

async function show(h, name) {
    const { width, ...fixture } = fixtures[name];
    await showTranscript(h, { ...fixture, width: width ?? WIDE, active: false, renderers: true });
    return (await h.ev(MESSAGES)) ?? [];
}

const hasAll = (text, parts) => parts.every((p) => text.includes(p));

export const transcriptArc = {
    name: "transcript-arc",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const seam = await waitSeam(h);
        const steps = [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
        if (!seam) return steps;

        // run brief, folded then opened
        const folded = (await show(h, "runBrief"))[0];
        await h.shot("cdp-shots/transcript-arc-run-brief-folded.png");
        const clicked = await h.ev(click(0, "button[aria-expanded]"));
        await sleep(CLICK_SETTLE_MS);
        const opened = ((await h.ev(MESSAGES)) ?? [])[0];
        await h.shot("cdp-shots/transcript-arc-run-brief-opened.png");
        steps.push({
            step: "Run brief folded and opened: the goal line, plan skill and autonomy folded; the brief's text opened",
            ok:
                folded?.kind === "brief" &&
                hasAll(folded.text, ["Run brief from Arc", GOAL, "plan skill arc:plan", "autonomous"]) &&
                folded.expanded[0] === "false" &&
                !folded.briefText &&
                clicked === true &&
                opened?.expanded[0] === "true" &&
                opened.briefText &&
                opened.text.includes("Lead this run"),
            detail: JSON.stringify({ folded, opened }),
        });

        const task = (await show(h, "taskBrief"))[0];
        await h.shot("cdp-shots/transcript-arc-task-brief.png");
        steps.push({
            step: "Task brief: the task id and its label, folded",
            ok: task?.kind === "brief" && hasAll(task.text, ["Task brief from Arc", "t-2: subtract module"]) && task.expanded[0] === "false",
            detail: JSON.stringify(task),
        });

        const plan = await show(h, "planReview");
        await h.shot("cdp-shots/transcript-arc-plan-review.png");
        const [failed, next] = plan;
        steps.push({
            step: "plan review failed with two findings, then passed: the failed wake opens to its findings, the pass shows before the next wake",
            ok:
                failed?.kind === "wake" &&
                failed.parts.includes("plan-review-failed") &&
                hasAll(failed.text, ["Arc woke the lead", "Plan review failed", "round 1", "2 findings", "Second pass", "writeLaunchPrompt"]) &&
                failed.findings === 2 &&
                failed.expanded[0] === "true" &&
                next?.parts.includes("plan-review-passed") &&
                hasAll(next.text, ["Plan review passed", "round 2", "3 tasks dispatched", "t-1 passed review with a note"]),
            detail: JSON.stringify(plan),
        });

        const ask = (await show(h, "asks"))[0];
        await h.shot("cdp-shots/transcript-arc-asks.png");
        steps.push({
            step: "t-4 asks a question: the asking task, the deadline from its child-ask event, and the question",
            ok: ask?.kind === "wake" && hasAll(ask.text, ["Arc woke the lead", "t-4 asks a question", "deadline in 9m 54s", ASK_QUESTION]),
            detail: JSON.stringify(ask),
        });

        const recovery = await show(h, "recovery");
        await h.shot("cdp-shots/transcript-arc-recovery.png");
        const kinds = recovery.map((m) => m.parts[0]);
        steps.push({
            step: "never started, merge conflict with its file, may be stuck, failed with its test lines",
            ok:
                JSON.stringify(kinds) === JSON.stringify(["never-started", "merge-conflict", "may-be-stuck", "task-failed"]) &&
                hasAll(recovery[0].text, ["t-5 never started", "no worker process 5m after spawn"]) &&
                hasAll(recovery[1].text, ["Merge conflict", "landing the lane ending at t-6", CONFLICT_FILE]) &&
                hasAll(recovery[2].text, ["t-4 may be stuck", "the same test has failed for 14 minutes"]) &&
                hasAll(recovery[3].text, ["t-7 failed", "tests · retry spent", FAIL_LINE]),
            detail: JSON.stringify(recovery),
        });

        const olds = await show(h, "finalFail");
        await h.shot("cdp-shots/transcript-arc-final-failed-old.png");
        steps.push({
            step: "an old Final-failed wake (no commit, no total): Final failed with its round and defects, never a guessed total",
            ok:
                olds.length === 2 &&
                hasAll(olds[0].text, ["Final failed", "round 1", "on the merged result", "2 defects", "boards-surface · step 2"]) &&
                !olds[0].text.includes("round 1 of") &&
                olds[0].defects === 2 &&
                hasAll(olds[1].text, ["Final failed", "round 2 of 2, the last", "1 defect"]),
            detail: JSON.stringify(olds),
        });

        const finals = await show(h, "finalFailEngine");
        await h.shot("cdp-shots/transcript-arc-final-failed.png");
        steps.push({
            step: "Final failed round 1 and the last round: each with the engine's total and commit, its defects opened, and Shots",
            ok:
                finals.length === 2 &&
                hasAll(finals[0].text, ["Final failed", "round 1 of 3", `on the merged result ${FINAL_SHA}`, "2 defects", DEFECT_1, "boards-surface · step 2", "Shots"]) &&
                finals[0].defects === 2 &&
                hasAll(finals[1].text, ["Final failed", "round 3 of 3, the last", `on the merged result ${FINAL_SHA_LAST}`, "1 defect"]) &&
                finals[1].defects === 1,
            detail: JSON.stringify(finals),
        });

        const waitedClicked = await h.ev(click(1, "[data-waited] button"));
        await sleep(CLICK_SETTLE_MS);
        const waited = ((await h.ev(MESSAGES)) ?? [])[1];
        await h.shot("cdp-shots/transcript-arc-waited.png");
        steps.push({
            step: "Waited 38m opened to its events: the gap's landed tasks and Final run, listed when opened",
            ok:
                finals[0].waited == null &&
                finals[1].waited != null &&
                hasAll(finals[1].waited, ["Waited 38m", "2 tasks landed", "Final ran"]) &&
                waitedClicked === true &&
                waited?.waitedEvents === 3,
            detail: JSON.stringify({ before: finals[1]?.waited, after: waited }),
        });

        const finished = (await show(h, "runFinished"))[0];
        await h.shot("cdp-shots/transcript-arc-run-finished.png");
        steps.push({
            step: "Run finished with Final passed: all tasks landed and the Final verdict card under it",
            ok: finished?.kind === "wake" && hasAll(finished.text, ["Run finished", "all 4 tasks landed", "Final passed"]),
            detail: JSON.stringify(finished),
        });

        const judge = (await show(h, "judge"))[0];
        await h.shot("cdp-shots/transcript-arc-judge.png");
        steps.push({
            step: "judge result with kept and dropped approaches: the pick, the kept options and the dropped ones struck through with reasons",
            ok:
                judge?.line === "judged" &&
                hasAll(judge.text, ["The judge weighed question 3", "picks One Final at a time", "dropped 2", "Memory gate", "the A/B kept Opus for quality"]) &&
                judge.kept === 3 &&
                judge.dropped.length === 2 &&
                judge.dropped.every((d) => d.includes("line-through")),
            detail: JSON.stringify(judge),
        });

        const pane = await show(h, "paneActions");
        await h.shot("cdp-shots/transcript-arc-pane-actions.png");
        const [confirm, settle, builder] = pane;
        steps.push({
            step: "pane actions and the builder check: what you did in the pane, and the check's questions split by who answers",
            ok:
                pane.length === 3 &&
                JSON.stringify(confirm.pane) === JSON.stringify(["confirm-all"]) &&
                hasAll(confirm.text, ["In the brainstorm pane, you", "confirmed every guess"]) &&
                JSON.stringify(settle.pane) === JSON.stringify(["settle", "check"]) &&
                hasAll(settle.text, ["3 parts", "asked for the builder check"]) &&
                builder.line === "builder" &&
                hasAll(builder.text, ["Builder check", "3 questions back", brainstormFile.spec]) &&
                hasAll(builder.counts ?? "", ["1 answered already", "1 minor, my call", "1 for you"]),
            detail: JSON.stringify(pane),
        });

        const pick = await show(h, "panePick");
        const bubbles = (await h.ev(BUBBLES)) ?? [];
        await h.shot("cdp-shots/transcript-arc-pane-pick.png");
        steps.push({
            step: "a pane pick is a plain user bubble: no Arc event, the human's words in the bubble",
            ok: pick.length === 0 && bubbles.some((b) => b.includes(PANE_PICK)),
            detail: JSON.stringify({ pick, bubbles }),
        });

        const unknown = (await show(h, "unknownWake"))[0];
        await h.shot("cdp-shots/transcript-arc-unknown-wake.png");
        steps.push({
            step: "an unknown wake reads Arc woke the lead with its text",
            ok:
                unknown?.kind === "wake" &&
                JSON.stringify(unknown.parts) === JSON.stringify(["unknown"]) &&
                hasAll(unknown.text, ["Arc woke the lead", "the human reran the final stage of round 1"]) &&
                !unknown.inBubble,
            detail: JSON.stringify(unknown),
        });

        const compact = await show(h, "compactWakes");
        await h.shot("cdp-shots/transcript-arc-compact.png");
        steps.push({
            step: "compact wakes at 380 px: the first finding and how many more, a composed wake one row per line, nothing overflows",
            ok:
                compact.length === 2 &&
                hasAll(compact[0].text, ["Plan review failed", "round 1", "+1 more"]) &&
                compact[0].findings === 1 &&
                JSON.stringify(compact[1].parts) === JSON.stringify(["plan-review-passed", "never-started", "worker-exited", "quiet"]) &&
                compact.every((m) => !m.overflows),
            detail: JSON.stringify(compact),
        });
        return steps;
    },
    async teardown(h) {
        await clearTranscript(h);
    },
};
