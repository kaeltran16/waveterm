// DEV-only E2E for the Channels Runs backend (Piece 1), driven over CDP against the running tauri
// dev app, entirely over the websocket wshrpc (globalThis.fetch is CORS-blocked in the webview).
// Exercises the real CreateRun/AdvanceRun/CancelRun RPCs, which spawn REAL claude worker tabs.
// Blast radius is contained: the channel's projectpath (worker cwd) is an isolated temp dir, each
// spawned worker's block is deleted immediately after it's confirmed (deleteblock -> block-close
// event -> DestroyBlockController -> ShellProc.Close, killing claude within ~1s), and the channel
// is deleted at the end. A successful CreateRun/AdvanceRun is itself proof ResyncController(force=true)
// launched claude (the RPC errors otherwise).
//
//   node scripts/cdp-e2e-runs.mjs "<isolated-cwd>"
const port = "9222";
const CWD = process.argv[2];
if (!CWD) {
    console.error("usage: node scripts/cdp-e2e-runs.mjs <isolated-cwd>");
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

const e2e = `(async () => {
  const CWD = ${JSON.stringify(CWD)};
  const rpc = (command, data) => window.TabRpcClient.wshRpcCall(command, data, {});
  const results = [];
  const rec = (step, ok, detail) => results.push({ step, ok, detail });

  const wslist = await rpc("workspacelist", null);
  const workspaceId = wslist[0].workspacedata.oid;

  const ch = await rpc("createchannel", { name: "runs-e2e", projectpath: CWD });
  const channelId = ch.oid;

  async function getRun(runId) {
    const res = await rpc("getchannels", null);
    const cc = (res.channels || []).find((x) => x.oid === channelId) || {};
    return (cc.runs || []).find((x) => x.id === runId);
  }
  async function blockOf(oref) {
    const tab = await rpc("gettab", oref.slice(4));
    return tab && tab.blockids && tab.blockids[0];
  }
  async function blockMeta(oref) {
    if (!oref) return null;
    try {
      const bid = await blockOf(oref);
      if (!bid) return null;
      return await rpc("getmeta", { oref: "block:" + bid });
    } catch (e) { return { __metaErr: String(e) }; }
  }
  async function killWorker(oref) {
    if (!oref) return "none";
    try {
      const bid = await blockOf(oref);
      if (!bid) return "no-block";
      await rpc("deleteblock", { blockid: bid });
      return "killed " + oref;
    } catch (e) { return "kill-fail " + String(e); }
  }

  // STEP 1: CreateRun
  const created = await rpc("createrun", { channelid: channelId, workspaceid: workspaceId,
    goal: "spawn-test only: do nothing, make no file changes, stop immediately" });
  const run = created.run, runId = run.id;
  const p0 = run.phases[0].workerorefs && run.phases[0].workerorefs[0];
  const meta0 = await blockMeta(p0);
  rec("1. CreateRun -> 3 phases, p0 running + worker tab, status planning",
    run.phases.length === 3 && run.phases[0].state === "running" && !!p0 && run.status === "planning",
    JSON.stringify({ status: run.status, states: run.phases.map((p) => p.state), workeroref: p0,
      block: meta0 && { controller: meta0.controller, cmd: meta0.cmd, args: meta0["cmd:args"], cwd: meta0["cmd:cwd"], jwt: meta0["cmd:jwt"], shell: meta0["cmd:shell"] } }));
  const k0 = await killWorker(p0);

  // STEP 2: complete phase 0 (brainstorm) -> plan starts
  await rpc("advancerun", { channelid: channelId, runid: runId, phaseidx: 0, action: "complete", artifacts: ["docs/spec.md"] });
  const r2 = await getRun(runId);
  const p1 = r2.phases[1].workerorefs && r2.phases[1].workerorefs[0];
  rec("2. Advance complete p0 -> p1 running + worker tab, status planning",
    r2.phases[0].state === "done" && r2.phases[1].state === "running" && !!p1 && r2.status === "planning",
    JSON.stringify({ status: r2.status, states: r2.phases.map((p) => p.state), p0artifacts: r2.phases[0].artifacts, workeroref: p1 }));
  const k1 = await killWorker(p1);

  // STEP 3: complete phase 1 (plan) -> gate halt, no auto-start
  await rpc("advancerun", { channelid: channelId, runid: runId, phaseidx: 1, action: "complete", artifacts: ["docs/plan.md"] });
  const r3 = await getRun(runId);
  const p2before = r3.phases[2].workerorefs && r3.phases[2].workerorefs[0];
  rec("3. Advance complete p1 -> awaiting-review, p2 pending, NO new worker",
    r3.phases[1].state === "done" && r3.phases[2].state === "pending" && !p2before && r3.status === "awaiting-review",
    JSON.stringify({ status: r3.status, states: r3.phases.map((p) => p.state), p2workeroref: p2before || null }));

  // STEP 4: approve gate -> execute starts
  await rpc("advancerun", { channelid: channelId, runid: runId, action: "approve" });
  const r4 = await getRun(runId);
  const p2 = r4.phases[2].workerorefs && r4.phases[2].workerorefs[0];
  const meta2 = await blockMeta(p2);
  rec("4. Approve gate -> p2 running + worker tab, status executing",
    r4.phases[2].state === "running" && !!p2 && r4.status === "executing",
    JSON.stringify({ status: r4.status, states: r4.phases.map((p) => p.state), workeroref: p2,
      block: meta2 && { controller: meta2.controller, cmd: meta2.cmd, cwd: meta2["cmd:cwd"] } }));
  const k2 = await killWorker(p2);

  // STEP 5: cancel
  await rpc("cancelrun", { channelid: channelId, runid: runId });
  const r5 = await getRun(runId);
  rec("5. Cancel -> status cancelled, p2 skipped",
    r5.status === "cancelled" && r5.phases[2].state === "skipped",
    JSON.stringify({ status: r5.status, states: r5.phases.map((p) => p.state) }));

  let cleanup;
  try { await rpc("deletechannel", { channelid: channelId }); cleanup = "channel deleted"; }
  catch (e) { cleanup = "delete-fail " + String(e); }

  return { workspaceId, channelId, runId, cwd: CWD, workerKills: [k0, k1, k2], cleanup, results };
})()`;

const out = await ev(e2e);
c.close();
if (out && out.__err) {
    console.error("E2E THREW:", out.__err);
    process.exit(1);
}
console.log(`workspace=${out.workspaceId}  channel=${out.channelId}  run=${out.runId}`);
console.log(`worker cwd=${out.cwd}`);
console.log(`worker kills: ${JSON.stringify(out.workerKills)}`);
console.log(`cleanup: ${out.cleanup}\n`);
let pass = 0;
for (const rr of out.results) {
    console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.step}\n        ${rr.detail}`);
    if (rr.ok) pass++;
}
console.log(`\n${pass}/${out.results.length} steps passed`);
process.exit(pass === out.results.length ? 0 : 2);
