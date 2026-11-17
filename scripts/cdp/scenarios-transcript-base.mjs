// Scenario `transcript-base`: the transcript's anatomy over plain entries (transcriptlayout.ts): each finished turn's
// work folded into one "Worked for N" line that opens to its step boxes and cards, a running step's live elapsed, a
// wsh change call as a standalone row inside its turn's fold while a failed one stays a step, a queued message
// splitting a turn's fold in two, consecutive thoughts merged into one clamped thought that stays clamped under
// renderAll and opens under unfold (as does a long bubble), a heredoc step's derived title, a cd-prefixed command's
// preview, turns started by a background notification, a background notice's muted row, and a slash command's printed output under its row. The fold checks run at the Rendered column's width and at a card's (compact).
// Step rows: merged edits to one file, the duration floor, one title colour for done and running rows, a failed
// call's error, a refused command's note, and the Raw output toggle under a wsh view.

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
        // as the projection records a refused call: no output, the unwrapped reason as its error
        error: "Refused by Arc",
        detail: { kind: "bash", command: "gh pr checks > checks.log", output: "", exit: null },
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
            // under a second, so the row draws no duration
            !step("Run the test").includes("0.4s") &&
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
    const grep = [...root.querySelectorAll('[data-tool-panel]')].find((p) => p.querySelector('[data-grep-group]'));
    const card = root.querySelector('[data-step-card]');
    const test = card?.querySelector('[data-tool-card="test"]');
    const cmd = [...root.querySelectorAll('[data-tool-panel]')].find((p) => p.textContent.includes('git log -1 --oneline'));
    const full = card ? [...card.querySelectorAll('button[aria-label="Open full view"]')].length : 0;
    return {
        fold: fold?.textContent ?? null,
        grep: grep
            ? [...grep.querySelectorAll('[data-grep-group]')].map((g) => ({
                  file: g.querySelector('[data-grep-file]')?.textContent ?? null,
                  lines: [...g.querySelectorAll('[data-file-line]')].map((l) => [l.querySelector('[data-line-no]')?.textContent ?? null, l.querySelector('[data-line-text]')?.textContent ?? null]),
              }))
            : null,
        counts: test?.querySelector('[data-test-counts]')?.textContent ?? null,
        failures: test ? [...test.querySelectorAll('[data-test-failure]')].map((r) => r.textContent) : null,
        cardFooter: card ? card.lastElementChild.textContent : null,
        full,
        cmd: cmd ? cmd.textContent : null,
        steps: [...root.querySelectorAll('[data-step]')].map((s) => s.textContent),
    };
`);

async function stepsOpenStep(h) {
    await showTranscript(h, { entries: STEPS_OPEN, width: 736, renderers: true });
    // the fold starts closed even with a test card in it; open it, then the other two steps as the board draws them
    await h.ev(openFold);
    await sleep(MOTION_MS);
    const grep = await h.ev(openStep("Searched"));
    const log = await h.ev(openStep("Show the last commit"));
    await sleep(MOTION_MS);
    const s = await h.ev(STEPS_OPEN_STATE);
    await h.shot("cdp-shots/transcript-base-steps-open.png");
    return {
        step: "StepsOpen: grep matches grouped by file, test card with Open full view and no Raw output label, command output with no exit 0 chip, the fold line's 1 failed",
        ok:
            s != null &&
            grep === true &&
            log === true &&
            (s.fold ?? "").includes("1 failed") &&
            Array.isArray(s.grep) &&
            s.grep.length === 2 &&
            s.grep[0].file === "src/client.js" &&
            s.grep[0].lines.length === 1 &&
            s.grep[0].lines[0][0] === "14" &&
            (s.grep[0].lines[0][1] ?? "").includes("retry(() => fetch(url)") &&
            s.grep[1].file === "src/queue.js" &&
            s.grep[1].lines[0]?.[0] === "41" &&
            (s.counts ?? "").includes("11 passed") &&
            (s.counts ?? "").includes("1 failed") &&
            s.failures?.length === 1 &&
            s.failures[0].includes("expected at least 200 ms") &&
            !(s.cardFooter ?? "").includes("Raw output") &&
            s.steps.every((t) => !/\b1 lines\b/.test(t)) &&
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

// two thoughts with nothing between them, long enough together to pass the thought's three-line clamp
const THOUGHT_A =
    "The retry helper multiplies the delay by the attempt index, and the index starts at zero, so the first retry " +
    "fires immediately. That matches the 121 ms the test reported, which is one attempt's work and no wait at all.";
const THOUGHT_B =
    "Shifting the index by one keeps every later delay where it was and only fixes the first. The queue caller passes " +
    "its own delay, so it inherits the fix without a change of its own; I will check it anyway before I reply.";
const THOUGHTS = [
    user("Why does the first retry not wait?", T0),
    { kind: "thought", text: THOUGHT_A, ts: T0 + S },
    { kind: "thought", text: THOUGHT_B, ts: T0 + 2 * S },
    prose("Because the delay is multiplied by an index that starts at zero.", T0 + 3 * S),
];

const THOUGHT_STATE = probe(`
    const thoughts = [...root.querySelectorAll('[data-thought]')];
    const t = thoughts[0];
    const more = t?.querySelector('[data-clamp-more]') ?? null;
    const text = t?.firstElementChild;
    return {
        count: thoughts.length,
        text: t?.textContent ?? null,
        more: more?.textContent ?? null,
        height: text ? text.clientHeight : 0,
        hidden: text ? text.scrollHeight > text.clientHeight + 1 : null,
    };
`);

async function thoughtStep(h) {
    await showTranscript(h, { entries: THOUGHTS, width: 736, thoughts: true });
    const closed = await h.ev(THOUGHT_STATE);
    await h.ev(`${R}.querySelector('[data-thought] [data-clamp-more]')?.click()`);
    await sleep(MOTION_MS);
    const opened = await h.ev(THOUGHT_STATE);
    await h.shot("cdp-shots/transcript-base-thought.png");
    return {
        step: "Thoughts: two consecutive thoughts draw as one clamped thought whose Show more opens it whole",
        ok:
            closed != null &&
            closed.count === 1 &&
            closed.text.includes("fires immediately") &&
            closed.text.includes("inherits the fix") &&
            closed.more === "Show more" &&
            closed.hidden === true &&
            opened?.more === "Show less" &&
            opened.hidden === false &&
            opened.height > closed.height,
        detail: JSON.stringify({ closed, opened }),
    };
}

// a prompt of ten lines, past the bubble's eight-line clamp, before the two thoughts
const LONG_PROMPT = Array.from({ length: 10 }, (_, i) => `Line ${i + 1} of the pasted spec.`).join("\n");
const LONG_TURN = [{ kind: "user", text: LONG_PROMPT, ts: T0 - S }, ...THOUGHTS.slice(1)];

const CLAMP_STATE = probe(`
    const more = (sel) => root.querySelector(sel + ' [data-clamp-more]')?.textContent ?? null;
    return { thought: more('[data-thought]'), bubble: more('[data-user-bubble]') };
`);

// renderAll (a whole session loaded) only lifts the item cap: the thought and the bubble stay clamped. unfold (a find
// is active) drops both clamps, so a match never sits in hidden text.
async function clampModeStep(h) {
    await showTranscript(h, { entries: LONG_TURN, width: 736, thoughts: true, renderAll: true });
    const all = await h.ev(CLAMP_STATE);
    await h.ev(`${R}.querySelector('[data-thought] [data-clamp-more]')?.click()`);
    await h.ev(`${R}.querySelector('[data-user-bubble] [data-clamp-more]')?.click()`);
    await sleep(MOTION_MS);
    const allOpened = await h.ev(CLAMP_STATE);
    await showTranscript(h, { entries: LONG_TURN, width: 736, thoughts: true, renderAll: true, unfold: true });
    const unfolded = await h.ev(CLAMP_STATE);
    return {
        step: "Clamp: with renderAll the thought and bubble keep a working Show more; with unfold neither has one",
        ok:
            all?.thought === "Show more" &&
            all.bubble === "Show more" &&
            allOpened?.thought === "Show less" &&
            allOpened.bubble === "Show less" &&
            unfolded?.thought === null &&
            unfolded.bubble === null,
        detail: JSON.stringify({ all, allOpened, unfolded }),
    };
}

// a Bash call with no description whose command is a heredoc script: titled, its command beside the title in mono
const HEREDOC = "python - <<'EOF'\nimport json\nprint(json.dumps({\"ok\": True}))\nEOF";
const HEREDOC_TURN = [
    user("Check the JSON output.", T0),
    bash({ command: HEREDOC, output: '{"ok": true}', ts: T0 + S, durationMs: 300 }),
    prose("It prints ok.", T0 + 2 * S),
];

const HEREDOC_STATE = probe(`
    const step = [...root.querySelectorAll('[data-step]')].find((s) => s.textContent.includes('python -'));
    const mono = step?.querySelector('.font-mono');
    return {
        text: step?.textContent ?? null,
        mono: mono?.textContent ?? null,
        monoFont: mono ? getComputedStyle(mono).fontFamily : null,
        title: step?.querySelector('button span')?.textContent ?? null,
    };
`);

async function heredocStep(h) {
    await showTranscript(h, { entries: HEREDOC_TURN, width: 736 });
    await h.ev(openFold);
    await sleep(MOTION_MS);
    const s = await h.ev(HEREDOC_STATE);
    await h.shot("cdp-shots/transcript-base-heredoc.png");
    return {
        step: 'Command title: a heredoc step with no description reads "Ran a Python script", its command in mono',
        ok:
            s != null &&
            s.title === "Ran a Python script" &&
            (s.mono ?? "").startsWith("python -") &&
            /mono/i.test(s.monoFont ?? ""),
        detail: JSON.stringify(s),
    };
}

// two turns, each started by a background-task notification that arrived as its own record (not queued): each its own
// Worked for line with its reply after it, rather than one fold swallowing both
const NOTIFIED_REPLIES = ["The first test run passed.", "The second test run passed too."];
const NOTIFIED = NOTIFIED_REPLIES.flatMap((reply, k) => {
    const ts = T0 + k * 600 * S;
    return [
        { kind: "notification", summary: `Background command "npm test" completed (exit code 0)`, status: "completed", ts },
        tool("read", `run-${k}.log`, { ts: ts + S, durationMs: 100 }),
        prose(reply, ts + 4 * S),
    ];
});

const NOTIFIED_STATE = probe(`
    const folds = [...root.querySelectorAll('[data-fold]')];
    const replies = ${JSON.stringify(NOTIFIED_REPLIES)}.map((r) => [...root.querySelectorAll('[data-find-turn]')].find((t) => t.textContent.includes(r)));
    const after = (a, b) => !!(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    return {
        folds: folds.map((f) => f.textContent),
        replies: replies.map((r) => (r ? { inFold: !!r.closest('[data-turn-fold]'), visible: r.getBoundingClientRect().height > 0 } : null)),
        order: after(folds[0], replies[0]) && after(replies[0], folds[1]) && after(folds[1], replies[1]),
    };
`);

async function notifiedStep(h) {
    await showTranscript(h, { entries: NOTIFIED, width: 736 });
    const s = await h.ev(NOTIFIED_STATE);
    await h.shot("cdp-shots/transcript-base-notified.png");
    return {
        step: "Notification turns: two turns started by a background notification draw two Worked for lines, each with its reply after it",
        ok:
            s != null &&
            s.folds.length === 2 &&
            s.folds.every((f) => f.startsWith("Worked for")) &&
            s.replies.every((r) => r != null && r.inFold === false && r.visible) &&
            s.order === true,
        detail: JSON.stringify(s),
    };
}

// a worker's command prefixed with a cd into its own tree: the row previews the command, the opened detail keeps the cd
const CD_DIR = "C:/Users/someone/AppData/Local/arc-wt/f860511c-t-6";
const CD_TURN = [
    user("Run the tests.", T0),
    bash({ description: "Run the tests", command: `cd ${CD_DIR} && npm test`, output: "ok 12 passed", ts: T0 + S, durationMs: 2_000 }),
    prose("They pass.", T0 + 4 * S),
];

const CD_STATE = probe(`
    const step = [...root.querySelectorAll('[data-step]')].find((s) => s.textContent.includes('Run the tests'));
    const panel = step?.querySelector('[data-tool-panel]');
    return { mono: step?.querySelector('.font-mono')?.textContent ?? null, panel: panel?.textContent ?? null };
`);

async function cdPreviewStep(h) {
    await showTranscript(h, { entries: CD_TURN, width: 736 });
    await h.ev(openFold);
    await sleep(MOTION_MS);
    const closed = await h.ev(CD_STATE);
    await h.ev(openStep("Run the tests"));
    await sleep(MOTION_MS);
    const opened = await h.ev(CD_STATE);
    await h.shot("cdp-shots/transcript-base-cd-preview.png");
    return {
        step: "Command preview: a cd <dir> && npm test row previews npm test; the opened detail keeps the cd",
        ok: closed?.mono === "npm test" && (opened?.panel ?? "").includes(`cd ${CD_DIR} && npm test`),
        detail: JSON.stringify({ closed, opened }),
    };
}

// a free-text background-task notice of two lines: one muted row that opens to the whole text
const NOTICE_TEXT = "arc-skim: its prompt.compose hook was skipped\nthe hook timed out after 5 s; the prompt went out without it";
const NOTICE_TURN = [
    user("Summarise the run.", T0),
    { kind: "notification", summary: NOTICE_TEXT, notice: true },
    prose("The run landed.", T0 + 2 * S),
];

const NOTICE_STATE = probe(`
    const row = root.querySelector('[data-notice]');
    const btn = row?.querySelector('button');
    return {
        head: btn?.textContent ?? null,
        expanded: btn?.getAttribute('aria-expanded') ?? null,
        body: row?.querySelector('[data-notice-body]')?.textContent ?? null,
        subagent: root.querySelectorAll('[data-subagent-finished]').length,
        bordered: btn ? getComputedStyle(btn).borderTopWidth : null,
    };
`);

async function noticeStep(h) {
    await showTranscript(h, { entries: NOTICE_TURN, width: 736 });
    const closed = await h.ev(NOTICE_STATE);
    await h.ev(`${R}.querySelector('[data-notice] button')?.click()`);
    await sleep(MOTION_MS);
    const opened = await h.ev(NOTICE_STATE);
    await h.shot("cdp-shots/transcript-base-notice.png");
    const [first, second] = NOTICE_TEXT.split("\n");
    return {
        step: "Notice: a multi-line background notice is one muted row, not the Subagent finished box, and a click opens its full text",
        ok:
            closed != null &&
            closed.subagent === 0 &&
            (closed.head ?? "").startsWith("Notice") &&
            (closed.head ?? "").includes(first) &&
            !(closed.head ?? "").includes(second) &&
            closed.bordered === "0px" &&
            closed.expanded === "false" &&
            closed.body === null &&
            opened?.expanded === "true" &&
            (opened.body ?? "").includes(first) &&
            (opened.body ?? "").includes(second),
        detail: JSON.stringify({ closed, opened }),
    };
}

// CommandOutput.dc.html: a command's printed line under its row, a command that printed nothing, a compaction divider
const MCP_OUTPUT = "Authentication successful. Connected to siem-portal.";
const CONFIG_OUTPUT = "Set theme to dark";
const COMMAND_OUTPUT_TURN = [
    { kind: "command", name: "/mcp", ts: T0, output: MCP_OUTPUT },
    { kind: "command", name: "/config", args: "theme dark", ts: T0 + S, output: CONFIG_OUTPUT },
    { kind: "command", name: "/clear", ts: T0 + 2 * S },
    { kind: "compaction", trigger: "manual", preTokens: 90_000, postTokens: 12_000 },
];

const COMMAND_OUTPUT_STATE = probe(`
    const chips = [...root.querySelectorAll('[data-command-chip]')].map((c) => {
        const out = c.querySelector('[data-command-output]');
        const row = c.querySelector('span');
        const rowBox = row?.getBoundingClientRect();
        const outBox = out?.getBoundingClientRect();
        return {
            name: row?.textContent ?? null,
            output: out?.textContent ?? null,
            below: rowBox && outBox ? outBox.top >= rowBox.bottom - 1 : null,
            rightAligned: rowBox && outBox ? Math.abs(outBox.right - rowBox.right) <= 1 : null,
            font: out ? getComputedStyle(out).fontFamily : null,
        };
    });
    const compaction = root.querySelector('[data-compaction]');
    return {
        chips,
        compaction: compaction != null,
        compactionOutput: compaction?.querySelector('[data-command-output]') != null,
    };
`);

async function commandOutputStep(h) {
    await showTranscript(h, { entries: COMMAND_OUTPUT_TURN, width: 736 });
    const s = await h.ev(COMMAND_OUTPUT_STATE);
    await h.shot("cdp-shots/transcript-base-command-output.png");
    const [mcp, config, clear] = s?.chips ?? [];
    return {
        step: "CommandOutput: /mcp and /config show their line under the row in mono, /clear shows nothing, the compaction divider has no output block",
        ok:
            s != null &&
            s.chips.length === 3 &&
            (mcp.name ?? "").includes("/mcp") &&
            mcp.output === MCP_OUTPUT &&
            mcp.below === true &&
            mcp.rightAligned === true &&
            /mono/i.test(mcp.font ?? "") &&
            (config.name ?? "").includes("/config") &&
            config.output === CONFIG_OUTPUT &&
            config.below === true &&
            (clear.name ?? "").includes("/clear") &&
            clear.output === null &&
            s.compaction &&
            !s.compactionOutput,
        detail: JSON.stringify(s),
    };
}

// step rows: four edits to one file, a quick and a slow command, a failed edit with its error, a failed Monitor call with
// no detail, and a refused command as the projection records each
const RETRY = "src/retry.js";
const EDIT_COUNTS = [
    [1, 0],
    [2, 1],
    [0, 3],
    [1, 1],
];
const editOf = (path, [adds, dels], k, ts, extra = {}) =>
    tool("edited", path, {
        ts,
        durationMs: 100,
        detail: {
            kind: "edit",
            files: [{ path, badge: "M", adds, dels, lines: [{ sign: "-", text: `const delay${k} = 0;` }, { sign: "+", text: `const delay${k} = 100;` }] }],
        },
        ...extra,
    });
const EDIT_ERROR = "String to replace not found in file.\nString: await sleep(delayMs * i);";
const MONITOR_ERROR = "InputValidationError: Monitor failed due to the following issue:\nThe required parameter `description` is missing";
const REFUSED_COMMAND = "npm run release > release.log";
const REFUSED_REASON = "Refused by Arc: a release's output may not be redirected to a file";
const ROWS = [
    user("Fix the retry delay, check it, and release.", T0),
    ...EDIT_COUNTS.map((c, k) => editOf(RETRY, c, k, T0 + (k + 1) * S)),
    bash({ description: "Quick check", command: "node -e 1", output: "", ts: T0 + 6 * S, durationMs: 200 }),
    bash({ description: "Slow check", command: "node test.js", output: "ok", ts: T0 + 7 * S, durationMs: 3_000 }),
    editOf("src/queue.js", [1, 1], 9, T0 + 11 * S, { outcome: "fail", error: EDIT_ERROR }),
    tool("monitor", "the release", { ts: T0 + 12 * S, outcome: "fail", error: MONITOR_ERROR }),
    {
        ...bash({ description: "Release", command: REFUSED_COMMAND, ts: T0 + 13 * S, durationMs: 50 }),
        outcome: "blocked",
        error: REFUSED_REASON,
        detail: { kind: "bash", command: REFUSED_COMMAND, output: "", exit: null },
    },
    prose("The release was refused.", T0 + 15 * S),
];

const rowOf = (text) => `[...root.querySelectorAll('[data-step]')].find((s) => s.textContent.includes(${JSON.stringify(text)}))`;
// brings a row into the screenshot's view
const scrollToRow = (text) => probe(`${rowOf(text)}?.scrollIntoView({ block: "center" }); return true;`);

const MERGED_STATE = probe(`
    const rows = [...root.querySelectorAll('[data-step]')].filter((s) => s.textContent.includes(${JSON.stringify(RETRY)}));
    const row = rows[0];
    return {
        rows: rows.length,
        head: row?.querySelector('[data-step-head]')?.textContent ?? null,
        files: row ? row.querySelectorAll('[data-tool-panel] [data-diff-file]').length : 0,
        added: row ? [...row.querySelectorAll('[data-diff-line="+"]')].map((l) => l.textContent) : [],
    };
`);

const durationOf = (text) => probe(`
    const row = ${rowOf(text)};
    return row ? { head: row.querySelector('[data-step-head]')?.textContent ?? null, duration: row.querySelector('[data-step-duration]')?.textContent ?? null } : null;
`);

// a failed row opened: whether its head is a button, and its panel's error block, tone and what the panel leads with
const failedOf = (text) => probe(`
    const row = ${rowOf(text)};
    const panel = row?.querySelector('[data-tool-panel]');
    const err = panel?.querySelector('[data-tool-error]');
    return row ? {
        clickable: !!row.querySelector('button[aria-expanded]'),
        panel: panel?.textContent ?? null,
        error: err?.textContent ?? null,
        errorTone: err ? err.classList.contains('text-error') : null,
        diffs: panel ? panel.querySelectorAll('[data-diff-file]').length : 0,
        errorAboveDiff: !!(err && panel.querySelector('[data-diff-file]') && err.compareDocumentPosition(panel.querySelector('[data-diff-file]')) & Node.DOCUMENT_POSITION_FOLLOWING),
    } : null;
`);

const REFUSED_STATE = probe(`
    const row = ${rowOf(REFUSED_COMMAND)};
    const panel = row?.querySelector('[data-tool-panel]');
    const cmd = panel ? [...panel.querySelectorAll('span')].find((s) => s.textContent === ${JSON.stringify(REFUSED_COMMAND)}) : null;
    const note = panel?.querySelector('[data-tool-note]');
    return row ? {
        clickable: !!row.querySelector('button[aria-expanded]'),
        panel: panel?.textContent ?? null,
        note: note?.textContent ?? null,
        noteError: note ? note.classList.contains('text-error') : null,
        below: cmd && note ? note.getBoundingClientRect().top >= cmd.getBoundingClientRect().bottom - 1 : null,
        outputs: panel ? panel.querySelectorAll('pre').length : null,
    } : null;
`);

async function stepRowSteps(h) {
    const steps = [];
    await showTranscript(h, { entries: ROWS, width: 736 });
    await h.ev(openFold);
    await sleep(MOTION_MS);

    await h.ev(openStep(RETRY));
    await sleep(MOTION_MS);
    const merged = await h.ev(MERGED_STATE);
    await h.shot("cdp-shots/transcript-base-merged-edits.png");
    steps.push({
        step: "Merged edits: four edits to one file draw one row with the summed +4 −5 and 4 edits, whose body shows each edit",
        ok:
            merged != null &&
            merged.rows === 1 &&
            (merged.head ?? "").includes("+4") &&
            (merged.head ?? "").includes("−5") &&
            (merged.head ?? "").includes("4 edits") &&
            merged.files === 4 &&
            [0, 1, 2, 3].every((k) => merged.added.some((l) => l.includes(`const delay${k} = 100;`))),
        detail: JSON.stringify(merged),
    });

    const quick = await h.ev(durationOf("Quick check"));
    const slow = await h.ev(durationOf("Slow check"));
    await h.ev(scrollToRow("Slow check"));
    await h.shot("cdp-shots/transcript-base-durations.png");
    steps.push({
        step: "Durations: a 0.2 s row shows no duration and a 3 s row shows 3.0s",
        ok: quick != null && quick.duration === null && !(quick.head ?? "").includes("0.2s") && slow?.duration === "3.0s",
        detail: JSON.stringify({ quick, slow }),
    });

    await h.ev(openStep("queue.js"));
    await sleep(MOTION_MS);
    const edit = await h.ev(failedOf("queue.js"));
    await h.ev(scrollToRow("queue.js"));
    await h.shot("cdp-shots/transcript-base-failed-edit.png");
    steps.push({
        step: "Failed edit: a failed Edit opens to its error, in the error tone, above the attempted edit",
        ok:
            edit != null &&
            edit.clickable &&
            edit.error === EDIT_ERROR &&
            edit.errorTone === true &&
            edit.diffs === 1 &&
            edit.errorAboveDiff === true &&
            (edit.panel ?? "").startsWith(EDIT_ERROR.split("\n")[0]),
        detail: JSON.stringify(edit),
    });

    await h.ev(openStep("the release"));
    await sleep(MOTION_MS);
    const monitor = await h.ev(failedOf("the release"));
    await h.ev(scrollToRow("the release"));
    await h.shot("cdp-shots/transcript-base-failed-monitor.png");
    steps.push({
        step: "Failed Monitor: a failed call with no detail is clickable and opens to its error",
        ok: monitor != null && monitor.clickable && monitor.error === MONITOR_ERROR && monitor.errorTone === true,
        detail: JSON.stringify(monitor),
    });

    await h.ev(openStep(REFUSED_COMMAND));
    await sleep(MOTION_MS);
    const refused = await h.ev(REFUSED_STATE);
    await h.ev(scrollToRow(REFUSED_COMMAND));
    await h.shot("cdp-shots/transcript-base-refused.png");
    steps.push({
        step: "Refused command: a blocked Bash row opens to its command, the reason as a muted note under it, no output block and no <tool_use_error>",
        ok:
            refused != null &&
            refused.clickable &&
            (refused.panel ?? "").startsWith("$" + REFUSED_COMMAND) &&
            refused.note === REFUSED_REASON &&
            refused.noteError === false &&
            refused.below === true &&
            refused.outputs === 0 &&
            !(refused.panel ?? "").includes("tool_use_error"),
        detail: JSON.stringify(refused),
    });
    return steps;
}

// the live turn: a finished command, then one still running
const colourTurn = () => [
    user("Run both checks.", Date.now() - 6 * S),
    bash({ description: "First check", command: "node -e 1", output: "", ts: Date.now() - 5 * S, durationMs: 1_200 }),
    bash({ description: "Second check", command: "node test.js", ts: Date.now() - 3 * S, pending: true }),
];

const COLOUR_STATE = probe(`
    const head = (status) => root.querySelector('[data-step-status="' + status + '"] [data-step-head]');
    const of = (el) => (el ? { secondary: el.classList.contains('text-secondary'), color: getComputedStyle(el).color } : null);
    return { done: of(head('ok')), running: of(head('running')) };
`);

async function colourStep(h) {
    await showTranscript(h, { entries: colourTurn(), width: 736, active: true });
    const s = await h.ev(COLOUR_STATE);
    await h.shot("cdp-shots/transcript-base-title-colour.png");
    return {
        step: "Title colour: a done row's title and a running row's title share text-secondary",
        ok: s?.done?.secondary === true && s.running?.secondary === true && s.done.color === s.running.color,
        detail: JSON.stringify(s),
    };
}

// a wsh effort show call whose effort is seeded, so its view draws from data and the toggle is the only way to the
// call's own output
const RAW_EID = "r4w00001";
const RAW_OUTPUT = "Retry fix\n 1/2 done";
const RAW_SEED = {
    [`effort:${RAW_EID}`]: {
        otype: "effort",
        oid: RAW_EID,
        version: 1,
        title: "Retry fix",
        project: "waveterm",
        status: "active",
        chunks: [
            { label: "Fix the delay", status: "done", notes: [], updatedts: T0 },
            { label: "Release", status: "pending", notes: [], updatedts: T0 },
        ],
        events: [],
        createdts: T0,
        updatedts: T0,
    },
};
const RAW_TURN = [
    user("Where is the retry fix?", T0),
    bash({ description: "Show the initiative", command: `wsh effort show effort:${RAW_EID}`, output: RAW_OUTPUT, ts: T0 + S, durationMs: 300 }),
    prose("Half done.", T0 + 3 * S),
];

const RAW_STATE = probe(`
    const view = root.querySelector('[data-wsh-view]');
    const toggle = view ? [...view.querySelectorAll('button[aria-pressed]')].find((b) => b.textContent.includes('Raw output')) : null;
    return {
        view: view?.getAttribute('data-wsh-view') ?? null,
        pressed: toggle?.getAttribute('aria-pressed') ?? null,
        raw: view?.querySelector('[data-step-raw] [data-recorded-output]')?.textContent ?? null,
        loadFailure: !!view?.querySelector('[data-wsh-load-failure]'),
    };
`);
const clickRawToggle = probe(`
    const b = [...root.querySelectorAll('[data-wsh-view] button[aria-pressed]')].find((x) => x.textContent.includes('Raw output'));
    b?.click();
    return !!b;
`);

async function rawToggleStep(h) {
    await showTranscript(h, { entries: RAW_TURN, width: 736, seed: RAW_SEED });
    await h.ev(openFold);
    await sleep(MOTION_MS);
    await h.ev(openStep("Show the initiative"));
    await sleep(MOTION_MS);
    const closed = await h.ev(RAW_STATE);
    const clicked = await h.ev(clickRawToggle);
    await sleep(MOTION_MS);
    const opened = await h.ev(RAW_STATE);
    await h.shot("cdp-shots/transcript-base-raw-toggle.png");
    await h.ev(clickRawToggle);
    await sleep(MOTION_MS);
    const shut = await h.ev(RAW_STATE);
    return {
        step: "Raw output: under a wsh view it is a toggle (aria-pressed) that reveals the call's recorded output and hides it again",
        ok:
            closed?.view === "effort-show" &&
            closed.pressed === "false" &&
            closed.raw === null &&
            clicked === true &&
            opened?.pressed === "true" &&
            opened.raw === RAW_OUTPUT &&
            shut?.pressed === "false" &&
            shut.raw === null,
        detail: JSON.stringify({ closed, opened, shut }),
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
        steps.push(await thoughtStep(h));
        steps.push(await clampModeStep(h));
        steps.push(await heredocStep(h));
        steps.push(await cdPreviewStep(h));
        steps.push(await notifiedStep(h));
        steps.push(await noticeStep(h));
        steps.push(await commandOutputStep(h));
        steps.push(...(await stepRowSteps(h)));
        steps.push(await colourStep(h));
        steps.push(await rawToggleStep(h));
        return steps;
    },
    async teardown(h) {
        await clearTranscript(h);
    },
};
