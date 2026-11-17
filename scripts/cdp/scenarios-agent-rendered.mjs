// Agent review scenario `agent-rendered`: the Agent surface center's Rendered mode. The roster is a fixture of four
// claude agents backed by real tabs: A (no controller, so keys sent to it fail) with a transcript of a prompt, prose,
// a go test run, a git diff, an image Read and five chart blocks; P, whose block runs the key probe
// (fixtures/keyprobe.mjs), so the keys typed into its pty are read back from a file; E with an empty transcript; N
// with none; L with a transcript longer than the live stream's tail. Statuses, permission requests and an ask are raised over rpc as the hooks would. Transcripts and the
// probe's file live in a temp dir; teardown publishes a Stop for every fixture block, clears the ask, restores the
// roster, closes the tabs and removes the dir. The last turn appended to A has a thinking-only message and a reply naming
// a real file under the temp dir, by a path long enough to ellipsize.

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    agentPage,
    assistantBlock,
    bashInput,
    bashOutput,
    assistantText,
    closeTabs,
    focusAgent,
    makeTab,
    pinDefaultView,
    restoreDefaultView,
    restoreRoster,
    setRoster,
    toolResult,
    toolUse,
    userText,
    writeTranscript,
} from "./agent-page-fixtures.mjs";
import { polishWaitFor } from "./scenarios-shared.mjs";

const NAME = "agent-rendered";
const KEYPROBE = fileURLToPath(new URL("./fixtures/keyprobe.mjs", import.meta.url));
const MODEL_ID = "claude-opus-5-5";
const WAIT_MS = 10_000;
const PROBE_BOOT_MS = 20_000;
const PROBE_SETTLE_MS = 1_000;
const PROBE_WAIT_MS = 5_000;
// a status that must not unflip the view is given this long to do it anyway
const HOLD_MS = 800;
// a turn fold's reveal settles before a step reads what it opened
const FOLD_MOTION_MS = 600;
// the scroll area's px-6 on each side, the column's measure, and the slack a rounded layout box gets
const SCROLL_PAD_PX = 48;
const COLUMN_MAX_PX = 736;
const FIT_PX = 2;
// a card in an opened step sits inside the step box's padding, so it starts and ends this close to the column's edges
const STEP_INSET_PX = 32;
// a center about 900px wide, and a wide one; the step then puts back the viewport it found
const NARROW_VIEW = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
const WIDE_VIEW = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
// the empty box: the placeholder line over its control row, about 92px
const COMPOSER_IDLE_MIN_PX = 80;
const COMPOSER_IDLE_MAX_PX = 110;
// what the fixture agents report: the box's context ring reads it
const USAGE = { contextpct: 6, contextmax: 1_000_000 };
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;

// keys as the probe logs them: one hex chunk per line
const SHIFT_TAB = "1b5b5a";
const ESC = "1b";
const CTRL_C = "03";
// past bindings.ts DOUBLE_CTRL_C_MS (500), so two presses this far apart are two first presses
const CTRL_C_PAIR_GAP_MS = 700;

const PROMPT = "Run the jarvis tests, show me the diff, and chart the timings.";
const PROSE_BOLD = "the plan";
const PROSE = `Here is **${PROSE_BOLD}**: run the tests first, then read the diff before charting.`;
const TEST_REPLY = "One test fails in pkg/jarvis. Here is the diff and the screenshot.";
const P_PROMPT ="Tidy pkg/a.go.";
const P_REPLY = "Tidying pkg/a.go now.";

// the turn the working-line steps append to A: a Read with its result, then a Bash still running. No description, so
// the Bash's row shows its command
const NOW_PROMPT = "Now make the jarvis tests pass.";
const NOW_CMD = "go test ./pkg/jarvis/...";
const NOW_REPLY = "The jarvis tests pass now.";
const NOW_TURN_MS = 3 * 60_000;
const NOW_CALL_MS = 42_000;
const NOW_END_MS = 5_000;
// the line draws the verb alone; the glyph is the line's own, cycling
const SPINNER_VERB = "Undulating…";
const SPINNER_DETAIL = "(3m 10s · ↓ 4.5k tokens · thinking with high effort)";
const SPINNER_TOKENS = "↓ 4.5k tokens";
const iso = (ms) => new Date(ms).toISOString();

// the turn the thought and file-link steps append to A: a thinking-only message before its Bash, then a message whose
// thinking is hidden by its reply, which names a file under the temp dir in a code span
const THINK_PROMPT = "Where does the fix go?";
const THOUGHT = "Listing the package before I name the file.";
const HIDDEN_THOUGHT = "This reasoning has a reply, so it stays hidden.";
const THINK_STEP = "list the package";
// folders long enough that the path overflows the column
const PEEK_DIRS = ["a-rather-long-folder-name-so-the-path-overflows-the-column", "and-one-more-nested-segment-for-good-measure"];
const PEEK_FILE = "peek-target.go";
const PEEK_LINE = 2;
// two `!` runs appended to A: one finished with both streams, one still running
const SHELL_DONE = "git status --short";
const SHELL_STDOUT = "M pkg/a.go";
const SHELL_STDERR = "warning: CRLF will be replaced";
const SHELL_RUNNING = "sleep 30";
// a third run, appended after those, whose output passes the card's 8-line clamp
const SHELL_LONG = "seq 12";
const SHELL_LONG_OUT = Array.from({ length: 12 }, (_, i) => String(i + 1));
const SHELL_CLAMP = 8;
// a reply holding a markdown table whose last column is a long sentence, appended to A: its cells must wrap
const TABLE_PROMPT = "List the renderer's panels.";
// a reply of one path per line, then a code block: markdown would join the lines, the terminal shows one per line
const BREAK_PROMPT = "List the files, one per line.";
const BREAK_LINES = ["first.txt", "second.txt", "third.txt"];
const BREAK_CODE = ["x = 1", "y = 2"];
const TABLE_HEAD = ["Panel", "Owner", "Description"];
const TABLE_DESC =
    "Draws every turn of the transcript as a column of rows and cards, keeps the tail pinned while the agent works, folds finished turns under a Worked line, and shows a long reply in full without letting the table spill past the edge of the reading column.";
const TABLE_ROWS = [
    ["Timeline", "Narration", TABLE_DESC],
    ["Composer", "Box", "Sends the prompt."],
];
// the folder the @ mention step points P's cwd at, under the temp dir, and the files in it
const MENTION_DIR = "mention";
const MENTION_FILES = ["src/widget-alpha.ts", "README.md", "notes.txt"];
const MENTION_PICK = "src/widget-alpha.ts";
// the live command list the slash step publishes for P's block, as the arc mod would: one per group, and the names
// `/co` matches (prefix: compact, config, context; inside: recompile, superpowers:code-review)
const SLASH_LIVE = [
    { name: "clear", description: "Start a new session", source: "builtin" },
    { name: "compact", description: "Free up context by summarizing the conversation so far", source: "builtin" },
    { name: "config", description: "Open settings", source: "builtin" },
    { name: "context", description: "Show current context usage", source: "builtin" },
    { name: "recompile", description: "Rebuild the generated bindings", source: "user" },
    { name: "superpowers:code-review", description: "Review the branch", source: "plugin", plugin: "superpowers" },
    { name: "mcp__docs__search", description: "Search the docs", source: "mcp" },
];
const SLASH_GROUPS = ["Built-in", "Skills", "Plugins", "MCP"];
const SLASH_CO = ["compact", "config", "context", "recompile", "superpowers:code-review"];

// L's transcript: prose-only turns, two lines and two feed items each, so the 300-line tail leaves its first turns out
// and the whole file holds more items than the feed's cap (TIMELINE_RENDER_CAP)
const LONG_TURNS = 200;
const RENDER_CAP = 200;
const longPrompt = (i) => `Earlier prompt ${String(i).padStart(3, "0")}`;
const longReply = (i) => `Earlier reply ${String(i).padStart(3, "0")}`;
// how far the row at the top of the viewport may move when the earlier turns come in
const PLACE_PX = 4;

const J = (o) => JSON.stringify(o);
const GO_JSON = [
    J({ Action: "start", Package: "pkg/jarvis" }),
    J({ Action: "run", Package: "pkg/jarvis", Test: "TestPlanParse" }),
    J({ Action: "pass", Package: "pkg/jarvis", Test: "TestPlanParse", Elapsed: 0 }),
    J({ Action: "run", Package: "pkg/jarvis", Test: "TestPlanParseFencedBullet" }),
    J({
        Action: "output",
        Package: "pkg/jarvis",
        Test: "TestPlanParseFencedBullet",
        Output: "    plan_test.go:88: want 3 tasks, got 1\n",
    }),
    J({
        Action: "output",
        Package: "pkg/jarvis",
        Test: "TestPlanParseFencedBullet",
        Output: "--- FAIL: TestPlanParseFencedBullet (0.00s)\n",
    }),
    J({ Action: "fail", Package: "pkg/jarvis", Test: "TestPlanParseFencedBullet", Elapsed: 0 }),
    J({ Action: "run", Package: "pkg/jarvis", Test: "TestSlow" }),
    J({ Action: "skip", Package: "pkg/jarvis", Test: "TestSlow", Elapsed: 0 }),
    J({ Action: "fail", Package: "pkg/jarvis", Elapsed: 0.2 }),
].join("\n");
const FAILURE = { pkg: "pkg/jarvis", test: "TestPlanParseFencedBullet", message: "want 3 tasks, got 1", loc: "plan_test.go:88" };

// two files, +4 -1 in all
const DIFF = [
    "diff --git a/pkg/a.go b/pkg/a.go",
    "index 1111111..2222222 100644",
    "--- a/pkg/a.go",
    "+++ b/pkg/a.go",
    "@@ -1,3 +1,4 @@",
    " package a",
    "-var x = 1",
    "+var x = 2",
    "+var y = 3",
    "",
    "diff --git a/pkg/new.go b/pkg/new.go",
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    "+++ b/pkg/new.go",
    "@@ -0,0 +1,2 @@",
    "+package a",
    "+// new",
].join("\n");

// a 1x1 PNG
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const BAR_TITLE = "Test time by package";
const CHARTS = {
    bar: {
        type: "bar",
        title: BAR_TITLE,
        y: { label: "seconds", unit: "s" },
        series: [
            {
                name: "time",
                points: [
                    { x: "pkg/jarvis", y: 41 },
                    { x: "pkg/wstore", y: 12 },
                    { x: "pkg/agentask", y: 8 },
                    { x: "pkg/wshrpc", y: 5 },
                    { x: "cmd/wsh", y: 3 },
                ],
            },
        ],
    },
    line: {
        type: "line",
        title: "Run wall clock",
        x: { label: "run" },
        y: { label: "minutes" },
        series: [{ name: "wall", points: [1, 2, 3, 4].map((x, i) => ({ x, y: [30, 27, 25, 22][i] })) }],
    },
    area: {
        type: "area",
        title: "Tokens per turn",
        x: { label: "turn" },
        y: { label: "tokens" },
        series: [{ name: "tokens", points: [1, 2, 3, 4].map((x, i) => ({ x, y: [1200, 3400, 2100, 4800][i] })) }],
    },
    scatter: {
        type: "scatter",
        title: "Cost vs duration",
        x: { label: "minutes" },
        y: { label: "dollars", unit: "$" },
        series: [{ name: "runs", points: [[12, 1.2], [30, 2.9], [45, 4.1], [21, 1.7]].map(([x, y]) => ({ x, y })) }],
    },
};
const BAR_MARKS = CHARTS.bar.series[0].points.length;
const MALFORMED = `{"type": "pie", "title": "not a chart"}`;
const fence = (body) => "```chart\n" + body + "\n```";
const CHART_TEXT = [
    "The timings, charted:",
    ...Object.values(CHARTS).map((c) => fence(JSON.stringify(c, null, 2))),
    "And one that cannot draw:",
    fence(MALFORMED),
].join("\n\n");

const EDIT_INPUT = { file_path: "pkg/a.go", old_string: "var x = 1", new_string: "var x = 2" };
const EDIT_CHOICES = ["Yes", "Yes, allow edits this session", "No, tell Claude what to do"];
const PLAN_HEADING = "Ship the rendered view";
const PLAN_INPUT = { plan: `## ${PLAN_HEADING}\n\n- write the scenario\n- run Final on it` };
const PLAN_CHOICES = ["Yes, and use auto mode", "Yes, manually approve edits", "No, keep planning"];
const MODEL_LABEL = "Opus 5.5";
const MODEL_ALIASES = ["default", "opus", "sonnet", "haiku"];
const ASK_QUESTION = { header: "Scope", question: "Which scope should the fix cover?", options: [{ label: "this file" }, { label: "the package" }] };
// the MultiQuestion board: a single-select question, then a multi-select one
const MULTI_QUESTIONS = [
    { header: "Backoff", question: "Which backoff should retry use?", options: [{ label: "Linear" }, { label: "Exponential" }] },
    {
        header: "Tests",
        question: "Which cases should the new tests cover?",
        multiSelect: true,
        options: [
            { label: "First retry waits", description: "The first retry waits delayMs, never 0 ms." },
            { label: "Gives up after the last try", description: "retry() rethrows the last error once times is reached." },
            { label: "Total time", description: "Three calls take at least 300 ms." },
        ],
    },
];

// every query is scoped to the Agent surface
const SURF = `document.querySelector("[data-cockpit-surface-wrap]")`;
const RV = `${SURF}?.querySelector("[data-rendered-view]")`;
const flatJs = `const flat = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();`;

// which view the center shows for an agent
const viewOf = (id) => `(() => {
    const s = ${SURF};
    const term = s?.querySelector('[data-agent-terminal="${id}"]');
    return {
        rendered: s?.querySelector("[data-rendered-view]") != null,
        termInDom: term != null,
        // under Rendered the terminal stays laid out but invisible, so its controller starts
        termShown: term != null && term.checkVisibility({ visibilityProperty: true }),
        termLaidOut: term != null && term.clientWidth > 0,
    };
})()`;

// the header's one view button flips Terminal / Rendered, so it is clicked only when the agent is not in `label` yet
const clickToggle = (h, label) =>
    h.ev(`(() => {
        const b = ${SURF}?.querySelector("button[data-view-toggle]");
        if (!b) return false;
        if ((b.getAttribute("aria-pressed") === "true") !== (${JSON.stringify(label)} === "Rendered")) b.click();
        return true;
    })()`);

// a key pressed with focus on the surface wrapper, outside every editable field, as agent-keys presses them
const pressOnSurface = (h, key) =>
    agentPage(
        h,
        `const wrap = ${SURF};
        wrap.focus();
        wrap.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
        await nap(150);
        return document.activeElement === wrap || wrap.contains(document.activeElement);`
    );

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const probeLines = (ctx) => (existsSync(ctx.probe) ? readFileSync(ctx.probe, "utf8").split("\n").filter(Boolean) : []);

const hasRun = (lines, want) => lines.some((_, i) => want.every((w, j) => lines[i + j] === w));

// waits for the probe to log the keys in want, in order and back to back, after its first `from` lines
async function waitProbe(ctx, from, want) {
    const end = Date.now() + PROBE_WAIT_MS;
    let lines = probeLines(ctx).slice(from);
    while (!hasRun(lines, want) && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 100));
        lines = probeLines(ctx).slice(from);
    }
    return { ok: hasRun(lines, want), lines };
}

// waits for the probe's input after its first `from` lines, decoded as text, to contain every string in want
async function waitDecoded(ctx, from, want) {
    const decode = () => Buffer.from(probeLines(ctx).slice(from).join(""), "hex").toString("utf8");
    const end = Date.now() + PROBE_WAIT_MS;
    let text = decode();
    while (!want.every((w) => text.includes(w)) && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 100));
        text = decode();
    }
    return { ok: want.every((w) => text.includes(w)), text };
}

const STEER_PLACEHOLDER = "Steer the agent; it reads this before its next step";
const STEER_TEXT = "Only touch pkg/a.go.";
// the key-hint footer the box used to have
const COMPOSER_HINTS = ["/ commands", "⇧ ↵ new line", "pickers open the terminal"];
// a pasted file whose save the Composing step refuses
const FAILED_ATTACH = "rendered-trace.png";
const COMPOSER_CHIPS = `[...(${RV}?.querySelectorAll("[data-rendered-composer] [data-attachment-chip]") ?? [])]`;

// sets the Rendered composer's text as typing would
const typeComposer = (h, text) =>
    h.ev(`(() => {
        const ta = ${RV}?.querySelector("[data-rendered-composer] textarea");
        if (!ta) return false;
        ta.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, ${JSON.stringify(text)});
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
    })()`);

// a synthetic paste of one PNG on the Rendered composer, as new-run-attachments pastes on the goal; returns whether
// the composer took it over
const pasteOnComposer = (name) => `(() => {
    const ta = ${RV}?.querySelector("[data-rendered-composer] textarea");
    if (!ta) return null;
    ta.focus();
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(${JSON.stringify(PNG_1X1)}), (c) => c.charCodeAt(0))], ${JSON.stringify(name)}, { type: "image/png" }));
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    return ev.defaultPrevented;
})()`;

// an agent:status as the hook publishes it: a state (the frontend ignores a state-less one) and a ts later than every
// earlier one, or the server drops it as stale
async function publishStatus(h, ctx, blockId, fields) {
    const ts = Math.max(Date.now(), (ctx.lastTs ?? 0) + 1);
    ctx.lastTs = ts;
    const oref = `block:${blockId}`;
    await h.rpc("eventpublish", {
        event: "agent:status",
        scopes: [oref],
        data: { oref, agent: "claude", ts, ...fields },
    });
    return ts;
}

const raisePermission = (h, blockId, toolname, input, toolkey, hassuggestions) =>
    h.rpc("agentpermission", {
        oref: `block:${blockId}`,
        toolname,
        toolinput: JSON.stringify(input),
        toolkey,
        hassuggestions,
    });

// the labels of the context menu a box control opens, and the menu's items for a click
const headerMenu = (h, attr, pick) =>
    agentPage(
        h,
        `const { contextMenuAtom, closeContextMenu } = await mod("app/store/contextmenu.ts");
        const btn = ${SURF}?.querySelector("[${attr}]");
        if (btn == null) return { error: "no [${attr}]" };
        btn.click();
        await until(() => globalStore.get(contextMenuAtom) != null, 2000);
        const items = globalStore.get(contextMenuAtom)?.items ?? [];
        const labels = items.map((i) => i.label).filter(Boolean);
        const hit = ${JSON.stringify(pick ?? null)} == null ? null : items.find((i) => i.label === ${JSON.stringify(pick ?? "")});
        closeContextMenu();
        hit?.click?.();
        return { labels, picked: hit != null };`
    );

const rosterAgent = (id, blockId, name, transcriptPath) => ({
    id,
    name,
    project: "fx-rendered",
    task: "rendered fixture",
    state: "idle",
    agent: "claude",
    model: MODEL_ID,
    usage: USAGE,
    blockId,
    ...(transcriptPath ? { transcriptPath } : {}),
});

export default function (_kit) {
    return [
        {
            name: NAME,
            surface: "agent",
            async arrange(h) {
                const tag = Date.now().toString(36);
                const ctx = { tabIds: [], tempFiles: [], dir: mkdtempSync(join(tmpdir(), "verify-agent-rendered-")) };
                // a throw past this point still returns ctx, so teardown removes whatever was already made
                try {
                    // the shipped default, whatever this dev app's Settings hold
                    await pinDefaultView(h, "rendered");
                    ctx.probe = join(ctx.dir, "keyprobe.log");
                    const aPath = writeTranscript(ctx.dir, `rendered-a-${tag}`, [
                        userText(PROMPT),
                        assistantText(PROSE),
                        toolUse("toolu_test", "Bash", { command: "go test -json ./pkg/jarvis/...", description: "run the tests" }),
                        toolResult("toolu_test", GO_JSON),
                        toolUse("toolu_diff", "Bash", { command: "git diff", description: "show the diff" }),
                        toolResult("toolu_diff", DIFF),
                        toolUse("toolu_img", "Read", { file_path: "C:/fx/shot.png" }),
                        toolResult("toolu_img", [
                            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1X1 } },
                        ]),
                        assistantText(TEST_REPLY),
                        assistantText(CHART_TEXT),
                    ]);
                    const pPath = writeTranscript(ctx.dir, `rendered-p-${tag}`, [userText(P_PROMPT), assistantText(P_REPLY)]);
                    const ePath = join(ctx.dir, `rendered-e-${tag}.jsonl`);
                    writeFileSync(ePath, "");
                    const lPath = writeTranscript(
                        ctx.dir,
                        `rendered-l-${tag}`,
                        Array.from({ length: LONG_TURNS }, (_, i) => [userText(longPrompt(i)), assistantText(longReply(i))]).flat()
                    );

                    await h.goto("agent");
                    // a new tab's block comes with a shell controller and setmeta merges, so A drops it by name: with no
                    // controller every key sent to A fails
                    const a = await makeTab(h, ctx, { label: `rendered-a-${tag}`, blockMeta: { view: "term", controller: null } });
                    // the cwd is ~, not the temp dir, which the probe would keep locked past teardown. An agent
                    // session's block is deleted 2s after its process exits unless it keeps on exit
                    const p = await makeTab(h, ctx, {
                        label: `rendered-p-${tag}`,
                        blockMeta: {
                            view: "term",
                            controller: "cmd",
                            cmd: `node '${KEYPROBE}' '${ctx.probe}'`,
                            "cmd:cwd": "~",
                            "cmd:keeponexit": true,
                        },
                    });
                    const e = await makeTab(h, ctx, { label: `rendered-e-${tag}` });
                    const n = await makeTab(h, ctx, { label: `rendered-n-${tag}` });
                    const l = await makeTab(h, ctx, { label: `rendered-l-${tag}`, blockMeta: { view: "term", controller: null } });
                    Object.assign(ctx, {
                        aPath,
                        aId: a.tabId,
                        aBlock: a.blockId,
                        pId: p.tabId,
                        pBlock: p.blockId,
                        eId: e.tabId,
                        nId: n.tabId,
                        lId: l.tabId,
                        blocks: [a.blockId, p.blockId, e.blockId, n.blockId, l.blockId],
                    });
                    // the meta change can start a probe that ends at once; the file the restarted one writes is the proof
                    // a live probe is reading
                    await new Promise((r) => setTimeout(r, PROBE_SETTLE_MS));
                    rmSync(ctx.probe, { force: true });
                    await h.rpc("controllerresync", { tabid: p.tabId, blockid: p.blockId, forcerestart: true });
                    for (const end = Date.now() + PROBE_BOOT_MS; !existsSync(ctx.probe) && Date.now() < end; ) {
                        await new Promise((r) => setTimeout(r, 200));
                    }
                    if (!existsSync(ctx.probe)) throw new Error(`the key probe never started (no ${ctx.probe})`);

                    ctx.roster = [
                        rosterAgent(a.tabId, a.blockId, `rendered-a-${tag}`, aPath),
                        rosterAgent(p.tabId, p.blockId, `rendered-p-${tag}`, pPath),
                        rosterAgent(e.tabId, e.blockId, `rendered-e-${tag}`, ePath),
                        rosterAgent(n.tabId, n.blockId, `rendered-n-${tag}`, null),
                        rosterAgent(l.tabId, l.blockId, `rendered-l-${tag}`, lPath),
                    ];
                    await setRoster(h, ctx.roster);
                    // the header reads the model off the status, as the hook reports it; no hook, so it retires nothing
                    for (const blockId of [a.blockId, p.blockId]) {
                        await publishStatus(h, ctx, blockId, { state: "idle", model: MODEL_ID });
                    }
                    await focusAgent(h, ctx.aId);
                    if (!(await polishWaitFor(h, `${SURF}?.querySelector("[data-view-toggle]") != null`, WAIT_MS))) {
                        throw new Error("the view toggle never showed for agent A");
                    }
                } catch (err) {
                    ctx.arrangeError = String(err?.message ?? err);
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
                // one throwing step is one FAIL, not the end of the run
                const step = async (name, fn) => {
                    try {
                        const [ok, detail] = await fn();
                        rec(name, ok, typeof detail === "string" ? detail : JSON.stringify(detail));
                    } catch (err) {
                        rec(name, false, `threw: ${err?.message ?? err}`);
                    }
                };
                const wait = (expr, ms = WAIT_MS) => polishWaitFor(h, expr, ms);
                const focus = async (id) => {
                    await focusAgent(h, id);
                    await wait(`${viewOf(id)}.termInDom`);
                };
                const ensureRendered = async () => {
                    if (!(await h.ev(`${viewOf(ctx.aId)}.rendered`))) await clickToggle(h, "Rendered");
                    return wait(`${RV} != null`);
                };
                const aOref = `block:${ctx.aBlock}`;
                // the view sticks to the latest entry, so a card is scrolled in before its shot
                const showCard = (sel) => agentPage(h, `${RV}?.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: "center" }); await nap(200); return true;`);
                // a finished turn starts folded, its cards inside, and a remount (focusing another agent) folds it again
                const openTurnFolds = () =>
                    agentPage(h, `${RV}?.querySelectorAll('[data-fold][aria-expanded="false"]').forEach((b) => b.click()); await nap(${FOLD_MOTION_MS}); return true;`);

                // a page without OS focus fires no focus events and keeps no activeElement change visible
                await h.cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
                ctx.focusEmulated = true;

                await step("rendered: toggle — A opens Rendered by default with its terminal laid out and invisible; Terminal shows the terminal, Rendered brings the view back", async () => {
                    await wait(`${RV} != null`);
                    const opened = await h.ev(viewOf(ctx.aId));
                    const toTerm = await clickToggle(h, "Terminal");
                    await wait(`${RV} == null`);
                    const term = await h.ev(viewOf(ctx.aId));
                    const toRendered = await clickToggle(h, "Rendered");
                    await wait(`${RV} != null`);
                    const after = await h.ev(viewOf(ctx.aId));
                    await h.shot(SHOT(1, "toggle"));
                    return [
                        opened.rendered &&
                            opened.termLaidOut &&
                            !opened.termShown &&
                            toTerm &&
                            !term.rendered &&
                            term.termShown &&
                            toRendered &&
                            after.rendered &&
                            after.termInDom &&
                            !after.termShown,
                        { opened, term, after },
                    ];
                });

                await step("rendered: timeline fills — at narrow and wide widths the column spans the scroll area up to its measure, prose keeps its reading measure, the diff card fills its opened step", async () => {
                    await wait(`(${RV}?.textContent ?? "").includes(${JSON.stringify(PROMPT)})`);
                    await openTurnFolds();
                    await wait(`(${RV}?.textContent ?? "").includes(${JSON.stringify(PROMPT)}) && ${RV}?.querySelector('[data-tool-card="git-diff"]') != null`);
                    const measure = `(() => {
                        ${flatJs}
                        const rv = ${RV};
                        const scroll = rv?.querySelector("[data-rendered-scroll]");
                        const col = rv?.querySelector("[data-rendered-column]");
                        const box = (el) => el.getBoundingClientRect();
                        const you = [...(rv?.querySelectorAll("[data-find-turn]") ?? [])].find((p) => flat(p) === ${JSON.stringify(PROMPT)});
                        const strong = [...(rv?.querySelectorAll("strong") ?? [])].find((s) => flat(s) === ${JSON.stringify(PROSE_BOLD)});
                        const para = strong?.closest("p");
                        const diff = rv?.querySelector('[data-tool-card="git-diff"]');
                        if (!scroll || !col || !para || !diff) return { scroll: !!scroll, col: !!col, para: !!para, diff: !!diff };
                        return {
                            window: window.innerWidth,
                            you: you != null && col.contains(you) && you.closest("[data-user-bubble]") != null,
                            // clientWidth holds the padding and not the scrollbar
                            inner: scroll.clientWidth - ${SCROLL_PAD_PX},
                            column: box(col).width,
                            para: box(para).width,
                            paraMax: getComputedStyle(para).maxWidth,
                            diff: box(diff).width,
                            diffLeftInset: box(diff).left - box(col).left,
                            diffRightInset: box(col).right - box(diff).right,
                        };
                    })()`;
                    const fits = (m) =>
                        m.you &&
                        Math.abs(m.column - Math.min(m.inner, COLUMN_MAX_PX)) <= FIT_PX &&
                        m.paraMax !== "none" &&
                        m.para <= parseFloat(m.paraMax) + 0.5 &&
                        m.diffLeftInset >= 0 &&
                        m.diffLeftInset <= STEP_INSET_PX &&
                        m.diffRightInset >= 0 &&
                        m.diffRightInset <= STEP_INSET_PX;
                    const at = async (view, what) => {
                        await h.cdp("Emulation.setDeviceMetricsOverride", view);
                        await wait(`window.innerWidth === ${view.width}`);
                        await agentPage(h, `await nap(300); return true;`);
                        await showCard(`[data-tool-card="git-diff"]`);
                        await h.shot(SHOT(2, `timeline-${what}`));
                        return h.ev(measure);
                    };
                    const found = await h.ev(`({ width: innerWidth, height: innerHeight })`);
                    let narrow, wide;
                    try {
                        narrow = await at(NARROW_VIEW, "narrow");
                        wide = await at(WIDE_VIEW, "wide");
                    } finally {
                        await h.cdp("Emulation.setDeviceMetricsOverride", { ...WIDE_VIEW, ...found });
                        await wait(`window.innerWidth === ${found.width}`);
                    }
                    return [fits(narrow) && fits(wide) && wide.diff > wide.para, { narrow, wide }];
                });

                await step("rendered: idle tail — A idle after its turn: no working line, and the column's last item ends above the box, which sits under the scroll area", async () => {
                    await agentPage(h, `const s = ${RV}?.querySelector("[data-rendered-scroll]"); if (s) s.scrollTop = s.scrollHeight; await nap(300); return true;`);
                    const seen = await h.ev(`(() => {
                        const rv = ${RV};
                        const scroll = rv?.querySelector("[data-rendered-scroll]");
                        const comp = rv?.querySelector("[data-rendered-composer]");
                        const last = rv?.querySelector("[data-rendered-feed]")?.firstElementChild?.lastElementChild;
                        if (!scroll || !comp || !last) return { scroll: !!scroll, composer: !!comp, last: !!last };
                        return {
                            working: rv.querySelector("[data-working-line]") != null,
                            scrollBottom: scroll.getBoundingClientRect().bottom,
                            composerTop: comp.getBoundingClientRect().top,
                            lastBottom: last.getBoundingClientRect().bottom,
                        };
                    })()`);
                    await h.shot(SHOT(2, "idle-tail"));
                    const ok = seen.working === false && seen.scrollBottom <= seen.composerTop + 0.5 && seen.lastBottom <= seen.scrollBottom + 0.5;
                    return [ok, seen];
                });

                await step("rendered: empty states — E shows the skeleton, N shows the no-transcript line", async () => {
                    await focus(ctx.eId);
                    await clickToggle(h, "Rendered");
                    const skeleton = await wait(`${RV}?.querySelector('[data-rendered-empty="skeleton"]') != null`);
                    await h.shot(SHOT(3, "empty-skeleton"));
                    await focus(ctx.nId);
                    await clickToggle(h, "Rendered");
                    await wait(`${RV}?.querySelector('[data-rendered-empty="no-transcript"]') != null`);
                    const none = await h.ev(`(${RV}?.querySelector('[data-rendered-empty="no-transcript"]')?.textContent ?? "").trim()`);
                    await h.shot(SHOT(3, "empty-no-transcript"));
                    return [skeleton && none === "No transcript for this session yet.", { skeleton, none }];
                });

                await focus(ctx.aId);
                await step("rendered: test card — counts read pass / fail / skip, one failure row, and raw shows the output", async () => {
                    await wait(`${RV}?.querySelector("[data-fold]") != null`);
                    await openTurnFolds();
                    await wait(`${RV}?.querySelector('[data-tool-card="test"]') != null`);
                    const card = await h.ev(`(() => {
                        ${flatJs}
                        const c = ${RV}?.querySelector('[data-tool-card="test"]');
                        const rows = [...(c?.querySelectorAll("[data-test-failure]") ?? [])].map(flat);
                        return { counts: flat(c?.querySelector("[data-test-counts]")), rows };
                    })()`);
                    await showCard(`[data-tool-card="test"]`);
                    await h.shot(SHOT(4, "test-card"));
                    const raw = await agentPage(
                        h,
                        `const c = ${RV}?.querySelector('[data-tool-card="test"]');
                        c?.querySelector("[data-raw-toggle]")?.click();
                        await nap(200);
                        const pre = c?.querySelector("pre")?.textContent ?? "";
                        const pressed = c?.querySelector("[data-raw-toggle]")?.getAttribute("aria-pressed");
                        return { pressed, hasOutput: pre.includes('"Action":"fail"') && pre.includes("plan_test.go:88") };`
                    );
                    await h.shot(SHOT(4, "test-card-raw"));
                    await h.ev(`${RV}?.querySelector('[data-tool-card="test"] [data-raw-toggle]')?.click()`);
                    const row = card.rows[0] ?? "";
                    const ok =
                        ["1 pass", "1 fail", "1 skip"].every((c) => card.counts.includes(c)) &&
                        card.rows.length === 1 &&
                        row.startsWith("FAIL") &&
                        // the row names the test, a short file:line under the package's last segment, then the message
                        [FAILURE.test, `${FAILURE.pkg.split("/").pop()}/${FAILURE.loc}`, FAILURE.message].every((t) =>
                            row.includes(t)
                        ) &&
                        raw.pressed === "true" &&
                        raw.hasOutput;
                    return [ok, { ...card, raw }];
                });

                await step("rendered: diff card — file headers with +/- counts and the diff lines", async () => {
                    await wait(`${RV}?.querySelector('[data-tool-card="git-diff"]') != null`);
                    const text = await h.ev(`(${RV}?.querySelector('[data-tool-card="git-diff"]')?.textContent ?? "")`);
                    await showCard(`[data-tool-card="git-diff"]`);
                    await h.shot(SHOT(5, "diff-card"));
                    const want = ["2 files", "+4", "\u22121", "pkg/a.go", "pkg/new.go", "var x = 2", "var y = 3"];
                    return [want.every((t) => text.includes(t)), { missing: want.filter((t) => !text.includes(t)), text: text.slice(0, 400) }];
                });

                await step("rendered: image — the image card's img has decoded (naturalWidth > 0)", async () => {
                    const loaded = await wait(`(${RV}?.querySelector('[data-tool-card="image"] img')?.naturalWidth ?? 0) > 0`);
                    const width = await h.ev(`${RV}?.querySelector('[data-tool-card="image"] img')?.naturalWidth ?? null`);
                    await showCard(`[data-tool-card="image"]`);
                    await h.shot(SHOT(6, "image"));
                    return [loaded, { naturalWidth: width }];
                });

                await step("rendered: cards in a turn — A's finished turn, its fold opened, shows every tool output card", async () => {
                    const state = await h.ev(`(() => {
                        const rv = ${RV};
                        const shown = (sel) => {
                            const el = rv?.querySelector(sel);
                            return !!el && el.checkVisibility() && el.getBoundingClientRect().height > 0;
                        };
                        return {
                            folds: rv?.querySelectorAll('[data-fold][aria-expanded="false"]').length ?? -1,
                            test: shown('[data-tool-card="test"]'),
                            diff: shown('[data-tool-card="git-diff"]'),
                            image: shown('[data-tool-card="image"]'),
                        };
                    })()`);
                    await showCard(`[data-tool-card="git-diff"]`);
                    await h.shot(SHOT(6, "cards-in-burst"));
                    return [state.folds === 0 && state.test && state.diff && state.image, state];
                });

                // a finished turn starts folded even when it holds tool output cards: a click on its Worked line opens it to
                // the cards, a second click folds it again
                await step("rendered: turn header — the card turn mounts folded with its cards hidden; a click on its Worked line opens it, a second folds it", async () => {
                    const BURST = `${RV}?.querySelector("[data-fold]")`;
                    const read = `(() => {
                        const b = ${BURST};
                        const card = ${RV}?.querySelector('[data-tool-card="git-diff"]');
                        return { expanded: b?.getAttribute("aria-expanded") ?? null, card: !!card && card.checkVisibility() };
                    })()`;
                    // focusing another agent and back remounts A's view, so its folds start as a fresh mount draws them
                    await focus(ctx.eId);
                    await focus(ctx.aId);
                    await wait(`${BURST} != null`);
                    const before = await h.ev(read);
                    await h.shot(SHOT(6, "burst-folded"));
                    await h.ev(`${BURST}?.click()`);
                    await wait(`${BURST}?.getAttribute("aria-expanded") === "true" && ${read}.card`);
                    const opened = await h.ev(read);
                    await h.ev(`${BURST}?.click()`);
                    // the fold collapses its body with an exit, so the card leaves after the line flips
                    await wait(`${BURST}?.getAttribute("aria-expanded") === "false" && !${read}.card`);
                    const refolded = await h.ev(read);
                    const ok =
                        before.expanded === "false" && !before.card &&
                        opened.expanded === "true" && opened.card &&
                        refolded.expanded === "false" && !refolded.card;
                    return [ok, { before, opened, refolded }];
                });

                const BAR = `${RV}?.querySelector('[data-chart-card][data-chart-type="bar"]')`;
                await step(`rendered: chart — the bar card draws ${BAR_MARKS} marks and its title; the spec toggle shows the raw block`, async () => {
                    await wait(`${BAR} != null`);
                    const bar = await h.ev(`(() => {
                        ${flatJs}
                        const c = ${BAR};
                        return { marks: c?.querySelectorAll("[data-chart-mark]").length ?? 0, title: flat(c).includes(${JSON.stringify(BAR_TITLE)}) };
                    })()`);
                    await showCard(`[data-chart-card][data-chart-type="bar"]`);
                    await h.shot(SHOT(7, "chart-bar"));
                    const spec = await agentPage(
                        h,
                        `const c = ${BAR};
                        c?.querySelector("[data-chart-spec-toggle]")?.click();
                        await nap(200);
                        const text = c?.textContent ?? "";
                        return { raw: text.includes('"type"') && text.includes('"pkg/jarvis"'), marks: c?.querySelectorAll("[data-chart-mark]").length ?? 0 };`
                    );
                    await h.shot(SHOT(7, "chart-spec"));
                    await h.ev(`${BAR}?.querySelector("[data-chart-spec-toggle]")?.click()`);
                    return [bar.marks === BAR_MARKS && bar.title && spec.raw && spec.marks === 0, { bar, spec }];
                });

                await step("rendered: chart types — line, area and scatter draw marks and axes; the malformed block falls back with its reason", async () => {
                    const seen = await h.ev(`(() => {
                        const rv = ${RV};
                        const card = (t) => rv?.querySelector('[data-chart-card][data-chart-type="' + t + '"]');
                        const of = (t) => ({ marks: card(t)?.querySelectorAll("[data-chart-mark]").length ?? 0, axes: card(t)?.querySelectorAll(".visx-axis").length ?? 0 });
                        const fb = rv?.querySelector("[data-chart-fallback]");
                        return {
                            line: of("line"),
                            area: of("area"),
                            scatter: of("scatter"),
                            fallback: fb == null ? null : { text: (fb.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 200), card: fb.querySelector("[data-chart-card]") != null },
                        };
                    })()`);
                    await h.ev(`${RV}?.querySelector('[data-chart-card][data-chart-type="line"]')?.scrollIntoView({ block: "center" })`);
                    await h.shot(SHOT(8, "chart-types"));
                    await h.ev(`${RV}?.querySelector("[data-chart-fallback]")?.scrollIntoView({ block: "center" })`);
                    await h.shot(SHOT(8, "chart-fallback"));
                    const drawn = (c) => c.marks > 0 && c.axes >= 2;
                    const ok =
                        drawn(seen.line) &&
                        drawn(seen.area) &&
                        seen.scatter.marks === CHARTS.scatter.series[0].points.length &&
                        seen.scatter.axes >= 2 &&
                        seen.fallback != null &&
                        !seen.fallback.card &&
                        seen.fallback.text.includes("chart not drawn: ") &&
                        seen.fallback.text.includes("type must be one of");
                    return [ok, seen];
                });

                // raises an ask on A over rpc. The fixture roster stands in for the live one, so the ask the server
                // published is put on A the way the live roster does it (withAsk)
                const raiseAsk = async (questions) => {
                    const rtn = await h.rpc("ask", { oref: aOref, questions });
                    ctx.askRaised = true;
                    const askid = rtn?.askid ?? null;
                    return agentPage(
                        h,
                        `const { getAgentAskAtom } = await mod("app/view/agents/agentaskstore.ts");
                        const { withAsk } = await mod("app/view/agents/agentsviewmodel.ts");
                        const D = await mod("app/view/agents/devmock.ts");
                        const askAtom = getAgentAskAtom(${JSON.stringify(aOref)});
                        const want = ${JSON.stringify(askid)};
                        const raised = () => { const a = globalStore.get(askAtom); return a != null && !a.cleared && (want == null || a.askid === want); };
                        if (!(await until(raised, 5000))) return false;
                        const ask = globalStore.get(askAtom);
                        globalStore.set(D.devMockAgentsAtom, globalStore.get(D.devMockAgentsAtom).map((a) =>
                            a.id === ${JSON.stringify(ctx.aId)} ? withAsk(a, ask, Date.now()) : a));
                        return true;`
                    );
                };
                const ASK = `${RV}?.querySelector("[data-rendered-ask]")`;
                await step("rendered: Asking — the card sits in the column under Needs your input; 2 answers it; Send is disabled with the notice", async () => {
                    const patched = await raiseAsk([ASK_QUESTION]);
                    await wait(`${ASK} != null`);
                    const card = await h.ev(`(() => {
                        ${flatJs}
                        const rv = ${RV};
                        const ask = rv?.querySelector("[data-rendered-ask]");
                        const col = rv?.querySelector("[data-rendered-column]");
                        if (!ask || !col) return { ask: !!ask, col: !!col };
                        const prev = ask.previousElementSibling;
                        return {
                            inColumn: ask.parentElement === col,
                            label: flat(ask.firstElementChild),
                            question: flat(ask).includes(${JSON.stringify(ASK_QUESTION.question)}),
                            numbers: [...ask.querySelectorAll("[data-ask-option]")].map((o) => flat(o.firstElementChild)),
                            // after the timeline's last item
                            afterLast: prev != null && prev.getBoundingClientRect().bottom <= ask.getBoundingClientRect().top + 0.5,
                            working: rv.querySelector("[data-working-line]") != null,
                        };
                    })()`);
                    await typeComposer(h, "hold on");
                    await wait(`${RV}?.querySelector("[data-composer-send]") != null`);
                    const box = await h.ev(`(() => {
                        ${flatJs}
                        const comp = ${RV}?.querySelector("[data-rendered-composer]");
                        return { sendDisabled: comp?.querySelector("[data-composer-send]")?.disabled ?? null, notice: flat(comp?.querySelector("[data-composer-notice]")) };
                    })()`);
                    await showCard("[data-rendered-ask]");
                    await h.shot(SHOT(9, "asking"));
                    await typeComposer(h, "");
                    // the answer goes to the agent's pty, which A has none of, so the call is caught here
                    await agentPage(
                        h,
                        `const { RpcApi } = await mod("app/store/wshclientapi.ts");
                        window.__renderedAnswer = { orig: RpcApi.AnswerAgentCommand, calls: [] };
                        RpcApi.AnswerAgentCommand = async (_c, data) => { window.__renderedAnswer.calls.push(data); };
                        return true;`
                    );
                    let answered;
                    try {
                        await pressOnSurface(h, "2");
                        const picked = await wait(`${ASK}?.querySelector('[data-ask-option="1"][data-picked]') != null`, 2000);
                        await pressOnSurface(h, "Enter");
                        await wait(`(window.__renderedAnswer?.calls.length ?? 0) > 0`, 3000);
                        answered = await h.ev(`(() => {
                            ${flatJs}
                            return { picked: ${picked}, calls: window.__renderedAnswer?.calls ?? [], text: flat(${ASK}) };
                        })()`);
                    } finally {
                        await agentPage(
                            h,
                            `const { RpcApi } = await mod("app/store/wshclientapi.ts");
                            if (window.__renderedAnswer) RpcApi.AnswerAgentCommand = window.__renderedAnswer.orig;
                            delete window.__renderedAnswer;
                            return true;`
                        );
                    }
                    await h.shot(SHOT(9, "asking-answered"));
                    // a picked option goes out as its index
                    const sent = JSON.stringify(answered.calls[0]?.answers ?? null);
                    const ok =
                        patched &&
                        card.inColumn &&
                        card.label === "Needs your input" &&
                        card.question &&
                        JSON.stringify(card.numbers) === JSON.stringify(["1", "2"]) &&
                        card.afterLast &&
                        !card.working &&
                        box.sendDisabled === true &&
                        box.notice === "Answer Claude's question first" &&
                        answered.picked &&
                        answered.calls.length === 1 &&
                        sent === JSON.stringify([{ selectedindexes: [1] }]) &&
                        answered.text.includes("Answered");
                    return [ok, { patched, card, box, answered }];
                });

                // Claude Code raises a permission request for the question dialog too; put one in the page's queue (a
                // server-held one would outlive the step and turn the next Edit request into a queue of two)
                await step("rendered: ask permission — the ask card's own AskUserQuestion request draws no band, nor once the card closes before the request retires, and the rail does not send you to the terminal", async () => {
                    // the last step answered its ask, so a fresh one is raised
                    const raised = await raiseAsk([ASK_QUESTION]);
                    await wait(`${ASK} != null && !(${ASK}.textContent ?? "").includes("Answered")`);
                    const injected = raised && await agentPage(
                        h,
                        `const { getAgentPermissionsAtom } = await mod("app/view/agents/permissionstore.ts");
                        globalStore.set(getAgentPermissionsAtom(${JSON.stringify(aOref)}), [{
                            oref: ${JSON.stringify(aOref)}, permid: "fx-rendered-ask-perm", toolname: "AskUserQuestion",
                            toolinput: JSON.stringify({ questions: [${JSON.stringify(ASK_QUESTION)}] }),
                            choices: ["Yes", "No"], ts: Date.now(),
                        }]);
                        return true;`
                    );
                    // the hint is on the rail's panel, which starts closed in a fresh profile; the old value goes back
                    const railWas = await agentPage(
                        h,
                        `const { railVisibleAtom } = await mod("app/view/agents/railstore.ts");
                        const was = globalStore.get(railVisibleAtom);
                        globalStore.set(railVisibleAtom, true);
                        return was;`
                    );
                    let seen;
                    try {
                        await wait(`document.querySelector("[data-rail-hint]") != null`, 2000);
                        seen = await h.ev(`(() => {
                            const rv = ${RV};
                            return {
                                ask: rv?.querySelector("[data-rendered-ask]") != null,
                                band: rv?.querySelector("[data-permission-band], [data-permission-queue]") != null,
                                hint: (document.querySelector("[data-rail-hint]")?.textContent ?? "").trim(),
                            };
                        })()`);
                        await h.shot(SHOT(9, "ask-permission"));
                        // claude's `wsh ask --clear` closes the dock before the PostToolUse that retires the request lands
                        await h.rpc("agentaskclear", aOref);
                        await wait(`${RV}?.querySelector("[data-rendered-ask]") == null`, 2000);
                        seen.bandAfterClear = await h.ev(
                            `${RV}?.querySelector("[data-permission-band], [data-permission-queue]") != null`
                        );
                    } finally {
                        await agentPage(
                            h,
                            `const { removeAgentPermission } = await mod("app/view/agents/permissionstore.ts");
                            const { railVisibleAtom } = await mod("app/view/agents/railstore.ts");
                            removeAgentPermission(${JSON.stringify(aOref)}, "fx-rendered-ask-perm");
                            globalStore.set(railVisibleAtom, ${JSON.stringify(railWas === true)});
                            return true;`
                        );
                    }
                    return [injected && seen.ask && !seen.band && !seen.bandAfterClear && seen.hint === "waiting on you", seen];
                });

                await step("rendered: MultiQuestion — two tabs, the second multi-select with two picked, 1/2 answered", async () => {
                    const patched = await raiseAsk(MULTI_QUESTIONS);
                    await wait(`(${ASK}?.querySelectorAll('[role="tab"]').length ?? 0) === 2`);
                    await h.ev(`${ASK}?.querySelectorAll('[role="tab"]')[1]?.click()`);
                    await wait(`${ASK}?.querySelectorAll('[role="tab"]')[1]?.getAttribute("aria-selected") === "true"`);
                    for (const oi of [0, 1]) {
                        await h.ev(`${ASK}?.querySelector('[data-ask-option="${oi}"]')?.click()`);
                    }
                    await wait(`(${ASK}?.querySelectorAll('[role="checkbox"][aria-checked="true"]').length ?? 0) === 2`);
                    const seen = await h.ev(`(() => {
                        ${flatJs}
                        const ask = ${ASK};
                        return {
                            tabs: [...(ask?.querySelectorAll('[role="tab"]') ?? [])].map((t) => ({ label: flat(t), selected: t.getAttribute("aria-selected") })),
                            boxes: ask?.querySelectorAll('[role="checkbox"]').length ?? 0,
                            checked: ask?.querySelectorAll('[role="checkbox"][aria-checked="true"]').length ?? 0,
                            hint: flat(ask?.querySelector("[data-ask-hint]")),
                        };
                    })()`);
                    await showCard("[data-rendered-ask]");
                    await h.shot(SHOT(9, "multi-question"));
                    const ok =
                        patched &&
                        JSON.stringify(seen.tabs.map((t) => t.label)) === JSON.stringify(MULTI_QUESTIONS.map((q) => q.header)) &&
                        seen.tabs[1]?.selected === "true" &&
                        seen.boxes === MULTI_QUESTIONS[1].options.length &&
                        seen.checked === 2 &&
                        seen.hint.startsWith("1/2 answered");
                    return [ok, { patched, ...seen }];
                });
                // the ask is not under test past its step
                try {
                    await h.rpc("agentaskclear", aOref);
                    ctx.askRaised = false;
                    await setRoster(h, ctx.roster);
                } catch (err) {
                    console.error(`${NAME}: clearing the ask failed: ${err?.message ?? err}`);
                }

                const BAND = `${RV}?.querySelector("[data-permission-band]")`;
                await step("rendered: permission band — an Edit request on A docks the band above the composer with its title, diff and three numbered choices", async () => {
                    ctx.aPerm1 = await raisePermission(h, ctx.aBlock, "Edit", EDIT_INPUT, "fx-rendered-edit-a1", true);
                    await wait(`${BAND} != null`);
                    const band = await h.ev(`(() => {
                        ${flatJs}
                        const rv = ${RV};
                        const b = rv?.querySelector("[data-permission-band]");
                        const comp = rv?.querySelector("[data-rendered-composer]");
                        if (!b || !comp) return { band: !!b, composer: !!comp };
                        return {
                            band: true,
                            text: flat(b).slice(0, 300),
                            above: b.getBoundingClientRect().bottom <= comp.getBoundingClientRect().top + 1,
                            choices: [...b.querySelectorAll("[data-permission-choice]")].map(flat),
                            // the band holds the working line's slot
                            working: rv.querySelector("[data-working-line]") != null,
                        };
                    })()`);
                    await h.shot(SHOT(10, "permission-band"));
                    const ok =
                        band.band &&
                        band.working === false &&
                        band.above &&
                        band.text.includes("Allow an edit to pkg/a.go?") &&
                        band.text.includes("var x = 2") &&
                        band.choices.length === 3 &&
                        band.choices.every((c, i) => c === `${i + 1} ${EDIT_CHOICES[i]}`);
                    return [ok, band];
                });

                await step("rendered: permission error — 1 on A's band (no controller) shows the error and keeps the band", async () => {
                    const focused = await pressOnSurface(h, "1");
                    const errored = await wait(`${RV}?.querySelector("[data-permission-error]") != null`);
                    const seen = await h.ev(`({ band: ${BAND} != null, error: (${RV}?.querySelector("[data-permission-error]")?.textContent ?? "").trim() })`);
                    await h.shot(SHOT(11, "permission-error"));
                    return [focused && errored && seen.band, { focused, ...seen }];
                });

                await step("rendered: permission queue — a second request turns the band into the queue; Open terminal flips A to Terminal", async () => {
                    ctx.aPerm2 = await raisePermission(h, ctx.aBlock, "Edit", EDIT_INPUT, "fx-rendered-edit-a2", true);
                    await wait(`${RV}?.querySelector("[data-permission-queue]") != null`);
                    const queue = await h.ev(`(() => {
                        ${flatJs}
                        const q = ${RV}?.querySelector("[data-permission-queue]");
                        return { text: flat(q), band: ${BAND} != null };
                    })()`);
                    await h.shot(SHOT(12, "permission-queue"));
                    const clicked = await h.ev(`(() => {
                        const b = [...(${RV}?.querySelectorAll("[data-permission-queue] button") ?? [])].find((x) => (x.textContent ?? "").trim() === "Open terminal");
                        if (!b) return false;
                        b.click();
                        return true;
                    })()`);
                    await wait(`!${viewOf(ctx.aId)}.rendered`);
                    const view = await h.ev(viewOf(ctx.aId));
                    await h.shot(SHOT(12, "queue-open-terminal"));
                    return [
                        queue.text.includes("2 permission prompts waiting") && !queue.band && clicked && !view.rendered && view.termShown,
                        { queue, clicked, view },
                    ];
                });
                // A's requests are not under test past here: a prompt retires the one the server holds (the failed
                // answer already dropped the first server-side, with no cleared event, so the page drops it)
                try {
                    await publishStatus(h, ctx, ctx.aBlock, { state: "working", hook: "UserPromptSubmit" });
                    await agentPage(
                        h,
                        `const { removeAgentPermission } = await mod("app/view/agents/permissionstore.ts");
                        removeAgentPermission(${JSON.stringify(aOref)}, ${JSON.stringify(ctx.aPerm1 ?? "")});
                        return true;`
                    );
                } catch (err) {
                    console.error(`${NAME}: retiring A's requests failed: ${err?.message ?? err}`);
                }

                await focus(ctx.pId);
                await clickToggle(h, "Rendered");
                await wait(`${RV} != null`);
                await step("rendered: plan approval — an ExitPlanMode request on P shows the plan's markdown and the three plan choices", async () => {
                    ctx.pPlan = await raisePermission(h, ctx.pBlock, "ExitPlanMode", PLAN_INPUT, "fx-rendered-plan", false);
                    await wait(`${BAND} != null`);
                    const band = await h.ev(`(() => {
                        ${flatJs}
                        const b = ${BAND};
                        return {
                            text: flat(b).slice(0, 300),
                            heading: [...(b?.querySelectorAll("h1, h2, h3") ?? [])].map(flat),
                            items: [...(b?.querySelectorAll("li") ?? [])].map(flat),
                            choices: [...(b?.querySelectorAll("[data-permission-choice]") ?? [])].map(flat),
                        };
                    })()`);
                    await h.shot(SHOT(13, "plan-approval"));
                    // a PostToolUse with the raise's tool key retires it, as when the plan is answered in the terminal
                    await publishStatus(h, ctx, ctx.pBlock, { state: "working", hook: "PostToolUse", toolkey: "fx-rendered-plan" });
                    const retired = await wait(`${BAND} == null`);
                    const ok =
                        band.text.includes("Approve this plan?") &&
                        band.heading.includes(PLAN_HEADING) &&
                        band.items.length === 2 &&
                        band.choices.length === 3 &&
                        band.choices.every((c, i) => c === `${i + 1} ${PLAN_CHOICES[i]}`) &&
                        retired;
                    return [ok, { ...band, retired }];
                });

                await step("rendered: permission answer — choice 3 (No) on P locks the buttons, types Escape, leaves a mark and refocuses the composer", async () => {
                    ctx.pPerm = await raisePermission(h, ctx.pBlock, "Edit", EDIT_INPUT, "fx-rendered-edit-p", true);
                    await wait(`${BAND} != null`);
                    const from = probeLines(ctx).length;
                    const click = await agentPage(
                        h,
                        `const b = ${BAND};
                        const choice = b?.querySelector('[data-permission-choice="2"]');
                        if (!choice) return { error: "no choice 3" };
                        // a one-key answer can return and remove the band within a poll's interval, so every
                        // render of the band is checked as it lands
                        let locked = false;
                        const isLocked = () => {
                            const all = [...b.querySelectorAll("[data-permission-choice]")];
                            return b.isConnected && all.length === 3 && all.every((x) => x.disabled);
                        };
                        const watch = new MutationObserver(() => (locked ||= isLocked()));
                        watch.observe(b, { subtree: true, attributes: true, attributeFilter: ["disabled"] });
                        choice.click();
                        for (const end = Date.now() + 1000; !locked && Date.now() < end; await nap(5)) locked ||= isLocked();
                        watch.disconnect();
                        return { locked };`
                    );
                    await h.shot(SHOT(14, "permission-in-flight"));
                    const gone = await wait(`${BAND} == null`);
                    const keys = await waitProbe(ctx, from, [ESC]);
                    await wait(`(${RV}?.querySelector("[data-permission-mark]")?.textContent ?? "").includes(${JSON.stringify(EDIT_CHOICES[2])})`);
                    const after = await h.ev(`(() => {
                        ${flatJs}
                        const rv = ${RV};
                        return {
                            marks: [...(rv?.querySelectorAll("[data-permission-mark]") ?? [])].map(flat),
                            composerFocused: document.activeElement != null && document.activeElement === rv?.querySelector("[data-rendered-composer] textarea"),
                        };
                    })()`);
                    await h.shot(SHOT(14, "permission-answered"));
                    const ok =
                        click.locked &&
                        gone &&
                        keys.ok &&
                        after.marks.some((m) => m.includes(EDIT_CHOICES[2])) &&
                        after.composerFocused;
                    return [ok, { ...click, gone, keys: keys.lines, ...after }];
                });

                const BOX_MODEL = `(${RV}?.querySelector("[data-composer-model]")?.textContent ?? "").trim()`;
                const BOX_MODE = `(${RV}?.querySelector("[data-composer-permission-mode]")?.textContent ?? "").trim()`;
                await step("rendered: box idle — model chip, mode chip and context ring in the box, none in the header; the model chip opens default/opus/sonnet/haiku", async () => {
                    await wait(`${BOX_MODEL} === ${JSON.stringify(MODEL_LABEL)}`);
                    const menu = await headerMenu(h, "data-composer-model");
                    // no hook: a mode report retires nothing and moves no hook stamp
                    await publishStatus(h, ctx, ctx.pBlock, { state: "idle", permissionmode: "default" });
                    await wait(`${BOX_MODE} === "Default permissions"`);
                    const seen = await h.ev(`(() => {
                        ${flatJs}
                        const header = ${SURF}?.querySelector("[data-agent-header]");
                        const ring = ${RV}?.querySelector("[data-rendered-composer] [data-context-ring]");
                        return {
                            model: ${BOX_MODEL},
                            mode: ${BOX_MODE},
                            ring: ring ? { text: flat(ring), title: ring.getAttribute("title") } : null,
                            header: {
                                model: header?.querySelector("[data-header-model]") != null,
                                mode: header?.querySelector("[data-header-permission-mode]") != null,
                                context: header?.querySelector('[title^="context:"]') != null,
                            },
                        };
                    })()`);
                    await h.shot(SHOT(15, "box-controls"));
                    const ok =
                        seen.model === MODEL_LABEL &&
                        JSON.stringify(menu.labels) === JSON.stringify(MODEL_ALIASES) &&
                        seen.mode === "Default permissions" &&
                        seen.ring?.text === `${USAGE.contextpct}%` &&
                        seen.ring.title === "Session, context and token usage" &&
                        !seen.header.model &&
                        !seen.header.mode &&
                        !seen.header.context;
                    return [ok, { menu, ...seen }];
                });

                await step("rendered: permission mode change — choosing plan mode on P relabels at once and types Shift+Tab twice", async () => {
                    const from = probeLines(ctx).length;
                    const menu = await headerMenu(h, "data-composer-permission-mode", "plan mode");
                    const relabeled = await wait(`${BOX_MODE} === "Plan mode"`, 1000);
                    const label = await h.ev(BOX_MODE);
                    const keys = await waitProbe(ctx, from, [SHIFT_TAB, SHIFT_TAB]);
                    await h.shot(SHOT(16, "permission-mode"));
                    const shiftTabs = keys.lines.filter((l) => l === SHIFT_TAB).length;
                    return [menu.picked && relabeled && keys.ok && shiftTabs === 2, { menu, relabeled, label, keys: keys.lines }];
                });

                await step("rendered: esc interrupt — Esc in P's composer types ESC into the pty", async () => {
                    const from = probeLines(ctx).length;
                    const sent = await agentPage(
                        h,
                        `const ta = ${RV}?.querySelector("[data-rendered-composer] textarea");
                        if (!ta) return false;
                        ta.focus();
                        ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
                        return true;`
                    );
                    const keys = await waitProbe(ctx, from, [ESC]);
                    await h.shot(SHOT(17, "esc"));
                    return [sent && keys.ok, { sent, keys: keys.lines }];
                });

                await step("rendered: ctrl+c — Ctrl+C in P's empty composer types ^C into the pty, and a second press within the double-press window asks to close P", async () => {
                    // clear of the Esc step's press, so the first press here starts a new pair
                    await sleep(CTRL_C_PAIR_GAP_MS);
                    const press = `{ const ta = ${RV}?.querySelector("[data-rendered-composer] textarea");
                        if (!ta) return false;
                        ta.focus();
                        window.getSelection()?.removeAllRanges();
                        ta.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, bubbles: true, cancelable: true })); }`;
                    const from = probeLines(ctx).length;
                    const once = await agentPage(h, `${press} return true;`);
                    const keys = await waitProbe(ctx, from, [CTRL_C]);
                    await sleep(CTRL_C_PAIR_GAP_MS);
                    const twice = await agentPage(h, `${press} ${press} return true;`);
                    const asked = await wait(`[...document.querySelectorAll('[role="dialog"]')].some((d) => /close/i.test(d.textContent ?? ""))`, WAIT_MS);
                    await h.shot(SHOT(17, "ctrl-c-confirm"));
                    const cancelled = await h.ev(`(() => {
                        const d = [...document.querySelectorAll('[role="dialog"]')].pop();
                        const b = [...(d?.querySelectorAll("button") ?? [])].find((x) => x.textContent?.trim().startsWith("Cancel"));
                        b?.click();
                        return b != null;
                    })()`);
                    const ctrlCs = probeLines(ctx).slice(from).filter((l) => l === CTRL_C).length;
                    // the second pair's first press reaches the pty too; its second only opens the confirm
                    return [once && keys.ok && twice && asked && cancelled && ctrlCs === 2, { keys: keys.lines, asked, cancelled, ctrlCs }];
                });

                await step("rendered: ctrl+c on the transcript — a click on P's reply text leaves focus on the surface, and Ctrl+C there types ^C into the pty; with that text selected it stays a copy", async () => {
                    await sleep(CTRL_C_PAIR_GAP_MS);
                    // a real click: the focus it leaves is the point, and a scripted focus() would choose it instead
                    const at = await h.ev(`(() => {
                        const p = [...(${RV}?.querySelectorAll("p") ?? [])].filter((x) => !x.closest("button, a, [data-steps], [data-rendered-composer]")).pop();
                        if (!p) return null;
                        const b = p.getBoundingClientRect();
                        return { x: b.left + 10, y: b.top + b.height / 2 };
                    })()`);
                    if (at == null) return [false, "no reply paragraph in P's rendered view"];
                    for (const type of ["mousePressed", "mouseReleased"]) {
                        await h.cdp("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
                    }
                    const press = `document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, bubbles: true, cancelable: true }));`;
                    const from = probeLines(ctx).length;
                    const onSurface = await h.ev(`(() => {
                        const onSurface = document.activeElement?.hasAttribute("data-cockpit-surface-wrap") === true;
                        window.getSelection()?.removeAllRanges();
                        ${press}
                        return onSurface;
                    })()`);
                    const keys = await waitProbe(ctx, from, [CTRL_C]);
                    await sleep(CTRL_C_PAIR_GAP_MS);
                    const copyFrom = probeLines(ctx).length;
                    const selected = await h.ev(`(() => {
                        const p = [...(${RV}?.querySelectorAll("p") ?? [])].filter((x) => !x.closest("button, a, [data-steps], [data-rendered-composer]")).pop();
                        const r = document.createRange();
                        r.selectNodeContents(p);
                        window.getSelection().removeAllRanges();
                        window.getSelection().addRange(r);
                        ${press}
                        const ok = !window.getSelection().isCollapsed;
                        window.getSelection().removeAllRanges();
                        return ok;
                    })()`);
                    await sleep(CTRL_C_PAIR_GAP_MS);
                    const copyCtrlCs = probeLines(ctx).slice(copyFrom).filter((l) => l === CTRL_C).length;
                    return [onSurface && keys.ok && selected && copyCtrlCs === 0, { onSurface, keys: keys.lines, selected, copyCtrlCs }];
                });

                await step("rendered: box shape — A's box is the rounded pill: the Reply placeholder on its first line, the control row under it, a round Send disabled, no key-hint footer", async () => {
                    await focus(ctx.aId);
                    const ready = await ensureRendered();
                    // the placeholder follows whether A has a transcript, so the box is read once it is drawn
                    await wait(`(${RV}?.textContent ?? "").includes(${JSON.stringify(PROMPT)})`);
                    const seen = await h.ev(`(() => {
                        ${flatJs}
                        const rv = ${RV};
                        const comp = rv?.querySelector("[data-rendered-composer]");
                        const box = comp?.querySelector("[data-composer-box]");
                        const ta = box?.querySelector("textarea");
                        const send = box?.querySelector("[data-composer-send]");
                        if (!box || !ta || !send) return { box: !!box, ta: !!ta, send: !!send };
                        return {
                            radius: getComputedStyle(box).borderTopLeftRadius,
                            font: getComputedStyle(ta).fontSize,
                            height: box.getBoundingClientRect().height,
                            placeholder: ta.placeholder,
                            textAboveRow: ta.getBoundingClientRect().bottom <= send.getBoundingClientRect().top + 0.5,
                            send: send.getAttribute("aria-label"),
                            round: getComputedStyle(send).borderTopLeftRadius === "9999px" || send.getBoundingClientRect().width === send.getBoundingClientRect().height,
                            sendDisabled: send.disabled,
                            interrupt: box.querySelector("[data-composer-interrupt]") != null,
                            text: flat(box),
                            hint: rv.querySelector("[data-rendered-hint]") != null,
                        };
                    })()`);
                    await h.shot(SHOT(20, "box-shape"));
                    const name = ctx.roster.find((a) => a.id === ctx.aId)?.name;
                    const ok =
                        ready &&
                        seen.radius === "14px" &&
                        seen.font === "14px" &&
                        seen.height >= COMPOSER_IDLE_MIN_PX &&
                        seen.height <= COMPOSER_IDLE_MAX_PX &&
                        seen.placeholder.startsWith(`Reply to ${name}`) &&
                        seen.textAboveRow &&
                        seen.send === "Send" &&
                        seen.round &&
                        seen.sendDisabled &&
                        !seen.interrupt &&
                        COMPOSER_HINTS.every((t) => !seen.text.includes(t)) &&
                        !seen.hint;
                    return [ok, { ready, ...seen }];
                });

                await step("rendered: Composing — two attachments above the text, one failed with Retry; a ready one alone enables Send and draws the accent border", async () => {
                    const typed = await typeComposer(h, "First line of the reply.\nSecond line of the reply.");
                    const taken = await h.ev(pasteOnComposer("rendered-attach.png"));
                    const uploaded = await wait(`${COMPOSER_CHIPS}.some((c) => c.getAttribute("data-attachment-chip") === "ready")`);
                    const ready = await h.ev(`(() => {
                        const box = ${RV}?.querySelector("[data-rendered-composer] [data-composer-box]");
                        const send = box?.querySelector("[data-composer-send]");
                        if (!box || !send) return { box: !!box, send: !!send };
                        // the accent border as the theme resolves it, read off a throwaway element
                        const probe = document.createElement("div");
                        probe.className = "border border-accent/60";
                        box.appendChild(probe);
                        const accent = getComputedStyle(probe).borderTopColor;
                        probe.remove();
                        return { sendDisabled: send.disabled, border: getComputedStyle(box).borderTopColor, accent };
                    })()`);
                    // the second file's save is refused, as a full disk would
                    await agentPage(
                        h,
                        `const { RpcApi } = await mod("app/store/wshclientapi.ts");
                        window.__renderedWrite = RpcApi.WriteTempFileCommand;
                        RpcApi.WriteTempFileCommand = async (c, data, o) => {
                            if (data?.filename === ${JSON.stringify(FAILED_ATTACH)}) throw new Error("disk full");
                            return window.__renderedWrite(c, data, o);
                        };
                        return true;`
                    );
                    let seen;
                    try {
                        await h.ev(pasteOnComposer(FAILED_ATTACH));
                        await wait(`${COMPOSER_CHIPS}.some((c) => c.getAttribute("data-attachment-chip") === "error")`);
                        seen = await h.ev(`(() => {
                            ${flatJs}
                            const box = ${RV}?.querySelector("[data-rendered-composer] [data-composer-box]");
                            const ta = box?.querySelector("textarea");
                            const chips = [...(box?.querySelectorAll("[data-attachment-chip]") ?? [])];
                            if (!ta || chips.length === 0) return { ta: !!ta, chips: chips.length };
                            const failed = chips.find((c) => c.getAttribute("data-attachment-chip") === "error");
                            return {
                                chips: chips.map((c) => ({ state: c.getAttribute("data-attachment-chip"), text: flat(c) })),
                                path: chips.find((c) => c.getAttribute("data-attachment-chip") === "ready")?.getAttribute("data-attachment-path") ?? null,
                                above: chips.every((c) => c.getBoundingClientRect().bottom <= ta.getBoundingClientRect().top + 0.5),
                                retry: failed?.querySelector('button[title="Retry"]') != null,
                            };
                        })()`);
                    } finally {
                        await agentPage(
                            h,
                            `const { RpcApi } = await mod("app/store/wshclientapi.ts");
                            if (window.__renderedWrite) RpcApi.WriteTempFileCommand = window.__renderedWrite;
                            delete window.__renderedWrite;
                            return true;`
                        );
                    }
                    if (seen.path) ctx.tempFiles.push(seen.path);
                    await h.shot(SHOT(21, "composing"));
                    // A's draft is not under test past here
                    await h.ev(`${COMPOSER_CHIPS}.forEach((c) => c.querySelector('button[title="Remove"]')?.click())`);
                    await typeComposer(h, "");
                    const failed = seen.chips?.find((c) => c.state === "error");
                    const ok =
                        typed &&
                        taken === true &&
                        uploaded &&
                        ready.sendDisabled === false &&
                        ready.border === ready.accent &&
                        seen.chips?.length === 2 &&
                        seen.chips.some((c) => c.state === "ready" && c.text.includes("rendered-attach.png")) &&
                        failed?.text.includes(FAILED_ATTACH) &&
                        failed.text.includes("upload failed") &&
                        seen.retry &&
                        seen.above;
                    return [ok, { typed, taken, uploaded, ready, ...seen }];
                });

                await focus(ctx.pId);
                await setRoster(h, ctx.roster.map((a) => (a.id === ctx.pId ? { ...a, state: "working" } : a)));
                await step("rendered: box working — P working reads the Steer placeholder; the empty box's round button is Stop, and the Stop button interrupts (ESC)", async () => {
                    const ready = await ensureRendered();
                    const working = await wait(`${RV}?.querySelector("[data-rendered-composer] textarea")?.placeholder === ${JSON.stringify(STEER_PLACEHOLDER)}`);
                    const seen = await h.ev(`(() => {
                        const comp = ${RV}?.querySelector("[data-rendered-composer]");
                        return {
                            placeholder: comp?.querySelector("textarea")?.placeholder ?? null,
                            stop: comp?.querySelector("[data-composer-interrupt]")?.getAttribute("aria-label") ?? null,
                            send: comp?.querySelector("[data-composer-send]") != null,
                        };
                    })()`);
                    await h.shot(SHOT(22, "box-working"));
                    const from = probeLines(ctx).length;
                    const clicked = await h.ev(`(() => {
                        const b = ${RV}?.querySelector("[data-composer-interrupt]");
                        if (!b) return false;
                        b.click();
                        return true;
                    })()`);
                    const keys = await waitProbe(ctx, from, [ESC]);
                    const ok = ready && working && seen.stop === "Interrupt (Esc)" && !seen.send && clicked && keys.ok;
                    return [ok, { ready, working, ...seen, clicked, keys: keys.lines }];
                });

                await step("rendered: box steer — text in P's working box turns Stop into Send (steer), which types the text and the pasted file's temp path into the pty, then empties the box", async () => {
                    const typed = await typeComposer(h, STEER_TEXT);
                    const taken = await h.ev(pasteOnComposer("rendered-steer.png"));
                    const uploaded = await wait(`${COMPOSER_CHIPS}.some((c) => c.getAttribute("data-attachment-chip") === "ready")`);
                    const path = await h.ev(`${COMPOSER_CHIPS}[0]?.getAttribute("data-attachment-path") ?? null`);
                    if (path) ctx.tempFiles.push(path);
                    const swapped = await h.ev(`(() => {
                        const comp = ${RV}?.querySelector("[data-rendered-composer]");
                        return comp?.querySelector("[data-composer-interrupt]") == null && comp?.querySelector("[data-composer-send]")?.getAttribute("aria-label") === "Steer";
                    })()`);
                    await h.shot(SHOT(23, "composer-steer-ready"));
                    const from = probeLines(ctx).length;
                    const clicked = await h.ev(`(() => {
                        const b = ${RV}?.querySelector("[data-composer-send]");
                        if (!b || b.disabled) return false;
                        b.click();
                        return true;
                    })()`);
                    const decoded = await waitDecoded(ctx, from, [STEER_TEXT, path ?? "<no path>"]);
                    const emptied = await wait(`${RV}?.querySelector("[data-rendered-composer] textarea")?.value === "" && ${COMPOSER_CHIPS}.length === 0`);
                    await h.shot(SHOT(23, "composer-steer-sent"));
                    const ok = typed && taken === true && uploaded && path != null && swapped && clicked && decoded.ok && emptied;
                    return [ok, { typed, taken, uploaded, path, swapped, clicked, input: decoded.text.slice(-400), emptied }];
                });
                await setRoster(h, ctx.roster);

                await step("rendered: @ tag — @ in P's box lists the other fixture agents in the @ panel's Agents group, Esc closes the panel without interrupting, Tab tags A, and the send carries A's tab id", async () => {
                    const PICKER = `${RV}?.querySelector("[data-rendered-composer] [data-mention-panel]")`;
                    const rowTags = `[...(${PICKER}?.querySelectorAll("[data-mention-row]") ?? [])].map((r) => r.getAttribute("data-mention-row"))`;
                    const key = (k) =>
                        h.ev(`(() => {
                            const ta = ${RV}?.querySelector("[data-rendered-composer] textarea");
                            if (!ta) return false;
                            ta.focus();
                            ta.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, code: ${JSON.stringify(k)}, bubbles: true, cancelable: true }));
                            return true;
                        })()`);
                    const aTag = ctx.roster.find((a) => a.id === ctx.aId).name.toLowerCase();
                    const others = ctx.roster.filter((a) => a.id !== ctx.pId).map((a) => a.name.toLowerCase());
                    await typeComposer(h, "ask @");
                    const listed = (await wait(`${PICKER} != null`)) ? await h.ev(rowTags) : [];
                    await h.shot(SHOT(23, "mention-list"));
                    const from = probeLines(ctx).length;
                    await key("Escape");
                    const closed = await wait(`${PICKER} == null`);
                    await sleep(PROBE_SETTLE_MS);
                    const noInterrupt = !probeLines(ctx).slice(from).includes(ESC);
                    // the token Esc closed stays closed while it is typed, so a new one starts from an empty box
                    await typeComposer(h, "");
                    await typeComposer(h, "ask @rendered-a");
                    const reopened = await wait(`${PICKER} != null`);
                    const filtered = await h.ev(rowTags);
                    await key("Tab");
                    const inserted = await wait(`${RV}?.querySelector("[data-rendered-composer] textarea")?.value === ${JSON.stringify(`ask @${aTag} `)}`);
                    await typeComposer(h, `ask @${aTag} what changed`);
                    const sendFrom = probeLines(ctx).length;
                    const clicked = await h.ev(`(() => {
                        const b = ${RV}?.querySelector("[data-composer-send]");
                        if (!b || b.disabled) return false;
                        b.click();
                        return true;
                    })()`);
                    const decoded = await waitDecoded(ctx, sendFrom, [`ask @${aTag} what changed`, ctx.aId]);
                    const ok =
                        JSON.stringify([...listed].sort()) === JSON.stringify([...others].sort()) &&
                        closed &&
                        noInterrupt &&
                        reopened &&
                        JSON.stringify(filtered) === JSON.stringify([aTag]) &&
                        inserted &&
                        clicked &&
                        decoded.ok;
                    return [ok, { listed, others, closed, noInterrupt, reopened, filtered, inserted, clicked, input: decoded.text.slice(-400) }];
                });

                await focus(ctx.aId);
                await step("rendered: picker flip — /config from A's composer flips to Terminal; Notification keeps it; UserPromptSubmit flips back", async () => {
                    const ready = await ensureRendered();
                    const sent = await agentPage(
                        h,
                        `const ta = ${RV}?.querySelector("[data-rendered-composer] textarea");
                        if (!ta) return false;
                        ta.focus();
                        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, "/config");
                        ta.dispatchEvent(new Event("input", { bubbles: true }));
                        await nap(80);
                        ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
                        return true;`
                    );
                    // statuses after the flip carry a later ts than the Date.now() the flip took
                    ctx.lastTs = Math.max(ctx.lastTs ?? 0, Date.now());
                    await wait(`!${viewOf(ctx.aId)}.rendered`);
                    const flipped = await h.ev(viewOf(ctx.aId));
                    await h.shot(SHOT(18, "picker-flip"));
                    await publishStatus(h, ctx, ctx.aBlock, { state: "idle", hook: "Notification", notificationtype: "idle_prompt" });
                    await new Promise((r) => setTimeout(r, HOLD_MS));
                    const held = await h.ev(viewOf(ctx.aId));
                    await publishStatus(h, ctx, ctx.aBlock, { state: "working", hook: "UserPromptSubmit" });
                    const back = await wait(`${viewOf(ctx.aId)}.rendered`);
                    await h.shot(SHOT(18, "picker-back"));
                    // A has no controller, so the send raised "Message not sent"; it would sit over every later shot.
                    // Waiting for it to leave the DOM keeps a later shot from catching its exit
                    const unsentToasts = `[...document.querySelectorAll('[data-notification-toast="error"]')].filter((t) => t.innerText.includes("Message not sent"))`;
                    await h.ev(`(${unsentToasts}.forEach((t) => t.click()), true)`);
                    const toastGone = await wait(`${unsentToasts}.length === 0`);
                    const ok = ready && sent && !flipped.rendered && flipped.termShown && !held.rendered && back && toastGone;
                    return [ok, { ready, sent, flipped, held, back, toastGone }];
                });

                await step("rendered: v key — v with focus outside the terminal flips A between Rendered and Terminal", async () => {
                    const ready = await ensureRendered();
                    const first = await pressOnSurface(h, "v");
                    await wait(`!${viewOf(ctx.aId)}.rendered`);
                    const toTerminal = await h.ev(viewOf(ctx.aId));
                    await h.shot(SHOT(19, "v-terminal"));
                    const second = await pressOnSurface(h, "v");
                    await wait(`${viewOf(ctx.aId)}.rendered`);
                    const toRendered = await h.ev(viewOf(ctx.aId));
                    await h.shot(SHOT(19, "v-rendered"));
                    return [
                        ready && first && second && !toTerminal.rendered && toTerminal.termShown && toRendered.rendered && !toRendered.termShown,
                        { ready, toTerminal, toRendered },
                    ];
                });

                // the working line on a turn appended to A, and the running Bash's step row. Every record is stamped
                // from one t0, so the times do not depend on how long the steps take
                const LINE = `(() => {
                    ${flatJs}
                    const rv = ${RV};
                    const line = rv?.querySelector("[data-working-line]");
                    if (!line) return null;
                    const verb = line.querySelector("[data-working-verb]");
                    const running = rv.querySelector('[data-step][data-step-status="running"]');
                    return {
                        inColumn: rv.querySelector("[data-rendered-column]")?.contains(line) ?? false,
                        verb: verb ? flat(verb) : null,
                        facts: flat(line.querySelector("[data-working-facts]")),
                        running: running ? { text: flat(running), elapsed: flat(running.querySelector("[data-step-elapsed]")) } : null,
                    };
                })()`;
                const waitLine = async (cond) => {
                    const met = await wait(`(() => { const n = ${LINE}; return n != null && (${cond}); })()`);
                    return { met, line: await h.ev(LINE) };
                };
                const appendA = (lines) => appendFileSync(ctx.aPath, lines.join("\n") + "\n");
                const t0 = Date.now();
                try {
                    appendA([
                        userText(NOW_PROMPT, { ts: iso(t0 - NOW_TURN_MS) }),
                        toolUse("toolu_now_read", "Read", { file_path: "C:/fx/pkg/a.go" }, { ts: iso(t0 - NOW_TURN_MS + 10_000) }),
                        toolResult("toolu_now_read", "package a", { ts: iso(t0 - NOW_TURN_MS + 11_000) }),
                        toolUse("toolu_now_bash", "Bash", { command: NOW_CMD }, { ts: iso(t0 - NOW_CALL_MS) }),
                    ]);
                    await setRoster(h, ctx.roster.map((a) => (a.id === ctx.aId ? { ...a, state: "working" } : a)));
                    // the picker flip left A's last hook a seconds-old UserPromptSubmit, which reads as a turn the
                    // transcript has not written yet
                    await publishStatus(h, ctx, ctx.aBlock, { state: "working", hook: "PreToolUse" });
                } catch (err) {
                    console.error(`${NAME}: appending A's turn failed: ${err?.message ?? err}`);
                }

                await step("rendered: working line starting — A working with no spinner on screen: Working · <turn time> · 2 tools in the column, and the running Bash's row shows its command and elapsed", async () => {
                    const ready = await ensureRendered();
                    const { met, line } = await waitLine(`n.running != null && n.running.text.includes(${JSON.stringify(NOW_CMD)})`);
                    await h.shot(SHOT(24, "working-starting"));
                    const ok =
                        ready &&
                        met &&
                        line.inColumn &&
                        line.verb == null &&
                        /^Working · (\d+m )?\d+s · 2 tools$/.test(line.facts) &&
                        /^(\d+m )?\d+s$/.test(line.running.elapsed);
                    return [ok, line];
                });

                await step("rendered: working line call — the spinner row on A's screen: its verb leads the line, its output tokens join the facts", async () => {
                    const wrote = await agentPage(
                        h,
                        `const { termForBlock } = await mod("app/view/term/termscreen.ts");
                        const t = termForBlock(${JSON.stringify(ctx.aBlock)});
                        if (!t?.write) return false;
                        t.write(${JSON.stringify(`\r\n✻ ${SPINNER_VERB} ${SPINNER_DETAIL}`)});
                        return true;`
                    );
                    const { met, line } = await waitLine(`n.verb === ${JSON.stringify(SPINNER_VERB)}`);
                    await h.shot(SHOT(24, "working-call"));
                    const ok = wrote && met && line.facts.includes(SPINNER_TOKENS) && line.facts.endsWith(" · 2 tools") && !line.facts.startsWith("Working");
                    return [ok, { wrote, ...line }];
                });

                await step("rendered: working line between — the Bash's result lands: no running row is left, the line keeps the verb and 2 tools", async () => {
                    appendA([toolResult("toolu_now_bash", "ok  pkg/jarvis  0.2s", { ts: iso(t0 - 1000) })]);
                    const { met, line } = await waitLine(`n.running == null`);
                    await h.shot(SHOT(24, "working-between"));
                    return [met && line.verb === SPINNER_VERB && line.facts.endsWith(" · 2 tools"), line];
                });

                const thinkSteps = () => {
                    const dir = join(ctx.dir, ...PEEK_DIRS);
                    mkdirSync(dir, { recursive: true });
                    writeFileSync(join(dir, PEEK_FILE), "package a\n\nvar fixed = true\n");
                    const peekPath = join(dir, PEEK_FILE).replace(/\\/g, "/");
                    const reply = `The fix goes in \`${peekPath}:${PEEK_LINE}\`, beside its test.`;
                    const t1 = Date.now();
                    appendA([
                        userText(THINK_PROMPT, { ts: iso(t1) }),
                        assistantBlock("msg_think_1", { type: "thinking", thinking: THOUGHT, signature: "s" }, { ts: iso(t1 + 1000) }),
                        assistantBlock(
                            "msg_think_1",
                            { type: "tool_use", id: "toolu_think_ls", name: "Bash", input: { command: "ls pkg", description: THINK_STEP } },
                            { ts: iso(t1 + 1000) }
                        ),
                        toolResult("toolu_think_ls", "a.go", { ts: iso(t1 + 2000) }),
                        assistantBlock("msg_think_2", { type: "thinking", thinking: HIDDEN_THOUGHT, signature: "s" }, { ts: iso(t1 + 3000) }),
                        assistantBlock("msg_think_2", { type: "text", text: reply }, { ts: iso(t1 + 3000) }),
                    ]);
                    return { peekPath };
                };
                const findLink = (path) =>
                    `[...(${RV}?.querySelectorAll("[data-file-link]") ?? [])].find((l) => l.getAttribute("data-file-link") === ${JSON.stringify(path)})`;
                // the link to the reply's path, measured against the column it sits in, and what selecting its paragraph copies
                const fileLink = (path) => `(() => {
                    const link = ${findLink(path)};
                    const col = ${RV}?.querySelector("[data-rendered-column]");
                    if (!link || !col) return null;
                    const range = document.createRange();
                    range.selectNodeContents(link.closest("p"));
                    const sel = getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                    const copied = sel.toString();
                    sel.removeAllRanges();
                    return {
                        ellipsized: link.scrollWidth > link.clientWidth && getComputedStyle(link).textOverflow === "ellipsis",
                        inColumn: link.getBoundingClientRect().right <= col.getBoundingClientRect().right + 0.5,
                        selectable: getComputedStyle(link).userSelect !== "none",
                        copied,
                    };
                })()`;
                const peekCard = `document.querySelector('aside[aria-label="Workspace"] [data-code-peek][data-peek-variant="tab"]')`;
                const clickLink = (path) =>
                    h.ev(`(() => {
                        const link = ${findLink(path)};
                        if (!link) return false;
                        getSelection().removeAllRanges();
                        link.scrollIntoView({ block: "center" });
                        link.click();
                        return true;
                    })()`);

                await step("rendered: working line done — the reply lands and A goes idle: the line leaves, though the spinner row is still on screen", async () => {
                    appendA([assistantText(NOW_REPLY, { ts: iso(t0 + NOW_END_MS) })]);
                    await setRoster(h, ctx.roster);
                    await publishStatus(h, ctx, ctx.aBlock, { state: "idle", hook: "Stop" });
                    const gone = await wait(`(${RV}?.textContent ?? "").includes(${JSON.stringify(NOW_REPLY)}) && ${RV}?.querySelector("[data-working-line]") == null`);
                    const seen = await agentPage(
                        h,
                        `const { screenRows } = await mod("app/view/term/termscreen.ts");
                        return { rowOnScreen: (screenRows(${JSON.stringify(ctx.aBlock)}) ?? []).some((r) => r.includes(${JSON.stringify(SPINNER_VERB)})) };`
                    );
                    await h.shot(SHOT(24, "working-done"));
                    return [gone && seen.rowOnScreen, { gone, ...seen }];
                });

                let think = null;
                await step("rendered: thought — a thinking-only message is a muted line in its stretch, before its step; a replied message's thinking stays hidden", async () => {
                    think = thinkSteps();
                    const landed = await wait(`(${RV}?.textContent ?? "").includes(${JSON.stringify(THINK_PROMPT)}) && ${findLink(think.peekPath)} != null`);
                    const seen = await h.ev(`(() => {
                        ${flatJs}
                        const rv = ${RV};
                        const thought = [...(rv?.querySelectorAll("[data-thought]") ?? [])].find((t) => flat(t) === ${JSON.stringify(THOUGHT)});
                        if (!thought) return { thought: false };
                        // each row of a step box sits in its own reveal wrapper
                        const next = thought.parentElement.nextElementSibling?.firstElementChild;
                        const md = thought.querySelector(".agent-md");
                        const reply = [...rv.querySelectorAll("[data-find-turn]")].pop();
                        return {
                            thought: true,
                            inStretch: thought.closest("[data-steps]") != null,
                            beforeStep: next?.matches("[data-step]") === true && flat(next).includes(${JSON.stringify(THINK_STEP)}),
                            muted: md?.classList.contains("text-ink-mid") === true && getComputedStyle(md).color !== getComputedStyle(reply).color,
                            hiddenShown: (rv.textContent ?? "").includes(${JSON.stringify(HIDDEN_THOUGHT)}),
                        };
                    })()`);
                    await agentPage(h, `[...(${RV}?.querySelectorAll("[data-thought]") ?? [])].pop()?.scrollIntoView({ block: "center" }); await nap(200); return true;`);
                    await h.shot(SHOT(25, "thought"));
                    return [landed && seen.thought && seen.inStretch && seen.beforeStep && seen.muted && seen.hiddenShown === false, { landed, ...seen }];
                });

                await step("rendered: file link — the reply's path is a link that ellipsizes inside the column and copies whole with the text around it", async () => {
                    if (think == null) return [false, "the thought step did not append the turn"];
                    const seen = await h.ev(fileLink(think.peekPath));
                    await h.shot(SHOT(26, "file-link"));
                    const ok =
                        seen != null &&
                        seen.ellipsized &&
                        seen.inColumn &&
                        seen.selectable &&
                        seen.copied.includes(`The fix goes in ${think.peekPath}:${PEEK_LINE}, beside its test.`);
                    return [ok, seen];
                });

                await step("rendered: file peek — a click on the path opens a File tab beside the transcript on that file, its editor drawing the file; a second click keeps it, and the tab's × closes the tab and its peek", async () => {
                    if (think == null) return [false, "the thought step did not append the turn"];
                    const key = `file:${think.peekPath}`;
                    const tab = `[...document.querySelectorAll("[data-workspace-tab]")].find((t) => t.dataset.workspaceTab === ${JSON.stringify(key)})`;
                    const clicked = await clickLink(think.peekPath);
                    const opened = await wait(`${peekCard}?.getAttribute("data-peek-state") === "text"`);
                    // the editor draws the file's own lines, not an empty box (Monaco draws a space as a no-break space)
                    const viewLines = `[...(${peekCard}?.querySelectorAll(".monaco-editor .view-line") ?? [])].map((l) => l.textContent.replace(/\\u00a0/g, " "))`;
                    const drawn = await wait(`${viewLines}.some((t) => t.includes("var fixed"))`);
                    const lines = await h.ev(viewLines);
                    const card = await h.ev(`(() => {
                        const rv = ${RV};
                        const pane = document.querySelector('aside[aria-label="Workspace"]');
                        const box = ${peekCard};
                        const path = box?.querySelector("[data-peek-path]");
                        const scroll = rv?.querySelector("[data-rendered-scroll]");
                        if (!pane || !box || !path || !scroll) return null;
                        return {
                            path: path.getAttribute("title"),
                            tabLabel: ${tab}?.textContent.trim() ?? null,
                            besideTranscript: pane.getBoundingClientRect().left >= scroll.getBoundingClientRect().right - 0.5,
                            noDock: rv.querySelector("[data-rendered-peek]") == null,
                        };
                    })()`);
                    await h.shot(SHOT(27, "file-peek"));
                    const again = await clickLink(think.peekPath);
                    await agentPage(h, `await nap(400); return true;`);
                    const kept = await h.ev(`${peekCard} != null && ${tab} != null`);
                    await h.ev(`${tab}?.querySelector("[data-workspace-tab-close]")?.click()`);
                    const closed = await wait(`${tab} == null && ${peekCard} == null`);
                    const peekGone = await agentPage(h, `const P = await mod("app/view/code/codepeekstore.ts"); return until(() => globalStore.get(P.codePeekAtom) == null, 3000);`);
                    const samePath = (p) => (p ?? "").replace(/\\/g, "/").toLowerCase() === think.peekPath.toLowerCase();
                    const ok =
                        clicked &&
                        opened &&
                        drawn &&
                        card != null &&
                        samePath(card.path) &&
                        card.tabLabel === PEEK_FILE &&
                        card.besideTranscript &&
                        card.noDock &&
                        again &&
                        kept &&
                        closed &&
                        peekGone;
                    return [ok, { clicked, opened, drawn, lines, card, again, kept, closed, peekGone }];
                });

                await step("rendered: bash card — A's two ! runs draw as cards: the finished one shows its command, stdout, and stderr in the error colour; the unfinished one reads running; no user bubble holds <bash-; a third run of 12 lines shows 8 and Show all, whose click shows every line", async () => {
                    // the input keeps a leading space, as real transcripts can
                    appendA([bashInput(` ${SHELL_DONE}`), bashOutput(SHELL_STDOUT, SHELL_STDERR), bashInput(SHELL_RUNNING)]);
                    const landed = await wait(`(${RV}?.querySelectorAll("[data-shell-run]").length ?? 0) >= 2`);
                    const seen = await h.ev(`(() => {
                        ${flatJs}
                        const rv = ${RV};
                        const cards = [...(rv?.querySelectorAll("[data-shell-run]") ?? [])];
                        const card = (cmd) => cards.find((c) => flat(c.querySelector("[data-shell-command]")) === cmd);
                        const done = card(${JSON.stringify(SHELL_DONE)});
                        const running = card(${JSON.stringify(SHELL_RUNNING)});
                        const out = done?.querySelector("[data-shell-stdout]");
                        const err = done?.querySelector("[data-shell-stderr]");
                        const probe = document.createElement("span");
                        probe.className = "text-error";
                        rv?.appendChild(probe);
                        const errorColour = getComputedStyle(probe).color;
                        probe.remove();
                        return {
                            cards: cards.length,
                            done: done != null,
                            stdout: flat(out),
                            stderr: flat(err),
                            stderrColour: err ? getComputedStyle(err).color : null,
                            stdoutColour: out ? getComputedStyle(out).color : null,
                            errorColour,
                            doneRunning: done?.querySelector('[data-shell-status="running"]') != null,
                            running: running != null && flat(running.querySelector('[data-shell-status="running"]')) === "running",
                            runningOutput: running?.querySelector("[data-shell-stdout], [data-shell-stderr]") != null,
                            rawBubble: [...(rv?.querySelectorAll("[data-user-bubble]") ?? [])].some((b) => (b.textContent ?? "").includes("<bash-")),
                        };
                    })()`);
                    await agentPage(h, `[...(${RV}?.querySelectorAll("[data-shell-run]") ?? [])].pop()?.scrollIntoView({ block: "center" }); await nap(200); return true;`);
                    await h.shot(SHOT(28, "bash-card"));

                    appendA([bashInput(SHELL_LONG), bashOutput(SHELL_LONG_OUT.join("\n") + "\n", "")]);
                    const LONG = `[...(${RV}?.querySelectorAll("[data-shell-run]") ?? [])].find((c) => (c.querySelector("[data-shell-command]")?.textContent ?? "").trim() === ${JSON.stringify(SHELL_LONG)})`;
                    const readLong = `(() => {
                        ${flatJs}
                        const c = ${LONG};
                        if (!c) return null;
                        const out = c.querySelector("[data-shell-stdout]")?.textContent ?? "";
                        return { lines: out === "" ? 0 : out.split("\\n").length, more: flat(c.querySelector("[data-shell-more]")) };
                    })()`;
                    const longLanded = await wait(`(${LONG})?.querySelector("[data-shell-stdout]") != null`);
                    await agentPage(h, `(${LONG})?.scrollIntoView({ block: "center" }); await nap(200); return true;`);
                    const clamped = await h.ev(readLong);
                    await h.shot(SHOT(28, "bash-card-clamped"));
                    const clicked = await h.ev(`(() => { const b = (${LONG})?.querySelector("[data-shell-more]"); b?.click(); return b != null; })()`);
                    const opened = await wait(`(${LONG})?.querySelector("[data-shell-stdout]")?.textContent?.split("\\n").length === ${SHELL_LONG_OUT.length}`);
                    const all = await h.ev(readLong);
                    await agentPage(h, `(${LONG})?.scrollIntoView({ block: "center" }); await nap(200); return true;`);
                    await h.shot(SHOT(28, "bash-card-opened"));
                    const longOk =
                        longLanded &&
                        clamped?.lines === SHELL_CLAMP &&
                        clamped.more === `Show all ${SHELL_LONG_OUT.length} lines` &&
                        clicked &&
                        opened &&
                        all?.lines === SHELL_LONG_OUT.length;
                    const ok =
                        longOk &&
                        landed &&
                        seen.done &&
                        seen.stdout === SHELL_STDOUT &&
                        seen.stderr === SHELL_STDERR &&
                        seen.stderrColour === seen.errorColour &&
                        seen.stderrColour !== seen.stdoutColour &&
                        !seen.doneRunning &&
                        seen.running &&
                        !seen.runningOutput &&
                        !seen.rawBubble;
                    return [ok, { landed, ...seen, longLanded, clamped, clicked, opened, all }];
                });

                await step("rendered: table — a reply's table with a long description column wraps its cells: every cell's text sits inside the table's box, which holds within the column, and the long cell takes more than one line", async () => {
                    const row = (cells) => `| ${cells.join(" | ")} |`;
                    const table = [row(TABLE_HEAD), row(TABLE_HEAD.map(() => "---")), ...TABLE_ROWS.map(row)].join("\n");
                    const t = Date.now();
                    appendA([userText(TABLE_PROMPT, { ts: iso(t) }), assistantText(`The panels:\n\n${table}\n`, { ts: iso(t + 1000) })]);
                    const landed = await wait(`${RV}?.querySelector(".agent-table-wrap") != null && (${RV}.textContent ?? "").includes(${J(TABLE_DESC.slice(0, 40))})`);
                    await agentPage(h, `${RV}?.querySelector(".agent-table-wrap")?.scrollIntoView({ block: "center" }); await nap(200); return true;`);
                    const seen = await h.ev(`(() => {
                        const rv = ${RV};
                        const wrap = rv?.querySelector(".agent-table-wrap");
                        const column = rv?.querySelector("[data-rendered-column]");
                        if (!wrap || !column) return null;
                        const w = wrap.getBoundingClientRect();
                        const cells = [...wrap.querySelectorAll("th, td")];
                        const long = cells.find((c) => (c.textContent ?? "").startsWith(${J(TABLE_DESC.slice(0, 40))}));
                        // a wrapped cell's text spans more than one line box
                        const lines = (c) => {
                            const r = document.createRange();
                            r.selectNodeContents(c);
                            return new Set([...r.getClientRects()].map((q) => Math.round(q.top))).size;
                        };
                        return {
                            cells: cells.length,
                            overflowPx: wrap.scrollWidth - wrap.clientWidth,
                            outside: cells.filter((c) => c.getBoundingClientRect().right > w.right + 0.5).length,
                            inColumn: w.right <= column.getBoundingClientRect().right + 0.5,
                            tableWidth: wrap.querySelector("table").getBoundingClientRect().width,
                            wrapWidth: w.width,
                            longLines: long ? lines(long) : 0,
                        };
                    })()`);
                    await h.shot(SHOT(28, "table"));
                    const ok =
                        landed &&
                        seen != null &&
                        seen.cells === TABLE_HEAD.length * (TABLE_ROWS.length + 1) &&
                        seen.overflowPx <= 1 &&
                        seen.outside === 0 &&
                        seen.inColumn &&
                        seen.longLines > 1;
                    return [ok, { landed, ...seen }];
                });

                await step("rendered: line breaks — a reply's single newlines draw as line breaks, one line each as in the terminal, while its code block keeps its own lines", async () => {
                    const t = Date.now();
                    const fence = "```";
                    const text = `${BREAK_LINES.join("\n")}\n\n${fence}\n${BREAK_CODE.join("\n")}\n${fence}\n`;
                    appendA([userText(BREAK_PROMPT, { ts: iso(t) }), assistantText(text, { ts: iso(t + 1000) })]);
                    const para = `[...(${RV}?.querySelectorAll("[data-find-turn] p") ?? [])].find((p) => (p.textContent ?? "").startsWith(${J(BREAK_LINES[0])}))`;
                    const landed = await wait(`${para} != null`);
                    await agentPage(h, `${para}?.scrollIntoView({ block: "center" }); await nap(200); return true;`);
                    const seen = await h.ev(`(() => {
                        const p = ${para};
                        if (!p) return null;
                        const lines = p.innerText.split("\\n").map((l) => l.trim()).filter(Boolean);
                        // the code block's own rows (codeblock.tsx draws one per line, its text after the gutter)
                        const block = p.closest("[data-find-turn]")?.querySelector("[data-code-head]")?.parentElement;
                        const codeLines = [...(block?.querySelectorAll(".whitespace-pre") ?? [])].map((r) => r.lastElementChild?.textContent ?? "");
                        return { lines, breaks: p.querySelectorAll("br").length, codeLines, codeBreaks: block?.querySelectorAll("br").length ?? null };
                    })()`);
                    await h.shot(SHOT(28, "line-breaks"));
                    const ok =
                        landed &&
                        seen != null &&
                        seen.breaks === BREAK_LINES.length - 1 &&
                        JSON.stringify(seen.lines) === JSON.stringify(BREAK_LINES) &&
                        JSON.stringify(seen.codeLines) === JSON.stringify(BREAK_CODE) &&
                        seen.codeBreaks === 0;
                    return [ok, { landed, ...seen }];
                });

                await step("rendered: @ mention — in P's box @ and part of a name lists the file, Enter writes @<path> and a pill draws over it, Backspace removes it whole; Esc closes the panel without typing ESC, it stays closed in that word, and a new @ opens it again", async () => {
                    const PANEL = `${RV}?.querySelector("[data-rendered-composer] [data-mention-panel]")`;
                    const TA = `${RV}?.querySelector("[data-rendered-composer] textarea")`;
                    const press = (key) =>
                        h.ev(`(() => {
                            const ta = ${TA};
                            if (!ta) return false;
                            ta.focus();
                            ta.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, code: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
                            return true;
                        })()`);
                    const value = () => h.ev(`${TA}?.value ?? null`);
                    const dir = join(ctx.dir, MENTION_DIR);
                    for (const f of MENTION_FILES) {
                        mkdirSync(dirname(join(dir, f)), { recursive: true });
                        writeFileSync(join(dir, f), "fixture\n");
                    }
                    // P's process keeps its own cwd: a meta change restarts nothing, and the picker reads the meta
                    await h.rpc("setmeta", { oref: `block:${ctx.pBlock}`, meta: { "cmd:cwd": dir } });
                    try {
                        await agentPage(h, `await WOS.reloadWaveObject(WOS.makeORef("block", ${JSON.stringify(ctx.pBlock)})); return true;`);
                        await focus(ctx.pId);
                        const ready = await ensureRendered();

                        await typeComposer(h, "@widg");
                        const listed = await wait(`[...(${PANEL}?.querySelectorAll("[data-suggest-item]") ?? [])].some((r) => (r.textContent ?? "").includes("widget-alpha.ts"))`);
                        await h.shot(SHOT(29, "mention-panel"));
                        await press("Enter");
                        const picked = await wait(`${TA}?.value === ${JSON.stringify(`@${MENTION_PICK} `)} && ${RV}?.querySelector("[data-rendered-composer] [data-mention-pill]") != null`);
                        const pill = await h.ev(`(() => {
                            const ta = ${TA};
                            const p = ${RV}?.querySelector("[data-rendered-composer] [data-mention-pill]");
                            if (!ta || !p) return null;
                            const a = p.getBoundingClientRect();
                            const b = ta.getBoundingClientRect();
                            return {
                                text: p.textContent,
                                over: a.left >= b.left - 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1,
                                textHidden: getComputedStyle(ta).color === "rgba(0, 0, 0, 0)",
                            };
                        })()`);
                        await h.shot(SHOT(29, "mention-pill"));
                        await press("Backspace");
                        const removed = await wait(`${TA}?.value === "" && ${RV}?.querySelector("[data-rendered-composer] [data-mention-pill]") == null`);
                        const afterBackspace = await value();

                        await typeComposer(h, "@w");
                        const reopened = await wait(`${PANEL} != null`);
                        const from = probeLines(ctx).length;
                        await press("Escape");
                        const closed = await wait(`${PANEL} == null`);
                        await sleep(HOLD_MS);
                        const escTyped = probeLines(ctx).slice(from).includes(ESC);
                        await typeComposer(h, "@wi");
                        await sleep(HOLD_MS);
                        const stayedClosed = await h.ev(`${PANEL} == null`);
                        await typeComposer(h, "@wi @");
                        const openedAgain = await wait(`${PANEL} != null`);
                        await h.shot(SHOT(29, "mention-reopen"));
                        await typeComposer(h, "");
                        const ok =
                            ready &&
                            listed &&
                            picked &&
                            pill?.text === `@${MENTION_PICK}` &&
                            pill.over &&
                            pill.textHidden &&
                            removed &&
                            reopened &&
                            closed &&
                            !escTyped &&
                            stayedClosed &&
                            openedAgain;
                        return [ok, { ready, listed, picked, pill, removed, afterBackspace, reopened, closed, escTyped, stayedClosed, openedAgain }];
                    } finally {
                        await h.rpc("setmeta", { oref: `block:${ctx.pBlock}`, meta: { "cmd:cwd": "~" } });
                    }
                });

                await step("rendered: slash panel — with a live list published for P's block, / lists it in its groups with the key line; /co filters to /compact and /config first, /config alone opens in Terminal; ArrowDown moves, Tab writes /config; Esc closes without typing ESC, it stays closed in that word, and a fresh / opens it again", async () => {
                    const PANEL = `${RV}?.querySelector("[data-rendered-composer] [data-slash-panel]")`;
                    const TA = `${RV}?.querySelector("[data-rendered-composer] textarea")`;
                    const press = (key) =>
                        h.ev(`(() => {
                            const ta = ${TA};
                            if (!ta) return false;
                            ta.focus();
                            ta.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, code: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
                            return true;
                        })()`);
                    const rows = () =>
                        h.ev(`[...(${PANEL}?.querySelectorAll("[data-suggest-item]") ?? [])].map((r) => ({
                            name: r.querySelector("[data-slash-name]")?.textContent ?? "",
                            active: r.hasAttribute("data-active"),
                            terminal: r.querySelector("[data-opens-terminal]") != null,
                        }))`);
                    const panelText = () => h.ev(`${PANEL}?.textContent ?? ""`);
                    await h.rpc("setclaudelivecommands", { blockid: ctx.pBlock, commands: SLASH_LIVE });
                    try {
                        await focus(ctx.pId);
                        const ready = await ensureRendered();

                        await typeComposer(h, "/");
                        const live = `${SLASH_LIVE.length} commands in this session`;
                        const grouped = await wait(
                            `(() => { const t = ${PANEL}?.textContent ?? ""; return ${JSON.stringify([...SLASH_GROUPS, live, "Esc close"])}.every((w) => t.includes(w)); })()`
                        );
                        const opened = await panelText();
                        await h.shot(SHOT(30, "slash-panel"));

                        await typeComposer(h, "/co");
                        const filtered = await wait(
                            `[...(${PANEL}?.querySelectorAll("[data-slash-name]") ?? [])].map((n) => n.textContent).join(" ") === ${JSON.stringify(SLASH_CO.map((n) => `/${n}`).join(" "))}`
                        );
                        const co = await rows();
                        const config = co.find((r) => r.name === "/config");
                        const compact = co.find((r) => r.name === "/compact");
                        await h.shot(SHOT(30, "slash-filtered"));
                        await press("ArrowDown");
                        const moved = await wait(`${PANEL}?.querySelector("[data-active] [data-slash-name]")?.textContent === "/config"`);
                        await press("Tab");
                        const completed = await wait(`${TA}?.value === "/config " && ${PANEL} == null`);

                        await typeComposer(h, "/co");
                        const reopened = await wait(`${PANEL} != null`);
                        const from = probeLines(ctx).length;
                        await press("Escape");
                        const closed = await wait(`${PANEL} == null`);
                        await sleep(HOLD_MS);
                        const escTyped = probeLines(ctx).slice(from).includes(ESC);
                        await typeComposer(h, "/com");
                        await sleep(HOLD_MS);
                        const stayedClosed = await h.ev(`${PANEL} == null`);
                        await typeComposer(h, "");
                        await wait(`${TA}?.value === ""`);
                        await typeComposer(h, "/");
                        const openedAgain = await wait(`${PANEL} != null`);
                        await typeComposer(h, "");
                        const ok =
                            ready &&
                            grouped &&
                            filtered &&
                            co[0]?.name === "/compact" &&
                            co[1]?.name === "/config" &&
                            config?.terminal === true &&
                            compact?.terminal === false &&
                            moved &&
                            completed &&
                            reopened &&
                            closed &&
                            !escTyped &&
                            stayedClosed &&
                            openedAgain;
                        return [ok, { ready, grouped, opened, filtered, co, moved, completed, reopened, closed, escTyped, stayedClosed, openedAgain }];
                    } finally {
                        await h.rpc("setclaudelivecommands", { blockid: ctx.pBlock, commands: [] });
                    }
                });

                await step("rendered: bash mode — ! in P's empty box turns on the ! Bash cue (mono, accent border, no attach button) with an empty box and the tray kept; with echo hi typed Send reads Run; Enter types !, the bracketed paste and \\r into the pty with no attachment path, then empties the box and leaves the mode; ! then Backspace leaves it; Esc leaves it and types no ESC", async () => {
                    const BOX = `${RV}?.querySelector("[data-rendered-composer] [data-composer-box]")`;
                    const TA = `${BOX}?.querySelector("textarea")`;
                    const BASH_ON = `${BOX}?.hasAttribute("data-bash-mode") === true`;
                    const press = (key) =>
                        h.ev(`(() => {
                            const ta = ${TA};
                            if (!ta) return false;
                            ta.focus();
                            ta.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, code: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
                            return true;
                        })()`);
                    await focus(ctx.pId);
                    const ready = await ensureRendered();
                    // a ready attachment in the tray must stay there and stay out of the command
                    const taken = await h.ev(pasteOnComposer("rendered-bash.png"));
                    const uploaded = await wait(`${COMPOSER_CHIPS}.some((c) => c.getAttribute("data-attachment-chip") === "ready")`);
                    const path = await h.ev(`${COMPOSER_CHIPS}[0]?.getAttribute("data-attachment-path") ?? null`);
                    if (path) ctx.tempFiles.push(path);
                    try {
                        await typeComposer(h, "!");
                        const on = await wait(`${BASH_ON} && ${TA}?.value === ""`);
                        const cue = await h.ev(`(() => {
                            const box = ${BOX};
                            const ta = ${TA};
                            if (!box || !ta) return null;
                            // the accent as the theme resolves it, read off a throwaway element
                            const probe = document.createElement("div");
                            probe.className = "border border-accent";
                            box.appendChild(probe);
                            const accent = getComputedStyle(probe).borderTopColor;
                            probe.remove();
                            return {
                                label: box.querySelector("[data-bash-label]")?.textContent ?? null,
                                mono: /mono/i.test(getComputedStyle(ta).fontFamily),
                                border: getComputedStyle(box).borderTopColor === accent,
                                attach: box.querySelector("[data-attach-files]") != null,
                                placeholder: ta.placeholder,
                                panels: box.querySelector("[data-slash-panel], [data-mention-panel]") != null,
                            };
                        })()`);
                        await h.shot(SHOT(31, "bash-mode"));

                        await typeComposer(h, "echo hi");
                        const sendLabel = await h.ev(`(() => {
                            const b = ${BOX}?.querySelector("[data-composer-send]");
                            return b ? { aria: b.getAttribute("aria-label"), title: b.getAttribute("title") } : null;
                        })()`);
                        const from = probeLines(ctx).length;
                        await press("Enter");
                        const paste = "\x1b[200~echo hi\x1b[201~";
                        const decoded = await waitDecoded(ctx, from, ["!", paste, "\r"]);
                        const bang = decoded.text.indexOf("!");
                        const at = decoded.text.indexOf(paste, bang);
                        const ordered = bang >= 0 && at > bang && decoded.text.indexOf("\r", at) > at;
                        const sent = await wait(`${TA}?.value === "" && !(${BASH_ON})`);
                        const kept = await h.ev(`${COMPOSER_CHIPS}.some((c) => c.getAttribute("data-attachment-chip") === "ready")`);
                        await h.shot(SHOT(31, "bash-sent"));

                        await typeComposer(h, "!");
                        const onAgain = await wait(BASH_ON);
                        await press("Backspace");
                        const backspaced = await wait(`!(${BASH_ON}) && ${TA}?.value === ""`);

                        await typeComposer(h, "!");
                        const onThird = await wait(BASH_ON);
                        const escFrom = probeLines(ctx).length;
                        await press("Escape");
                        const escaped = await wait(`!(${BASH_ON})`);
                        await sleep(HOLD_MS);
                        const escTyped = probeLines(ctx).slice(escFrom).includes(ESC);
                        const ok =
                            ready &&
                            taken === true &&
                            uploaded &&
                            path != null &&
                            on &&
                            cue?.label === "! Bash" &&
                            cue.mono &&
                            cue.border &&
                            !cue.attach &&
                            !cue.panels &&
                            sendLabel?.aria === "Run" &&
                            sendLabel.title === "Run" &&
                            ordered &&
                            !decoded.text.includes(path) &&
                            sent &&
                            kept &&
                            onAgain &&
                            backspaced &&
                            onThird &&
                            escaped &&
                            !escTyped;
                        return [ok, { ready, taken, uploaded, path, on, cue, sendLabel, input: JSON.stringify(decoded.text.slice(-200)), ordered, sent, kept, onAgain, backspaced, onThird, escaped, escTyped }];
                    } finally {
                        await h.ev(`${COMPOSER_CHIPS}.forEach((c) => c.querySelector('button[title="Remove"]')?.click())`);
                        await typeComposer(h, "");
                        // a failed check can leave the mode on; Backspace on the empty box turns it off
                        if (await h.ev(BASH_ON)) await press("Backspace");
                    }
                });

                await step(`rendered: show earlier — L's transcript runs past the stream's tail: the feed opens without its first prompt under "Show earlier turns"; the click brings the first prompt in, draws past ${RENDER_CAP} items, drops the control and keeps the row at the top of the viewport in place`, async () => {
                    await focus(ctx.lId);
                    await clickToggle(h, "Rendered");
                    await wait(`(${RV}?.textContent ?? "").includes(${J(longReply(LONG_TURNS - 1))}) && ${RV}?.querySelector("[data-rendered-earlier]") != null`);
                    // the feed's rows, and the first whose bottom is below the scroll area's top: its text and offset
                    const read = `(() => {
                        ${flatJs}
                        const rv = ${RV};
                        const scroll = rv?.querySelector("[data-rendered-scroll]");
                        if (!scroll) return null;
                        const rows = [...(rv.querySelector("[data-rendered-feed]")?.firstElementChild?.children ?? [])];
                        const top = scroll.getBoundingClientRect().top;
                        const row = rows.find((r) => r.getBoundingClientRect().bottom > top);
                        return {
                            control: flat(rv.querySelector("[data-rendered-earlier]")) || null,
                            first: (rv.textContent ?? "").includes(${J(longPrompt(0))}),
                            rows: rows.length,
                            top: row ? { text: flat(row), offset: row.getBoundingClientRect().top - top } : null,
                        };
                    })()`;
                    // the control sits at the top of the feed, so the reader scrolls up to it
                    await agentPage(h, `const s = ${RV}?.querySelector("[data-rendered-scroll]"); if (s) s.scrollTop = 0; await nap(300); return true;`);
                    const before = await h.ev(read);
                    await h.shot(SHOT(32, "earlier-before"));
                    const clicked = await h.ev(`(() => { const b = ${RV}?.querySelector("[data-rendered-earlier]"); b?.click(); return b != null; })()`);
                    const landed = await wait(`(${RV}?.textContent ?? "").includes(${J(longPrompt(0))}) && ${RV}?.querySelector("[data-rendered-earlier]") == null`);
                    await new Promise((r) => setTimeout(r, HOLD_MS));
                    const after = await h.ev(read);
                    // where the row that was at the top now sits, found by its text (each turn's text is unique)
                    const held =
                        before?.top == null
                            ? null
                            : await h.ev(`(() => {
                                  ${flatJs}
                                  const scroll = ${RV}?.querySelector("[data-rendered-scroll]");
                                  const rows = [...(${RV}?.querySelector("[data-rendered-feed]")?.firstElementChild?.children ?? [])];
                                  const row = rows.find((r) => flat(r) === ${J(before.top.text)});
                                  return row && scroll ? row.getBoundingClientRect().top - scroll.getBoundingClientRect().top : null;
                              })()`);
                    await h.shot(SHOT(32, "earlier-after"));
                    const moved = held == null ? null : held - before.top.offset;
                    const ok =
                        before != null &&
                        before.control === "Show earlier turns" &&
                        !before.first &&
                        before.rows <= RENDER_CAP &&
                        clicked &&
                        landed &&
                        after != null &&
                        after.control == null &&
                        after.first &&
                        after.rows > RENDER_CAP &&
                        moved != null &&
                        Math.abs(moved) <= PLACE_PX;
                    return [ok, { before, clicked, landed, after, moved }];
                });
                return steps;
            },
            // best-effort, so one failed step does not strand the rest
            async teardown(h, ctx) {
                const step = async (what, fn) => {
                    try {
                        await fn();
                    } catch (err) {
                        console.error(`${NAME} teardown: ${what} failed: ${err?.message ?? err}`);
                    }
                };
                if (ctx.focusEmulated) {
                    await step("turn focus emulation off", () => h.cdp("Emulation.setFocusEmulationEnabled", { enabled: false }));
                }
                await step("restore the default view", () => restoreDefaultView(h));
                // a Stop retires every request still pending on the block
                for (const blockId of ctx.blocks ?? []) {
                    await step(`publish a Stop for ${blockId}`, () => publishStatus(h, ctx, blockId, { state: "idle", hook: "Stop" }));
                }
                if (ctx.askRaised) {
                    await step("clear the ask", () => h.rpc("agentaskclear", `block:${ctx.aBlock}`));
                }
                await step("drop pending requests the page still shows", () =>
                    agentPage(
                        h,
                        `const { getAgentPermissionsAtom } = await mod("app/view/agents/permissionstore.ts");
                        for (const b of ${JSON.stringify(ctx.blocks ?? [])}) globalStore.set(getAgentPermissionsAtom("block:" + b), []);
                        return true;`
                    )
                );
                await step("restore the roster", () => restoreRoster(h));
                await step("drop the focus", () =>
                    agentPage(h, `globalStore.set(agentsModel().focusIdAtom, undefined); return true;`)
                );
                await step("close the tabs", () => closeTabs(h, ctx));
                // the probe exits with its pty; its last append can hold the file for a moment
                // each pasted file got its own wavesrv temp dir
                for (const f of ctx.tempFiles ?? []) {
                    await step(`remove ${dirname(f)}`, () => rmSync(dirname(f), { recursive: true, force: true }));
                }
                await step("remove the temp dir", () => rmSync(ctx.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
                await step("go home", () => h.goto("cockpit"));
            },
        },
    ];
}
