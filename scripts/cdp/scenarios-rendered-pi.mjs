// Scenario `rendered-pi`: a pi agent in the Rendered view (docs/superpowers/plans/2026-11-19-pi-rendered-view.md). The
// roster is a fixture of one pi agent P backed by a real tab whose block runs the key probe (fixtures/keyprobe.mjs), so
// what the box types into its pty is read back from a file. P's transcript is a pi v3 session file in a temp dir, and
// its status is published with agent "pi" and no hook, as the arc pi extension reports it. Teardown clears the ask and
// the published commands, publishes an idle status, restores the roster and the default view, closes the tab and
// removes the dir.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    agentPage,
    closeTabs,
    focusAgent,
    makeTab,
    pinDefaultView,
    restoreDefaultView,
    restoreRoster,
    setRoster,
} from "./agent-page-fixtures.mjs";
import { polishWaitFor } from "./scenarios-shared.mjs";

const NAME = "rendered-pi";
const KEYPROBE = fileURLToPath(new URL("./fixtures/keyprobe.mjs", import.meta.url));
const MODEL_ID = "claude-opus-5-5";
const WAIT_MS = 10_000;
const PROBE_BOOT_MS = 20_000;
const PROBE_SETTLE_MS = 1_000;
const PROBE_WAIT_MS = 5_000;
// a status that must not unflip the view is given this long to do it anyway
const HOLD_MS = 800;
const FOLD_MOTION_MS = 600;
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
const iso = (ms) => new Date(ms).toISOString();

const PROMPT = "Rename the retry helper and run the tests.";
const REPLY = "Renamed retryOnce to retryWithBackoff; the tests pass.";
// what P reports: the ring reads it off the roster row, as the live roster reads pi's --usage reports
const USAGE = { contextpct: 23, contextmax: 200_000 };
// pi 1.5.2's built-ins, in its order (picommands.ts)
const PI_BUILTINS = [
    "settings", "model", "tree", "thinking", "scoped-models", "export", "import", "share", "bug", "copy", "name",
    "session", "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "new", "compact", "resume", "reload",
    "quit",
];
// what the arc pi extension publishes for P's block: pi.getCommands() with pi's own sources
const PUBLISHED = [
    { name: "fx-deploy", description: "Deploy the fixture", source: "extension" },
    { name: "fx-review", description: "Review the diff", source: "prompt" },
    { name: "skill:fx-pdf", description: "Read PDFs", source: "skill" },
];
const GROUPS = ["Built-in", "Extensions", "Prompts", "Skills"];
// the reasoning of a message with no reply text, before its tool call
const THOUGHT = "The call sites may live outside this package, so list them first.";
const BASH_CMD = "echo from-pi";
// a `!` command already in P's transcript, as pi writes one the person ran
const BANG_CMD = "git status --short";
const BANG_OUT = "fatal: not a git repository";
const BANG_EXIT = 128;
// a box message sent while P works: pi takes it as a steer, so it waits in the foot
const STEER = "Also rename the call sites in cmd/.";
const QUEUED_TAIL = "Esc to stop and send now";
const ASK_QUESTION = { header: "Scope", question: "Which scope should the rename cover?", options: [{ label: "this file" }, { label: "the package" }] };

// every query is scoped to the Agent surface
const SURF = `document.querySelector("[data-cockpit-surface-wrap]")`;
const RV = `${SURF}?.querySelector("[data-rendered-view]")`;
const BOX = `${RV}?.querySelector("[data-rendered-composer] [data-composer-box]")`;
const TA = `${BOX}?.querySelector("textarea")`;
const PANEL = `${RV}?.querySelector("[data-rendered-composer] [data-slash-panel]")`;
const RING = `${RV}?.querySelector("[data-rendered-composer] [data-context-ring]")`;
const ASK = `${RV}?.querySelector("[data-rendered-ask]")`;
const FLAT = `const flat = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();`;

// which view the center shows for an agent
const viewOf = (id) => `(() => {
    const s = ${SURF};
    const term = s?.querySelector('[data-agent-terminal="${id}"]');
    return {
        rendered: s?.querySelector("[data-rendered-view]") != null,
        termShown: term != null && term.checkVisibility({ visibilityProperty: true }),
    };
})()`;

// a pi v3 session file: the session header, then each message parented on the one before, so all are on the active
// branch
function writePiTranscript(dir, name, messages) {
    const t0 = Date.now() - 60_000;
    const lines = [{ type: "session", version: 3, id: `fx-${name}`, timestamp: iso(t0), cwd: dir }];
    messages.forEach((message, i) => {
        lines.push({ type: "message", id: `m${i}`, parentId: i === 0 ? null : `m${i - 1}`, timestamp: iso(t0 + i * 1_000), message });
    });
    const path = join(dir, `${name}.jsonl`);
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return path;
}

// sets the box's text as typing would
const typeComposer = (h, text) =>
    h.ev(`(() => {
        const ta = ${TA};
        if (!ta) return false;
        ta.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, ${JSON.stringify(text)});
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
    })()`);

const pressInBox = (h, key) =>
    h.ev(`(() => {
        const ta = ${TA};
        if (!ta) return false;
        ta.focus();
        ta.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, code: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
        return true;
    })()`);

// an agent:status as the arc pi extension publishes it: agent pi, no hook, and a ts later than every earlier one, or
// the server drops it as stale
async function publishStatus(h, ctx, fields) {
    const ts = Math.max(Date.now(), (ctx.lastTs ?? 0) + 1);
    ctx.lastTs = ts;
    const oref = `block:${ctx.pBlock}`;
    await h.rpc("eventpublish", { event: "agent:status", scopes: [oref], data: { oref, agent: "pi", ts, ...fields } });
}

// P's roster state: the fixture roster stands in for the live one, so a published state does not reach it
const setPState = (h, ctx, state) =>
    agentPage(
        h,
        `const D = await mod("app/view/agents/devmock.ts");
        globalStore.set(D.devMockAgentsAtom, globalStore.get(D.devMockAgentsAtom).map((a) =>
            a.id === ${JSON.stringify(ctx.pId)} ? { ...a, state: ${JSON.stringify(state)} } : a));
        return true;`
    );

// the foot's items and its Queued line
const FOOT = `(() => {
    ${FLAT}
    const foot = ${RV}?.querySelector("[data-queued-foot]");
    return {
        items: [...(foot?.querySelectorAll("[data-queued-item]") ?? [])].map((el) => flat(el.firstElementChild)),
        line: flat(foot?.querySelector("[data-queued-line]")),
    };
})()`;

const probeLines = (ctx) => (existsSync(ctx.probe) ? readFileSync(ctx.probe, "utf8").split("\n").filter(Boolean) : []);

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

// the panel's list in order: each group title with the names under it, and each row's opens-in-Terminal mark
const panelRows = `(() => {
    ${FLAT}
    const list = ${PANEL}?.querySelector('[role="listbox"]');
    const groups = [];
    for (const el of list?.children ?? []) {
        if (!el.hasAttribute("data-suggest-item")) {
            groups.push({ title: flat(el), rows: [] });
            continue;
        }
        const mark = el.querySelector("[data-opens-terminal]");
        groups.at(-1)?.rows.push({
            name: el.querySelector("[data-slash-name]")?.textContent ?? "",
            terminal: mark != null,
            title: mark ? mark.title || mark.getAttribute("data-arc-title") : null,
        });
    }
    return groups;
})()`;

const rosterAgent = (id, blockId, name, transcriptPath) => ({
    id,
    name,
    project: "fx-rendered-pi",
    task: "rendered pi fixture",
    state: "idle",
    agent: "pi",
    model: MODEL_ID,
    usage: USAGE,
    blockId,
    transcriptPath,
});

export const renderedPi = {
    name: NAME,
    surface: "agent",
    async arrange(h) {
        const tag = Date.now().toString(36);
        const ctx = { tabIds: [], dir: mkdtempSync(join(tmpdir(), "verify-rendered-pi-")) };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            // the shipped default, whatever this dev app's Settings hold
            await pinDefaultView(h, "rendered");
            ctx.probe = join(ctx.dir, "keyprobe.log");
            const pPath = writePiTranscript(ctx.dir, `pi-p-${tag}`, [
                { role: "user", content: PROMPT, timestamp: Date.now() - 60_000 },
                {
                    role: "assistant",
                    content: [
                        { type: "thinking", thinking: THOUGHT, thinkingSignature: "fx" },
                        { type: "toolCall", id: "fx-ls", name: "ls", arguments: { path: "cmd" } },
                    ],
                    model: MODEL_ID,
                    provider: "anthropic",
                },
                { role: "toolResult", toolCallId: "fx-ls", toolName: "ls", content: [{ type: "text", text: "main.go" }], isError: false },
                { role: "assistant", content: [{ type: "text", text: REPLY }], model: MODEL_ID, provider: "anthropic" },
                {
                    role: "bashExecution",
                    command: BANG_CMD,
                    output: `${BANG_OUT}\n`,
                    exitCode: BANG_EXIT,
                    cancelled: false,
                    truncated: false,
                    timestamp: Date.now() - 50_000,
                },
            ]);
            await h.goto("agent");
            // the cwd is ~, not the temp dir, which the probe would keep locked past teardown. An agent session's block
            // is deleted 2s after its process exits unless it keeps on exit
            const p = await makeTab(h, ctx, {
                label: `pi-p-${tag}`,
                blockMeta: {
                    view: "term",
                    controller: "cmd",
                    cmd: `node '${KEYPROBE}' '${ctx.probe}'`,
                    "cmd:cwd": "~",
                    "cmd:keeponexit": true,
                },
            });
            Object.assign(ctx, { pId: p.tabId, pBlock: p.blockId, pName: `pi-p-${tag}` });
            // the meta change can start a probe that ends at once; the file the restarted one writes is the proof a
            // live probe is reading
            await new Promise((r) => setTimeout(r, PROBE_SETTLE_MS));
            rmSync(ctx.probe, { force: true });
            await h.rpc("controllerresync", { tabid: p.tabId, blockid: p.blockId, forcerestart: true });
            for (const end = Date.now() + PROBE_BOOT_MS; !existsSync(ctx.probe) && Date.now() < end; ) {
                await new Promise((r) => setTimeout(r, 200));
            }
            if (!existsSync(ctx.probe)) throw new Error(`the key probe never started (no ${ctx.probe})`);
            await setRoster(h, [rosterAgent(p.tabId, p.blockId, ctx.pName, pPath)]);
            await publishStatus(h, ctx, { state: "idle", model: MODEL_ID, transcriptpath: pPath });
            await focusAgent(h, ctx.pId);
        } catch (err) {
            ctx.arrangeError = String(err?.message ?? err);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
        if (ctx.arrangeError != null) {
            rec(`${NAME}: arrange`, false, ctx.arrangeError);
            return steps;
        }
        // one throwing step is one FAIL, not the end of the run
        const step = async (name, fn) => {
            try {
                const [ok, detail] = await fn();
                rec(name, ok, detail);
            } catch (err) {
                rec(name, false, `threw: ${err?.message ?? err}`);
            }
        };
        const wait = (expr, ms = WAIT_MS) => polishWaitFor(h, expr, ms);
        const oref = `block:${ctx.pBlock}`;

        await step("rendered-pi: P opens in Rendered with its pi transcript drawn and the ring at the reported percent", async () => {
            const drawn = await wait(
                `(${RV}?.textContent ?? "").includes(${JSON.stringify(PROMPT)}) && (${RV}?.textContent ?? "").includes(${JSON.stringify(REPLY)})`
            );
            const view = await h.ev(viewOf(ctx.pId));
            const ring = await h.ev(`(${RING}?.textContent ?? "").trim()`);
            await h.shot(SHOT(1, "rendered"));
            return [drawn && view.rendered && !view.termShown && ring === `${USAGE.contextpct}%`, { drawn, view, ring }];
        });

        await step(`rendered-pi: P's transcript's !${BANG_CMD} draws as a command row with its output and exit ${BANG_EXIT}`, async () => {
            const rowOf = `[...(${RV}?.querySelectorAll("[data-shell-run]") ?? [])].find((r) => flat(r.querySelector("[data-shell-command]")) === ${JSON.stringify(BANG_CMD)})`;
            const drawn = await wait(`(() => { ${FLAT} return ${rowOf} != null; })()`);
            const row = await h.ev(`(() => {
                ${FLAT}
                const row = ${rowOf};
                return row ? { exit: flat(row.querySelector('[data-shell-mark="exit"]')), out: flat(row.querySelector("[data-shell-stdout]")) } : null;
            })()`);
            await agentPage(h, `${RV}?.querySelector("[data-shell-run]")?.scrollIntoView({ block: "center" }); await nap(200); return true;`);
            await h.shot(SHOT(1, "bang-row"));
            return [drawn && row?.exit === `exit ${BANG_EXIT}` && row.out.includes(BANG_OUT), { drawn, row }];
        });

        await step("rendered-pi: a thinking-only message in P's transcript draws as a thought", async () => {
            // the thought sits in the turn's fold, above its reply
            await agentPage(h, `${RV}?.querySelectorAll('[data-fold][aria-expanded="false"]').forEach((b) => b.click()); await nap(${FOLD_MOTION_MS}); return true;`);
            const thoughtOf = `[...(${RV}?.querySelectorAll("[data-thought]") ?? [])].find((t) => flat(t) === ${JSON.stringify(THOUGHT)})`;
            const drawn = await wait(`(() => { ${FLAT} return ${thoughtOf} != null; })()`);
            await agentPage(h, `(() => { ${FLAT} ${thoughtOf}?.scrollIntoView({ block: "center" }); })(); await nap(200); return true;`);
            await h.shot(SHOT(1, "thought"));
            return [drawn, { drawn }];
        });

        await step("rendered-pi: / lists pi's built-ins with /settings opening in Terminal, then the published commands under Extensions, Prompts and Skills", async () => {
            await h.rpc("setclaudelivecommands", { blockid: ctx.pBlock, commands: PUBLISHED });
            try {
                await typeComposer(h, "/");
                const opened = await wait(`(${PANEL}?.querySelectorAll("[data-suggest-item]").length ?? 0) === ${PI_BUILTINS.length + PUBLISHED.length}`);
                const groups = await h.ev(panelRows);
                await h.shot(SHOT(2, "slash-panel"));
                const rows = groups.flatMap((g) => g.rows);
                const builtin = groups.find((g) => g.title === "Built-in");
                const row = (name) => rows.find((r) => r.name === `/${name}`);
                const ok =
                    opened &&
                    JSON.stringify(groups.map((g) => g.title)) === JSON.stringify(GROUPS) &&
                    JSON.stringify(builtin?.rows.map((r) => r.name)) === JSON.stringify(PI_BUILTINS.map((n) => `/${n}`)) &&
                    JSON.stringify(groups.slice(1).map((g) => g.rows.map((r) => r.name))) ===
                        JSON.stringify(PUBLISHED.map((c) => [`/${c.name}`])) &&
                    row("settings")?.terminal === true &&
                    (row("settings")?.title ?? "").includes("Pi") &&
                    row("compact")?.terminal === false &&
                    row("model")?.terminal === true &&
                    // Claude's built-ins are not pi's
                    row("config") == null;
                return [ok, { opened, groups }];
            } finally {
                await typeComposer(h, "");
            }
        });

        await step("rendered-pi: sending /settings shows the terminal; a working report mid-turn keeps it; pi's idle report after it returns to Rendered", async () => {
            // a turn in progress, so the working report after the flip is one mid-turn
            await publishStatus(h, ctx, { state: "working", detail: "running go test" });
            const from = probeLines(ctx).length;
            await typeComposer(h, "/settings");
            await wait(`${PANEL} != null`);
            await pressInBox(h, "Enter");
            // statuses after the flip carry a later ts than the Date.now() the flip took
            ctx.lastTs = Math.max(ctx.lastTs ?? 0, Date.now());
            const flipped = await wait(`!${viewOf(ctx.pId)}.rendered && ${viewOf(ctx.pId)}.termShown`);
            const typed = await waitDecoded(ctx, from, ["/settings", "\r"]);
            await h.shot(SHOT(3, "picker-flip"));
            await publishStatus(h, ctx, { state: "working", detail: "reading a.go" });
            await new Promise((r) => setTimeout(r, HOLD_MS));
            const held = await h.ev(viewOf(ctx.pId));
            await publishStatus(h, ctx, { state: "idle" });
            const back = await wait(`${viewOf(ctx.pId)}.rendered`);
            await h.shot(SHOT(3, "picker-back"));
            const ok = flipped && typed.ok && !held.rendered && back;
            return [ok, { flipped, typed: JSON.stringify(typed.text.slice(-120)), held, back }];
        });

        await step(`rendered-pi: a bash-mode Run types !, ${BASH_CMD} and Enter into P's block`, async () => {
            await wait(`${TA} != null`);
            await typeComposer(h, "!");
            const on = await wait(`${BOX}?.hasAttribute("data-bash-mode") === true`);
            await typeComposer(h, BASH_CMD);
            const from = probeLines(ctx).length;
            await pressInBox(h, "Enter");
            const decoded = await waitDecoded(ctx, from, ["!", BASH_CMD, "\r"]);
            const bang = decoded.text.indexOf("!");
            const at = decoded.text.indexOf(BASH_CMD, bang);
            const ordered = bang >= 0 && at > bang && decoded.text.indexOf("\r", at) > at;
            const left = await wait(`${TA}?.value === "" && !${BOX}?.hasAttribute("data-bash-mode")`);
            return [on && decoded.ok && ordered && left, { on, ordered, left, input: JSON.stringify(decoded.text.slice(-120)) }];
        });

        await step("rendered-pi: a box send while P works waits in the foot with the Queued · Esc to stop and send now line", async () => {
            await setPState(h, ctx, "working");
            // a new turn: the send comes after its boundary
            await publishStatus(h, ctx, { state: "working", detail: "running go test" });
            await new Promise((r) => setTimeout(r, 50));
            await wait(`${RV}?.querySelector("[data-rendered-composer] [data-composer-interrupt]") != null`);
            const from = probeLines(ctx).length;
            await typeComposer(h, STEER);
            await pressInBox(h, "Enter");
            const typed = await waitDecoded(ctx, from, [STEER]);
            const queued = await wait(
                `(() => { const f = ${FOOT}; return f.items.length === 1 && f.items[0] === ${JSON.stringify(STEER)} && f.line.includes(${JSON.stringify(QUEUED_TAIL)}); })()`
            );
            const foot = await h.ev(FOOT);
            await agentPage(h, `${RV}?.querySelector("[data-queued-foot]")?.scrollIntoView({ block: "center" }); await nap(200); return true;`);
            await h.shot(SHOT(4, "queued"));
            return [typed.ok && queued, { typed: typed.ok, foot }];
        });

        await step("rendered-pi: Stop types Esc, then Enter only after P's idle report, and the foot clears", async () => {
            const from = probeLines(ctx).length;
            const clicked = await h.ev(`(() => { const b = ${RV}?.querySelector("[data-rendered-composer] [data-composer-interrupt]"); b?.click(); return b != null; })()`);
            const esc = await waitDecoded(ctx, from, ["\x1b"]);
            // pi has not settled yet, so nothing more is typed
            await new Promise((r) => setTimeout(r, HOLD_MS));
            const before = await waitDecoded(ctx, from, ["\x1b"]);
            const early = before.text.slice(before.text.indexOf("\x1b")).includes("\r");
            await publishStatus(h, ctx, { state: "idle" });
            const after = await waitDecoded(ctx, from, ["\x1b", "\r"]);
            const ordered = after.text.indexOf("\r", after.text.indexOf("\x1b")) > 0;
            const enters = after.text.split("\r").length - 1;
            const cleared = await wait(`${RV}?.querySelector("[data-queued-foot]") == null`);
            await setPState(h, ctx, "idle");
            const ok = clicked && esc.ok && !early && after.ok && ordered && enters === 1 && cleared;
            return [ok, { clicked, esc: esc.ok, early, ordered, enters, cleared, input: JSON.stringify(after.text.slice(-40)) }];
        });

        await step("rendered-pi: with a foot queued again, the header's Interrupt turn types Esc, then one Enter after P's idle report, and the foot clears", async () => {
            await setPState(h, ctx, "working");
            await publishStatus(h, ctx, { state: "working", detail: "running go test" });
            await new Promise((r) => setTimeout(r, 50));
            const sentFrom = probeLines(ctx).length;
            await wait(`${TA} != null`);
            await typeComposer(h, STEER);
            await pressInBox(h, "Enter");
            const typed = await waitDecoded(ctx, sentFrom, [STEER]);
            const queued = await wait(`(() => { const f = ${FOOT}; return f.items.length === 1 && f.items[0] === ${JSON.stringify(STEER)}; })()`);
            const from = probeLines(ctx).length;
            const menu = await agentPage(
                h,
                `const { contextMenuAtom, closeContextMenu } = await mod("app/store/contextmenu.ts");
                const hd = ${SURF}?.querySelector("[data-agent-header]");
                if (hd == null) return { error: "no [data-agent-header]" };
                hd.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
                await until(() => globalStore.get(contextMenuAtom) != null, 2000);
                const hit = (globalStore.get(contextMenuAtom)?.items ?? []).find((i) => i.label === "Interrupt turn");
                closeContextMenu();
                hit?.click?.();
                return { picked: hit != null };`
            );
            const esc = await waitDecoded(ctx, from, ["\x1b"]);
            await new Promise((r) => setTimeout(r, HOLD_MS));
            const before = await waitDecoded(ctx, from, ["\x1b"]);
            const early = before.text.slice(before.text.indexOf("\x1b")).includes("\r");
            await publishStatus(h, ctx, { state: "idle" });
            await waitDecoded(ctx, from, ["\x1b", "\r"]);
            // a second Enter would follow at once, so give it the time to land before counting
            await new Promise((r) => setTimeout(r, HOLD_MS));
            const after = await waitDecoded(ctx, from, ["\x1b", "\r"]);
            const ordered = after.text.indexOf("\r", after.text.indexOf("\x1b")) > 0;
            const enters = after.text.split("\r").length - 1;
            const cleared = await wait(`${RV}?.querySelector("[data-queued-foot]") == null`);
            await setPState(h, ctx, "idle");
            const ok = typed.ok && queued && menu?.picked === true && esc.ok && !early && after.ok && ordered && enters === 1 && cleared;
            return [ok, { typed: typed.ok, queued, menu, esc: esc.ok, early, ordered, enters, cleared, input: JSON.stringify(after.text.slice(-40)) }];
        });

        await step("rendered-pi: an ask raised for P's block docks as the card in its column, and the box's notice names Pi", async () => {
            const rtn = await h.rpc("ask", { oref, questions: [ASK_QUESTION] });
            ctx.askRaised = true;
            // the fixture roster stands in for the live one, so the ask is put on P the way the live roster does it
            const patched = await agentPage(
                h,
                `const { getAgentAskAtom } = await mod("app/view/agents/agentaskstore.ts");
                const { withAsk } = await mod("app/view/agents/agentsviewmodel.ts");
                const D = await mod("app/view/agents/devmock.ts");
                const askAtom = getAgentAskAtom(${JSON.stringify(oref)});
                const want = ${JSON.stringify(rtn?.askid ?? null)};
                const raised = () => { const a = globalStore.get(askAtom); return a != null && !a.cleared && (want == null || a.askid === want); };
                if (!(await until(raised, 5000))) return false;
                const ask = globalStore.get(askAtom);
                globalStore.set(D.devMockAgentsAtom, globalStore.get(D.devMockAgentsAtom).map((a) =>
                    a.id === ${JSON.stringify(ctx.pId)} ? withAsk(a, ask, Date.now()) : a));
                return true;`
            );
            const docked = await wait(`${ASK} != null`);
            await typeComposer(h, "hold on");
            const card = await h.ev(`(() => {
                ${FLAT}
                const ask = ${ASK};
                const col = ${RV}?.querySelector("[data-rendered-column]");
                return {
                    inColumn: ask != null && ask.parentElement === col,
                    question: flat(ask).includes(${JSON.stringify(ASK_QUESTION.question)}),
                    notice: flat(${RV}?.querySelector("[data-rendered-composer] [data-composer-notice]")),
                    sendDisabled: ${RV}?.querySelector("[data-rendered-composer] [data-composer-send]")?.disabled ?? null,
                };
            })()`);
            await agentPage(h, `${ASK}?.scrollIntoView({ block: "center" }); await nap(200); return true;`);
            await h.shot(SHOT(5, "ask"));
            await typeComposer(h, "");
            const ok =
                patched &&
                docked &&
                card.inColumn &&
                card.question &&
                card.sendDisabled === true &&
                card.notice.includes("Pi") &&
                !card.notice.includes("Claude");
            return [ok, { patched, docked, card }];
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
        await step("restore the default view", () => restoreDefaultView(h));
        if (ctx.pBlock) {
            if (ctx.askRaised) await step("clear the ask", () => h.rpc("agentaskclear", `block:${ctx.pBlock}`));
            await step("clear the published commands", () => h.rpc("setclaudelivecommands", { blockid: ctx.pBlock, commands: [] }));
            await step("publish an idle status", () => publishStatus(h, ctx, { state: "idle" }));
        }
        await step("restore the roster", () => restoreRoster(h));
        await step("drop the focus", () => agentPage(h, `globalStore.set(agentsModel().focusIdAtom, undefined); return true;`));
        await step("close the tabs", () => closeTabs(h, ctx));
        await step("remove the temp dir", () => rmSync(ctx.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
        await step("go home", () => h.goto("cockpit"));
    },
};
