// DEV-only verification for the Jarvis profile RPCs (Piece 3), over CDP against the running tauri dev
// app via the websocket wshrpc. Exercises getjarvisprofile / setchannelprofile round-trip + section
// resolution + CreateRun playbook resolution. Blast radius contained like cdp-e2e-runs.mjs: isolated
// temp cwd, the one spawned worker is deleted, the throwaway channel is deleted at the end.
//   node scripts/cdp-profile-verify.mjs "<isolated-cwd>"
const port = "9222";
const CWD = process.argv[2];
if (!CWD) {
    console.error("usage: node scripts/cdp-profile-verify.mjs <isolated-cwd>");
    process.exit(1);
}
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

const script = `(async () => {
  const CWD = ${JSON.stringify(CWD)};
  const rpc = (command, data) => window.TabRpcClient.wshRpcCall(command, data, {});
  const results = [];
  const rec = (step, ok, detail) => results.push({ step, ok, detail });

  const wslist = await rpc("workspacelist", null);
  const workspaceId = wslist[0].workspacedata.oid;
  const ch = await rpc("createchannel", { name: "profile-verify", projectpath: CWD });
  const channelId = ch.oid;

  async function blockOf(oref) { const tab = await rpc("gettab", oref.slice(4)); return tab && tab.blockids && tab.blockids[0]; }
  async function killWorker(oref) {
    if (!oref) return "none";
    try { const bid = await blockOf(oref); if (!bid) return "no-block"; await rpc("deleteblock", { blockid: bid }); return "killed"; }
    catch (e) { return "kill-fail " + String(e); }
  }

  // STEP 1: fresh channel -> pure global, no override
  const g = await rpc("getjarvisprofile", { channelid: channelId });
  rec("1. getjarvisprofile fresh -> global(3 phases, principles), override null, resolved==global",
    g.global.playbook.length === 3 && !!g.global.principles && g.override == null &&
      g.resolved.playbook.length === 3 && g.resolved.principles === g.global.principles,
    JSON.stringify({ globalPhases: g.global.playbook.map(p=>p.kind), principlesLen: (g.global.principles||"").length, override: g.override, resolvedPrinLen: (g.resolved.principles||"").length }));

  // STEP 2: principles-only override -> playbook inherits, resolved principles overridden
  await rpc("setchannelprofile", { channelid: channelId, override: { principles: "PROJECT-OVERRIDE-TEST" } });
  const g2 = await rpc("getjarvisprofile", { channelid: channelId });
  rec("2. principles override -> override.principles set, playbook inherited(3), resolved.principles overridden",
    g2.override && g2.override.principles === "PROJECT-OVERRIDE-TEST" && g2.override.playbook == null &&
      g2.resolved.playbook.length === 3 && g2.resolved.principles === "PROJECT-OVERRIDE-TEST",
    JSON.stringify({ override: g2.override, resolvedPrin: g2.resolved.principles, resolvedPhases: g2.resolved.playbook.map(p=>p.kind) }));

  // STEP 3: playbook override -> CreateRun uses the resolved (custom) playbook
  await rpc("setchannelprofile", { channelid: channelId, override: { playbook: [{ kind: "execute", skill: "custom:only", state: "pending" }] } });
  const g3 = await rpc("getjarvisprofile", { channelid: channelId });
  const created = await rpc("createrun", { channelid: channelId, workspaceid: workspaceId,
    goal: "profile-playbook-test: do nothing, make no changes, stop immediately" });
  const run = created.run;
  const w0 = run.phases[0].workerorefs && run.phases[0].workerorefs[0];
  rec("3. playbook override -> getjarvisprofile 1 phase; CreateRun uses resolved playbook (1 phase, execute)",
    g3.override && Array.isArray(g3.override.playbook) && g3.override.playbook.length === 1 &&
      run.phases.length === 1 && run.phases[0].kind === "execute",
    JSON.stringify({ overridePhases: (g3.override.playbook||[]).map(p=>p.kind), runPhases: run.phases.map(p=>p.kind), runStatus: run.status }));
  const kill = await killWorker(w0);
  try { await rpc("cancelrun", { channelid: channelId, runid: run.id }); } catch (e) {}

  // STEP 4: empty override clears the meta key back to pure global
  await rpc("setchannelprofile", { channelid: channelId, override: {} });
  const g4 = await rpc("getjarvisprofile", { channelid: channelId });
  rec("4. empty override -> cleared (override null), resolved back to global playbook(3)",
    g4.override == null && g4.resolved.playbook.length === 3 && g4.resolved.principles === g4.global.principles,
    JSON.stringify({ override: g4.override, resolvedPhases: g4.resolved.playbook.map(p=>p.kind) }));

  let cleanup;
  try { await rpc("deletechannel", { channelid: channelId }); cleanup = "channel deleted"; }
  catch (e) { cleanup = "delete-fail " + String(e); }

  return { workspaceId, channelId, cwd: CWD, kill, cleanup, results };
})()`;

const out = await ev(script);
c.close();
if (out && out.__err) {
    console.error("VERIFY THREW:", out.__err);
    process.exit(1);
}
console.log(`workspace=${out.workspaceId}  channel=${out.channelId}`);
console.log(`worker kill: ${out.kill}   cleanup: ${out.cleanup}\n`);
let pass = 0;
for (const rr of out.results) {
    console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.step}\n        ${rr.detail}`);
    if (rr.ok) pass++;
}
console.log(`\n${pass}/${out.results.length} steps passed`);
process.exit(pass === out.results.length ? 0 : 2);
