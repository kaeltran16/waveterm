// Scenario `transcript-base`: the transcript's anatomy over plain entries (transcriptlayout.ts): a finished stretch
// folded into "Worked for N", a short stretch as a step box, a running step's live elapsed, and a wsh change call as
// a standalone row outside the fold while a failed one stays a step. Each check runs at the Rendered column's width
// and at a card's (compact).

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
// and a two-step box holding the failed one
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

// the live turn: a Bash call with no result yet, started three seconds ago
const running = () => [
    user("Run the test again.", Date.now() - 5 * S),
    prose("Running it.", Date.now() - 4 * S),
    bash({ description: "Run the test again", command: "node test.js", ts: Date.now() - 3 * S, pending: true }),
];

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
    const fold = root.querySelector('[data-fold]');
    if (!fold) return { fold: null };
    const box = fold.parentElement.querySelector('[data-steps]');
    return { fold: fold.textContent, expanded: fold.getAttribute('aria-expanded'), steps: box ? box.querySelectorAll('[data-step]').length : 0 };
`);

const BOX_STATE = probe(`
    // run with the fold closed, so every box on screen is an unfolded stretch
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
        inFold: row ? !!row.closest('[data-steps]') : null,
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
        step: `${tag} fold: a finished four-step stretch reads Worked for N with its phrase and +/−, opens on a click and folds again`,
        ok:
            closed?.fold != null &&
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

    const boxes = await h.ev(BOX_STATE);
    await h.shot(`cdp-shots/transcript-base-box-${width}.png`);
    steps.push({
        step: `${tag} box: a two-step stretch draws as a step box`,
        ok: Array.isArray(boxes) && boxes.length === 1 && boxes[0].steps === 2 && boxes[0].border === "1px" && boxes[0].text.includes("notes.md"),
        detail: JSON.stringify(boxes),
    });

    const change = await h.ev(CHANGE_STATE);
    steps.push({
        step: `${tag} change call: a successful wsh effort rename draws a WshChangeRow outside the fold, the failed one a failed step`,
        ok:
            change?.row != null &&
            change.row.includes("wsh effort rename") &&
            change.row.includes("e-fixture") &&
            change.inFold === false &&
            change.showCommand === true &&
            change.failed != null &&
            change.failed.includes("exit 1"),
        detail: JSON.stringify(change),
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
        return steps;
    },
    async teardown(h) {
        await clearTranscript(h);
    },
};
