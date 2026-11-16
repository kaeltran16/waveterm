// Scenario `rendered-shell`: the Rendered view's shell (the Working, Empty, Loading, Compact and Composing boards). The
// roster is a fixture of three claude agents backed by real tabs, as agent-rendered builds them: W, working, with a
// transcript of a long first prompt, a reply, then a last prompt whose reply runs past the view and ends in a running
// Bash, and a spinner row written onto its terminal; L whose transcript is empty, so it has not loaded; N with none.
// The compact working line is drawn through the narration fixture seam. Teardown publishes a Stop for every fixture
// block, restores the roster, closes the tabs and removes the temp dir.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { bash, clearTranscript, prose, ROOT, showTranscript, user, waitSeam } from "./transcript-fixture.mjs";

const NAME = "rendered-shell";
const MODEL_ID = "claude-opus-5-5";
const WAIT_MS = 10_000;
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
const COMPACT_PX = 380;
// a layout box's rounding slack
const FIT_PX = 2;

// the first prompt is long enough for the bubble's clamp; the last one is the prompt the bar pins
const LONG_PROMPT = Array.from({ length: 16 }, (_, i) => `Step ${i + 1}: check the retry backoff and note what you find.`).join("\n");
const LAST_PROMPT = "Run node test.js, find why it fails, fix src/retry.js and run the test again.";
// the reply under the last prompt: taller than the view, so at the bottom the prompt has scrolled out of it
const LONG_REPLY = Array.from({ length: 40 }, (_, i) => `- finding ${i + 1}: the first retry waits 0 ms because i starts at 0.`).join("\n");
const RUN_CMD = "node test.js";
const TURN_MS = 24_000;
const SPINNER_VERB = "✻ Cogitating…";
const SPINNER_ROW = `${SPINNER_VERB} (24s · ↓ 1.8k tokens · esc to interrupt)`;
const TOKENS = "↓ 1.8k tokens";
// the Read and the running Bash after the last prompt
const TURN_TOOLS = 2;
const iso = (ms) => new Date(ms).toISOString();

// every query is scoped to the Agent surface
const SURF = `document.querySelector("[data-cockpit-surface-wrap]")`;
const RV = `${SURF}?.querySelector("[data-rendered-view]")`;
const SCROLL = `${RV}?.querySelector("[data-rendered-scroll]")`;
const FLAT = `const flat = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();`;

// the header's one view button flips Terminal / Rendered, so it is clicked only when the agent is not in Rendered yet
const ensureRendered = async (h) => {
    await h.ev(`(() => {
        const b = ${SURF}?.querySelector("button[data-view-toggle]");
        if (b && b.getAttribute("aria-pressed") !== "true") b.click();
        return true;
    })()`);
    return polishWaitFor(h, `${RV} != null`, WAIT_MS);
};

// an agent:status as the hook publishes it, with a ts later than every earlier one, or the server drops it as stale
async function publishStatus(h, ctx, blockId, fields) {
    const ts = Math.max(Date.now(), (ctx.lastTs ?? 0) + 1);
    ctx.lastTs = ts;
    const oref = `block:${blockId}`;
    await h.rpc("eventpublish", { event: "agent:status", scopes: [oref], data: { oref, agent: "claude", ts, ...fields } });
}

const rosterAgent = (id, blockId, name, transcriptPath, state = "idle") => ({
    id,
    name,
    project: "fx-rendered-shell",
    task: "rendered shell fixture",
    state,
    agent: "claude",
    model: MODEL_ID,
    blockId,
    ...(transcriptPath ? { transcriptPath } : {}),
});

// where the bubble, the bar and the scroller sit, read in one evaluation
const PIN = `(() => {
    ${FLAT}
    const scroll = ${SCROLL};
    const bubbles = scroll ? [...scroll.querySelectorAll("[data-user-bubble]")] : [];
    const last = bubbles.at(-1);
    const bar = ${RV}?.querySelector("[data-pinned-prompt]");
    const top = scroll?.getBoundingClientRect().top ?? null;
    return {
        bar: bar ? { text: flat(bar), label: bar.getAttribute("aria-label") } : null,
        lastText: flat(last),
        lastTop: last ? last.getBoundingClientRect().top : null,
        lastBottom: last ? last.getBoundingClientRect().bottom : null,
        scrollTop: top,
        scrollBottom: scroll?.getBoundingClientRect().bottom ?? null,
        atBottom: scroll ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 4 : null,
    };
})()`;

// the working line in the Rendered column, and the lowest box that holds the running command's text
const WORKING = `(() => {
    ${FLAT}
    const col = ${RV}?.querySelector("[data-rendered-column]");
    const line = col?.querySelector("[data-working-line]");
    if (!line) return null;
    const holders = [...col.querySelectorAll("*")].filter(
        (el) => !line.contains(el) && (el.textContent ?? "").includes(${JSON.stringify(RUN_CMD)}) &&
            ![...el.children].some((c) => (c.textContent ?? "").includes(${JSON.stringify(RUN_CMD)}))
    );
    const runBottom = Math.max(...holders.map((el) => el.getBoundingClientRect().bottom));
    return {
        text: flat(line),
        verb: flat(line.querySelector("[data-working-verb]")),
        top: line.getBoundingClientRect().top,
        runBottom: holders.length ? runBottom : null,
    };
})()`;

export const renderedShell = {
    name: NAME,
    surface: "agent",
    async arrange(h) {
        const tag = Date.now().toString(36);
        const ctx = { tabIds: [], dir: mkdtempSync(join(tmpdir(), "verify-rendered-shell-")) };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            const t0 = Date.now();
            const wPath = writeTranscript(ctx.dir, `shell-w-${tag}`, [
                userText(LONG_PROMPT, { ts: iso(t0 - 10 * 60_000) }),
                assistantText("I read the backoff and noted each step.", { ts: iso(t0 - 9 * 60_000) }),
                userText(LAST_PROMPT, { ts: iso(t0 - TURN_MS) }),
                toolUse("toolu_read", "Read", { file_path: "C:/fx/src/retry.js" }, { ts: iso(t0 - TURN_MS + 1_000) }),
                toolResult("toolu_read", "module.exports = retry;", { ts: iso(t0 - TURN_MS + 2_000) }),
                assistantText(LONG_REPLY, { ts: iso(t0 - TURN_MS + 3_000) }),
                toolUse("toolu_run", "Bash", { command: RUN_CMD, description: "Run the test again" }, { ts: iso(t0 - 2_000) }),
            ]);
            const lPath = join(ctx.dir, `shell-l-${tag}.jsonl`);
            writeFileSync(lPath, "");

            await h.goto("agent");
            // no controller, so nothing runs in W's terminal but the spinner row this scenario writes
            const w = await makeTab(h, ctx, { label: `shell-w-${tag}`, blockMeta: { view: "term", controller: null } });
            const l = await makeTab(h, ctx, { label: `shell-l-${tag}` });
            const n = await makeTab(h, ctx, { label: `shell-n-${tag}` });
            Object.assign(ctx, { wId: w.tabId, wBlock: w.blockId, lId: l.tabId, nId: n.tabId, blocks: [w.blockId, l.blockId, n.blockId] });
            ctx.roster = [
                rosterAgent(w.tabId, w.blockId, `shell-w-${tag}`, wPath, "working"),
                rosterAgent(l.tabId, l.blockId, `shell-l-${tag}`, lPath),
                rosterAgent(n.tabId, n.blockId, `shell-n-${tag}`, null),
            ];
            await setRoster(h, ctx.roster);
            await publishStatus(h, ctx, w.blockId, { state: "working", hook: "PreToolUse", model: MODEL_ID });
            await focusAgent(h, ctx.wId);
            if (!(await polishWaitFor(h, `${SURF}?.querySelector("[data-view-toggle]") != null`, WAIT_MS))) {
                throw new Error("the view toggle never showed for agent W");
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
            return ensureRendered(h);
        };

        await step("Working: scrolled past the prompt, the pinned bar shows it and a click brings the bubble back; the working line sits under the running step with the spinner, elapsed, tokens and tool count", async () => {
            const ready = await focus(ctx.wId);
            await wait(`(${RV}?.textContent ?? "").includes(${JSON.stringify(RUN_CMD)})`);
            const wrote = await agentPage(
                h,
                `const { termForBlock } = await mod("app/view/term/termscreen.ts");
                const t = termForBlock(${JSON.stringify(ctx.wBlock)});
                if (!t?.write) return false;
                t.write(${JSON.stringify(`\r\n${SPINNER_ROW}`)});
                return true;`
            );
            await wait(`(${WORKING})?.verb === ${JSON.stringify(SPINNER_VERB)}`);
            const line = await h.ev(WORKING);
            await wait(`(${PIN}).bar != null`);
            const pinned = await h.ev(PIN);
            await h.shot(SHOT(1, "working-pinned"));
            await h.ev(`(${RV}?.querySelector("[data-pinned-prompt]")?.click(), true)`);
            await wait(`(() => { const p = ${PIN}; return p.bar == null && p.lastTop >= p.scrollTop - ${FIT_PX} && p.lastBottom <= p.scrollBottom; })()`);
            const jumped = await h.ev(PIN);
            await h.shot(SHOT(1, "working-jumped"));
            const lineOk =
                line != null &&
                line.verb === SPINNER_VERB &&
                /\d+s/.test(line.text) &&
                line.text.includes(TOKENS) &&
                line.text.includes(`${TURN_TOOLS} tools`) &&
                line.runBottom != null &&
                line.top >= line.runBottom - FIT_PX;
            const pinOk =
                pinned.bar?.text === LAST_PROMPT &&
                pinned.bar?.label === "Jump to your last message" &&
                pinned.lastText.includes(LAST_PROMPT) &&
                pinned.lastBottom <= pinned.scrollTop &&
                jumped.bar == null &&
                jumped.lastTop >= jumped.scrollTop - FIT_PX;
            return [ready && wrote && lineOk && pinOk, { ready, wrote, line, pinned, jumped }];
        });

        await step("Latest: scrolled up, the Latest pill shows and a click returns to the bottom", async () => {
            await h.ev(`(() => { const s = ${SCROLL}; s.scrollTop = 0; s.dispatchEvent(new Event("scroll")); return true; })()`);
            const shown = await wait(`${RV}?.querySelector("[data-latest-pill]") != null`);
            const pill = await h.ev(`(() => {
                const b = ${RV}?.querySelector("[data-latest-pill]");
                return b ? { title: b.getAttribute("title"), text: b.textContent.replace(/\\s+/g, "") } : null;
            })()`);
            await h.shot(SHOT(2, "latest-pill"));
            await h.ev(`(${RV}?.querySelector("[data-latest-pill]")?.click(), true)`);
            const back = await wait(`(${PIN}).atBottom === true && ${RV}?.querySelector("[data-latest-pill]") == null`);
            await h.shot(SHOT(2, "latest-back"));
            return [shown && pill?.title === "Jump to latest" && pill.text === "↓Latest" && back, { shown, pill, back }];
        });

        await step("Composing: a long prompt is clamped with Show more, and a click on Show more opens it whole", async () => {
            const read = `(() => {
                const bubble = ${SCROLL}?.querySelector("[data-user-bubble]");
                const text = bubble?.querySelector("[data-find-turn]");
                const more = bubble ? [...bubble.querySelectorAll("button")].find((b) => /^Show (more|less)$/.test(b.textContent.trim())) : null;
                if (!text) return null;
                return { clamped: text.scrollHeight > text.clientHeight + 1, more: more?.textContent.trim() ?? null, expanded: more?.getAttribute("aria-expanded") ?? null };
            })()`;
            await h.ev(`(${SCROLL}?.querySelector("[data-user-bubble]")?.scrollIntoView({ block: "start" }), true)`);
            await wait(`(${read})?.more === "Show more"`);
            const before = await h.ev(read);
            await h.shot(SHOT(3, "composing-clamped"));
            await h.ev(`(() => {
                const bubble = ${SCROLL}?.querySelector("[data-user-bubble]");
                [...(bubble?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === "Show more")?.click();
                return true;
            })()`);
            await wait(`(${read})?.expanded === "true"`);
            const after = await h.ev(read);
            await h.shot(SHOT(3, "composing-open"));
            return [before?.clamped === true && before.more === "Show more" && after?.clamped === false && after.expanded === "true", { before, after }];
        });

        await step("Loading: a tab whose transcript has not loaded shows the skeleton with role=status", async () => {
            const ready = await focus(ctx.lId);
            const shown = await wait(`${RV}?.querySelector('[role="status"][aria-label="Loading the transcript"]') != null`);
            await h.shot(SHOT(4, "loading"));
            return [ready && shown, { ready, shown }];
        });

        await step("Empty: a tab with no transcript shows the centred line", async () => {
            const ready = await focus(ctx.nId);
            await wait(`${RV}?.querySelector('[data-rendered-empty="no-transcript"]') != null`);
            const seen = await h.ev(`(() => {
                const el = ${RV}?.querySelector('[data-rendered-empty="no-transcript"]');
                const scroll = ${SCROLL};
                if (!el || !scroll) return null;
                const range = document.createRange();
                range.selectNodeContents(el);
                const t = range.getBoundingClientRect();
                const s = scroll.getBoundingClientRect();
                return { text: el.textContent.trim(), dx: Math.abs((t.left + t.right) / 2 - (s.left + s.right) / 2), dy: Math.abs((t.top + t.bottom) / 2 - (s.top + s.bottom) / 2) };
            })()`);
            await h.shot(SHOT(5, "empty"));
            const ok = ready && seen?.text === "No transcript for this session yet." && seen.dx <= FIT_PX && seen.dy <= FIT_PX;
            return [ok, { ready, ...seen }];
        });

        await step("Compact: the fixture at 380 px with a nowLine draws the working line without the tool count", async () => {
            const seam = await waitSeam(h);
            const t0 = Date.now();
            await showTranscript(h, {
                entries: [
                    user("Run node test.js, find why it fails, fix src/retry.js and run the test again.", t0 - TURN_MS),
                    prose("The first retry waits 0 ms because i starts at 0.", t0 - TURN_MS + 3_000),
                    bash({ description: "Run the test again", command: RUN_CMD, ts: t0 - 2_000, pending: true }),
                ],
                width: COMPACT_PX,
                compact: true,
                active: true,
                nowLine: {
                    kind: "working",
                    spinner: { glyph: "✻", verb: "Cogitating…", detail: "24s · ↓ 1.8k tokens", tokens: "1.8k" },
                    elapsedMs: TURN_MS,
                    tokens: "1.8k",
                    tools: 4,
                },
            });
            const seen = await h.ev(`(() => {
                ${FLAT}
                const line = document.querySelector(${JSON.stringify(ROOT)})?.querySelector("[data-working-line]");
                return line ? { text: flat(line), verb: flat(line.querySelector("[data-working-verb]")) } : null;
            })()`);
            await h.shot(SHOT(6, "compact"));
            await clearTranscript(h);
            const ok = seam && seen?.verb === SPINNER_VERB && seen.text.includes("24s") && seen.text.includes(TOKENS) && !/tool/.test(seen.text);
            return [ok, { seam, ...seen }];
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
        await step("clear the fixture feed", () => clearTranscript(h));
        for (const blockId of ctx.blocks ?? []) {
            await step(`publish a Stop for ${blockId}`, () => publishStatus(h, ctx, blockId, { state: "idle", hook: "Stop" }));
        }
        await step("restore the roster", () => restoreRoster(h));
        await step("drop the focus", () => agentPage(h, `globalStore.set(agentsModel().focusIdAtom, undefined); return true;`));
        await step("close the tabs", () => closeTabs(h, ctx));
        await step("remove the temp dir", () => rmSync(ctx.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
        await step("go home", () => h.goto("cockpit"));
    },
};
