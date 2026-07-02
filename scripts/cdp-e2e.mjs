// DEV-only live E2E driver for the Channels Jarvis tiers. One phase per invocation so each stays
// observable and under timeouts. Drives the real UI over CDP; spawns REAL workers for gatekeeper/
// delegator. Tasks are strictly no-op (ask/echo, explicitly no edits) so the repo stays clean.
//
//   node scripts/cdp-e2e.mjs tier <concierge|gatekeeper|delegator> [report|manage]
//   node scripts/cdp-e2e.mjs send "<message>"
//   node scripts/cdp-e2e.mjs watch "<regex>" <timeoutSec> <shotName>
//   node scripts/cdp-e2e.mjs dump           # print current stream text + roster/context panel
//   node scripts/cdp-e2e.mjs shot <name>

const port = "9222";
const SHOTS = "cdp-shots";
const [cmd, a1, a2, a3] = process.argv.slice(2);

function cdp(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        let id = 0;
        const pending = new Map();
        ws.addEventListener("open", () =>
            resolve({
                send: (m, p = {}) => {
                    const i = ++id;
                    ws.send(JSON.stringify({ id: i, method: m, params: p }));
                    return new Promise((r) => pending.set(i, r));
                },
                close: () => ws.close(),
            })
        );
        ws.addEventListener("error", reject);
        ws.addEventListener("message", (e) => {
            const m = JSON.parse(e.data);
            if (m.id && pending.has(m.id)) {
                pending.get(m.id)(m.result);
                pending.delete(m.id);
            }
        });
    });
}
const { writeFileSync, mkdirSync } = await import("node:fs");
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r = await fetch(`http://localhost:${port}/json/list`);
const pg = (await r.json()).find((x) => x.type === "page");
const c = await cdp(pg.webSocketDebuggerUrl);
await c.send("Runtime.enable");
await c.send("Page.enable");
async function ev(expr) {
    const x = await c.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (x.exceptionDetails) return { __err: x.exceptionDetails.exception?.description || x.exceptionDetails.text };
    return x.result?.value;
}
async function shot(name) {
    const { data } = await c.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(data, "base64"));
    console.log(`shot -> ${SHOTS}/${name}.png`);
}

// in-page helpers. STREAM = the channel message list (unique max-w-[760px] col).
const H = `window.__e = {
  onChannels: () => !!document.querySelector('textarea[placeholder^="Message #"]'),
  goChannels: () => { const b=[...document.querySelectorAll('nav button')].find(x=>/Channels/.test(x.textContent||'')); if(b)b.click(); },
  firstChannel: () => { const b=[...document.querySelectorAll('button')].find(x=>/^\\s*#\\s/.test(x.textContent||'')); if(b)b.click(); return b?b.textContent.trim():''; },
  stream: () => { const cols=[...document.querySelectorAll('[class*="max-w-"]')].filter(d=>/flex-col/.test(d.className)&&/gap-5/.test(d.className)); return cols[0]||null; },
  streamText: () => { const s=window.__e.stream(); return s?s.innerText:''; },
  rows: () => { const s=window.__e.stream(); return s?s.children.length:0; },
  tierActive: () => { const b=[...document.querySelectorAll('button')].find(x=>/^(concierge|gatekeeper|delegator)$/.test((x.textContent||'').trim())&&/accent/.test(x.className)); return b?b.textContent.trim():''; },
  setTier: (t) => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()===t); if(b){b.click();return true;} return false; },
  panel: () => { const a=document.querySelector('aside'); return a?a.innerText:''; },
  setComposer: (text) => { const ta=document.querySelector('textarea[placeholder^="Message #"]'); if(!ta)return false;
    const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
    ta.focus(); setter.call(ta,text); ta.setSelectionRange(text.length,text.length);
    ta.dispatchEvent(new Event('input',{bubbles:true})); return true; },
  send: () => { const b=[...document.querySelectorAll('button')].find(x=>/^Send/.test((x.textContent||'').trim())); if(b){b.click();return true;} return false; },
}; true;`;
await ev(H);
await ev(`if(!window.__e.onChannels()) window.__e.goChannels();`);
await sleep(400);
await ev(`if(window.__e.rows()===0) window.__e.firstChannel();`);
await sleep(300);

if (cmd === "tier") {
    const ok = await ev(`window.__e.setTier(${JSON.stringify(a1)})`);
    await sleep(600);
    const active = await ev(`window.__e.tierActive()`);
    console.log(`setTier ${a1} -> ok=${ok} active=${active}`);
} else if (cmd === "send") {
    const set = await ev(`window.__e.setComposer(${JSON.stringify(a1)})`);
    await sleep(250);
    const sent = await ev(`window.__e.send()`);
    console.log(`send set=${set} clicked=${sent} :: ${a1}`);
} else if (cmd === "watch") {
    const rx = new RegExp(a1);
    const timeout = (Number(a2) || 60) * 1000;
    const deadline = Date.now() + timeout;
    let hit = false;
    while (Date.now() < deadline) {
        const t = await ev(`window.__e.streamText()`);
        if (typeof t === "string" && rx.test(t)) {
            hit = true;
            break;
        }
        await sleep(2000);
    }
    console.log(`watch /${a1}/ -> ${hit ? "MATCH" : "TIMEOUT"} after ${Math.round((Date.now() - (deadline - timeout)) / 1000)}s`);
    if (a3) await shot(a3);
    process.exitCode = hit ? 0 : 2;
} else if (cmd === "dump") {
    const t = await ev(`window.__e.streamText()`);
    const p = await ev(`window.__e.panel()`);
    const tier = await ev(`window.__e.tierActive()`);
    console.log(`TIER: ${tier}\n--- STREAM (tail) ---\n${(t || "").slice(-1200)}\n--- CONTEXT PANEL ---\n${p}`);
} else if (cmd === "shot") {
    await shot(a1 || "chan");
} else {
    console.log("unknown cmd");
}
c.close();
