// Scenario `transcript-census-rows`: the census's feed-row fixes (narrationtimeline.tsx, arcmessagerow.tsx), each at
// both census hosts, from trimmed specimens.
// E1: a Final-failed log is one mono block, its indentation kept, its failing lines in the error tone. E2: wake bodies
// render their markdown. E3: a narrow wake row keeps its status whole. E4: a failed notice names "failed" once, in the
// error tone. E5: "You interrupted", "You approved the design" and "You skipped the questions" share one look. E7: the
// engine's "… N more characters: <cmd>" cut is not shown. Decision 2: a bubble renders markdown and stays clamped
// until Show more. G1: a JSON bubble reads as code, a slash command sets only its name mono. Decision 4: compact
// draws a wake's body flush with its head; rendered keeps the indent.

import { clearTranscript, HOSTS, prose, ROOT, showAt, user, waitSeam } from "./transcript-fixture.mjs";

const T0 = Date.UTC(2026, 10, 18, 9, 0, 0);
const S = 1000;
const R = `document.querySelector(${JSON.stringify(ROOT)})`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MOTION_MS = 500;
// the rendered view's body sits ml-6 past the bell; anything under that is no indent
const RENDERED_INDENT_MIN_PX = 19;

const FINAL_HEAD = (round) =>
    `wake: the final stage failed on the merged result ${round}. Write a fix plan and run \`wsh jarvis dag submit --round --plan <fix plan>\`. Fix every failing step, one already on the base or outside the goal included, since any of them holds the land.`;

// census specimen 6: a playwright log, its failing test marked x
const FINAL_6 = [
    FINAL_HEAD("in round 1"),
    "Final `sh scripts/final.sh` failed (exit 1):",
    "  ok 23 [chromium] › e2e\\04-session.spec.ts:177:1 › behavioral without profile shows the note (443ms)",
    "  x  55 [chromium] › e2e\\09-board.spec.ts:278:1 › boxes glide to their new places (1.2s)",
    "  -  56 [chromium] › e2e\\09-board.spec.ts:311:1 › deep dives list box notes and count them on the box",
    "    Error: expect(received).not.toEqual(expected) // deep equality",
    '    Expected: not {"x": 260, "y": 0}',
    "  1 failed",
].join("\n");

// census specimen 95: a pytest log with CRLF line ends, its E and FAILED lines failing
const FINAL_95 = [
    FINAL_HEAD("in round 1"),
    "Verify `python -m pytest tests -q --no-cov -rf` failed on the merged result (exit 1):",
    "    @pytest.mark.asyncio\r",
    "    async def test_respond_writes_timestamps_to_state(self):\r",
    "        node, structured, registry = _build_agent_node()\r",
    '>       assert result["from_timestamp"] == "2026-04-15T00:00:00.000Z"\r',
    "E       AssertionError: assert None == '2026-04-15T00:00:00.000Z'\r",
    "tests\\agent\\test_clarify.py:463: AssertionError\r",
    "FAILED tests/agent/test_clarify.py::TestRespondTimeOverride::test_respond_writes_timestamps_to_state\r",
    "=========== 3 failed, 3956 passed, 10 skipped in 164.37s (0:02:44) ============",
    "Unverified:",
    "t-32 Differs from plan: - **No `AssistantDependencies` field removed.** All 24 fields are still read: by `__init__`, `_initialize_workflow` (`WorkflowDependencies`).",
    "Since your last wake:",
    "t-31 passed review: Deleted `FinalizeNode._cleanup_transient`, its **try/finally** and import.",
].join("\n");

// census specimen 133: final-verify's own log, every shown step passing, its detail lines indented under them
const FINAL_133 = [
    FINAL_HEAD("34e50dd in round 1 of 3"),
    "Final `node scripts/cdp/final-verify.mjs rendered-bs-host rendered-bs-question rendered-bs-run canvas-mark canvas-tabs` failed (exit 1):",
    "  PASS  the pick shows as picked in the brainstorm pane, and one made there shows here",
    '        {"shown":true,"inPane":{"pressed":"true","clickedGate":true},"back":true}',
    "  PASS  a changed row opens to its was/now sentence diff",
    '        {"before":false,"expanded":"true"}',
    "196/197 steps passed",
].join("\n");

// census specimen 52: a finished run's wake whose sections quote reports in markdown
const RUN_52 = [
    "wake: run finished. wsh jarvis dag status",
    "The final stage finished unverified. What it could not verify:",
    "- verifier: A real Claude session running the arc mod's publish (`$.command.list`, `$.clock.after`) end to end.",
    "Unverified:",
    "t-8 For later tasks: - `ComposerBox` now has a required `sendLabel`, so any code that builds a `ComposerBox` literal has to set it.",
    "Since your last wake:",
    "t-8 passed review: The shell card's clamp moved into the pure `shellRunLines(stdout, stderr, open)` in shellrunmodel.ts.",
].join("\n");

// census specimen 27: a plan review that failed in its last round, with a long meta beside it
const PLAN_27 =
    "wake: plan review failed in round 2, the last: [Round-2 follow-up] 1) ModalShell/Esc: fixed. 2) Task 1 acceptance: fixed, 4 tabs (Run, Changes, file, Canvas). 5) Parallelism: NOT FIXED, and not declined. Task 5 (Canvas tab) still waits for all of Task 4. The run is autonomous and nobody is at the cockpit, so the call is yours: carry each finding into the pending tasks it affects with `wsh jarvis dag amend <task> \"<note>\"` first.";

// census specimen 7: the engine cut the plan review's findings and named the command that reads the rest. Trimmed to
// the cut finding alone, as compact draws only the first.
const PLAN_7 =
    "wake: plan review failed in round 1: [Full review] 1) t-5 and t-6 run in parallel in pkg/orchestrate. Holds: dagDigestRetainedKinds is in wshserver_dag.go, which Task 7 lists. … 1750 more characters: wsh jarvis dag planreview findings. Revise the plan (make any spec change yourself and record it in your report) and run `wsh jarvis dag submit` again.";

// census specimen 40: a background command's notice whose summary already says it failed
const NOTICE_40 = { kind: "notification", summary: 'Background command "Typecheck the frontend" failed with exit code 2', status: "failed", source: "command", notice: true };

// census specimens 39/165: the three human-action markers in one feed
const MARKERS = [
    prose("The rectangles are hard-coded today; answer 2 changes that.", T0),
    user("brainstorm: skip questions", T0 + S),
    user("brainstorm: approved", T0 + 2 * S),
    { kind: "interrupted" },
    user("dont hard code shape, why would you do that?", T0 + 3 * S),
];

// census specimen 3: a pasted brief, trimmed: a list and a heading past the bubble's eight-line clamp
const BRIEF_3 = [
    "You review a project's Claude Code auto memory. Sessions load the index, MEMORY.md, and read a topic file only when its index line looks relevant.",
    "",
    "Propose changes only where the evidence supports them. Proposing nothing is a fine answer.",
    "",
    "Change kinds:",
    '- "delete": the memory is stale, wrong, a one-off record, or repeats an instruction doc. Deletes the file and its index line.',
    '- "trim": replace one exact passage of a memory\'s body with a shorter one. "old" must be copied exactly from the body.',
    '- "merge": two or more memories of THIS batch say one thing.',
    '- "move-to-doc": the memory is a rule the repo should own.',
    '- "add-to-index": a memory the index doesn\'t link that is still worth loading.',
    "",
    "Leave out the fields a kind doesn't use.",
    "",
    "## The whole index (MEMORY.md)",
    "",
    "- [PROD detector psql one-liner](reference_prod_detector_psql_one_liner.md) — `tenant_id = 'MX'`, never ILIKE.",
    "- [Signal 3 is a workaround](project_signal3_is_a_workaround_not_a_feature.md) — ladder fix ships.",
    "- [Config from_env shadows the dataclass default](project_anomaly_config_from_env_shadows_default.md) — test via `from_env()`.",
].join("\n");

// census specimens 35/162: a pasted JSON payload, and a slash command with its arguments
const JSON_35 = [
    user("Assess the exact planned action below. Use read-only tool checks when local state matters.\n", T0),
    user(
        '{\n  "command": [\n    "C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe",\n    "-NoProfile",\n    "-Command",\n    "Get-Location"\n  ],\n  "sandbox_permissions": "require_escalated",\n  "tool": "exec_command",\n  "tty": false\n}\n',
        T0 + S
    ),
];
const COMMAND_162 = [
    { kind: "command", name: "/arc:design", args: "show me the design first", ts: T0 },
    user("check the existing @@ implementation", T0 + S),
];

const probe = (body) => `(() => { const root = ${R}; if (!root) return null; ${body} })()`;

// the computed colour and font of a token class, read off a probe span in the root
const TOKENS = `
    const token = (cls, prop) => {
        const el = document.createElement('span');
        el.className = cls;
        root.appendChild(el);
        const v = getComputedStyle(el)[prop];
        el.remove();
        return v;
    };`;

const FINAL_LOG = probe(`
    ${TOKENS}
    const error = token('text-error', 'color');
    const mono = token('font-mono', 'fontFamily');
    const logs = [...root.querySelectorAll('[data-wake-part="final-failed"] [data-final-log]')];
    const log = logs[0];
    if (!log) return { logs: 0 };
    const lines = [...log.querySelectorAll('[data-defect]')].map((l) => ({
        text: l.textContent,
        failing: l.hasAttribute('data-failing'),
        error: getComputedStyle(l).color === error,
    }));
    return {
        logs: logs.length,
        whiteSpace: getComputedStyle(log).whiteSpace,
        mono: getComputedStyle(log).fontFamily === mono,
        indented: lines.filter((l) => /^\\s{2,}\\S/.test(l.text)).length,
        failingError: lines.filter((l) => l.failing).every((l) => l.error),
        failing: lines.filter((l) => l.error).map((l) => l.text.trim().slice(0, 40)),
        passingPlain: lines.filter((l) => !l.failing).every((l) => !l.error),
        passing: lines.filter((l) => !l.error).length,
    };
`);

// every prose wake body's text, its rendered code pills and bold, and whether a markdown mark survived as text. A Final
// log is literal by design, so it is left out.
const WAKE_BODIES = probe(`
    const bodies = [...root.querySelectorAll('[data-arc-message="wake"] [data-event-body]')].filter((b) => !b.querySelector('[data-final-log]'));
    const text = bodies.map((b) => b.innerText).join('\\n');
    return {
        bodies: bodies.length,
        rawBold: text.includes('**'),
        rawTick: text.includes('\`'),
        code: bodies.reduce((n, b) => n + b.querySelectorAll('code').length, 0),
        strong: bodies.reduce((n, b) => n + b.querySelectorAll('strong').length, 0),
    };
`);

const HEADLINES = probe(`
    return [...root.querySelectorAll('[data-event-headline]')].map((el) => ({
        text: el.textContent,
        cut: el.scrollWidth > el.clientWidth,
        meta: el.closest('button, div')?.querySelector('[data-event-meta]')?.textContent ?? null,
    }));
`);

const WAKE_TEXT = probe(`return [...root.querySelectorAll('[data-arc-message="wake"]')].map((el) => el.innerText).join('\\n');`);

const NOTICE = probe(`
    ${TOKENS}
    const row = root.querySelector('[data-notice]');
    const button = row?.querySelector('button');
    const icon = button?.querySelector('svg');
    if (!button || !icon) return null;
    const text = button.innerText;
    return {
        text,
        failedCount: text.split(/\\bfailed\\b/).length - 1,
        iconError: getComputedStyle(icon).color === token('text-error', 'color'),
    };
`);

// each marker's look: what one shared row sets, and whether it draws rules
const MARKER_LOOK = probe(`
    const look = (el) => {
        if (!el) return null;
        const s = getComputedStyle(el);
        return {
            font: [s.fontFamily, s.fontSize, s.fontWeight, s.color, s.justifyContent, s.columnGap, s.display].join(' | '),
            rules: [...el.children].filter((c) => c.getBoundingClientRect().height <= 1).length,
            text: el.innerText.trim(),
        };
    };
    return {
        interrupted: look(root.querySelector('[data-interrupted]')),
        approved: look(root.querySelector('[data-pane-action="approved"]')),
        skip: look(root.querySelector('[data-pane-action="skip"]')),
    };
`);

const BUBBLE = probe(`
    const bubble = root.querySelector('[data-user-bubble]');
    const shell = bubble?.firstElementChild;
    const clamp = bubble?.querySelector('[data-find-turn]');
    if (!shell || !clamp) return null;
    const more = bubble.querySelector('[data-clamp-more]');
    const lh = parseFloat(getComputedStyle(clamp).lineHeight);
    const s = getComputedStyle(shell);
    const pad = parseFloat(s.paddingTop) + parseFloat(s.paddingBottom);
    // the Show more line: the inline button sits in a line box at least its parent's line-height tall
    const moreBox = more
        ? Math.max(more.getBoundingClientRect().height, parseFloat(getComputedStyle(more.parentElement).lineHeight)) +
          parseFloat(getComputedStyle(more).marginTop)
        : 0;
    return {
        heading: clamp.querySelectorAll('h1, h2, h3').length,
        items: clamp.querySelectorAll('li').length,
        more: more?.innerText.trim() ?? null,
        height: shell.getBoundingClientRect().height,
        clampHeight: clamp.getBoundingClientRect().height,
        bound: 8 * lh + pad + moreBox + 1,
        clampBound: 8 * lh + 1,
    };
`);

const CODE_BUBBLES = probe(`
    ${TOKENS}
    const mono = token('font-mono', 'fontFamily');
    const bubbles = [...root.querySelectorAll('[data-user-bubble]')];
    const json = bubbles.find((b) => b.innerText.includes('exec_command'));
    const code = json?.querySelector('[data-bubble-code]');
    const plain = bubbles.find((b) => b.innerText.includes('Assess the exact'));
    const plainText = plain?.querySelector('[data-find-turn] p');
    return {
        jsonMono: code ? getComputedStyle(code).fontFamily === mono : false,
        jsonKeepsLines: code ? code.innerText.split('\\n').length > 5 : false,
        plainSans: plainText ? getComputedStyle(plainText).fontFamily !== mono : false,
    };
`);

const COMMAND_CHIP = probe(`
    ${TOKENS}
    const mono = token('font-mono', 'fontFamily');
    const name = root.querySelector('[data-command-chip] [data-command-name]');
    const args = root.querySelector('[data-command-chip] [data-command-args]');
    return name && args
        ? { nameMono: getComputedStyle(name).fontFamily === mono, argsMono: getComputedStyle(args).fontFamily === mono, args: args.innerText }
        : null;
`);

// the final-failed part's head and opened body, against the wake row's own left edge
const INDENT = probe(`
    const wake = root.querySelector('[data-arc-message="wake"]');
    const part = wake?.querySelector('[data-wake-part="final-failed"]');
    const head = part?.firstElementChild;
    const body = part?.querySelector('[data-event-body]');
    if (!wake || !head || !body) return null;
    const left = wake.getBoundingClientRect().left;
    return {
        head: Math.round(head.getBoundingClientRect().left - left),
        body: Math.round(body.getBoundingClientRect().left - left),
    };
`);

async function showWake(h, host, text) {
    await showAt(h, host, [user(text, T0), prose("Writing the fix plan.", T0 + 30 * S)]);
}

export const transcriptCensusRows = {
    name: "transcript-census-rows",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const seam = await waitSeam(h);
        const steps = [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
        if (!seam) return steps;

        for (const [name, host] of Object.entries(HOSTS)) {
            for (const [id, text, failing] of [
                [6, FINAL_6, true],
                [95, FINAL_95, true],
                [133, FINAL_133, false],
            ]) {
                await showWake(h, host, text);
                const log = await h.ev(FINAL_LOG);
                await h.shot(`cdp-shots/transcript-census-rows-final-${id}-${name}.png`);
                steps.push({
                    step: `E1 ${name} #${id}: the Final log is one mono block keeping its indentation, ${failing ? "its failing lines in the error tone and " : ""}its passing lines not`,
                    ok:
                        log != null &&
                        log.logs === 1 &&
                        log.whiteSpace === "pre-wrap" &&
                        log.mono &&
                        log.indented >= 2 &&
                        log.passingPlain &&
                        log.passing > 0 &&
                        (failing ? log.failing.length > 0 && log.failingError : log.failing.length === 0),
                    detail: JSON.stringify(log),
                });
            }

            for (const [id, text] of [
                [52, RUN_52],
                [95, FINAL_95],
            ]) {
                await showWake(h, host, text);
                const bodies = await h.ev(WAKE_BODIES);
                await h.shot(`cdp-shots/transcript-census-rows-markdown-${id}-${name}.png`);
                steps.push({
                    step: `E2 ${name} #${id}: wake bodies render their markdown, no raw ** or backtick left`,
                    ok: bodies != null && bodies.bodies >= 2 && !bodies.rawBold && !bodies.rawTick && bodies.code > 0,
                    detail: JSON.stringify(bodies),
                });
            }

            for (const [id, text, headline] of [
                [27, PLAN_27, "Plan review failed"],
                [133, FINAL_133, "Final failed"],
            ]) {
                await showWake(h, host, text);
                const heads = await h.ev(HEADLINES);
                await h.shot(`cdp-shots/transcript-census-rows-status-${id}-${name}.png`);
                const head = heads?.find((x) => x.text === headline);
                steps.push({
                    step: `E3 ${name} #${id}: the wake row keeps "${headline}" whole, its facts give way first`,
                    ok: head != null && !head.cut,
                    detail: JSON.stringify(heads),
                });
            }

            await showWake(h, host, PLAN_7);
            const plan7 = await h.ev(WAKE_TEXT);
            await h.shot(`cdp-shots/transcript-census-rows-cut-${name}.png`);
            steps.push({
                step: `E7 ${name} #7: the engine's "… N more characters: <cmd>" cut is not shown`,
                ok: plan7 != null && plan7.includes("Task 7 lists") && !plan7.includes("more characters") && !plan7.includes("planreview findings"),
                detail: JSON.stringify(plan7?.slice(-200)),
            });

            await showAt(h, host, [user("typecheck it in the background", T0), NOTICE_40, prose("The typecheck failed; reading why.", T0 + 5 * S)]);
            const notice = await h.ev(NOTICE);
            await h.shot(`cdp-shots/transcript-census-rows-notice-${name}.png`);
            steps.push({
                step: `E4 ${name} #40: a failed background command names "failed" once, its icon in the error tone`,
                ok: notice != null && notice.failedCount === 1 && notice.iconError,
                detail: JSON.stringify(notice),
            });

            await showAt(h, host, MARKERS);
            const markers = await h.ev(MARKER_LOOK);
            await h.shot(`cdp-shots/transcript-census-rows-markers-${name}.png`);
            const looks = markers ? [markers.interrupted, markers.approved, markers.skip] : [];
            steps.push({
                step: `E5 ${name} #39/#165: You interrupted, You approved the design and You skipped the questions share one look, no rules`,
                ok:
                    looks.length === 3 &&
                    looks.every((l) => l != null && l.rules === 0) &&
                    new Set(looks.map((l) => l.font)).size === 1,
                detail: JSON.stringify(markers),
            });

            await showAt(h, host, [user(BRIEF_3, T0), prose("Reading the memories.", T0 + 5 * S)]);
            const clamped = await h.ev(BUBBLE);
            await h.shot(`cdp-shots/transcript-census-rows-bubble-${name}.png`);
            steps.push({
                step: `Decision 2 ${name} #3: a bubble renders its heading and list, and stays within the clamp's bound with Show more`,
                ok:
                    clamped != null &&
                    clamped.heading === 1 &&
                    clamped.items >= 5 &&
                    clamped.more === "Show more" &&
                    clamped.clampHeight <= clamped.clampBound &&
                    clamped.height <= clamped.bound,
                detail: JSON.stringify(clamped),
            });
            await h.ev(`${R}?.querySelector('[data-user-bubble] [data-clamp-more]')?.click()`);
            await sleep(MOTION_MS);
            const opened = await h.ev(BUBBLE);
            await h.shot(`cdp-shots/transcript-census-rows-bubble-open-${name}.png`);
            steps.push({
                step: `Decision 2 ${name} #3: the long brief grows past the clamp once Show more is pressed`,
                ok: clamped != null && opened != null && opened.more === "Show less" && opened.height > clamped.bound,
                detail: JSON.stringify({ before: clamped?.height, bound: clamped?.bound, after: opened?.height }),
            });

            await showAt(h, host, JSON_35);
            const json = await h.ev(CODE_BUBBLES);
            await showAt(h, host, COMMAND_162);
            const chip = await h.ev(COMMAND_CHIP);
            await h.shot(`cdp-shots/transcript-census-rows-command-${name}.png`);
            steps.push({
                step: `G1 ${name} #35/#162: a JSON bubble reads as code, prose stays sans, and a slash command sets only its name mono`,
                ok:
                    json != null &&
                    json.jsonMono &&
                    json.jsonKeepsLines &&
                    json.plainSans &&
                    chip != null &&
                    chip.nameMono &&
                    !chip.argsMono &&
                    chip.args === "show me the design first",
                detail: JSON.stringify({ json, chip }),
            });

            await showWake(h, host, FINAL_6);
            const indent = await h.ev(INDENT);
            await h.shot(`cdp-shots/transcript-census-rows-indent-${name}.png`);
            const compact = host.compact === true;
            steps.push({
                step: compact
                    ? `Decision 4 ${name} #6: the wake's body sits flush with its head, no 19px indent`
                    : `Decision 4 ${name} #6: the wake's body keeps its indent past the bell`,
                ok:
                    indent != null &&
                    (compact ? indent.body === indent.head : indent.body - indent.head >= RENDERED_INDENT_MIN_PX),
                detail: JSON.stringify(indent),
            });
        }
        return steps;
    },
    teardown(h) {
        return clearTranscript(h);
    },
};
