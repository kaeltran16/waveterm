// orchsim3 -- deepened orchestrator simulation.
// Every constant is MEASURED (probed on this machine 2026-09-14) or SWEPT (unknown, varied).
// deterministic rng so every number in the write-up reproduces exactly
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
Math.random = mulberry32(20260914);


const S = 1000, M = 60 * S;

// ---------------------------------------------------------------- MEASURED
const MEAS = {
  tick: 30 * S,                    // watchdog.go:17
  leadCtxRepo: 33254,              // claude -p from repo cwd, tokens
  leadCtxNeutral: 11042,           // claude -p from empty cwd, tokens
  cacheTtl: 300 * S,               // 5m ephemeral TTL; cache_read hit observed under it
  coldWakeCostMult: 7.84,          // $0.0439 cold / $0.0056 warm
  verifyVitestSolo: 36 * S,        // 30.8s and 42.0s observed
  verifyGoPkg: 32 * S,             // 29.0s and 35.9s observed (CGO+zig)
  contention3x: 2.70,              // 3 concurrent vitest 113.6s vs 42.0s solo
  wtCreate: 3.88 * S,              // git worktree add + task worktree:prepare
  wtReset: 0.22 * S,               // git reset --hard + clean -df
  pCollideAdjacent: 0.184,         // source-file overlap, adjacent commits
  pCollideSameDay: 0.094,
  pCollideHistory: 0.062,
  genTouchRate: 0.212,             // commits touching generated outputs
  run1b: {
    workers: [40 * M + 12 * S, 21 * M + 18 * S, 13 * M + 25 * S],
    plan: 45 * M + 19 * S, gate: 8 * M + 39 * S, seal: 5 * M + 40 * S, total: 103 * M,
  },
};

// contention fit: measured k=3 -> 2.70x, so t(k) = solo * (1 + (k-1)*a)
const CONT_A = (MEAS.contention3x - 1) / 2;
const verifyTime = (solo, k) => solo * (1 + Math.max(0, k - 1) * CONT_A);

const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
function fmt(ms) {
  const neg = ms < 0;
  ms = Math.abs(Math.round(ms));
  const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
  return (neg ? "-" : "") + m + "m" + String(s).padStart(2, "0") + "s";
}
const pct = (arr, p) => {
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(p * a.length))];
};

function trial(cfg) {
  let { tasks: N } = cfg;
  const {
    slots, pCollide, pWorkerFail, pVerifyFail, pAsk,
    humanLatency, leadDecompose, leadTick, workerSpeed, orientationShare, goHeavyShare,
    warmAgent, taskCap,
  } = cfg;

  const base = [];
  if (cfg.workBudget) {
    // a goal of a fixed size, split into cap-sized tasks: isolates work volume from task count
    N = Math.max(1, Math.ceil(cfg.workBudget / (taskCap || 25 * M)));
    const each = (cfg.workBudget / N) * (1 - orientationShare) * workerSpeed;
    for (let i = 0; i < N; i++) base.push(each * rnd(0.75, 1.25));
  } else {
    for (let i = 0; i < N; i++) {
      const w = MEAS.run1b.workers[Math.floor(Math.random() * 3)];
      let d = w * (1 - orientationShare) * workerSpeed * rnd(0.75, 1.25);
      if (taskCap) d = Math.min(d, taskCap);
      base.push(d);
    }
  }
  const isGo = base.map(() => Math.random() < goHeavyShare);
  const touchesGen = base.map(() => Math.random() < MEAS.genTouchRate);

  const conflict = Array.from({ length: N }, () => new Set());
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const gen = touchesGen[i] && touchesGen[j];
      if (gen || Math.random() < pCollide) {
        conflict[i].add(j);
        conflict[j].add(i);
      }
    }
  }

  let clock = leadDecompose;
  let lastWake = 0, wakesCold = 1, wakesWarm = 0;
  const done = new Array(N).fill(false), running = new Set();
  let mergeFree = 0, verifying = 0, humanTouches = 0, redispatches = 0;
  const events = [], attempts = new Array(N).fill(0);

  const canDispatch = (i) =>
    !done[i] && !running.has(i) && ![...running].some((r) => conflict[i].has(r));

  function pump() {
    for (let i = 0; i < N; i++) {
      if (running.size >= slots) break;
      if (!canDispatch(i)) continue;
      attempts[i]++;
      running.add(i);
      const setup = attempts[i] === 1 ? MEAS.wtCreate : MEAS.wtReset;
      let dur = base[i] + setup;
      if (Math.random() < pWorkerFail) dur += base[i] * rnd(0.3, 0.8);
      if (Math.random() < pAsk) {
        dur += humanLatency;
        humanTouches++;
      }
      events.push({ t: clock + dur, kind: "worker", id: i });
    }
  }

  pump();
  let guard = 0;
  while (events.length && guard++ < 20000) {
    events.sort((a, b) => a.t - b.t);
    const e = events.shift();
    clock = Math.max(clock, e.t);

    if (e.kind === "worker") {
      verifying++;
      const solo = (isGo[e.id] ? MEAS.verifyGoPkg : 0) + MEAS.verifyVitestSolo;
      events.push({ t: clock + verifyTime(solo, verifying), kind: "verified", id: e.id });
    } else if (e.kind === "verified") {
      verifying--;
      if (Math.random() < pVerifyFail) {
        redispatches++;
        if (warmAgent) {
          // worker still alive in its worktree: hand back the failure, short fix turn
          const fix = base[e.id] * rnd(0.15, 0.35);
          events.push({ t: clock + fix, kind: "worker", id: e.id });
          continue;
        }
        // released worktree, dead agent: full re-dispatch plus a lead wake
        running.delete(e.id);
        clock - lastWake > MEAS.cacheTtl ? wakesCold++ : wakesWarm++;
        lastWake = clock;
        clock += leadTick;
        pump();
        continue;
      }
      const start = Math.max(clock, mergeFree);
      mergeFree = start + 15 * S;
      events.push({ t: mergeFree, kind: "merged", id: e.id });
    } else {
      done[e.id] = true;
      running.delete(e.id);
      const unblocked = [...Array(N).keys()].some((i) => !done[i] && conflict[i].has(e.id));
      if (unblocked) {
        clock - lastWake > MEAS.cacheTtl ? wakesCold++ : wakesWarm++;
        lastWake = clock;
        clock += Math.min(leadTick, MEAS.tick);
      }
      pump();
    }
  }
  wakesCold++;
  return {
    wallMs: clock + leadTick,
    leadTokens: (wakesCold + wakesWarm) * MEAS.leadCtxRepo,
    leadCostUnits: wakesCold * MEAS.coldWakeCostMult + wakesWarm,
    wakes: wakesCold + wakesWarm,
    humanTouches,
    redispatches,
  };
}

function run(cfg, trials = 400) {
  const out = [];
  for (let i = 0; i < trials; i++) out.push(trial(cfg));
  const avg = (f) => out.reduce((a, o) => a + f(o), 0) / out.length;
  return {
    p50: pct(out.map((o) => o.wallMs), 0.5),
    p90: pct(out.map((o) => o.wallMs), 0.9),
    p99: pct(out.map((o) => o.wallMs), 0.99),
    tokens: avg((o) => o.leadTokens),
    costUnits: avg((o) => o.leadCostUnits),
    wakes: avg((o) => o.wakes),
    human: avg((o) => o.humanTouches),
    redis: avg((o) => o.redispatches),
  };
}

const BASE = {
  tasks: 4, slots: 3,
  pCollide: MEAS.pCollideSameDay,
  pWorkerFail: 0.15,
  pVerifyFail: 0.10,
  pAsk: 0.10,
  humanLatency: 5 * M,
  leadDecompose: 3 * M,
  leadTick: 45 * S,
  workerSpeed: 1.0,
  orientationShare: 0.15,
  goHeavyShare: 0.5,
};

const head = () =>
  console.log(
    "scenario".padEnd(30), "p50".padStart(8), "p90".padStart(8), "p99".padStart(8),
    "leadTok".padStart(8), "wakes".padStart(6), "human".padStart(6), "redisp".padStart(7));
const row = (label, r) =>
  console.log(
    label.padEnd(30), fmt(r.p50).padStart(8), fmt(r.p90).padStart(8), fmt(r.p99).padStart(8),
    (Math.round(r.tokens / 1000) + "k").padStart(8), r.wakes.toFixed(1).padStart(6),
    r.human.toFixed(2).padStart(6), r.redis.toFixed(2).padStart(7));

console.log("=".repeat(84));
console.log("ORCHESTRATOR SIM v3 -- measured constants, swept unknowns");
console.log("=".repeat(84));
console.log("MEASURED on this machine 2026-09-14:");
console.log("  lead wake context, repo cwd   ", MEAS.leadCtxRepo, "tok  (neutral cwd:", MEAS.leadCtxNeutral + ")");
console.log("  cold wake vs warm wake cost   ", MEAS.coldWakeCostMult + "x  (5m cache TTL)");
console.log("  verify solo vitest / go pkg   ", fmt(MEAS.verifyVitestSolo), "/", fmt(MEAS.verifyGoPkg));
console.log("  verify contention at 3 slots  ", MEAS.contention3x + "x");
console.log("  worktree create / reset       ", (MEAS.wtCreate / 1000).toFixed(2) + "s /", (MEAS.wtReset / 1000).toFixed(2) + "s");
console.log("  pairwise collision adj/day/all", MEAS.pCollideAdjacent, "/", MEAS.pCollideSameDay, "/", MEAS.pCollideHistory);
console.log("  run 1b measured total         ", fmt(MEAS.run1b.total));
console.log();

console.log("--- A. baseline, 4 tasks / 3 slots -------------------------------------------------");
head();
row("base (same-day collide)", run(BASE));
row("clean split (history p)", run({ ...BASE, pCollide: MEAS.pCollideHistory }));
row("naive split (adjacent p)", run({ ...BASE, pCollide: MEAS.pCollideAdjacent }));
row("no failures at all", run({ ...BASE, pWorkerFail: 0, pVerifyFail: 0, pAsk: 0 }));

console.log();
console.log("--- B. verify-failure rate (full re-dispatch: no warm agent to return to) ----------");
head();
for (const p of [0, 0.05, 0.10, 0.20, 0.35]) row("pVerifyFail=" + p, run({ ...BASE, pVerifyFail: p }));

console.log();
console.log("--- C. worker speed (Sonnet/codex vs whatever ran 1b) ------------------------------");
head();
for (const s of [0.75, 1.0, 1.5, 2.0]) row("workerSpeed=" + s + "x", run({ ...BASE, workerSpeed: s }));

console.log();
console.log("--- D. human latency on asks ------------------------------------------------------");
head();
for (const [pa, hl] of [[0, 0], [0.1, 5 * M], [0.25, 15 * M], [0.25, 45 * M], [0.5, 45 * M]])
  row("pAsk=" + pa + " lat=" + fmt(hl), run({ ...BASE, pAsk: pa, humanLatency: hl }));

console.log();
console.log("--- E. slots (verify contention is measured, not assumed) --------------------------");
head();
for (const k of [1, 2, 3, 4, 6]) row("slots=" + k, run({ ...BASE, slots: k }));

console.log();
console.log("--- F. lead decomposition time (UNMEASURED -- Fable probe not run) -----------------");
head();
for (const d of [1 * M, 3 * M, 8 * M, 15 * M]) row("leadDecompose=" + fmt(d), run({ ...BASE, leadDecompose: d }));

console.log();
console.log("--- G. an 8-task day, 3 slots -----------------------------------------------------");
head();
row("8 tasks, base", run({ ...BASE, tasks: 8 }));
row("8 tasks, naive split", run({ ...BASE, tasks: 8, pCollide: MEAS.pCollideAdjacent }));
row("8 tasks, 2x slow workers", run({ ...BASE, tasks: 8, workerSpeed: 2.0 }));

console.log();
console.log("--- H. break-even: what must be true for p90 < 60m (4 tasks / 3 slots) -------------");
const budget = 60 * M;
const dims = [
  ["pVerifyFail", [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.45], (v) => ({ pVerifyFail: v })],
  ["pWorkerFail", [0, 0.1, 0.2, 0.3, 0.45, 0.6], (v) => ({ pWorkerFail: v })],
  ["workerSpeed", [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5], (v) => ({ workerSpeed: v })],
  ["pCollide", [0.05, 0.1, 0.184, 0.3, 0.45, 0.6], (v) => ({ pCollide: v })],
  ["humanLatency(min)", [0, 5, 15, 30, 60, 120], (v) => ({ pAsk: 0.25, humanLatency: v * M })],
  ["leadDecompose(min)", [1, 3, 8, 15, 25, 40], (v) => ({ leadDecompose: v * M })],
];
for (const [name, vals, mk] of dims) {
  let last = null;
  for (const v of vals) {
    const r = run({ ...BASE, ...mk(v) }, 250);
    if (r.p90 < budget) last = v;
    else break;
  }
  console.log("  " + name.padEnd(20) + " holds p90<60m up to: " + (last === null ? "FAILS EVEN AT BEST VALUE" : last));
}

console.log();
console.log("--- I. lead economics (measured context sizes) -------------------------------------");
const b = run(BASE);
console.log("  wakes per run               ", b.wakes.toFixed(1));
console.log("  lead input tokens per run   ", Math.round(b.tokens / 1000) + "k  (measured 33.3k/wake from repo cwd)");
console.log("  same lead, neutral cwd      ", Math.round((b.wakes * MEAS.leadCtxNeutral) / 1000) + "k  (" + (MEAS.leadCtxRepo / MEAS.leadCtxNeutral).toFixed(1) + "x less)");
console.log("  cost in warm-wake units     ", b.costUnits.toFixed(1), " (a cold wake costs", MEAS.coldWakeCostMult + "x a warm one)");

console.log();
console.log("--- J. the two design changes the failure layer implies -----------------------------");
head();
row("as-designed (v3 base)", run(BASE));
row("+ warm agent on verify fail", run({ ...BASE, warmAgent: true }));
row("+ task cap 25m", run({ ...BASE, taskCap: 25 * M }));
row("+ both", run({ ...BASE, warmAgent: true, taskCap: 25 * M }));
row("+ both, naive split", run({ ...BASE, warmAgent: true, taskCap: 25 * M, pCollide: MEAS.pCollideAdjacent }));
row("+ both, 2x slow workers", run({ ...BASE, warmAgent: true, taskCap: 25 * M, workerSpeed: 2 }));
row("+ both, human away 45m", run({ ...BASE, warmAgent: true, taskCap: 25 * M, pAsk: 0.25, humanLatency: 45 * M }));
row("+ both, 8 tasks", run({ ...BASE, warmAgent: true, taskCap: 25 * M, tasks: 8 }));

console.log();
console.log("--- K. break-even with both changes applied (p90 < 60m) ----------------------------");
const FIXED = { ...BASE, warmAgent: true, taskCap: 25 * M };
const dims2 = [
  ["pVerifyFail", [0, 0.1, 0.2, 0.35, 0.5, 0.7], (v) => ({ pVerifyFail: v })],
  ["pWorkerFail", [0, 0.15, 0.3, 0.45, 0.6, 0.8], (v) => ({ pWorkerFail: v })],
  ["workerSpeed", [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5], (v) => ({ workerSpeed: v })],
  ["pCollide", [0.05, 0.1, 0.184, 0.3, 0.45, 0.6, 0.8], (v) => ({ pCollide: v })],
  ["humanLatency(min)", [0, 5, 15, 30, 45, 60, 120], (v) => ({ pAsk: 0.25, humanLatency: v * M })],
  ["leadDecompose(min)", [1, 3, 8, 15, 25, 40], (v) => ({ leadDecompose: v * M })],
  ["tasks", [2, 3, 4, 5, 6, 8, 10], (v) => ({ tasks: v })],
];
for (const [name, vals, mk] of dims2) {
  let last = null;
  for (const v of vals) {
    const r = run({ ...FIXED, ...mk(v) }, 300);
    if (r.p90 < 60 * M) last = v; else break;
  }
  console.log("  " + name.padEnd(20) + " holds p90<60m up to: " + (last === null ? "FAILS EVEN AT BEST VALUE" : last));
}

console.log();
console.log("--- L. same break-even, printed as p90 values (1000 trials; bar = 60m) --------------");
console.log("   a PASS/FAIL cell hides the margin. These are the actual p90s.");
for (const [name, vals, mk] of dims2) {
  const cells = vals.map((v) => {
    const r = run({ ...FIXED, ...mk(v) }, 1000);
    return String(v).padStart(5) + ":" + fmt(r.p90).padStart(8) + (r.p90 < 60 * M ? " " : "*");
  });
  console.log("  " + name.padEnd(20) + cells.join("  "));
}
console.log("   (* = over the 60m bar)");

console.log();
console.log("--- M. work budget: how big a goal fits under the bar? -----------------------------");
console.log("   slots=3, 25m task cap, warm agent, measured overheads. N is derived from the budget.");
console.log("   run 1b's three children were 74.9 worker-minutes of work.");
console.log();
console.log("  budget".padStart(9), "tasks".padStart(6), "p50".padStart(9), "p90".padStart(9), "p99".padStart(9), "  under 60m at");
for (const bm of [25, 50, 75, 100, 125, 150, 200, 300]) {
  const n = Math.max(1, Math.ceil((bm * M) / (25 * M)));
  const r = run({ ...FIXED, workBudget: bm * M }, 1000);
  const verdict = r.p90 < 60 * M ? "p90" : r.p50 < 60 * M ? "p50 only" : "neither";
  console.log(String(bm + "m").padStart(9), String(n).padStart(6), fmt(r.p50).padStart(9),
    fmt(r.p90).padStart(9), fmt(r.p99).padStart(9), "  " + verdict);
}
console.log();
console.log("  same sweep with 2x slower workers (a Sonnet/codex worker needing more turns):");
console.log("  budget".padStart(9), "tasks".padStart(6), "p50".padStart(9), "p90".padStart(9), "p99".padStart(9), "  under 60m at");
for (const bm of [25, 50, 75, 100, 150]) {
  const n = Math.max(1, Math.ceil((bm * M) / (25 * M)));
  const r = run({ ...FIXED, workBudget: bm * M, workerSpeed: 2 }, 1000);
  const verdict = r.p90 < 60 * M ? "p90" : r.p50 < 60 * M ? "p50 only" : "neither";
  console.log(String(bm + "m").padStart(9), String(n).padStart(6), fmt(r.p50).padStart(9),
    fmt(r.p90).padStart(9), fmt(r.p99).padStart(9), "  " + verdict);
}
