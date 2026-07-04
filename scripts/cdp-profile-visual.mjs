// DEV-only: creates a persistent channel and drives the UI (Channels -> channel -> Runs -> Profile)
// via DOM clicks over CDP, then reports what rendered. Cleanup is manual (prints channelId to delete).
//   node scripts/cdp-profile-visual.mjs "<cwd>" <phase:create|open|customize|reset|delete> [channelId]
const port = "9222";
const CWD = process.argv[2];
const PHASE = process.argv[3] ?? "create";
const CHANNEL_ID = process.argv[4];
function cdp(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        let id = 0;
        const pending = new Map();
        ws.addEventListener("open", () =>
            resolve({
                send: (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((r) => pending.set(i, r)); },
                close: () => ws.close(),
            })
        );
        ws.addEventListener("error", reject);
        ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
    });
}
const r = await fetch(`http://localhost:${port}/json/list`);
const list = await r.json();
const pg = list.find((x) => x.type === "page" && /5174|wave/i.test(x.url ?? "")) ?? list.find((x) => x.type === "page");
const c = await cdp(pg.webSocketDebuggerUrl);
await c.send("Runtime.enable");
async function ev(expr) {
    const x = await c.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (x.exceptionDetails) return { __err: x.exceptionDetails.exception?.description || x.exceptionDetails.text };
    return x.result?.value;
}

// click helper: finds a clickable element whose trimmed text equals or includes `label`
const helpers = `
  window.__sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__clickText = (sel, label, exact) => {
    const els = [...document.querySelectorAll(sel)];
    const el = els.find((e) => { const t = (e.textContent||"").trim(); return exact ? t === label : t.includes(label); });
    if (el) { el.click(); return true; }
    return false;
  };
`;

async function create() {
    const out = await ev(`(async () => {
      ${helpers}
      const rpc = (cmd, data) => window.TabRpcClient.wshRpcCall(cmd, data, {});
      const ch = await rpc("createchannel", { name: "profile-visual", projectpath: ${JSON.stringify(CWD)} });
      return { channelId: ch.oid };
    })()`);
    console.log(JSON.stringify(out));
}

async function open() {
    const out = await ev(`(async () => {
      ${helpers}
      // 1. go to Channels surface (left nav)
      __clickText('button, a, div[role=button]', 'Channels', true) || __clickText('*', 'Channels', true);
      await __sleep(400);
      // 2. select the channel by name
      const picked = __clickText('button, div[role=button], li, a', 'profile-visual', false);
      await __sleep(500);
      // 3. switch to Runs sub-view
      const runsBtn = __clickText('button', 'runs', true) || __clickText('button', 'Runs', true);
      await __sleep(500);
      // 4. open the Profile rail
      const prof = __clickText('button', 'Profile', false);
      await __sleep(700);
      // report what rendered
      const railText = (document.querySelector('aside[aria-label="Jarvis profile"]')||{}).textContent || "(no rail)";
      return { picked, runsBtn, prof, railText: railText.slice(0, 600) };
    })()`);
    console.log(JSON.stringify(out, null, 2));
}

async function del() {
    const out = await ev(`(async () => {
      const rpc = (cmd, data) => window.TabRpcClient.wshRpcCall(cmd, data, {});
      try { await rpc("deletechannel", { channelid: ${JSON.stringify(CHANNEL_ID)} }); return { deleted: true }; }
      catch (e) { return { deleted: false, err: String(e) }; }
    })()`);
    console.log(JSON.stringify(out));
}

if (PHASE === "create") await create();
else if (PHASE === "open") await open();
else if (PHASE === "delete") await del();
c.close();
