// Scenario `transcript-base`: the transcript's anatomy over plain entries (transcriptlayout.ts): each finished turn's
// work folded into one "Worked for N" line that opens to its step boxes and cards, a running step's live elapsed, a
// wsh change call as a standalone row inside its turn's fold while a failed one stays a step, and a queued message
// splitting a turn's fold in two. Each check runs at the Rendered column's width and at a card's (compact).

import { bash, clearTranscript, prose, ROOT, showTranscript, tool, user, waitSeam } from "./transcript-fixture.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T0 = Date.UTC(2026, 10, 16, 9, 0, 0);
const S = 1000;
// the fold's motion settles before a step reads it
const MOTION_MS = 600;
// past one tick of the running step's elapsed
const TICK_MS = 2_100;
const RENAME = 'wsh effort rename e-fixture "Retry fix"';
const RENAME_FAILED = 'wsh effort rename e-missing "Retry fix"';

const edit = (path, ts) =>
    tool("edited", path, {
        ts,
        detail: {
            kind: "edit",
            files: [{ path, badge: "M", adds: 1, dels: 1, lines: [{ sign: "-", text: "await sleep(delayMs * i);" }, { sign: "+", text: "await sleep(delayMs * (i + 1));" }] }],
        },
    });

// a finished turn of four steps (41 s from the prompt to the reply), then a turn with a successful wsh change call
// and a two-step box holding the failed one: one fold each
const FINISHED = [
    user("Run node test.js, find why it fails, fix src/retry.js and run the test again.", T0),
    bash({ description: "Run the test", command: "node test.js", output: "not ok 1 waited 121ms", exit: 1, ts: T0 + 2 * S, durationMs: 400 }),
    tool("read", "retry.js", { ts: T0 + 3 * S }),
    edit("retry.js", T0 + 4 * S),
    bash({ description: "Run the test again", command: "node test.js", output: "ok 3 calls 313 ms", ts: T0 + 5 * S, durationMs: 300 }),
    prose("The first retry waited 0 ms. It passes now.", T0 + 41 * S),
    user("Rename the initiative to Retry fix.", T0 + 60 * S),
    bash({ description: "Rename the initiative", command: RENAME, output: "renamed", ts: T0 + 61 * S, durationMs: 200 }),
    bash({ description: "Rename the other one", command: RENAME_FAILED, output: "no effort e-missing", exit: 1, ts: T0 + 62 * S, durationMs: 150 }),
    tool("read", "notes.md", { ts: T0 + 63 * S }),
    prose("Renamed; the second id does not exist.", T0 + 64 * S),
];

// a finished turn the human steered mid-way: the queued message stays out, a fold on each side of it
const QUEUED_TEXT = "Also check the second caller.";
const QUEUED = [
    user("Fix the retry delay.", T0),
    tool("read", "retry.js", { ts: T0 + S }),
    bash({ description: "Run the test", command: "node test.js", output: "ok", ts: T0 + 2 * S, durationMs: 300 }),
    { kind: "user", text: QUEUED_TEXT, ts: T0 + 3 * S, queued: true },
    tool("read", "queue.js", { ts: T0 + 4 * S }),
    prose("Both callers are fixed.", T0 + 9 * S),
];

// the live turn: a Bash call with no result yet, started three seconds ago
const running = () => [
    user("Run the test again.", Date.now() - 5 * S),
    prose("Running it.", Date.now() - 4 * S),
    bash({ description: "Run the test again", command: "node test.js", ts: Date.now() - 3 * S, pending: true }),
];

// Main.dc.html: a finished turn of six steps, its edit numbered from the result's structuredPatch as the projection
// fills it, an answered question, then the reply
const ASKED = "The retry fix is done and the test passes. Should I also add jitter to the backoff delay?";
const MAIN = [
    user("Run node test.js, find why it fails, fix src/retry.js and run the test again. Then ask me whether to add jitter.", T0),
    bash({ description: "Run the test", command: "node test.js", output: "not ok 1 waited 121ms", exit: 1, ts: T0 + 2 * S, durationMs: 400 }),
    tool("read", "retry.js", { ts: T0 + 3 * S }),
    tool("edited", "retry.js", {
        ts: T0 + 4 * S,
        detail: {
            kind: "edit",
            files: [
                {
                    path: "src/retry.js",
                    badge: "M",
                    adds: 1,
                    dels: 1,
                    lines: [
                        { sign: "", text: "    } catch (e) {", oldNo: 6, newNo: 6 },
                        { sign: "", text: "      if (i === times) throw e;", oldNo: 7, newNo: 7 },
                        { sign: "-", text: "      await sleep(delayMs * i);", oldNo: 8 },
                        { sign: "+", text: "      await sleep(delayMs * (i + 1));", newNo: 8 },
                        { sign: "", text: "    }", oldNo: 9, newNo: 9 },
                    ],
                },
            ],
        },
    }),
    bash({ description: "Run the test again", command: "node test.js", output: "ok 3 calls 313 ms", ts: T0 + 5 * S, durationMs: 300 }),
    tool("asked", ASKED, {
        ts: T0 + 6 * S,
        durationMs: 28_100,
        summary: "Leave it",
        detail: { kind: "ask", questions: [{ question: ASKED, options: [{ label: "Add jitter" }, { label: "Leave it" }], picked: ["Leave it"] }] },
    }),
    bash({
        description: "Commit the retry fix",
        command: 'git add src/retry.js && git commit -q -m "fix: wait before the first retry"',
        output: "",
        ts: T0 + 35 * S,
        durationMs: 1_500,
    }),
    prose("The test was failing because the first retry didn't wait at all. It passes now.", T0 + 41 * S),
];

// StepsOpen.dc.html: a search, a failing vitest run (a test card), and a passing command
const VITEST_OUT = [
    " RUN  v3.2.4 C:/dev/chatdemo",
    "",
    ...Array.from({ length: 11 }, (_, i) => ` ✓ test/retry.test.js > retry > case ${i + 1}`),
    " FAIL  test/retry.test.js > retry > waits before the first retry",
    "AssertionError: expected at least 200 ms, got 121 ms",
    " ❯ test/retry.test.js:22:5",
    "",
    " Test Files  1 failed (1)",
    "      Tests  1 failed | 11 passed (12)",
].join("\n");
const STEPS_OPEN = [
    user("Find every caller of retry() and run the whole test suite.", T0),
    tool("grep", "retry(", {
        ts: T0 + 2 * S,
        durationMs: 100,
        summary: "2 matches",
        detail: {
            kind: "grep",
            matches: [
                { loc: "src/client.js:14", code: "  return retry(() => fetch(url), 3, 100);" },
                { loc: "src/queue.js:41", code: "   await retry(job.run, 5, 250);" },
            ],
        },
    }),
    bash({ description: "Run the test suite", command: "npx vitest run", output: VITEST_OUT, exit: 1, ts: T0 + 3 * S, durationMs: 3_200 }),
    bash({ description: "Show the last commit", command: "git log -1 --oneline", output: "085ead4 fix: wait before the first retry in retry()", ts: T0 + 70 * S, durationMs: 100 }),
    prose("Two places call retry(). One test still fails.", T0 + 72 * S),
];

// Events.dc.html: compaction, a typed command, a typed skill (Pi's chip), a finished subagent, an answered permission
// (marked after the prose at entry 4), a stopped step and the interrupt that stopped it, and a command a hook refused
const EVENTS = [
    { kind: "compaction", trigger: "auto", preTokens: 182_000, postTokens: 41_000, summary: "Kept: the retry fix and its test." },
    { kind: "command", name: "/review", args: "src/retry.js", ts: T0 },
    { kind: "command", name: "superpowers:brainstorming", isSkill: true, ts: T0 + S },
    { kind: "notification", summary: "Explore: find every caller of retry() and how it sets the delay", status: "completed", result: "Both callers pass a fixed delay." },
    prose("Both callers pass a fixed delay, so the fix covers them. I'll push the branch next.", T0 + 10 * S),
    bash({ description: "Run the release script", command: "npm run release", ts: T0 + 20 * S, pending: true }),
    { kind: "interrupted" },
    user("Don't release yet. Open a pull request instead.", T0 + 30 * S),
    prose("Understood. I'll leave the release alone and open a pull request.", T0 + 32 * S),
    {
        ...bash({ description: "Save the PR checks", command: "gh pr checks > checks.log", ts: T0 + 40 * S, durationMs: 50 }),
        outcome: "blocked",
        detail: { kind: "bash", command: "gh pr checks > checks.log", output: "<tool_use_error>Refused by Arc</tool_use_error>", exit: null },
    },
    prose("The hook refused the redirect; I'll read the output file instead.", T0 + 42 * S),
];
const EVENT_MARKS = [{ afterEntry: 5, text: "Yes: git push origin master" }];

// Compact.dc.html: the Main turn's first steps in a card, the reply so far, and the re-run still running
const compactTurn = () => {
    const now = Date.now();
    return [
        user("Run node test.js, find why it fails, fix src/retry.js and run the test again.", now - 30 * S),
        ...MAIN.slice(1, 4).map((e) => ({ ...e, ts: now - 25 * S })),
        prose("The first retry waits 0 ms because i starts at 0. I changed the wait and am running the test again.", now - 4 * S),
        bash({ description: "Run the test again", command: "node test.js", ts: now - 2 * S, pending: true }),
    ];
};

// the seam's options all set, so a broken seed or ctx path shows here rather than in a family scenario
const HARNESS = {
    entries: [user("ship the retry fix", T0), prose("Marking the chunk done.", T0 + S)],
    width: 640,
    ctx: { agentId: "tab-fixture", effortId: "e-fixture" },
    compact: false,
    active: false,
    renderers: true,
    seed: { "effort:e-fixture": { id: "e-fixture" } },
    runEvents: { "r-fixture": [] },
};

const probe = (body) => `(() => { const root = document.querySelector(${JSON.stringify(ROOT)}); if (!root) return null; ${body} })()`;

const FOLD_STATE = probe(`
    const folds = [...root.querySelectorAll('[data-fold]')];
    const fold = folds[0];
    if (!fold) return { fold: null };
    const box = fold.parentElement.querySelector('[data-steps]');
    return {
        fold: fold.textContent,
        expanded: fold.getAttribute('aria-expanded'),
        steps: box ? box.querySelectorAll('[data-step]').length : 0,
        folds: folds.map((f) => f.textContent),
    };
`);

// opens the nth fold line, unless it is open already
const openNthFold = (n) =>
    probe(`const f = root.querySelectorAll('[data-fold]')[${n}]; if (f && f.getAttribute('aria-expanded') !== 'true') f.click(); return !!f;`);

const BOX_STATE = probe(`
    // run with only the second turn's fold open, so every box on screen is one of its stretches
    return [...root.querySelectorAll('[data-steps]')].map((b) => {
        const s = getComputedStyle(b);
        return { steps: b.querySelectorAll('[data-step]').length, border: s.borderTopWidth, radius: s.borderTopLeftRadius, text: b.textContent };
    });
`);

const CHANGE_STATE = probe(`
    const row = root.querySelector('[data-wsh-change="effort rename"]');
    const failed = [...root.querySelectorAll('[data-step-status="fail"]')].find((s) => s.textContent.includes('e-missing'));
    return {
        row: row ? row.textContent : null,
        inBox: row ? !!row.closest('[data-steps]') : null,
        inFold: row ? !!row.closest('[data-turn-fold]') : null,
        showCommand: row ? !!row.querySelector('button[aria-label="Show the command"]') : false,
        failed: failed ? failed.textContent : null,
    };
`);

const RUNNING_STATE = probe(`
    const row = root.querySelector('[data-step-status="running"]');
    if (!row) return null;
    return { spinner: !!row.querySelector('[role="img"][aria-label="Running"]'), elapsed: row.querySelector('[data-step-elapsed]')?.textContent ?? null, text: row.textContent };
`);

async function widthSteps(h, width, compact) {
    const tag = `[${width}]`;
    const steps = [];
    await showTranscript(h, { entries: FINISHED, width, compact, active: false });

    const closed = await h.ev(FOLD_STATE);
    await h.ev(`document.querySelector(${JSON.stringify(ROOT)}).querySelector('[data-fold]')?.click()`);
    await sleep(MOTION_MS);
    const opened = await h.ev(FOLD_STATE);
    await h.shot(`cdp-shots/transcript-base-fold-${width}.png`);
    await h.ev(`document.querySelector(${JSON.stringify(ROOT)}).querySelector('[data-fold]')?.click()`);
    await sleep(MOTION_MS);
    const refolded = await h.ev(FOLD_STATE);
    steps.push({
        step: `${tag} fold: one Worked for line per finished turn; the first reads its N, phrase and +/−, opens on a click and folds again`,
        ok:
            closed?.fold != null &&
            closed.folds.length === 2 &&
            closed.folds.every((f) => f.startsWith("Worked for")) &&
            /^Worked for 41s/.test(closed.fold) &&
            closed.fold.includes("retry.js") &&
            closed.fold.includes("+1") &&
            closed.fold.includes("−1") &&
            closed.fold.includes("1 failed") &&
            closed.expanded === "false" &&
            closed.steps === 0 &&
            opened?.expanded === "true" &&
            opened.steps === 4 &&
            refolded?.expanded === "false" &&
            refolded.steps === 0,
        detail: JSON.stringify({ closed, opened, refolded }),
    });

    const shut = await h.ev(CHANGE_STATE);
    const second = await h.ev(openNthFold(1));
    await sleep(MOTION_MS);
    const boxes = await h.ev(BOX_STATE);
    await h.shot(`cdp-shots/transcript-base-box-${width}.png`);
    steps.push({
        step: `${tag} box: the second turn's fold opens to its two-step stretch as a step box`,
        ok:
            second === true &&
            Array.isArray(boxes) &&
            boxes.length === 1 &&
            boxes[0].steps === 2 &&
            boxes[0].border === "1px" &&
            boxes[0].text.includes("notes.md"),
        detail: JSON.stringify(boxes),
    });

    const change = await h.ev(CHANGE_STATE);
    steps.push({
        step: `${tag} change call: a successful wsh effort rename draws a WshChangeRow inside its turn's fold, the failed one a failed step`,
        ok:
            shut?.row === null &&
            change?.row != null &&
            change.row.includes("wsh effort rename") &&
            change.row.includes("e-fixture") &&
            change.inFold === true &&
            change.inBox === false &&
            change.showCommand === true &&
            change.failed != null &&
            change.failed.includes("exit 1"),
        detail: JSON.stringify({ shut, change }),
    });
    await h.shot(`cdp-shots/transcript-base-change-${width}.png`);

    await showTranscript(h, { entries: running(), width, compact, active: true });
    const first = await h.ev(RUNNING_STATE);
    await sleep(TICK_MS);
    const later = await h.ev(RUNNING_STATE);
    await h.shot(`cdp-shots/transcript-base-running-${width}.png`);
    steps.push({
        step: `${tag} running: a pending Bash shows the spinner and its elapsed ticking`,
        ok: first?.spinner === true && first.elapsed != null && later?.elapsed != null && later.elapsed !== first.elapsed,
        detail: JSON.stringify({ first, later }),
    });
    return steps;
}

const R = `document.querySelector(${JSON.stringify(ROOT)})`;
// opens the step row whose text holds `text`, unless it is open already
const openStep = (text) => `(() => {
    const step = [...${R}.querySelectorAll('[data-step]')].find((s) => s.textContent.includes(${JSON.stringify(text)}));
    const btn = step?.querySelector('button[aria-expanded]');
    if (!btn) return false;
    if (btn.getAttribute('aria-expanded') !== 'true') btn.click();
    return true;
})()`;
const openFold = `(() => { const f = ${R}.querySelector('[data-fold]'); if (f && f.getAttribute('aria-expanded') !== 'true') f.click(); return !!f; })()`;

const MAIN_STATE = probe(`
    const fold = root.querySelector('[data-fold]');
    const steps = [...root.querySelectorAll('[data-step]')].map((s) => s.textContent);
    const panel = [...root.querySelectorAll('[data-tool-panel]')].find((p) => p.querySelector('[data-diff-file]'));
    const rows = panel ? [...panel.querySelectorAll('[data-diff-line]')].map((r) => [r.getAttribute('data-diff-line'), r.querySelector('[data-diff-no]').textContent]) : null;
    const reply = [...root.querySelectorAll('[data-find-turn]')].map((t) => t.textContent).find((t) => t.includes('first retry')) ?? null;
    const bubble = root.querySelector('[data-user-bubble]');
    return { fold: fold?.textContent ?? null, expanded: fold?.getAttribute('aria-expanded') ?? null, steps, rows, reply, bubble: bubble ? bubble.innerText.trim() : null };
`);

async function mainStep(h) {
    await showTranscript(h, { entries: MAIN, width: 736, renderers: true });
    await h.ev(openFold);
    await sleep(MOTION_MS);
    const opened = await h.ev(openStep("Edited"));
    await sleep(MOTION_MS);
    const s = await h.ev(MAIN_STATE);
    await h.shot("cdp-shots/transcript-base-main.png");
    const step = (t) => s?.steps.find((x) => x.includes(t)) ?? "";
    return {
        step: "Main: Worked for fold opened, steps with commands and times, edit diff with line numbers, answered question, reply",
        ok:
            s != null &&
            opened === true &&
            /^Worked for 41s/.test(s.fold ?? "") &&
            s.expanded === "true" &&
            s.steps.length === 6 &&
            step("Run the test").includes("node test.js") &&
            step("Run the test").includes("exit 1") &&
            step("Run the test").includes("0.4s") &&
            step("Commit the retry fix").includes("git commit") &&
            step("Commit the retry fix").includes("1.5s") &&
            step("Asked").includes("Leave it") &&
            step("Asked").includes("28.1s") &&
            JSON.stringify(s.rows) === JSON.stringify([["", "6"], ["", "7"], ["-", "8"], ["+", "8"], ["", "9"]]) &&
            s.reply != null &&
            // the bubble is the prompt alone, no "You" label
            s.bubble === MAIN[0].text,
        detail: JSON.stringify(s),
    };
}

const STEPS_OPEN_STATE = probe(`
    const fold = root.querySelector('[data-fold]');
    const grep = [...root.querySelectorAll('[data-tool-panel]')].find((p) => p.textContent.includes('src/client.js:14'));
    const card = root.querySelector('[data-step-card]');
    const test = card?.querySelector('[data-tool-card="test"]');
    const cmd = [...root.querySelectorAll('[data-tool-panel]')].find((p) => p.textContent.includes('git log -1 --oneline'));
    const full = card ? [...card.querySelectorAll('button[aria-label="Open full view"]')].length : 0;
    return {
        fold: fold?.textContent ?? null,
        grep: grep ? [...grep.querySelectorAll('.flex')].map((r) => r.textContent) : null,
        counts: test?.querySelector('[data-test-counts]')?.textContent ?? null,
        failures: test ? [...test.querySelectorAll('[data-test-failure]')].map((r) => r.textContent) : null,
        cardFooter: card ? card.lastElementChild.textContent : null,
        full,
        cmd: cmd ? cmd.textContent : null,
    };
`);

async function stepsOpenStep(h) {
    await showTranscript(h, { entries: STEPS_OPEN, width: 736, renderers: true });
    // a stretch holding a test card starts open in the rendered view; open the other two steps as the board draws them
    await h.ev(openFold);
    await sleep(MOTION_MS);
    const grep = await h.ev(openStep("Searched"));
    const log = await h.ev(openStep("Show the last commit"));
    await sleep(MOTION_MS);
    const s = await h.ev(STEPS_OPEN_STATE);
    await h.shot("cdp-shots/transcript-base-steps-open.png");
    return {
        step: "StepsOpen: grep matches, test card with Raw output and Open full view, command output with no exit 0 chip, the fold line's 1 failed",
        ok:
            s != null &&
            grep === true &&
            log === true &&
            (s.fold ?? "").includes("1 failed") &&
            Array.isArray(s.grep) &&
            s.grep.some((r) => r.startsWith("src/client.js:14") && r.includes("retry(() => fetch(url)")) &&
            s.grep.some((r) => r.startsWith("src/queue.js:41")) &&
            (s.counts ?? "").includes("11 passed") &&
            (s.counts ?? "").includes("1 failed") &&
            s.failures?.length === 1 &&
            s.failures[0].includes("expected at least 200 ms") &&
            /Raw output, \d+ lines/.test(s.cardFooter ?? "") &&
            s.full === 1 &&
            (s.cmd ?? "").includes("$git log -1 --oneline") &&
            (s.cmd ?? "").includes("085ead4") &&
            !(s.cmd ?? "").includes("exit 0"),
        detail: JSON.stringify(s),
    };
}

const EVENTS_STATE = probe(`
    const text = (sel) => root.querySelector(sel)?.textContent ?? null;
    const chip = (kind) => {
        const el = root.querySelector('[data-command-chip="' + kind + '"]');
        return el ? { text: el.textContent, justify: getComputedStyle(el).justifyContent } : null;
    };
    const compaction = root.querySelector('[data-compaction] button');
    const sub = root.querySelector('[data-subagent-finished] button');
    return {
        compaction: compaction?.textContent ?? null,
        compactionOpen: compaction?.getAttribute('aria-expanded') ?? null,
        summary: root.querySelector('[data-compaction]')?.textContent.includes('Kept: the retry fix') ?? false,
        command: chip('command'),
        skill: chip('skill'),
        subagent: sub?.textContent ?? null,
        subagentOpen: sub?.getAttribute('aria-expanded') ?? null,
        result: root.querySelector('[data-subagent-finished]')?.textContent.includes('Both callers pass a fixed delay.') ?? false,
        mark: text('[data-permission-mark]'),
        stopped: text('[data-step-status="stopped"]'),
        blocked: text('[data-step-status="blocked"]'),
        blockedChip: root.querySelector('[data-step-status="blocked"] .text-error') != null,
        interrupted: text('[data-interrupted]'),
    };
`);

async function eventsStep(h) {
    await showTranscript(h, { entries: EVENTS, width: 736, renderers: true, marks: EVENT_MARKS });
    // the stopped and the blocked step sit in their turns' folds
    await h.ev(`${R}.querySelectorAll('[data-fold][aria-expanded="false"]').forEach((f) => f.click())`);
    await h.ev(`${R}.querySelector('[data-compaction] button')?.click()`);
    await h.ev(`${R}.querySelector('[data-subagent-finished] button')?.click()`);
    await sleep(MOTION_MS);
    const s = await h.ev(EVENTS_STATE);
    await h.shot("cdp-shots/transcript-base-events.png");
    return {
        step: "Events: compaction, slash command chip, skill chip, subagent finished, You allowed, stopped step, You interrupted, blocked step",
        ok:
            s != null &&
            /Context compacted.*182k → 41k tokens.*auto/.test(s.compaction ?? "") &&
            s.compactionOpen === "true" &&
            s.summary &&
            (s.command?.text ?? "").includes("/review") &&
            s.command?.justify === "flex-end" &&
            (s.skill?.text ?? "").startsWith("✦") &&
            (s.skill?.text ?? "").includes("superpowers:brainstorming") &&
            s.skill?.justify === "flex-end" &&
            (s.subagent ?? "").startsWith("Subagent finished") &&
            (s.subagent ?? "").includes("completed") &&
            s.subagentOpen === "true" &&
            s.result &&
            (s.mark ?? "").startsWith("You allowed") &&
            (s.mark ?? "").includes("git push origin master") &&
            (s.stopped ?? "").includes("stopped") &&
            (s.blocked ?? "").includes("Save the PR checks") &&
            (s.blocked ?? "").includes("blocked") &&
            !s.blockedChip &&
            (s.interrupted ?? "") === "You interrupted",
        detail: JSON.stringify(s),
    };
}

const COMPACT_STATE = probe(`
    const bubble = root.querySelector('[data-user-bubble]');
    const box = root.querySelector('[data-steps]');
    const running = root.querySelector('[data-step-status="running"]');
    return {
        bubble: bubble ? { text: bubble.innerText.trim(), marginLeft: getComputedStyle(bubble).marginLeft } : null,
        steps: box ? box.querySelectorAll('[data-step]').length : 0,
        running: running ? { spinner: !!running.querySelector('[aria-label="Running"]'), text: running.textContent } : null,
        prose: [...root.querySelectorAll('[data-find-turn]')].some((t) => t.textContent.includes('running the test again')),
    };
`);

async function compactStep(h) {
    const entries = compactTurn();
    await showTranscript(h, { entries, width: 380, compact: true, active: true, renderers: false });
    const s = await h.ev(COMPACT_STATE);
    await h.shot("cdp-shots/transcript-base-compact.png");
    return {
        step: "Compact: the same turn at 380 px with a running step",
        ok:
            s != null &&
            s.bubble?.text === entries[0].text &&
            s.bubble.marginLeft === "28px" &&
            s.steps === 3 &&
            s.prose &&
            s.running?.spinner === true &&
            s.running.text.includes("Run the test again"),
        detail: JSON.stringify(s),
    };
}

const QUEUED_STATE = probe(`
    const folds = [...root.querySelectorAll('[data-fold]')];
    const bubble = [...root.querySelectorAll('[data-user-bubble]')].find((b) => b.textContent.includes(${JSON.stringify(QUEUED_TEXT)}));
    const after = (a, b) => !!(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    return {
        folds: folds.map((f) => f.textContent),
        bubbles: root.querySelectorAll('[data-user-bubble]').length,
        between: folds.length === 2 && after(folds[0], bubble) && after(bubble, folds[1]),
        bubbleInFold: bubble ? !!bubble.closest('[data-turn-fold]') : null,
    };
`);

async function queuedStep(h) {
    await showTranscript(h, { entries: QUEUED, width: 736 });
    const s = await h.ev(QUEUED_STATE);
    await h.shot("cdp-shots/transcript-base-queued.png");
    return {
        step: "Queued: a message typed mid-turn draws as a bubble between two Worked for lines, one per side",
        ok:
            s != null &&
            s.folds.length === 2 &&
            s.folds.every((f) => f.startsWith("Worked for")) &&
            s.bubbles === 2 &&
            s.between === true &&
            s.bubbleInFold === false,
        detail: JSON.stringify(s),
    };
}

export const transcriptBase = {
    name: "transcript-base",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const seam = await waitSeam(h);
        const steps = [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
        if (!seam) return steps;
        await showTranscript(h, HARNESS);
        const shown = await h.ev(probe(`return { bubbles: root.querySelectorAll('[data-user-bubble]').length, text: root.innerText.slice(0, 200) };`));
        steps.push({
            step: "the harness mounts a transcript with ctx, seed and run events, its user bubble marked",
            ok: shown != null && shown.bubbles === 1 && shown.text.includes("Marking the chunk done."),
            detail: JSON.stringify(shown),
        });
        steps.push(...(await widthSteps(h, 736, false)));
        steps.push(...(await widthSteps(h, 380, true)));
        steps.push(await mainStep(h));
        steps.push(await stepsOpenStep(h));
        steps.push(await eventsStep(h));
        steps.push(await compactStep(h));
        steps.push(await queuedStep(h));
        return steps;
    },
    async teardown(h) {
        await clearTranscript(h);
    },
};
