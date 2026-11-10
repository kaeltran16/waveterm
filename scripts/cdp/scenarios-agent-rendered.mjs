// Agent review scenario `agent-rendered`: the Agent surface center's Rendered mode. The roster is a fixture of four
// claude agents backed by real tabs: A (no controller, so keys sent to it fail) with a transcript of a prompt, prose,
// a go test run, a git diff, an image Read and five chart blocks; P, whose block runs the key probe
// (fixtures/keyprobe.mjs), so the keys typed into its pty are read back from a file; E with an empty transcript; N
// with none. Statuses, permission requests and an ask are raised over rpc as the hooks would. Transcripts and the
// probe's file live in a temp dir; teardown publishes a Stop for every fixture block, clears the ask, restores the
// roster, closes the tabs and removes the dir.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    agentPage,
    assistantText,
    closeTabs,
    focusAgent,
    makeTab,
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
const COLUMN_MAX_PX = 920;
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;

// keys as the probe logs them: one hex chunk per line
const DOWN = "1b5b42";
const ENTER = "0d";
const SHIFT_TAB = "1b5b5a";
const ESC = "1b";

const PROMPT = "Run the jarvis tests, show me the diff, and chart the timings.";
const PROSE_BOLD = "the plan";
const PROSE = `Here is **${PROSE_BOLD}**: run the tests first, then read the diff before charting.`;
const TEST_REPLY = "One test fails in pkg/jarvis. Here is the diff and the screenshot.";
const P_PROMPT ="Tidy pkg/a.go.";
const P_REPLY = "Tidying pkg/a.go now.";

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
const PLAN_CHOICES = ["Yes, auto-accept edits", "Yes, manually approve edits", "No, keep planning"];
const MODEL_LABEL = "opus 5.5";
const MODEL_ALIASES = ["default", "opus", "sonnet", "haiku"];
const ASK_QUESTION = { header: "Scope", question: "Which scope should the fix cover?", options: [{ label: "this file" }, { label: "the package" }] };

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
        termShown: term != null && getComputedStyle(term).display !== "none",
    };
})()`;

const clickToggle = (h, label) =>
    h.ev(`(() => {
        const b = [...(${SURF}?.querySelectorAll("[data-view-toggle] button") ?? [])]
            .find((x) => (x.textContent ?? "").trim() === ${JSON.stringify(label)});
        if (!b) return false;
        b.click();
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

// the labels of the context menu a header control opens, and the menu's items for a click
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
                const ctx = { tabIds: [], dir: mkdtempSync(join(tmpdir(), "verify-agent-rendered-")) };
                // a throw past this point still returns ctx, so teardown removes whatever was already made
                try {
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
                    Object.assign(ctx, {
                        aId: a.tabId,
                        aBlock: a.blockId,
                        pId: p.tabId,
                        pBlock: p.blockId,
                        eId: e.tabId,
                        nId: n.tabId,
                        blocks: [a.blockId, p.blockId, e.blockId, n.blockId],
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

                // a page without OS focus fires no focus events and keeps no activeElement change visible
                await h.cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
                ctx.focusEmulated = true;

                await step("rendered: toggle — clicking Rendered on A shows the rendered view, the terminal stays mounted and hidden", async () => {
                    const before = await h.ev(viewOf(ctx.aId));
                    const clicked = await clickToggle(h, "Rendered");
                    await wait(`${RV} != null`);
                    const after = await h.ev(viewOf(ctx.aId));
                    await h.shot(SHOT(1, "toggle"));
                    return [
                        clicked && !before.rendered && before.termShown && after.rendered && after.termInDom && !after.termShown,
                        { clicked, before, after },
                    ];
                });

                await step(`rendered: timeline — the You bubble and markdown prose sit in a column no wider than ${COLUMN_MAX_PX}px`, async () => {
                    await wait(`(${RV}?.textContent ?? "").includes(${JSON.stringify(PROMPT)})`);
                    const seen = await h.ev(`(() => {
                        ${flatJs}
                        const rv = ${RV};
                        const you = [...(rv?.querySelectorAll("[data-find-turn]") ?? [])].find((p) => flat(p) === ${JSON.stringify(PROMPT)});
                        const strong = [...(rv?.querySelectorAll("strong") ?? [])].find((s) => flat(s) === ${JSON.stringify(PROSE_BOLD)});
                        const col = you?.closest('[class*="max-w-[920px]"]');
                        return {
                            you: you != null,
                            youLabel: flat(you?.previousElementSibling),
                            prose: strong != null,
                            proseInColumn: col != null && strong != null && col.contains(strong),
                            columnWidth: col?.getBoundingClientRect().width ?? null,
                        };
                    })()`);
                    await h.shot(SHOT(2, "timeline"));
                    return [
                        seen.you && seen.youLabel === "You" && seen.prose && seen.proseInColumn && seen.columnWidth <= COLUMN_MAX_PX + 0.5,
                        seen,
                    ];
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
                        [FAILURE.pkg, `${FAILURE.test}: ${FAILURE.message}`, FAILURE.loc].every((t) => row.includes(t)) &&
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

                await step("rendered: cards in a burst — A's three back-to-back tool calls render open, every card visible", async () => {
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

                // the open burst keeps its summary row as a header: a click folds it, a second click opens it again
                await step("rendered: burst header — a click on the open card burst's header folds it, a second click opens it", async () => {
                    const BURST = `[...(${RV}?.querySelectorAll('[data-fold]') ?? [])].find((b) => /\\d+ tools/.test(b.textContent ?? ""))`;
                    const read = `(() => {
                        const b = ${BURST};
                        const card = ${RV}?.querySelector('[data-tool-card="git-diff"]');
                        return { expanded: b?.getAttribute("aria-expanded") ?? null, card: !!card && card.checkVisibility() };
                    })()`;
                    const before = await h.ev(read);
                    await h.ev(`${BURST}?.click()`);
                    await wait(`${BURST}?.getAttribute("aria-expanded") === "false"`);
                    const folded = await h.ev(read);
                    await h.shot(SHOT(6, "burst-folded"));
                    await h.ev(`${BURST}?.click()`);
                    await wait(`${BURST}?.getAttribute("aria-expanded") === "true"`);
                    const reopened = await h.ev(read);
                    const ok =
                        before.expanded === "true" && before.card &&
                        folded.expanded === "false" && !folded.card &&
                        reopened.expanded === "true" && reopened.card;
                    return [ok, { before, folded, reopened }];
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

                await step("rendered: ask dock — an ask raised on A docks the AnswerBar above the composer", async () => {
                    const rtn = await h.rpc("ask", { oref: aOref, questions: [ASK_QUESTION] });
                    ctx.askRaised = true;
                    // the fixture roster stands in for the live one, so the ask the server published is put on A the
                    // way the live roster does it (withAsk)
                    const patched = await agentPage(
                        h,
                        `const { getAgentAskAtom } = await mod("app/view/agents/agentaskstore.ts");
                        const { withAsk } = await mod("app/view/agents/agentsviewmodel.ts");
                        const D = await mod("app/view/agents/devmock.ts");
                        const askAtom = getAgentAskAtom(${JSON.stringify(aOref)});
                        if (!(await until(() => globalStore.get(askAtom) != null, 5000))) return false;
                        const ask = globalStore.get(askAtom);
                        globalStore.set(D.devMockAgentsAtom, globalStore.get(D.devMockAgentsAtom).map((a) =>
                            a.id === ${JSON.stringify(ctx.aId)} ? withAsk(a, ask, Date.now()) : a));
                        return true;`
                    );
                    await wait(`${RV}?.querySelector("[data-rendered-ask]") != null`);
                    const dock = await h.ev(`(() => {
                        const rv = ${RV};
                        const ask = rv?.querySelector("[data-rendered-ask]");
                        const comp = rv?.querySelector("[data-rendered-composer]");
                        if (!ask || !comp) return { ask: !!ask, composer: !!comp };
                        return {
                            ask: true,
                            question: (ask.textContent ?? "").includes(${JSON.stringify(ASK_QUESTION.question)}),
                            above: ask.getBoundingClientRect().bottom <= comp.getBoundingClientRect().top + 1,
                        };
                    })()`);
                    await h.shot(SHOT(9, "ask-dock"));
                    return [patched && dock.ask && dock.question && dock.above, { askid: rtn?.askid ?? rtn, patched, dock }];
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
                        };
                    })()`);
                    await h.shot(SHOT(10, "permission-band"));
                    const ok =
                        band.band &&
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

                await step("rendered: permission answer — choice 3 on P locks the buttons, types Down Down Enter, leaves a mark and refocuses the composer", async () => {
                    ctx.pPerm = await raisePermission(h, ctx.pBlock, "Edit", EDIT_INPUT, "fx-rendered-edit-p", true);
                    await wait(`${BAND} != null`);
                    const from = probeLines(ctx).length;
                    const click = await agentPage(
                        h,
                        `const b = ${BAND};
                        const choice = b?.querySelector('[data-permission-choice="2"]');
                        if (!choice) return { error: "no choice 3" };
                        choice.click();
                        let locked = false;
                        for (const end = Date.now() + 1000; !locked && Date.now() < end; await nap(5)) {
                            const all = [...(b.querySelectorAll("[data-permission-choice]") ?? [])];
                            locked = b.isConnected && all.length === 3 && all.every((x) => x.disabled);
                        }
                        return { locked };`
                    );
                    await h.shot(SHOT(14, "permission-in-flight"));
                    const gone = await wait(`${BAND} == null`);
                    const keys = await waitProbe(ctx, from, [DOWN, DOWN, ENTER]);
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

                await step("rendered: header controls — the model reads opus 5.5 with default/opus/sonnet/haiku; a reported mode reads default permissions", async () => {
                    await wait(`(${SURF}?.querySelector("[data-header-model]")?.textContent ?? "").trim() === ${JSON.stringify(MODEL_LABEL)}`);
                    const model = await h.ev(`(${SURF}?.querySelector("[data-header-model]")?.textContent ?? "").trim()`);
                    const menu = await headerMenu(h, "data-header-model");
                    // no hook: a mode report retires nothing and moves no hook stamp
                    await publishStatus(h, ctx, ctx.pBlock, { state: "idle", permissionmode: "default" });
                    await wait(`(${SURF}?.querySelector("[data-header-permission-mode]")?.textContent ?? "").trim() === "default permissions"`);
                    const mode = await h.ev(`(${SURF}?.querySelector("[data-header-permission-mode]")?.textContent ?? "").trim()`);
                    await h.shot(SHOT(15, "header-controls"));
                    return [
                        model === MODEL_LABEL && JSON.stringify(menu.labels) === JSON.stringify(MODEL_ALIASES) && mode === "default permissions",
                        { model, menu, mode },
                    ];
                });

                await step("rendered: permission mode change — choosing plan mode on P relabels at once and types Shift+Tab twice", async () => {
                    const from = probeLines(ctx).length;
                    const menu = await headerMenu(h, "data-header-permission-mode", "plan mode");
                    const relabeled = await wait(`(${SURF}?.querySelector("[data-header-permission-mode]")?.textContent ?? "").trim() === "plan mode"`, 1000);
                    const label = await h.ev(`(${SURF}?.querySelector("[data-header-permission-mode]")?.textContent ?? "").trim()`);
                    const keys = await waitProbe(ctx, from, [SHIFT_TAB, SHIFT_TAB]);
                    await h.shot(SHOT(16, "permission-mode"));
                    const shiftTabs = keys.lines.filter((l) => l === SHIFT_TAB).length;
                    return [menu.picked && relabeled && keys.ok && shiftTabs === 2, { menu, label, keys: keys.lines }];
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
                    const ok = ready && sent && !flipped.rendered && flipped.termShown && !held.rendered && back;
                    return [ok, { ready, sent, flipped, held, back }];
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
                await step("remove the temp dir", () => rmSync(ctx.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
                await step("go home", () => h.goto("cockpit"));
            },
        },
    ];
}
