// Agent review scenario `agent-queued`: messages waiting on a working agent, drawn at the foot of the Rendered
// transcript. The roster is one fixture claude agent Q, backed by a real tab with no controller and no arc mod, working
// on a Bash call. The mod's reports are driven over rpc with SetAgentQueueCommand, as `wsh agentqueue set` sends them;
// Claude Code's own queue is driven by appending queue-operation records to Q's transcript. Teardown reports nothing
// held, publishes a Stop, restores the roster, closes the tab and removes the temp dir.

import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
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

const NAME = "agent-queued";
const MODEL_ID = "claude-opus-5-5";
const WAIT_MS = 10_000;
// how long the frame sampler keeps watching after the last change it waits for
const SAMPLE_SETTLE_MS = 600;
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
const iso = (ms) => new Date(ms).toISOString();

const SURF = `document.querySelector("[data-cockpit-surface-wrap]")`;
const RV = `${SURF}?.querySelector("[data-rendered-view]")`;
const flatJs = `const flat = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();`;
// a command row's name and args are spans with no text between them
const chipJs = `const chipText = (c) => [...(c?.querySelector("span")?.children ?? [])].map((s) => s.textContent.trim()).join(" ");`;

const PROMPT = "Move the slash panel's keys ahead of the mention keys, then run the agents tests.";
const REPLY = "I'll move the slash panel's keys first, then run the agents tests.";
const TEST_CMD = "npx vitest run frontend/app/view/agents/";
const M1 = { id: "fx-q-1", text: "Only touch renderedcomposer.tsx, leave agentcomposer.tsx alone." };
const M2 = { id: "fx-q-2", text: "and keep the Esc order as it is" };
const CMD = { id: "fx-q-3", text: "/review the slash panel", name: "/review", args: "the slash panel" };
const TERMINAL = "typed in the terminal: also check the @ panel";
const LINE_TAIL = "· Esc to stop and send now";
const QUEUED_PLACEHOLDER = "Press ↑ to edit queued messages";
const WORKING_PLACEHOLDER = "Steer the agent; it reads this before its next step";

// the records the arc mod's join writes (claude/arc-mod): a meta user record of the arc plugin
const joinedRecord = (text, ts) => JSON.stringify({ ...JSON.parse(userText(text, { ts })), isMeta: true, origin: { kind: "plugin", name: "arc" } });
// the command record Claude Code writes for a slash command it runs
const commandRecord = (name, args, ts) =>
    userText(`<command-name>${name}</command-name>\n<command-message>${name.slice(1)}</command-message>\n<command-args>${args}</command-args>`, { ts });
// Claude Code's queue records, and the attachment it writes for a message taken mid-turn
const queueOp = (operation, ts, extra = {}) => JSON.stringify({ type: "queue-operation", operation, timestamp: iso(ts), sessionId: "arc-verify-agent-session", ...extra });
const queuedAttachment = (prompt, ts) =>
    JSON.stringify({
        type: "attachment",
        timestamp: iso(ts),
        sessionId: "arc-verify-agent-session",
        attachment: { type: "queued_command", prompt, commandMode: "prompt", timestamp: iso(ts) },
    });

// what the foot, the line and the box show, read in one pass
const FOOT = `(() => {
    ${flatJs}
    ${chipJs}
    const rv = ${RV};
    if (!rv) return null;
    const foot = rv.querySelector("[data-queued-foot]");
    const items = [...(foot?.querySelectorAll("[data-queued-item]") ?? [])];
    const lines = [...rv.querySelectorAll("[data-queued-line]")];
    const working = rv.querySelector("[data-working-line]");
    const lastItem = items[items.length - 1];
    return {
        items: items.map((el) => {
            const chip = el.querySelector("[data-command-chip]");
            return { state: el.getAttribute("data-queued-item"), command: chip != null, text: chip ? chipText(chip) : flat(el.firstElementChild) };
        }),
        lines: lines.map(flat),
        lineInLast: lines.length === 1 && lastItem != null && lastItem.contains(lines[0]),
        footAboveWorking: foot != null && working != null && (foot.compareDocumentPosition(working) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        timeline: [...rv.querySelectorAll("[data-rendered-feed] [data-user-bubble]")].map(flat),
        commands: [...rv.querySelectorAll("[data-rendered-feed] [data-command-chip]")].filter((c) => !foot?.contains(c)).map(chipText),
        placeholder: rv.querySelector("[data-rendered-composer] textarea")?.placeholder ?? null,
    };
})()`;

// counts, every frame, the bubbles showing each text, foot and timeline together, so a frame that shows one twice or
// not at all is caught between two polls
const startSampler = (h, texts) =>
    h.ev(`(() => {
        ${flatJs}
        const texts = ${JSON.stringify(texts)};
        const s = { min: Object.fromEntries(texts.map((t) => [t, Infinity])), max: Object.fromEntries(texts.map((t) => [t, 0])), frames: 0, on: true };
        window.__queuedSampler = s;
        const tick = () => {
            if (!s.on) return;
            const rv = ${RV};
            const shown = [...(rv?.querySelectorAll("[data-user-bubble], [data-queued-item]") ?? [])].map((el) => flat(el.firstElementChild));
            for (const t of texts) {
                const n = shown.filter((x) => x === t).length;
                s.min[t] = Math.min(s.min[t], n);
                s.max[t] = Math.max(s.max[t], n);
            }
            s.frames++;
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return true;
    })()`);
const stopSampler = (h) =>
    h.ev(`(() => { const s = window.__queuedSampler; if (!s) return null; s.on = false; delete window.__queuedSampler; return { min: s.min, max: s.max, frames: s.frames }; })()`);

// an agent:status as the hook publishes it, with a ts later than every earlier one, or the server drops it as stale
async function publishStatus(h, ctx, blockId, fields) {
    const ts = Math.max(Date.now(), (ctx.lastTs ?? 0) + 1);
    ctx.lastTs = ts;
    const oref = `block:${blockId}`;
    await h.rpc("eventpublish", { event: "agent:status", scopes: [oref], data: { oref, agent: "claude", ts, ...fields } });
}

// a report as the mod sends it after each change; held is remembered so teardown can hand back what is still held
async function report(h, ctx, held, left = []) {
    await h.rpc("setagentqueue", { blockid: ctx.qBlock, held, ...(left.length > 0 ? { left } : {}) });
    ctx.held = held;
}

export default function (_kit) {
    return [
        {
            name: NAME,
            surface: "agent",
            async arrange(h) {
                const tag = Date.now().toString(36);
                const ctx = { tabIds: [], held: [], dir: mkdtempSync(join(tmpdir(), "verify-agent-queued-")) };
                // a throw past this point still returns ctx, so teardown removes whatever was already made
                try {
                    const t0 = Date.now();
                    ctx.path = writeTranscript(ctx.dir, `queued-q-${tag}`, [
                        userText(PROMPT, { ts: iso(t0 - 120_000) }),
                        assistantText(REPLY, { ts: iso(t0 - 110_000) }),
                        toolUse("toolu_q_test", "Bash", { command: TEST_CMD }, { ts: iso(t0 - 72_000) }),
                    ]);
                    await h.goto("agent");
                    // no controller and no mod: nothing reads the reports but the page
                    const q = await makeTab(h, ctx, { label: `queued-q-${tag}`, blockMeta: { view: "term", controller: null } });
                    Object.assign(ctx, { qId: q.tabId, qBlock: q.blockId });
                    ctx.roster = [
                        {
                            id: q.tabId,
                            name: `queued-q-${tag}`,
                            project: "fx-queued",
                            task: "queued fixture",
                            state: "working",
                            agent: "claude",
                            model: MODEL_ID,
                            blockId: q.blockId,
                            transcriptPath: ctx.path,
                        },
                    ];
                    await setRoster(h, ctx.roster);
                    await publishStatus(h, ctx, q.blockId, { state: "working", hook: "PreToolUse", model: MODEL_ID });
                    await focusAgent(h, q.tabId);
                    if (!(await polishWaitFor(h, `${SURF}?.querySelector("[data-view-toggle]") != null`, WAIT_MS))) {
                        throw new Error("the view toggle never showed for agent Q");
                    }
                    await h.ev(`(() => {
                        const b = ${SURF}?.querySelector("button[data-view-toggle]");
                        if (b && b.getAttribute("aria-pressed") !== "true") b.click();
                        return true;
                    })()`);
                    if (!(await polishWaitFor(h, `(${RV}?.textContent ?? "").includes(${JSON.stringify(REPLY)}) && ${RV}?.querySelector("[data-working-line]") != null`, WAIT_MS))) {
                        throw new Error("Q's Rendered view never showed its transcript and working line");
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
                const waitFoot = async (cond) => {
                    const met = await polishWaitFor(h, `(() => { const f = ${FOOT}; return f != null && (${cond}); })()`, WAIT_MS);
                    return { met, foot: await h.ev(FOOT) };
                };
                const append = (lines) => appendFileSync(ctx.path, lines.join("\n") + "\n");
                const t0 = Date.now();
                const m1 = { ...M1, ts: t0 };
                const m2 = { ...M2, ts: t0 + 1 };
                const cmd = { id: CMD.id, text: CMD.text, ts: t0 + 2 };

                await step("queued: one message — its bubble with Queued · Esc to stop and send now above the working line, and the box offers ↑", async () => {
                    await report(h, ctx, [m1]);
                    const { met, foot } = await waitFoot(`f.items.length === 1 && f.lines.length === 1 && f.placeholder === ${JSON.stringify(QUEUED_PLACEHOLDER)}`);
                    await h.shot(SHOT(1, "one-queued"));
                    const ok =
                        met &&
                        foot.items[0].text === M1.text &&
                        foot.items[0].state === "queued" &&
                        !foot.items[0].command &&
                        foot.lines[0] === `Queued ${LINE_TAIL}` &&
                        foot.lineInLast &&
                        foot.footAboveWorking;
                    return [ok, foot];
                });

                await step("queued: two messages — a second bubble under the first, one line 2 queued · Esc to stop and send now under the last", async () => {
                    await report(h, ctx, [m1, m2]);
                    const { met, foot } = await waitFoot(`f.items.length === 2 && f.lines.length === 1 && f.lineInLast`);
                    await h.shot(SHOT(2, "two-queued"));
                    const ok =
                        met &&
                        foot.items.map((i) => i.text).join("|") === [M1.text, M2.text].join("|") &&
                        foot.lines[0] === `2 queued ${LINE_TAIL}` &&
                        foot.footAboveWorking;
                    return [ok, foot];
                });

                await step("queued: a slash command — its command row with the line; once it runs, its row moves into the transcript", async () => {
                    await report(h, ctx, [m1, m2, cmd]);
                    const queued = await waitFoot(`f.items.length === 3 && f.lines.length === 1 && f.lineInLast`);
                    await h.shot(SHOT(3, "command-queued"));
                    const last = queued.foot.items[2];
                    const shown = queued.met && last.command && last.text === `${CMD.name} ${CMD.args}` && queued.foot.lines[0] === `3 queued ${LINE_TAIL}`;
                    await report(h, ctx, [m1, m2], [{ id: cmd.id, how: "sent" }]);
                    append([commandRecord(CMD.name, CMD.args, iso(Date.now()))]);
                    const ran = await waitFoot(`f.items.length === 2 && f.commands.includes(${JSON.stringify(`${CMD.name} ${CMD.args}`)}) && f.lines[0] === ${JSON.stringify(`2 queued ${LINE_TAIL}`)}`);
                    return [shown && ran.met, { queued: queued.foot, ran: ran.foot }];
                });

                await step("queued: taken at the next step — the report drops both as joined and joined records land: the bubbles stay, each drawn once every frame, the line goes and the placeholder is the working one", async () => {
                    await startSampler(h, [M1.text, M2.text]);
                    const now = Date.now();
                    await report(h, ctx, [], [
                        { id: m1.id, how: "joined" },
                        { id: m2.id, how: "joined" },
                    ]);
                    append([
                        toolResult("toolu_q_test", "Test Files  41 passed (41)", { ts: iso(now) }),
                        joinedRecord(M1.text, iso(now + 1)),
                        joinedRecord(M2.text, iso(now + 1)),
                        toolUse("toolu_q_lint", "Bash", { command: "npx eslint frontend/app/view/agents/" }, { ts: iso(now + 2) }),
                    ]);
                    const { met, foot } = await waitFoot(
                        `f.items.length === 0 && f.lines.length === 0 && f.timeline.includes(${JSON.stringify(M1.text)}) && f.timeline.includes(${JSON.stringify(M2.text)})`
                    );
                    await new Promise((r) => setTimeout(r, SAMPLE_SETTLE_MS));
                    const frames = await stopSampler(h);
                    await h.shot(SHOT(4, "taken"));
                    const order = foot.timeline.indexOf(M1.text) < foot.timeline.indexOf(M2.text);
                    const once = [M1.text, M2.text].every((t) => frames?.min[t] === 1 && frames?.max[t] === 1);
                    const ok = met && order && once && foot.placeholder === WORKING_PLACEHOLDER;
                    return [ok, { foot, frames, order }];
                });

                await step("queued: typed in the terminal — an enqueue record shows a Queued bubble; its remove absorbed_mid_turn keeps the bubble and drops the line, and the box never offers ↑", async () => {
                    const now = Date.now();
                    append([queueOp("enqueue", now, { content: TERMINAL })]);
                    const queued = await waitFoot(`f.items.length === 1 && f.lines.length === 1`);
                    await h.shot(SHOT(5, "terminal-queued"));
                    const shown =
                        queued.met &&
                        queued.foot.items[0].text === TERMINAL &&
                        queued.foot.lines[0] === `Queued ${LINE_TAIL}` &&
                        queued.foot.footAboveWorking &&
                        queued.foot.placeholder === WORKING_PLACEHOLDER;
                    await startSampler(h, [TERMINAL]);
                    append([
                        queueOp("remove", now + 1_000, { content: TERMINAL, reason: "absorbed_mid_turn" }),
                        queuedAttachment(TERMINAL, now + 1_000),
                    ]);
                    const taken = await waitFoot(`f.items.length === 0 && f.lines.length === 0 && f.timeline.includes(${JSON.stringify(TERMINAL)})`);
                    await new Promise((r) => setTimeout(r, SAMPLE_SETTLE_MS));
                    const frames = await stopSampler(h);
                    await h.shot(SHOT(5, "terminal-taken"));
                    // the foot only lags its record by a render, so a frame between the two may show neither; it never shows two
                    const ok = shown && taken.met && frames?.max[TERMINAL] === 1 && taken.foot.placeholder === WORKING_PLACEHOLDER;
                    return [ok, { queued: queued.foot, taken: taken.foot, frames }];
                });

                return steps;
            },
            async teardown(h, ctx) {
                const step = async (what, fn) => {
                    try {
                        await fn();
                    } catch (err) {
                        console.error(`${NAME} teardown: ${what} failed: ${err?.message ?? err}`);
                    }
                };
                if (ctx.qBlock != null) {
                    // handed back rather than dropped, so nothing reads as lost
                    if ((ctx.held ?? []).length > 0) {
                        await step("hand back what is still held", () =>
                            report(h, ctx, [], ctx.held.map((p) => ({ id: p.id, how: "takenback" })))
                        );
                    }
                    await step("publish a Stop", () => publishStatus(h, ctx, ctx.qBlock, { state: "idle", hook: "Stop" }));
                }
                await step("restore the roster", () => restoreRoster(h));
                await step("drop the focus", () => agentPage(h, `globalStore.set(agentsModel().focusIdAtom, undefined); return true;`));
                await step("close the tabs", () => closeTabs(h, ctx));
                await step("remove the temp dir", () => rmSync(ctx.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
                await step("go home", () => h.goto("cockpit"));
            },
        },
    ];
}
