// Cockpit review scenarios: composer sends (F1). Each composer must hand long text to the agent as one message that
// submits once. The agents are fixture rows whose blocks are real: each runs a small node echo program that drops
// the bracketed-paste markers and prints GOT:<line> on each CR, teeing the line to a log the steps read.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COCKPIT, polishReload, polishWaitFor, TREE_RAIL_FIXTURE, waveService } from "./scenarios-shared.mjs";

const WORKING_ID = "fx-composer-working";
const WORKING_NAME = "composer worker";
const IDLE_ID = "fx-composer-idle";
const IDLE_NAME = "composer idler";
const MESSAGE_LEN = 120;
// a cold scan of every transcript root outlasts one CDP command, so it runs in the page and is polled
const SESSIONS_SCAN_TIMEOUT_MS = 120_000;
// typeWake pastes, pauses (agentask.KeystrokeDelay), then submits: well inside this
const ARRIVE_MS = 10_000;
// long enough for a stray second submit to land after the first
const SETTLE_MS = 2_000;
const IDLE_AGE_MS = 3_600_000;

// the paste markers may reach the program with or without their ESC, depending on how the pty forwards them
const ECHO_SOURCE = `import { appendFileSync } from "node:fs";
const log = process.argv[2];
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (d) => {
    buf = (buf + d).replace(/\\x1b?\\[20[01]~/g, "");
    for (let i = buf.search(/[\\r\\n]/); i >= 0; i = buf.search(/[\\r\\n]/)) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line === "") continue;
        process.stdout.write("GOT:" + line + "\\r\\n");
        appendFileSync(log, "GOT:" + line + "\\n");
    }
});
`;

// a message of exactly MESSAGE_LEN characters, unique per step so a line from one step can't satisfy another
const messageFor = (tag) => {
    const head = `${tag} composer send keeps the whole message `;
    return (head + "x".repeat(MESSAGE_LEN)).slice(0, MESSAGE_LEN);
};

const gotLines = (log) => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);

// a tab of its own whose block runs the echo program; deleting the last block of a tab deletes the tab
async function startEchoBlock(h, ctx, name) {
    const tabId = await waveService(h, "workspace", "CreateTab", [ctx.workspaceId, `verify-${name}`, false]);
    const echo = { tabId, log: join(ctx.dir, `${name}.log`) };
    ctx.echoes.push(echo);
    const tab = await waveService(h, "object", "GetObject", [`tab:${tabId}`]);
    echo.blockId = tab?.blockids?.[0];
    if (!echo.blockId) throw new Error(`the ${name} tab has no block`);
    // the cwd is ~, not the temp dir, which the process would keep locked past teardown
    await h.rpc("setmeta", {
        oref: `block:${echo.blockId}`,
        meta: { view: "term", controller: "cmd", cmd: `node '${ctx.script}' '${echo.log}'`, "cmd:cwd": "~" },
    });
    await h.rpc("controllerresync", { tabid: tabId, blockid: echo.blockId, forcerestart: true });
    return echo;
}

// a transcript the archive scan already lists (read, never written), so both agents have entries to show
async function borrowTranscript(h) {
    await h.ev(`void window.TabRpcClient.wshRpcCall("getsessionsactivity", { windowdays: 30, limit: 100 }, { timeout: ${SESSIONS_SCAN_TIMEOUT_MS} }).then(
        (r) => (window.__composerSendScan = { path: (r?.sessions ?? []).find((s) => s.transcriptpath)?.transcriptpath ?? null }),
        (e) => (window.__composerSendScan = { error: String(e?.message ?? e) })
    )`);
    await polishWaitFor(h, "window.__composerSendScan != null", SESSIONS_SCAN_TIMEOUT_MS);
    const scan = await h.ev("(() => { const s = window.__composerSendScan; delete window.__composerSendScan; return s ?? null; })()");
    if (scan?.error != null) throw new Error(`the sessions scan failed: ${scan.error}`);
    if (!scan?.path) throw new Error("no listed session has a transcript to borrow");
    return scan.path;
}

// types into a composer the way React sees typing, then presses its Send button
const sendFrom = (placeholder, text) => `(() => {
    const ta = [...(${COCKPIT}?.querySelectorAll("textarea") ?? [])].find((t) => t.placeholder === ${JSON.stringify(placeholder)});
    if (!ta) return "no composer";
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    const send = [...ta.parentElement.querySelectorAll("button")].find((b) => b.textContent.trim() === "Send");
    if (!send || send.disabled) return "send is disabled";
    send.click();
    return "sent";
})()`;

// parenthesized: callers compare it with != null, which would otherwise bind tighter than its ??
const composerValue = (placeholder) =>
    `([...(${COCKPIT}?.querySelectorAll("textarea") ?? [])].find((t) => t.placeholder === ${JSON.stringify(placeholder)})?.value ?? null)`;

// sends text from a composer and waits for the echo; ok when the whole text arrived once and the composer cleared
async function sendAndCheck(h, placeholder, echo, text) {
    const before = gotLines(echo.log).length;
    const sent = await h.ev(sendFrom(placeholder, text));
    if (sent !== "sent") return { ok: false, detail: sent };
    const want = `GOT:${text}`;
    for (const deadline = Date.now() + ARRIVE_MS; Date.now() < deadline && !gotLines(echo.log).includes(want); ) {
        await new Promise((r) => setTimeout(r, 250));
    }
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const lines = gotLines(echo.log).slice(before);
    const cleared = (await h.ev(composerValue(placeholder))) === "";
    return {
        ok: lines.length === 1 && lines[0] === want && cleared,
        detail: JSON.stringify({ lines, cleared }),
    };
}

export const cockpitComposerSend = {
    name: "cockpit-composer-send",
    surface: "cockpit",
    async arrange(h) {
        const ctx = { echoes: [] };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            ctx.dir = mkdtempSync(join(tmpdir(), "verify-composer-send-"));
            ctx.script = join(ctx.dir, "echo.mjs");
            writeFileSync(ctx.script, ECHO_SOURCE);
            const bootTab = String(await h.ev("window.TabRpcClient.routeId")).replace(/^tab:/, "");
            const wslist = await h.rpc("workspacelist", null);
            const ws = wslist.find((w) => (w.workspacedata?.tabids ?? []).includes(bootTab)) ?? wslist[0];
            ctx.workspaceId = ws.workspacedata.oid;
            ctx.working = await startEchoBlock(h, ctx, "composer-working");
            ctx.idle = await startEchoBlock(h, ctx, "composer-idle");
            const transcriptPath = await borrowTranscript(h);
            const now = Date.now();
            mkdirSync(new URL(".", TREE_RAIL_FIXTURE), { recursive: true });
            writeFileSync(
                TREE_RAIL_FIXTURE,
                JSON.stringify(
                    [
                        {
                            id: WORKING_ID,
                            name: WORKING_NAME,
                            project: "composer-send",
                            task: "echo what the composer sends",
                            activity: "waiting for a message",
                            state: "working",
                            agent: "claude",
                            model: "opus",
                            activeMs: 120_000,
                            blockId: ctx.working.blockId,
                            transcriptPath,
                        },
                        {
                            id: IDLE_ID,
                            name: IDLE_NAME,
                            project: "composer-send",
                            task: "echo what the idle row sends",
                            state: "idle",
                            agent: "claude",
                            model: "opus",
                            activeMs: IDLE_AGE_MS,
                            // past the idle grace window, so it is parked in the Idle list
                            idleSince: now - IDLE_AGE_MS,
                            blockId: ctx.idle.blockId,
                            transcriptPath,
                        },
                    ],
                    null,
                    2
                )
            );
            ctx.wroteFixture = true;
            // the fixture roster is read once at boot
            await polishReload(h);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        if (ctx.arrangeError) return [{ step: "cockpit-composer-send arrange", ok: false, detail: ctx.arrangeError }];
        const steps = [];
        const run = async (step, fn) => {
            try {
                steps.push({ step, ...(await fn()) });
            } catch (e) {
                steps.push({ step, ok: false, detail: String(e?.message ?? e) });
            }
        };

        await run("a 120-character card reply arrives whole and submits once", async () => {
            const card = `${COCKPIT}?.querySelector('[data-agent-id="${WORKING_ID}"]')`;
            if (!(await polishWaitFor(h, `!!(${card})`, 10000))) return { ok: false, detail: "the working card never rendered" };
            // the footer's slim "+ message…" row expands into the composer
            const opened = await h.ev(`(() => {
                const row = [...(${card}.querySelectorAll("span") ?? [])].find((s) => s.textContent === ${JSON.stringify(`message ${WORKING_NAME}…`)});
                if (!row) return false;
                row.parentElement.click();
                return true;
            })()`);
            if (!opened) return { ok: false, detail: "the card has no message row" };
            const placeholder = `message ${WORKING_NAME}…`;
            if (!(await polishWaitFor(h, `${composerValue(placeholder)} != null`, 3000))) {
                return { ok: false, detail: "the card composer never opened" };
            }
            const r = await sendAndCheck(h, placeholder, ctx.working, messageFor("card"));
            await h.shot("cdp-shots/cockpit-composer-send-card.png");
            return r;
        });

        await run("the Idle row composer sends the same way", async () => {
            const header = `[...(${COCKPIT}?.querySelectorAll("h2") ?? [])].find((e) => e.textContent.trim() === "Idle")`;
            if (!(await polishWaitFor(h, `!!(${header})`, 5000))) return { ok: false, detail: "no Idle section: the idle agent is not parked" };
            const placeholder = `message ${IDLE_NAME}…`;
            if ((await h.ev(composerValue(placeholder))) == null) await h.ev(`${header}.click()`);
            if (!(await polishWaitFor(h, `${composerValue(placeholder)} != null`, 3000))) {
                return { ok: false, detail: "the Idle row has no composer" };
            }
            const r = await sendAndCheck(h, placeholder, ctx.idle, messageFor("idle"));
            await h.shot("cdp-shots/cockpit-composer-send-idle.png");
            return r;
        });
        return steps;
    },
    async teardown(h, ctx) {
        const failed = [];
        const undo = [
            ["remove the fixture roster", () => ctx.wroteFixture && rmSync(TREE_RAIL_FIXTURE, { force: true })],
            ...ctx.echoes.map((e) => [
                `close the echo tab ${e.tabId}`,
                () => waveService(h, "workspace", "CloseTab", [ctx.workspaceId, e.tabId, false]),
            ]),
            ["remove the temp dir", () => ctx.dir && rmSync(ctx.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })],
            // onto the live roster again
            ["reload", () => polishReload(h)],
            ["return to the cockpit", () => h.goto("cockpit")],
        ];
        for (const [what, fn] of undo) {
            try {
                await fn();
            } catch (e) {
                failed.push(`${what}: ${e?.message ?? e}`);
            }
        }
        if (failed.length > 0) throw new Error(`cockpit-composer-send teardown: ${failed.join("; ")}`);
    },
};
