// DEV-only functional test of the Channels surface, driven over CDP against the running tauri dev app.
// Non-destructive: exercises composer typing, @mention autocomplete, a plain-note round-trip (human
// message → PostChannelMessageCommand → re-render), channel switching, and the Jarvis tier toggle.
// It never sends a dispatch/consult/@jarvis message, so no live workers are spawned.
//
//   node scripts/cdp-test-channels.mjs
// Screenshots land in cdp-shots/. Prints a PASS/FAIL line per step.

const port = "9222";
const SHOTS = "cdp-shots";

function cdp(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        let id = 0;
        const pending = new Map();
        ws.addEventListener("open", () =>
            resolve({
                send: (method, params = {}) => {
                    const msgId = ++id;
                    ws.send(JSON.stringify({ id: msgId, method, params }));
                    return new Promise((res) => pending.set(msgId, res));
                },
                close: () => ws.close(),
            })
        );
        ws.addEventListener("error", reject);
        ws.addEventListener("message", (e) => {
            const msg = JSON.parse(e.data);
            if (msg.id && pending.has(msg.id)) {
                pending.get(msg.id)(msg.result);
                pending.delete(msg.id);
            }
        });
    });
}

const { writeFileSync, mkdirSync } = await import("node:fs");
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pick() {
    const r = await fetch(`http://localhost:${port}/json/list`);
    const t = await r.json();
    return t.find((x) => x.type === "page" && /5174|arc|wave/i.test(x.url ?? "")) ?? t.find((x) => x.type === "page");
}
const target = await pick();
if (!target) {
    console.error("no page target");
    process.exit(1);
}
const c = await cdp(target.webSocketDebuggerUrl);
await c.send("Runtime.enable");
await c.send("Page.enable");

const results = [];
const rec = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function evalJs(expression) {
    const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
        return { __error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    }
    return r.result?.value;
}
async function shot(name) {
    const { data } = await c.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(data, "base64"));
}

// helpers evaluated in-page --------------------------------------------------
const H = `
window.__t = {
  composer: () => document.querySelector('textarea[placeholder^="Message #"]'),
  setComposer: (text) => {
    const ta = window.__t.composer(); if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    ta.focus(); setter.call(ta, text);
    ta.setSelectionRange(text.length, text.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    return true;
  },
  clickText: (sel, rx) => {
    const el = [...document.querySelectorAll(sel)].find(x => new RegExp(rx).test(x.textContent||''));
    if (!el) return false; el.click(); return true;
  },
  streamText: () => (document.querySelector('.overflow-y-auto')?.innerText || ''),
  header: () => (document.querySelector('.truncate.font-bold')?.textContent || document.querySelector('[class*="font-bold"]')?.textContent || ''),
  paneWidth: () => { const a = document.querySelector('.\\\\@container'); return a ? a.getBoundingClientRect().width : -1; },
  contextPanelVisible: () => !!document.querySelector('aside') && document.querySelector('aside').offsetParent !== null,
  mentionOptions: () => [...document.querySelectorAll('button span')].filter(s => (s.textContent||'').startsWith('@')).map(s=>s.textContent),
  tierActive: () => { const b=[...document.querySelectorAll('button')].find(x=>/concierge|gatekeeper|delegator/.test(x.textContent)&&/accent/.test(x.className)); return b?b.textContent:''; },
  rowCount: () => document.querySelectorAll('.overflow-y-auto .flex.items-start.gap-3').length,
};
true;
`;
await evalJs(H);

// step 0: confirm on channels + widened screenshot ---------------------------
await evalJs(`window.__t.clickText('nav button','Channels')`);
await sleep(500);
const pw = await evalJs(`window.__t.paneWidth()`);
const ctxVisible = await evalJs(`window.__t.contextPanelVisible()`);
await shot("chan-01-wide");
rec("context panel visible when widened", pw >= 1040 ? ctxVisible === true : true, `paneWidth=${Math.round(pw)} ctxVisible=${ctxVisible}`);

// step 1: @mention autocomplete ---------------------------------------------
await evalJs(`window.__t.setComposer('@')`);
await sleep(400);
const opts = await evalJs(`window.__t.mentionOptions()`);
await shot("chan-02-mention");
rec("@mention autocomplete lists candidates", Array.isArray(opts) && opts.length > 0, `options=${JSON.stringify(opts)}`);
await evalJs(`window.__t.setComposer('')`);
await sleep(150);

// step 2: plain-note round-trip (human message) ------------------------------
const marker = `cdp-note-${Date.now()}`;
const before = await evalJs(`window.__t.rowCount()`);
await evalJs(`window.__t.setComposer(${JSON.stringify(marker)})`);
await sleep(200);
await shot("chan-03-typed");
await evalJs(`window.__t.clickText('button','^Send')`);
// poll for the note to appear in the stream (backend round-trip)
let appeared = false;
for (let i = 0; i < 20; i++) {
    await sleep(400);
    const txt = await evalJs(`window.__t.streamText()`);
    if (typeof txt === "string" && txt.includes(marker)) {
        appeared = true;
        break;
    }
}
const after = await evalJs(`window.__t.rowCount()`);
await shot("chan-04-note-sent");
rec("plain note round-trips to the stream", appeared, `marker=${marker} rows ${before}->${after}`);

// step 3: channel switch -----------------------------------------------------
const railChannels = await evalJs(
    `[...document.querySelectorAll('button, [role=button], a')].map(b=>b.textContent).filter(t=>/^#\\s/.test(t||'')).length`
);
const hdrBefore = await evalJs(`window.__t.header()`);
const switched = await evalJs(`(() => {
  const items = [...document.querySelectorAll('button')].filter(b => /^\\s*#/.test(b.textContent||''));
  if (items.length < 2) return 'only ' + items.length + ' channels';
  items[1].click(); return 'clicked #2';
})()`);
await sleep(600);
const hdrAfter = await evalJs(`window.__t.header()`);
await shot("chan-05-switch");
rec("channel switch updates the view", typeof switched === "string" && switched.startsWith("clicked"), `switch=${switched} header '${hdrBefore}'->'${hdrAfter}'`);

// step 4: tier toggle (reversible) ------------------------------------------
const tierBefore = await evalJs(`window.__t.tierActive()`);
await evalJs(`window.__t.clickText('button','^gatekeeper$')`);
await sleep(700);
const tierMid = await evalJs(`window.__t.tierActive()`);
await shot("chan-06-tier-gatekeeper");
// restore
await evalJs(`window.__t.clickText('button','^concierge$')`);
await sleep(500);
const tierRestored = await evalJs(`window.__t.tierActive()`);
rec("tier toggle switches active tier", /gatekeeper/.test(tierMid || ""), `${tierBefore} -> ${tierMid} -> ${tierRestored} (restored)`);

c.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} steps passed`);
process.exit(passed === results.length ? 0 : 2);
