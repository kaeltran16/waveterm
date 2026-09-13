// What sets the floor? Isolate task-duration variance from every orchestration effect.
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
const W1B = [40 * M + 12 * S, 21 * M + 18 * S, 13 * M + 25 * S]; // MEASURED run 1b workers
const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
const fmt = (ms) => {
  const m = Math.floor(Math.abs(ms) / 60000), s = Math.round((Math.abs(ms) % 60000) / 1000);
  return (ms < 0 ? "-" : "") + m + "m" + String(s).padStart(2, "0") + "s";
};
const pctl = (a, p) => { const x = [...a].sort((i, j) => i - j); return x[Math.min(x.length - 1, Math.floor(p * x.length))]; };

console.log("=".repeat(78));
console.log("WHERE THE HOUR GOES -- run 1b decomposed (all MEASURED)");
console.log("=".repeat(78));
const plan = 45 * M + 19 * S, gate = 8 * M + 39 * S, seal = 5 * M + 40 * S, total = 103 * M;
const ceremony = plan + gate + seal;
console.log("  planning turn                 ", fmt(plan));
console.log("  gate wait                     ", fmt(gate));
console.log("  seal                          ", fmt(seal));
console.log("  ---------------------------------------");
console.log("  removable ceremony            ", fmt(ceremony), " (" + (100 * ceremony / total).toFixed(0) + "% of the 103m run)");
console.log("  longest single task (t-1)     ", fmt(W1B[0]), " (" + (100 * W1B[0] / total).toFixed(0) + "% of the run) -- NOT removable by orchestration");
console.log("  unaccounted                   ", fmt(total - ceremony - W1B[0]));
console.log();
console.log("  -> perfect orchestration removes the ceremony and overlaps the rest.");
console.log("     The floor it cannot go below is the LONGEST SINGLE TASK.");
console.log();

console.log("=".repeat(78));
console.log("FLOOR: max task duration over N tasks, zero overhead, infinite slots");
console.log("=".repeat(78));
console.log("  (tasks resampled from run 1b's three measured workers, x0.85 orientation saving, +-25%)");
console.log();
console.log("  N".padStart(4), "p50 floor".padStart(11), "p90 floor".padStart(11), "p99 floor".padStart(11), "  P(p90 floor > 60m)");
for (const N of [1, 2, 3, 4, 6, 8]) {
  const maxes = [];
  let over = 0;
  for (let t = 0; t < 5000; t++) {
    let mx = 0;
    for (let i = 0; i < N; i++) mx = Math.max(mx, W1B[Math.floor(Math.random() * 3)] * 0.85 * rnd(0.75, 1.25));
    maxes.push(mx);
    if (mx > 60 * M) over++;
  }
  console.log(String(N).padStart(4), fmt(pctl(maxes, 0.5)).padStart(11), fmt(pctl(maxes, 0.9)).padStart(11),
    fmt(pctl(maxes, 0.99)).padStart(11), ("  " + (100 * over / 5000).toFixed(1) + "%").padStart(20));
}
console.log();
console.log("  Even with ZERO orchestration cost, a 4-task run built from run-1b-sized tasks");
console.log("  has a p90 floor above 40m before a single overhead is added.");
console.log();

console.log("=".repeat(78));
console.log("REQUIRED TASK SIZE: what task cap makes p90 < 60m achievable?");
console.log("=".repeat(78));
// full model, simplified: floor = max task; overheads measured
const VERIFY = 36 * S + 32 * S, MERGE = 15 * S, DECOMP = 3 * M, WAKE = 45 * S, WT = 3.88 * S;
console.log("  cap".padStart(6), "p50 wall".padStart(10), "p90 wall".padStart(10), "  verdict (4 tasks, 3 slots, measured overheads, 10% verify-fail)");
for (const capM of [40, 30, 25, 20, 15, 10]) {
  const walls = [];
  for (let t = 0; t < 3000; t++) {
    const tasks = [];
    for (let i = 0; i < 4; i++) {
      let d = W1B[Math.floor(Math.random() * 3)] * 0.85 * rnd(0.75, 1.25);
      tasks.push(Math.min(d, capM * M));
    }
    // 3 slots: two waves for 4 tasks
    tasks.sort((a, b) => b - a);
    const wave1 = Math.max(tasks[0], tasks[1], tasks[2]);
    const finish = [tasks[0], tasks[1], tasks[2]].sort((a, b) => a - b);
    const wave2 = finish[0] + tasks[3];
    let wall = DECOMP + WT + Math.max(wave1, wave2) + VERIFY + MERGE + WAKE;
    if (Math.random() < 0.10) wall += tasks[0] + VERIFY + WAKE; // one verify failure -> full re-dispatch
    walls.push(wall);
  }
  const p50 = pctl(walls, 0.5), p90 = pctl(walls, 0.9);
  console.log(String(capM + "m").padStart(6), fmt(p50).padStart(10), fmt(p90).padStart(10),
    "  " + (p90 < 60 * M ? "PASS" : "fail") + (p50 < 60 * M ? "  (p50 under)" : ""));
}
console.log();
console.log("  The knee is the task cap, not the orchestrator.");
