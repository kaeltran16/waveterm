// Scenario `transcript-census-markdown`: the census's markdown fixes (markdownmessage.tsx, `.agent-md`, chartcard.tsx),
// at both census hosts. Each message is trimmed from a census specimen (its id in the constant's comment): ordered list
// markers past 9 show whole (D1), tables scroll in their wrapper with a minimum column width (D2), fenced code scrolls
// with an edge cue (D3), long tokens break inside the column (D4), the inline code pill keeps its padding on wrap and
// its short words whole (D5), block spacing around lists and rules and one blockquote bar (D6), and a bar chart's tick
// labels apart with no wide label gutter (D7).

import { clearTranscript, HOSTS, openFolds, prose, ROOT, showAt, user, waitSeam } from "./transcript-fixture.mjs";

const T0 = Date.UTC(2026, 10, 18, 9, 0, 0);
const S = 1000;
const R = `document.querySelector(${JSON.stringify(ROOT)})`;
// sub-pixel layout slack
const EPS = 0.5;
// markdownmessage.tsx's CODE_NOWRAP_MAX_CHARS
const CODE_NOWRAP_MAX_CHARS = 32;
// tailwindsetup.css's .agent-md block margins, in em
const LIST_MARGIN_EM = 0.6;
const HR_MARGIN_EM = 0.9;
// the inline code pill's side padding, and the most its end may sit off the punctuation after it
const PILL_GAP_MAX_PX = 2.5;
// a bar chart's track starts this close to the card body's content edge
const CHART_GUTTER_MAX_PX = 48;

// specimen 2: an ordered list that reaches 10 and 11
const LIST = [
    "Below are the facts any design has to respect.",
    "",
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `${n}. **Fact ${n}.** The reviewer judges the committed range.\n`),
    "9. **Verify is fixed at submit, but the scripts it calls are not.** `g.Verify` is a string captured at submit (`engine.go:960-962`).",
    "",
    "10. **Shell edits and subagent edits bypass any edit-tool hook.** The worker is only asked to use its edit tool (`engine.go:950`).",
    "",
    "11. **The repo is full of legitimate suppressions, so false positives will be common.**",
].join("\n");

// specimen 8: a wide table whose first and last columns are prose
const TABLE_WIDE = [
    "**Counts** (interactive sessions only)",
    "",
    "| Measure | Aug | Sep | Oct | Nov | Total |",
    "|---|---|---|---|---|---|",
    "| Q1 core diagram replies (box chars, ASCII box, mermaid or fenced flows) | 7 | 4 | 9 | 6 | 26 (0.11% of replies), 20 sessions (2.1%) |",
    "| Q1 wide (core plus fenced arrow chains) | 25 | 16 | 14 | 14 | 69, 46 sessions (4.7%) |",
    "| Q2b \"show me the flow / how does X work\" prompts | 6 | 2 | 11 | 4 | 23; 7 got a drawn diagram, 16 got prose |",
].join("\n");

// specimen 121: a two-column table, short labels beside long prose
const TABLE_TWO = [
    "From the code, the full list of things the transcript renderer draws is:",
    "",
    "| Layer | What it covers |",
    "|---|---|",
    "| **Entry kinds** | `message` (markdown: lists, tables, links, inline code, fenced blocks for each language), `thought`, `user` (images, queued), `compaction`, `notification` |",
    "| **Composition** | how kinds sit next to each other: spacing between kinds, folded turns, verb grouping and merged steps, the latest-entry accent, very long turns |",
].join("\n");

// specimens 13 and 91: a box diagram and a long shell command, both wider than either host
const CODE = [
    "**Today** (the bug: two Terminals, and the lit one on the right is wrong)",
    "```",
    " ● my-agent  claude  asking        ┌──────────┬─[Brainstorm•]┐ ┌─[Terminal]─┬──────────┐ v",
    "                                   │ Terminal │              │ │            │ Rendered │",
    "```",
    "",
    "Put the key into `ANTHROPIC_API_KEY` for that one process only:",
    "",
    "```sh",
    'cd <repo> && env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_ENTRYPOINT \\',
    "  claude -p --model claude-fable-5-2 --effort high --output-format json --disallowedTools Edit Write NotebookEdit",
    "```",
].join("\n");

// specimens 16 and 88: paths and ids longer than the compact line, in prose and in code
const LONG = [
    "The lead's worktree is C:/Users/kael02/IdeaProjects/waveterm/.superpowers/dag-measure/planskill-compare.mjs, and the transcript is C:\\Users\\kael02\\.claude\\projects\\C--Users-kael02-AppData-Local-arc-wt-98637b17\\6f9c64c6-2058-4222-bb1d-d9ba74a6cdeb.jsonl.",
    "",
    "- location: `C:\\Users\\kael02\\AppData\\Local\\arc-wt\\98637b17\\docs\\superpowers\\plans\\2026-11-17-plan-skill-bench.md` (same pattern at `:902` for `~/.pi/agent/settings.json`)",
    "- failure scenario: a markdown file contains `<a href='https://example.com/\"&calc.exe&\"'>docs</a>`.",
].join("\n");

// specimens 6 and 44: pills before punctuation, and flags whose hyphens must not break
const PILL = [
    "Same spec, same base `d82662791`, the same replay goal text, autonomous, in its own worktree `resource-arc`. Checking the start flags first:",
    "",
    "Run it with `--config-dir`, `--max-budget-usd 40`, `--disallowedTools Edit Write NotebookEdit` and `wsh runs cancel <id> --yes` so the run stops cleanly, and the list column in `src/components/session/BoardList.tsx` anchors it.",
].join("\n");

// specimen 132: text against a list and a rule
const SPACING = [
    "I've closed and archived the SIEM-1750 initiative. Nothing was posted to Jira.",
    "",
    "- **Verify:** renamed and marked done.",
    "- **Shared redaction corpus:** skipped.",
    "",
    "Here's the table:",
    "",
    "---",
    "",
    "**Scan:** Fable 5.2 code review of cyber_assistant.",
].join("\n");

// specimen 159: two blockquotes split by a blank line
const QUOTE = [
    "## Suggested text for the changed parts",
    "",
    "> - **Council:** 4 experts read the code over 2 rounds; the coordinator merges their list.",
    "> - **Brainstorm:** one agent runs the brainstorming skill, with its judge and reviewer.",
    "",
    "> **This round:** brainstorm found 15/48, council 10/48.",
].join("\n");

// specimen 173: a two-series bar chart with short categories
const CHART = [
    "Step 5: build and test seconds per day from `timings.csv`:",
    "",
    "```chart",
    '{"type": "bar", "title": "Build and test seconds per day", "x": {"label": "day"}, "y": {"unit": "s"},',
    ' "series": [',
    '   {"name": "build", "points": [{"x": "mon", "y": 42}, {"x": "tue", "y": 39}, {"x": "wed", "y": 51}, {"x": "thu", "y": 44}, {"x": "fri", "y": 37}]},',
    '   {"name": "test", "points": [{"x": "mon", "y": 118}, {"x": "tue", "y": 121}, {"x": "wed", "y": 97}, {"x": "thu", "y": 103}, {"x": "fri", "y": 88}]}]}',
    "```",
].join("\n");

const ENTRIES = [
    user("Walk me through it.", T0),
    ...[LIST, TABLE_WIDE, TABLE_TWO, CODE, LONG, PILL, SPACING, QUOTE, CHART].map((text, i) => prose(text, T0 + (i + 1) * S)),
];

// a shot of each part below the first screen, scrolled to the message holding the text
const SHOT_PARTS = [
    ["code", "the lit one on the right"],
    ["prose", "planskill-compare.mjs"],
    ["blocks", "Nothing was posted to Jira"],
    ["chart", "timings.csv"],
];

// every measure, in the page. md(text): the message whose markdown holds text. content: the card's content box.
const MEASURE = `(() => {
    const root = ${R};
    if (!root) return null;
    const EPS = ${EPS};
    const rs = getComputedStyle(root);
    const rr = root.getBoundingClientRect();
    const content = { left: rr.left + parseFloat(rs.paddingLeft), right: rr.right - parseFloat(rs.paddingRight) };
    const mds = [...root.querySelectorAll('.agent-md')];
    const md = (text) => mds.find((m) => m.textContent.includes(text));
    const textWidth = (text, like) => {
        const s = document.createElement('span');
        s.style.font = getComputedStyle(like).font;
        s.style.whiteSpace = 'pre';
        s.style.position = 'absolute';
        s.textContent = text;
        document.body.appendChild(s);
        const w = s.getBoundingClientRect().width;
        s.remove();
        return w;
    };
    const fs = (el) => parseFloat(getComputedStyle(el).fontSize);
    const out = {};

    const list = md('Shell edits and subagent edits');
    const li10 = list?.querySelectorAll('ol > li')[9];
    out.list = li10 == null ? null : {
        items: list.querySelectorAll('ol > li').length,
        markerW: textWidth('10. ', li10),
        room: li10.getBoundingClientRect().left - content.left,
    };

    out.tables = ['Q1 core diagram', 'Entry kinds'].map((key) => {
        const wrap = md(key)?.querySelector('.agent-table-wrap');
        if (!wrap) return { key, found: false };
        const w = wrap.getBoundingClientRect();
        const cells = [...wrap.querySelectorAll('th, td')];
        const wrapCells = cells.filter((c) => c.style.minWidth !== '');
        return {
            key,
            found: true,
            overflowX: getComputedStyle(wrap).overflowX,
            scrolls: wrap.scrollWidth > wrap.clientWidth,
            inside: w.left >= content.left - EPS && w.right <= content.right + EPS,
            wrapCells: wrapCells.length,
            narrow: wrapCells.filter((c) => c.getBoundingClientRect().width < parseFloat(getComputedStyle(c).minWidth) - EPS).length,
            clipped: cells.filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => c.textContent.slice(0, 30)),
        };
    });

    out.code = ['my-agent', 'CLAUDE_CODE_CHILD_SESSION'].map((key) => {
        const pre = md(key) == null ? null : [...md(key).querySelectorAll('[data-code-head]')].map((hd) => hd.parentElement).find((b) => b.textContent.includes(key));
        const scroller = pre?.querySelector('[data-code-head] + div');
        if (!scroller) return { key, found: false };
        const b = pre.getBoundingClientRect();
        return {
            key,
            found: true,
            overflowX: getComputedStyle(scroller).overflowX,
            scrolls: scroller.scrollWidth > scroller.clientWidth,
            cue: getComputedStyle(scroller).backgroundImage.includes('gradient'),
            inside: b.left >= content.left - EPS && b.right <= content.right + EPS,
        };
    });

    const long = md('planskill-compare.mjs');
    if (long) {
        const past = [...long.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > content.right + EPS).map((e) => e.tagName + ':' + e.textContent.slice(0, 30));
        const walker = document.createTreeWalker(long, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const r = document.createRange();
            r.selectNodeContents(n);
            if ([...r.getClientRects()].some((q) => q.right > content.right + EPS)) past.push('text:' + n.textContent.slice(0, 30));
        }
        out.long = { past };
    } else out.long = null;

    const pill = md('d82662791');
    if (pill) {
        const codes = [...pill.querySelectorAll('code')];
        const first = codes.find((c) => c.textContent === 'd82662791');
        const after = first.nextSibling;
        const lastChar = document.createRange();
        const tn = document.createTreeWalker(first, NodeFilter.SHOW_TEXT);
        let last = null;
        for (let n = tn.nextNode(); n; n = tn.nextNode()) last = n;
        lastChar.setStart(last, last.length - 1);
        lastChar.setEnd(last, last.length);
        const punct = document.createRange();
        punct.setStart(after, 0);
        punct.setEnd(after, 1);
        const words = [];
        for (const c of codes) {
            const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
            for (let n = w.nextNode(); n; n = w.nextNode()) {
                if (/\\s/.test(n.textContent) || n.textContent.length > ${CODE_NOWRAP_MAX_CHARS}) continue;
                words.push({ word: n.textContent, nowrap: getComputedStyle(n.parentElement).whiteSpace === 'nowrap' });
            }
        }
        out.pill = {
            punct: after?.textContent?.[0],
            gap: punct.getBoundingClientRect().left - lastChar.getBoundingClientRect().right,
            decoration: getComputedStyle(first).boxDecorationBreak || getComputedStyle(first).webkitBoxDecorationBreak,
            broken: words.filter((w) => !w.nowrap).map((w) => w.word),
            flagLines: codes.filter((c) => c.textContent.startsWith('--config-dir')).map((c) => c.getClientRects().length),
        };
    } else out.pill = null;

    const sp = md('Nothing was posted to Jira');
    const ul = sp?.querySelector('ul');
    const hr = sp?.querySelector('hr');
    out.spacing = ul && hr ? {
        em: fs(sp),
        beforeList: ul.getBoundingClientRect().top - ul.previousElementSibling.getBoundingClientRect().bottom,
        afterList: ul.nextElementSibling.getBoundingClientRect().top - ul.getBoundingClientRect().bottom,
        beforeRule: hr.getBoundingClientRect().top - hr.previousElementSibling.getBoundingClientRect().bottom,
        afterRule: hr.nextElementSibling.getBoundingClientRect().top - hr.getBoundingClientRect().bottom,
    } : null;

    const quotes = md('brainstorm found 15/48')?.querySelectorAll('blockquote');
    out.quote = quotes?.length === 2 ? { count: 2, gap: quotes[1].getBoundingClientRect().top - quotes[0].getBoundingClientRect().bottom } : { count: quotes?.length ?? 0 };

    const card = root.querySelector('[data-chart-card][data-chart-type="bar"]');
    const axis = card?.querySelector('[data-chart-axis]');
    const track = card?.querySelector('[data-chart-track]');
    if (card && axis && track) {
        const body = card.lastElementChild;
        const labels = [...axis.children].map((s) => s.getBoundingClientRect()).sort((a, b) => a.left - b.left);
        out.chart = {
            labels: labels.length,
            overlaps: labels.slice(1).filter((l, i) => l.left < labels[i].right - EPS).length,
            gutter: track.getBoundingClientRect().left - (body.getBoundingClientRect().left + parseFloat(getComputedStyle(body).paddingLeft)),
        };
    } else out.chart = { found: false, card: !!card };
    return out;
})()`;

function hostSteps(name, m) {
    const at = (s) => `${name}: ${s}`;
    const d = (v) => JSON.stringify(v);
    const steps = [];
    steps.push({
        step: at("D1 the '10.' marker of an ordered list sits wholly inside the card"),
        ok: m.list != null && m.list.items === 11 && m.list.room >= m.list.markerW - EPS,
        detail: d(m.list),
    });
    for (const t of m.tables) {
        steps.push({
            step: at(`D2 table '${t.key}' sits in a sideways scroller inside the card, no prose cell under its minimum width, no cell clipped`),
            ok: t.found && t.overflowX === "auto" && t.inside && t.wrapCells > 0 && t.narrow === 0 && t.clipped.length === 0,
            detail: d(t),
        });
    }
    const wide = m.tables.find((t) => t.key === "Q1 core diagram");
    if (name === "compact") {
        steps.push({ step: at("D2 the wide table scrolls rather than squeezing its columns"), ok: wide?.scrolls === true, detail: d(wide) });
    }
    for (const c of m.code) {
        steps.push({
            step: at(`D3 fenced block '${c.key}' scrolls sideways inside the card, with an edge cue`),
            ok: c.found && c.overflowX === "auto" && c.scrolls && c.cue && c.inside,
            detail: d(c),
        });
    }
    steps.push({
        step: at("D4 long paths and ids break inside the column: nothing in the message runs past the card"),
        ok: m.long != null && m.long.past.length === 0,
        detail: d(m.long),
    });
    steps.push({
        step: at("D5 the code pill: padding on every wrapped line, no gap before the comma after it, short words never break"),
        ok:
            m.pill != null &&
            m.pill.punct === "," &&
            m.pill.gap <= PILL_GAP_MAX_PX &&
            m.pill.decoration === "clone" &&
            m.pill.broken.length === 0 &&
            m.pill.flagLines.length > 0 &&
            m.pill.flagLines.every((n) => n === 1),
        detail: d(m.pill),
    });
    const s = m.spacing;
    const listGap = s == null ? 0 : LIST_MARGIN_EM * s.em - EPS;
    const ruleGap = s == null ? 0 : HR_MARGIN_EM * s.em - EPS;
    steps.push({
        step: at("D6 text keeps its block margin from a list and from a rule"),
        ok: s != null && s.beforeList >= listGap && s.afterList >= listGap && s.beforeRule >= ruleGap && s.afterRule >= ruleGap,
        detail: d(s),
    });
    steps.push({
        step: at("D6 two blockquotes split by a blank line draw one unbroken bar"),
        ok: m.quote.count === 2 && Math.abs(m.quote.gap) <= EPS,
        detail: d(m.quote),
    });
    steps.push({
        step: at(`D7 the bar chart's tick labels do not overlap, and its bars start within ${CHART_GUTTER_MAX_PX}px of the card's content edge`),
        ok: m.chart.labels > 1 && m.chart.overlaps === 0 && m.chart.gutter <= CHART_GUTTER_MAX_PX,
        detail: d(m.chart),
    });
    return steps;
}

export const transcriptCensusMarkdown = {
    name: "transcript-census-markdown",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const seam = await waitSeam(h);
        const steps = [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
        if (!seam) return steps;
        for (const [name, host] of Object.entries(HOSTS)) {
            await showAt(h, host, ENTRIES);
            await openFolds(h);
            const m = await h.ev(MEASURE);
            await h.shot(`cdp-shots/transcript-census-markdown-${name}.png`);
            for (const [part, text] of SHOT_PARTS) {
                await h.ev(`[...${R}.querySelectorAll('.agent-md')].find((m) => m.textContent.includes(${JSON.stringify(text)}))?.scrollIntoView({ block: "start" })`);
                await h.shot(`cdp-shots/transcript-census-markdown-${name}-${part}.png`);
            }
            if (m == null) {
                steps.push({ step: `${name}: the transcript mounted`, ok: false, detail: "no fixture root" });
                continue;
            }
            steps.push(...hostSteps(name, m));
        }
        return steps;
    },
    teardown(h) {
        return clearTranscript(h);
    },
};
