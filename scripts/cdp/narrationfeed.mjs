// narration-feed: the narration timeline (frontend/app/view/agents/narrationtimeline.tsx) against the approved
// polish (docs/superpowers/specs/2026-09-29-narration-timeline-polish-design.md), at a card width and a narrow one.
// Every real host of the feed needs a live session or run, so the feed is mounted over the fixture below through
// the dev-only window.__narrationFeedFixture seam (frontend/app/view/agents/narrationfeedfixture.tsx).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// one unbroken token, long enough to overflow a 360px panel if the line did not wrap
const LONG = "C:/Users/dev/waveterm/pkg/retry/testdata/" + "segment/".repeat(12) + "retry_loop_output.log";
// not a test command: a test run opens to its test card (transcript-base checks that), this one to the raw panel
const BASH_TARGET = "go run ./cmd/retrycheck -case TestBackoff";
const BASH_OUT = `--- FAIL: TestBackoff (0.21s)\n    retry_test.go:42: want 3 attempts, got 4 at ${LONG}\nFAIL`;

const edit = (path, badge, text) => ({
    kind: "action",
    verb: "edited",
    target: path,
    outcome: "ok",
    detail: {
        kind: "edit",
        files: [{ path, badge, adds: 1, dels: 1, lines: [{ sign: "-", text: "for i := 0; i <= max; i++ {" }, { sign: "+", text }] }],
    },
});

// every entry kind in one finished turn: its work folds into "Worked" (no times here) on each side of the compaction,
// which stays outside, and opens to its step boxes, one per stretch between the messages (transcriptlayout.ts)
const ENTRIES = [
    { kind: "user", text: "tighten the retry loop and prove it with a test" },
    {
        kind: "message",
        text: "Reading the retry path first.\n\n`★ Insight ─────────────────────────────────────`\n- The loop counts from zero, so `<=` runs one extra attempt.\n`─────────────────────────────────────────────────`",
    },
    {
        kind: "action",
        verb: "grep",
        target: "attempts",
        outcome: "ok",
        summary: "2 matches",
        durationMs: 180,
        detail: {
            kind: "grep",
            matches: [
                { loc: "retry.go:18", code: "for i := 0; i <= max; i++ {" },
                { loc: "retry_test.go:42", code: "want 3 attempts" },
            ],
            more: "+3 more in 2 files",
        },
    },
    {
        kind: "action",
        verb: "ran",
        target: BASH_TARGET,
        outcome: "fail",
        summary: "1 failed",
        durationMs: 4200,
        detail: { kind: "bash", command: BASH_TARGET, output: BASH_OUT, exit: 1 },
    },
    { kind: "message", text: "The test confirms the off-by-one. Checking the callers before editing." },
    { kind: "action", verb: "read", target: "pkg/retry/retry.go", outcome: "ok", summary: "4 lines" },
    { kind: "action", verb: "read", target: "pkg/retry/backoff.go", outcome: "ok" },
    { kind: "action", verb: "ran", target: "go vet ./pkg/retry/", outcome: "fail" },
    { kind: "action", verb: "grep", target: "Retry(", outcome: "ok" },
    { kind: "message", text: "Two callers, both pass a max of 3." },
    { kind: "action", verb: "read", target: "cmd/wsh/main.go", outcome: "ok" },
    { kind: "action", verb: "read", target: "pkg/jobs/runner.go", outcome: "ok" },
    { kind: "action", verb: "grep", target: "maxAttempts", outcome: "ok" },
    { kind: "message", text: "Fixing the bound." },
    edit("pkg/retry/retry.go", "M", `for i := 0; i < max; i++ { // ${LONG}`),
    edit("pkg/retry/retry_test.go", "M", "want 3 attempts"),
    edit("pkg/retry/doc.go", "A", "// Retry runs at most max attempts."),
    { kind: "compaction", trigger: "auto", preTokens: 182000, postTokens: 24000, summary: "Kept: the retry off-by-one and its test." },
    {
        kind: "action",
        verb: "ran",
        target: "task check:ts",
        outcome: "ok",
        durationMs: 98000,
        detail: { kind: "bash", command: "task check:ts", output: "", exit: 0 },
    },
    // a bare line (no detail, as Codex actions are): no affordance, full opacity
    { kind: "action", verb: "read", target: "CHANGELOG.md", outcome: "ok" },
    { kind: "notification", summary: "Subagent checked the other retry loops", status: "completed", result: "No other loop uses `<=`." },
    { kind: "interrupted" },
    { kind: "command", name: "verify", args: "retry", isSkill: true },
    { kind: "message", text: "Bound fixed; TestBackoff passes." },
];

// the text glyphs the polish replaced with icons (✦ and ⑃ stay)
const GONE_GLYPHS = "✓✗▶▼▲▸↗⊘★";

const ROOT = `document.querySelector('[data-narration-fixture]')`;

// the feed's static checks: no text under 10.5px, nothing dimmed, no replaced glyph, the folds and the boxes, read
// with the folds as they mount, closed
const STATIC_PROBE = `(() => {
    const root = ${ROOT};
    if (!root) return null;
    const all = [...root.querySelectorAll('*')];
    const small = all
        .filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== ''))
        .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 10.5)
        .map((el) => el.textContent.trim().slice(0, 30) + ' @' + getComputedStyle(el).fontSize);
    const dim = all.filter((el) => parseFloat(getComputedStyle(el).opacity) < 1).map((el) => (el.textContent || '').trim().slice(0, 30));
    const glyphs = [...${JSON.stringify(GONE_GLYPHS)}].filter((g) => root.innerText.includes(g));
    const folds = [...root.querySelectorAll('[data-fold]')].map((b) => b.textContent);
    const boxes = [...root.querySelectorAll('[data-steps]')].map((b) => b.querySelectorAll('[data-step]').length);
    return { small, dim, glyphs, folds, boxes };
})()`;

// click the row whose target span reads `text` (React delegates, so a bubbling click reaches the handler)
const clickRow = (text) => `(() => {
    const span = [...${ROOT}.querySelectorAll('span')].find((s) => s.textContent === ${JSON.stringify(text)});
    if (!span) return false;
    span.parentElement.click();
    return true;
})()`;

// the open panels: footer, wrapping and horizontal overflow
const PANEL_PROBE = `(() => [...${ROOT}.querySelectorAll('[data-tool-panel]')].map((p) => {
    const btn = p.querySelector('button[aria-label="Open full view"]');
    const pre = p.querySelector('pre');
    const footer = btn ? btn.parentElement : null;
    const body = p.firstElementChild;
    return {
        text: (p.textContent || '').slice(0, 200),
        // a bare command's body leaves the command to its row
        row: p.closest('[data-step]')?.querySelector('[data-step-head]')?.textContent ?? '',
        btnText: btn ? btn.textContent.trim() : null,
        btnTitle: btn ? btn.getAttribute('title') : null,
        footer: footer ? footer.textContent : null,
        hasExit: /exit \\d/i.test(p.textContent || ''),
        ws: pre ? getComputedStyle(pre).whiteSpace : null,
        overflow: Math.max(p.scrollWidth - p.clientWidth, body.scrollWidth - body.clientWidth),
    };
}))()`;

const allEqual1px = (widths) => Array.isArray(widths) && widths.every((w) => w === "1px");

// opens every closed fold, so the turn's step rows mount
const OPEN_FOLDS = `${ROOT}.querySelectorAll('[data-fold][aria-expanded="false"]').forEach((b) => b.click())`;
const BOXES = `[...${ROOT}.querySelectorAll('[data-steps]')].map((b) => b.querySelectorAll('[data-step]').length)`;
// the insight callout's borders; it is in the turn's interim prose, so read with the folds open
const INSIGHT = `(() => {
    const ins = ${ROOT}.querySelector('[data-insight]');
    const is = ins && getComputedStyle(ins);
    return is ? [is.borderTopWidth, is.borderRightWidth, is.borderBottomWidth, is.borderLeftWidth] : null;
})()`;

// the tool panels (spec 2026-11-17 transcript renderer fix round 2, #14-#17 and decision 47), one call of each kind
const DEEP_PATH = "frontend/app/view/agents/" + "nested/".repeat(8) + "tooldetailbody.tsx";
const GREP_LONG = "    const retryBudget = computeRetryBudget(attempts, " + "options.backoff, ".repeat(14) + "jitter);";
const READ_LONG = "// " + "the retry budget counts every attempt, the first one included, ".repeat(5);
const GREP_TARGET = "retryBudget src/";
const PANEL_ENTRIES = [
    { kind: "user", text: "check the retry budget" },
    {
        kind: "action",
        verb: "edited",
        target: DEEP_PATH,
        outcome: "ok",
        detail: {
            kind: "edit",
            files: [{ path: DEEP_PATH, badge: "M", adds: 1, dels: 1, lines: [{ sign: "-", text: "a" }, { sign: "+", text: "b" }] }],
        },
    },
    {
        kind: "action",
        verb: "grep",
        target: GREP_TARGET,
        outcome: "ok",
        summary: "3 matches",
        detail: {
            kind: "grep",
            pattern: "retryBudget",
            matches: [
                { loc: "src/retry.ts:12", code: GREP_LONG },
                { loc: "src/retry.ts:40", code: "return retryBudget > 0;" },
                { loc: "src/client.ts:7", code: "import { retryBudget } from './retry';" },
            ],
        },
    },
    {
        kind: "action",
        verb: "read",
        target: "src/retry.ts",
        outcome: "ok",
        detail: {
            kind: "read",
            path: "src/retry.ts",
            snippet: `     1\timport { backoff } from './backoff';\n     2\t${READ_LONG}\n     3\texport const max = 3;`,
        },
    },
    {
        kind: "action",
        verb: "wrote",
        target: "src/jitter.ts",
        outcome: "ok",
        detail: {
            kind: "edit",
            files: [
                {
                    path: "src/jitter.ts",
                    badge: "A",
                    adds: 3,
                    dels: 0,
                    lines: [
                        { sign: "+", text: "export function jitter(ms: number) {" },
                        { sign: "+", text: "    return ms * Math.random();" },
                        { sign: "+", text: "}" },
                    ],
                },
            ],
        },
    },
    {
        kind: "action",
        verb: "edited",
        target: "src/missing.ts",
        outcome: "fail",
        error: "File has not been read yet. Read it first before writing to it.",
        detail: {
            kind: "edit",
            files: [{ path: "src/missing.ts", badge: "M", adds: 1, dels: 1, lines: [{ sign: "-", text: "x" }, { sign: "+", text: "y" }] }],
        },
    },
    { kind: "message", text: "The budget counts the first attempt." },
];

// opens the step row whose text includes `text`
const openStep = (text) => `(() => {
    const step = [...${ROOT}.querySelectorAll('[data-step]')].find((s) => s.textContent.includes(${JSON.stringify(text)}));
    const btn = step?.querySelector('button[aria-expanded]');
    if (!btn) return false;
    if (btn.getAttribute('aria-expanded') !== 'true') btn.click();
    return true;
})()`;
// the open panel whose text includes `text`, as a JS expression
const panelWith = (text) => `[...${ROOT}.querySelectorAll('[data-tool-panel]')].find((p) => p.textContent.includes(${JSON.stringify(text)}))`;
// the feed scrolls inside its modal, so a later panel is out of frame until brought in
async function shotPanel(h, text, file) {
    await h.ev(`${panelWith(text)}?.scrollIntoView({ block: "center" })`);
    await sleep(200);
    await h.shot(file);
}
// the open tool detail modal: the one whose head is not inside the fixture
const MODAL_HEAD = `document.querySelector('[data-tool-modal-head]')`;

async function panelSteps(h) {
    const steps = [];
    await show(h, 360, PANEL_ENTRIES);
    await h.ev(OPEN_FOLDS);
    await sleep(600);
    const openedEdit = await h.ev(openStep(DEEP_PATH));
    await sleep(600);
    // cut a whole segment at a time (census C6), so it starts at a segment, not mid-word
    // found by its row: the header no longer holds the whole path
    const edit = await h.ev(`(() => {
        const row = [...${ROOT}.querySelectorAll('[data-step]')].find((s) => (s.querySelector('[data-step-head]')?.textContent ?? '').includes(${JSON.stringify(DEEP_PATH)}));
        const span = row?.querySelector('[data-tool-panel] [data-panel-path]');
        const bdi = span?.querySelector('bdi');
        if (!span || !bdi) return null;
        return { text: bdi.textContent, fits: span.scrollWidth <= span.clientWidth + 1 };
    })()`);
    steps.push({
        step: "[360] an Edit panel header cut from the left starts at a segment and ends with the file name",
        ok:
            openedEdit === true &&
            edit?.fits === true &&
            edit.text.startsWith("…/") &&
            edit.text.endsWith("/nested/tooldetailbody.tsx") &&
            DEEP_PATH.endsWith(edit.text.slice(1)),
        detail: JSON.stringify(edit),
    });
    await h.shot("cdp-shots/narration-feed-panel-path.png");

    await show(h, 640, PANEL_ENTRIES);
    await h.ev(OPEN_FOLDS);
    await sleep(600);
    const openedGrep = await h.ev(openStep(GREP_TARGET));
    await sleep(600);
    const grep = await h.ev(`(() => {
        const p = ${panelWith("src/client.ts")};
        if (!p) return null;
        return {
            files: [...p.querySelectorAll('[data-grep-file]')].map((f) => f.textContent),
            lines: [...p.querySelectorAll('[data-grep-group]')].map((g) => g.querySelectorAll('[data-file-line]').length),
            hits: [...p.querySelectorAll('[data-grep-hit]')].map((m) => m.textContent),
            locs: /src\\/retry\\.ts:\\d/.test(p.textContent),
        };
    })()`);
    steps.push({
        step: "[640] a grep panel shows one header per file over its lines, each match marked",
        ok:
            openedGrep === true &&
            JSON.stringify(grep?.files) === JSON.stringify(["src/retry.ts", "src/client.ts"]) &&
            JSON.stringify(grep.lines) === JSON.stringify([2, 1]) &&
            grep.hits.length === 3 &&
            grep.hits.every((t) => t === "retryBudget") &&
            grep.locs === false,
        detail: JSON.stringify(grep),
    });
    await shotPanel(h, "src/client.ts", "cdp-shots/narration-feed-grep.png");

    const openedRead = await h.ev(openStep("Read src/retry.ts"));
    await sleep(600);
    const read = await h.ev(`(() => {
        const p = ${panelWith("export const max")};
        if (!p) return null;
        const rows = [...p.querySelectorAll('[data-file-line]')];
        const long = rows[1];
        const no = long?.querySelector('[data-line-no]');
        const text = long?.querySelector('[data-line-text]');
        if (!no || !text) return { rows: rows.length };
        const lh = parseFloat(getComputedStyle(text).lineHeight);
        return {
            rows: rows.length,
            numbers: rows.map((r) => r.querySelector('[data-line-no]')?.textContent),
            firstText: rows[0].querySelector('[data-line-text]').textContent,
            wrapped: text.getBoundingClientRect().height > lh * 1.5,
            hangs: text.getBoundingClientRect().left >= no.getBoundingClientRect().right,
            muted: getComputedStyle(no).color !== getComputedStyle(text.querySelector('span') ?? text).color,
        };
    })()`);
    steps.push({
        step: "[640] a Read panel's numbers sit in a muted gutter and a wrapped line hangs under its own text",
        ok:
            openedRead === true &&
            read?.rows === 3 &&
            JSON.stringify(read.numbers) === JSON.stringify(["1", "2", "3"]) &&
            read.firstText === "import { backoff } from './backoff';" &&
            read.wrapped === true &&
            read.hangs === true &&
            read.muted === true,
        detail: JSON.stringify(read),
    });
    await shotPanel(h, "export const max", "cdp-shots/narration-feed-read.png");

    const openedWrite = await h.ev(openStep("Wrote src/jitter.ts"));
    await sleep(600);
    const write = await h.ev(`(() => {
        const p = ${panelWith("src/jitter.ts")};
        if (!p) return null;
        return {
            preview: p.querySelector('[data-file-preview]') != null,
            isNew: [...p.querySelectorAll('[data-diff-file] span')].some((s) => s.textContent === 'new'),
            plusRows: p.querySelectorAll('[data-diff-line]').length,
            numbers: [...p.querySelectorAll('[data-line-no]')].map((n) => n.textContent),
        };
    })()`);
    steps.push({
        step: '[640] a Write of a new file shows the file preview with "new" and no + rows',
        ok:
            openedWrite === true &&
            write?.preview === true &&
            write.isNew === true &&
            write.plusRows === 0 &&
            JSON.stringify(write.numbers) === JSON.stringify(["1", "2", "3"]),
        detail: JSON.stringify(write),
    });
    await shotPanel(h, "src/jitter.ts", "cdp-shots/narration-feed-new-file.png");

    // the grep row's Open full view
    const inlineWidth = await h.ev(`${panelWith("src/client.ts")}?.getBoundingClientRect().width ?? null`);
    await h.ev(`${panelWith("src/client.ts")}?.querySelector('button[aria-label="Open full view"]')?.click()`);
    await sleep(700);
    const full = await h.ev(`(() => {
        const head = ${MODAL_HEAD};
        const body = document.querySelector('[data-tool-modal-body]');
        if (!head || !body) return null;
        const line = [...body.querySelectorAll('[data-line-text]')].find((t) => t.textContent.includes('computeRetryBudget'));
        return {
            width: body.getBoundingClientRect().width,
            square: head.querySelector('[role="img"]') != null,
            whole: line != null && line.textContent === ${JSON.stringify(GREP_LONG)} && getComputedStyle(line).whiteSpace === 'pre',
            lineHeight: line ? Math.round(line.getBoundingClientRect().height) : null,
        };
    })()`);
    steps.push({
        step: "[640] Open full view is wider than the inline panel, shows a grep line whole on one line, and has no status square for a successful call",
        ok:
            inlineWidth != null &&
            full != null &&
            full.width > inlineWidth + 100 &&
            full.square === false &&
            full.whole === true &&
            full.lineHeight < 24,
        detail: JSON.stringify({ inlineWidth, ...full }),
    });
    await h.shot("cdp-shots/narration-feed-full-view.png");
    await h.ev(`${MODAL_HEAD}?.querySelector('button[aria-label="Close"]')?.click()`);
    await sleep(700);

    // a failed call's full view leads with its error, its mark a word
    const openedFail = await h.ev(openStep("Edited src/missing.ts"));
    await sleep(600);
    await h.ev(`${panelWith("src/missing.ts")}?.querySelector('button[aria-label="Open full view"]')?.click()`);
    await sleep(700);
    const failed = await h.ev(`(() => {
        const head = ${MODAL_HEAD};
        const body = document.querySelector('[data-tool-modal-body]');
        if (!head || !body) return null;
        return {
            lead: body.firstElementChild?.hasAttribute('data-tool-error') ? body.firstElementChild.textContent : null,
            failedWord: [...head.querySelectorAll('span')].some((s) => s.textContent === 'failed'),
            square: head.querySelector('[role="img"]') != null,
        };
    })()`);
    steps.push({
        step: '[640] a failed call\'s full view leads with its error and marks it with a "failed" word, not a square',
        ok:
            openedFail === true &&
            failed?.lead === "File has not been read yet. Read it first before writing to it." &&
            failed.failedWord === true &&
            failed.square === false,
        detail: JSON.stringify(failed),
    });
    await h.shot("cdp-shots/narration-feed-full-view-error.png");
    await h.ev(`${MODAL_HEAD}?.querySelector('button[aria-label="Close"]')?.click()`);
    await sleep(700);
    return steps;
}

async function show(h, width, entries = ENTRIES) {
    await h.ev(`window.__narrationFeedFixture.clear()`);
    // the modal's key is stable, so a show during the exit motion revives the old feed with its panels still open
    for (let i = 0; i < 25 && (await h.ev(`${ROOT} != null`)); i++) await sleep(100);
    await h.ev(`window.__narrationFeedFixture.show(${JSON.stringify(entries)}, ${width})`);
    await sleep(900); // the modal's open motion and the rows' fade-in settle before styles are read
}

async function staticSteps(h, label) {
    const s = await h.ev(STATIC_PROBE);
    if (!s) return [{ step: `[${label}] feed rendered`, ok: false, detail: "no [data-narration-fixture]" }];
    await h.ev(OPEN_FOLDS);
    await sleep(600);
    const boxes = await h.ev(BOXES);
    const insight = await h.ev(INSIGHT);
    return [
        { step: `[${label}] no text below 10.5px`, ok: s.small.length === 0, detail: s.small.slice(0, 5).join(" | ") || "none" },
        { step: `[${label}] nothing dimmed`, ok: s.dim.length === 0, detail: s.dim.slice(0, 5).join(" | ") || "none" },
        { step: `[${label}] no replaced text glyphs`, ok: s.glyphs.length === 0, detail: s.glyphs.join(" ") || "none" },
        {
            step: `[${label}] the turn folds on each side of the compaction: two "Worked · <phrase>" lines, the first with "2 failed" and the edits "+3 −3", no box drawn while closed`,
            ok:
                s.folds.length === 2 &&
                s.folds.every((t) => t.startsWith("Worked")) &&
                s.folds[0].includes("2 failed") &&
                s.folds[0].includes("edited 3 files") &&
                s.folds[0].includes("+3") &&
                s.folds[0].includes("−3") &&
                !s.folds[1].includes("failed") &&
                s.boxes.length === 0,
            detail: JSON.stringify(s.folds),
        },
        {
            step: `[${label}] the opened folds draw each stretch as a step box`,
            ok: JSON.stringify(boxes) === JSON.stringify([2, 4, 3, 3, 2]),
            detail: JSON.stringify(boxes),
        },
        { step: `[${label}] insight callout: 1px border all round`, ok: allEqual1px(insight), detail: JSON.stringify(insight) },
    ];
}

export const narrationFeed = {
    name: "narration-feed",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        let seam = false;
        for (let i = 0; i < 25 && !seam; i++) {
            seam = await h.ev(`typeof window.__narrationFeedFixture === 'object'`);
            if (!seam) await sleep(200);
        }
        steps.push({ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` });
        if (!seam) return steps;

        // wide: a card
        await show(h, 640);
        steps.push(...(await staticSteps(h, "640")));
        const failRow = await h.ev(`(() => {
            const row = ${ROOT}.querySelector('[data-step-status="fail"]');
            return row ? row.textContent : null;
        })()`);
        steps.push({
            step: "[640] a failed command's step row: the command in mono, an exit 1 chip and its time",
            ok: failRow != null && failRow.includes(BASH_TARGET) && failRow.includes("exit 1") && failRow.includes("4.2s"),
            detail: JSON.stringify(failRow),
        });
        const opened = await h.ev(clickRow(BASH_TARGET));
        const openedOk = await h.ev(clickRow("task check:ts"));
        await sleep(600);
        const panels = await h.ev(PANEL_PROBE);
        const fail = panels.find((p) => p.text.includes("TestBackoff"));
        const ok = panels.find((p) => p.row.includes("task check:ts"));
        steps.push({
            step: '[640] bash panel footer: only "Open full view", with aria-label and no title; the exit chip stays on the row',
            ok:
                opened === true &&
                fail != null &&
                fail.btnText === "Open full view" &&
                fail.btnTitle === null &&
                fail.footer === "Open full view" &&
                fail.hasExit === false,
            detail: JSON.stringify(fail ?? null),
        });
        steps.push({ step: "[640] bash output wraps (pre-wrap)", ok: fail?.ws === "pre-wrap", detail: `ws=${fail?.ws}` });
        steps.push({
            step: "[640] command-only bash with exit 0 opens with no exit chip",
            ok: openedOk === true && ok != null && ok.hasExit === false,
            detail: JSON.stringify(ok ?? null),
        });
        await h.shot("cdp-shots/narration-feed-wide.png");

        // "Open full view" opens the tool detail modal, which keeps its lines unwrapped
        await h.ev(`[...${ROOT}.querySelectorAll('button[aria-label="Open full view"]')][0].click()`);
        await sleep(700);
        const modalWs = await h.ev(`(() => {
            const root = ${ROOT};
            const pres = [...document.querySelectorAll('pre')].filter((p) => !root.contains(p) && (p.textContent || '').includes('TestBackoff'));
            return pres.length ? getComputedStyle(pres[pres.length - 1]).whiteSpace : null;
        })()`);
        steps.push({ step: "tool detail modal keeps unwrapped lines (white-space: pre)", ok: modalWs === "pre", detail: `ws=${modalWs}` });
        await h.shot("cdp-shots/narration-feed-modal.png");

        // narrow: the long token must wrap inside the panels, not scroll them sideways
        await show(h, 360);
        steps.push(...(await staticSteps(h, "360")));
        const openedBash = await h.ev(clickRow(BASH_TARGET));
        const openedEdit = await h.ev(clickRow("Edited pkg/retry/retry.go"));
        await sleep(600);
        const narrow = await h.ev(PANEL_PROBE);
        steps.push({
            step: "[360] bash and edit panels do not scroll sideways",
            ok:
                openedBash === true &&
                openedEdit === true &&
                narrow.length === 2 &&
                narrow.some((p) => p.text.includes("TestBackoff")) &&
                narrow.some((p) => p.text.includes("pkg/retry/retry.go")) &&
                narrow.every((p) => p.overflow <= 1),
            detail: JSON.stringify(narrow.map((p) => ({ text: p.text, overflow: p.overflow }))),
        });
        await h.shot("cdp-shots/narration-feed-narrow.png");

        // an expanded fold keeps its summary row as a header, so a click folds it and a second opens it again
        const FOLD = `[...${ROOT}.querySelectorAll('[data-fold]')].find((b) => (b.textContent || '').includes('CHANGELOG.md'))`;
        const foldState = `(() => ({ expanded: ${FOLD}?.getAttribute('aria-expanded') ?? null, folds: ${ROOT}.querySelectorAll('[data-fold]').length }))()`;
        const expanded = await h.ev(foldState);
        await h.shot("cdp-shots/narration-feed-fold-open.png");
        await h.ev(`${FOLD}?.click()`);
        await sleep(600);
        const closed = await h.ev(foldState);
        await h.ev(`${FOLD}?.click()`);
        await sleep(600);
        const reopened = await h.ev(foldState);
        steps.push({
            step: "[360] an open fold keeps its header: a click folds it, a second click opens it again",
            ok:
                expanded.expanded === "true" &&
                closed.expanded === "false" &&
                closed.folds === expanded.folds &&
                reopened.expanded === "true",
            detail: JSON.stringify({ expanded, closed, reopened }),
        });
        steps.push(...(await panelSteps(h)));
        return steps;
    },
    async teardown(h) {
        await h.ev(`window.__narrationFeedFixture?.clear()`);
    },
};
