# Orchestrator redesign — measurements and verdict (2026-09-14)

> 2026-09-14. The orchestrator's measured run (run 1b, `docs/orchestrator-howto.md` Phase 7) took 103
> minutes for three small chunks, and the owner's bar is "a day-2-day tool, more than 1h like the 1b is
> not acceptable." This brief records what a clean-sheet redesign would actually buy, measured rather
> than assumed.
>
> **Nothing here is a design decision.** It is the evidence a design decision would rest on. No spec, no
> plan, no code. The redesign itself was discussed in conversation and is summarised only far enough to
> say which of its parts the measurements killed.

## Provenance

- Constants marked **MEASURED** were taken on this machine (Windows 11, 16 cores) on 2026-09-14, by the
  probe described beside each one. Run-1b constants come from that run's own event log.
- Constants marked **ASSUMED** are swept across a range, never reported as a point estimate.
- Simulation numbers come from `2026-09-14-orchestrator-sim/orchsim3.mjs` and `orchfloor.mjs`, seeded
  (`mulberry32(20260914)`) so every figure below reproduces exactly. Re-run with `node orchsim3.mjs`.
- **Margins near the 60-minute bar are inside noise.** Before seeding, the same 75-minute work-budget
  row landed at p90 58m51s on one run and 60m39s on the next. Treat any figure within about three
  minutes of 60m as "at the line", not above or below it.

---

## 1. What run 1b actually was

Thirty-three run events, from the store (howto Phase 7). Two facts settle questions the redesign
discussion had been treating as open:

- **All three children ran concurrently** — spawned 23:07:07 / 23:07:07 / 23:08:23, finishing 23:20:32,
  23:29:41, 23:47:19. Three-way CPU contention between workers is therefore already baked into the
  measured child durations; it is not an unmodelled cost to add.
- **The workers were Opus.** The launch summary pinned `LEAD ROUTE claude · opus` and the worker route
  was "inherit the lead" (howto Phase 1). Every "worker speed" figure below is relative to Opus workers.

The 103 minutes decompose cleanly:

| Span | Duration | Removable by orchestration? |
|---|---|---|
| planning turn (`triage` → `dag-plan-gated`) | 45m19s | Yes — the lead transcribed a spec that already existed in a file |
| gate wait (human approving the DAG) | 8m39s | Yes |
| seal (`dag-done`, evidence) | 5m40s | Yes |
| **ceremony subtotal** | **59m38s** | **58% of the run** |
| longest child, t-1 | 40m12s | **No — 39% of the run** |
| unaccounted | 3m10s | — |

Work actually done: 13m25s + 21m18s + 40m12s = **74.9 worker-minutes**. That number turns out to be the
whole answer (§6).

### The floor this implies

Perfect orchestration removes ceremony and overlaps the rest. What it cannot go below is the longest
single task. Resampling tasks from run 1b's three measured children, with a 15% saving for the
orientation a redesign removes, zero orchestration cost and infinite slots:

```
   N   p50 floor   p90 floor   p99 floor
   1      17m40s      37m21s      42m17s
   2      27m35s      39m59s      42m25s
   3      32m27s      41m01s      42m32s
   4      34m39s      41m20s      42m36s
   8      38m31s      42m03s      42m39s
```

A four-task run built from run-1b-sized tasks has a **p90 floor above 40 minutes before a single
overhead is added**.

---

## 2. Measurements

| Constant | Value | How it was measured |
|---|---|---|
| Lead wake context, repo cwd | **33,254 tok** | `claude -p` from the repo root, usage report |
| Lead wake context, neutral cwd | **11,042 tok** | same, from an empty directory — the difference is project context (CLAUDE.md, AGENTS.md, git status) |
| Prompt cache scope | **shared across processes** | wakes 2 and 3 of separate `claude -p` runs reported `cache_read` 33,254 |
| Prompt cache TTL | **5 min** (`ephemeral_5m_input_tokens`) | usage report; an `ephemeral_1h` field exists but the CLI exposes no flag to select it (`claude --help`) |
| Cold wake vs warm wake cost | **7.84x** | $0.0439 cold / $0.0056 warm |
| Verify, vitest solo | 30.8s, 42.0s (model: 36s) | `npx vitest run` |
| Verify, go orchestrate pkg | 29.0s, 35.9s (model: 32s) | `go test ./pkg/orchestrate/...` with `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu"` |
| **Verify contention, 3 concurrent** | **2.70x** | 3 concurrent vitest = 113.6s vs 42.0s solo |
| Worktree cold create + prepare | 3.88s | `git worktree add` + `task worktree:prepare` |
| Worktree reset (pool reuse) | 0.22s | `git reset --hard` + `git clean -df` |
| Pairwise source-file collision | **6.2%** history / **9.4%** same-day / **18.4%** adjacent commits | git log analysis; all-file variants are 8.3% / 11.3% / 23.5% |
| Commits touching generated outputs | **21.2%** | git log analysis |
| Collisions that are generated/doc-only | **24.7%** | of all colliding pairs |
| Commits touching `pkg/wshrpc/` | 29.9% | git log analysis |
| Mean files per commit | 10.8 | git log analysis |
| Watchdog tick | 30s | `pkg/orchestrate/watchdog.go:17` |

Still **ASSUMED**, swept not measured: worker-failure rate, verify-failure rate, ask rate, human
latency, and Fable's decomposition latency and split quality (see §8).

### What the measurements killed or changed

1. **The workspace pool is dead.** It was my own proposal. Cold create is 3.88s, pool reset is 0.22s —
   it buys 3.7 seconds per task. Not worth building. Negative result against my own design.
2. **Slots have a hard knee at 3-4.** Verify does not parallelize (2.70x at three concurrent). Going
   from 3 slots to 6 moves p50 by under two minutes (§5, section E).
3. **The lead is not cheap.** At 33k tokens per wake from repo cwd and ~3 wakes, the lead costs ~100k
   input tokens per run, and because children run 13-40 minutes apart, essentially every wake misses the
   5-minute cache and pays the 7.84x cold premium. The one real lever is running the lead from a neutral
   cwd with an injected brief: 11k instead of 33k, 3x less. This matters most on Fable, which prices
   above Opus per input token (`pkg/consult/consult.go`).

---

## 3. What the simulation models

Discrete-event Monte Carlo, 400 trials per scenario (1000 for section L). Per trial:

- N tasks drawn from run 1b's three measured child durations, x0.85 for removed orientation, ±25%,
  optionally capped.
- A pairwise conflict graph: each pair collides with probability `pCollide`, plus a deterministic edge
  whenever both tasks touch generated outputs (21.2% each).
- Dispatch into `slots`, never two conflicting tasks at once; first attempt pays cold worktree create,
  a retry pays reset.
- Verify after each worker, with the **measured** contention curve fitted to the 3-concurrent
  datapoint: `t(k) = solo * (1 + (k-1) * 0.85)`.
- Verify failure either re-dispatches from scratch (as designed) or hands the failure back to a
  still-live worker as a short fix turn (`warmAgent`).
- Lead wakes on unblock and on re-dispatch, costing a tick of wall clock and 33,254 tokens, charged cold
  or warm against the 5-minute TTL.

**Not modelled**, and each would push the numbers the wrong way: worker-worker CPU contention beyond
what run 1b's timings already contain; lead context growth across a long run; merge conflicts that need
human resolution rather than a lead turn; any failure of the orchestrator itself (F26 force-kill leaving
a run `executing`, F22 latched ask, F13 stalled-vs-working).

---

## 4. Results — the design as discussed

Baseline is 4 tasks, 3 slots, same-day collision rate, 15% worker failure, 10% verify failure, 10% ask
rate, 5-minute human latency, 3-minute decomposition.

```
--- A. baseline, 4 tasks / 3 slots
scenario                            p50      p90      p99  leadTok  wakes  human  redisp
base (same-day collide)          56m14s   83m34s  115m51s     103k    3.1   0.50    0.41
clean split (history p)          56m19s   88m59s  141m57s      99k    3.0   0.43    0.48
naive split (adjacent p)         59m23s   97m24s  166m15s     116k    3.5   0.48    0.40
no failures at all               46m35s   64m49s   89m24s      91k    2.7   0.00    0.00

--- E. slots (verify contention is measured, not assumed)
slots=1                         107m51s  156m12s  217m16s     103k    3.1   0.47    0.42
slots=2                          67m55s  103m00s  164m55s     104k    3.1   0.39    0.46
slots=3                          55m03s   86m38s  144m16s     105k    3.2   0.44    0.46
slots=4                          55m47s   91m16s  159m56s     108k    3.3   0.48    0.47
slots=6                          54m50s   90m21s  157m42s     106k    3.2   0.46    0.51

--- H. break-even: what must be true for p90 < 60m
  every dimension            FAILS EVEN AT BEST VALUE
```

As discussed, the design misses the bar on every axis. Two changes the failure layer forces fix most of
it.

---

## 5. Results — with the two changes the failure layer forces

**Warm agent on verify failure:** keep the worker alive in its worktree until verify passes, so a
failure is a 15-35% fix turn instead of a full re-dispatch plus a lead wake.
**Task cap 25m:** refuse to dispatch a task estimated above the cap; split it instead.

```
--- J.
scenario                            p50      p90      p99  leadTok  wakes  human  redisp
as-designed (v3 base)            54m46s   93m30s  145m48s     105k    3.1   0.47    0.41
+ warm agent on verify fail      53m39s   83m01s  100m59s      91k    2.7   0.38    0.40
+ task cap 25m                   49m21s   78m07s  119m58s     106k    3.2   0.48    0.40
+ both                           46m11s   62m09s   89m50s      89k    2.7   0.39    0.46
+ both, naive split              47m53s   68m46s   88m44s     104k    3.1   0.34    0.46
+ both, 2x slow workers          57m35s   77m12s  101m60s      91k    2.7   0.42    0.45
+ both, human away 45m           74m50s  107m23s  157m49s      90k    2.7   1.04    0.50
+ both, 8 tasks                  76m12s   97m24s  126m44s     157k    4.7   0.87    0.89
```

Against run 1b's measured 103m: **the median roughly halves, and p90 lands at the bar rather than under
it.**

The break-even table is reported as p90 values rather than pass/fail, because at this margin a binary
cell reads as catastrophe when the truth is "misses by a hair":

```
--- L. break-even as p90 values (1000 trials; * = over the 60m bar)
  pVerifyFail       0: 60m57s*  0.1: 63m51s*  0.2: 65m26s*  0.35: 72m10s*  0.5: 81m31s*
  pWorkerFail       0: 56m37s  0.15: 62m00s*  0.3: 68m58s*  0.45: 73m17s*  0.6: 73m55s*
  workerSpeed    0.75: 56m37s     1: 62m52s* 1.25: 69m17s*   1.5: 72m53s*    2: 74m49s*
  pCollide       0.05: 60m09s*  0.1: 61m37s* 0.184: 67m10s*  0.3: 72m48s*  0.45: 81m12s*
  humanLatency      0: 62m10s*     5: 65m40s*   15: 72m04s*    30: 88m50s*   45: 101m07s*
  leadDecompose     1: 61m12s*     3: 63m11s*    8: 68m10s*    15: 74m21s*    25: 85m35s*
  tasks             2: 47m40s      3: 55m37s     4: 63m08s*     5: 71m23s*     6: 80m05s*
```

Nothing here is catastrophic and everything is close. The dimension that moves fastest is **human
latency** — the owner's availability is a bigger lever than any orchestration parameter.

---

## 6. The rule that actually falls out

Task count is the wrong knob: capping tasks at 25 minutes *raises* the count, and the count is itself a
constraint. What binds is total work. Holding slots at 3 with both changes applied, and deriving the
task count from the budget:

```
   budget  tasks       p50       p90       p99   under 60m at
      25m      1    28m16s    38m51s    49m37s   p90
      50m      2    31m40s    50m48s    68m34s   p90
      75m      3    40m03s    59m54s    78m60s   p90
     100m      4    52m10s    67m44s    94m52s   p50 only
     125m      5    58m40s    79m16s   103m20s   p50 only
     150m      6    67m56s    86m14s   110m31s   neither
     200m      8    85m11s   106m12s   131m28s   neither
     300m     12   120m05s   143m53s   174m06s   neither
```

**A goal of roughly 75 worker-minutes or less finishes under an hour at p90.** Run 1b was 74.9
worker-minutes — it sits exactly on that boundary, which is why it is the right calibration point.

This is a rule the owner can apply *before* walking away, which is what "day-2-day tool" requires. It is
also the honest statement of what the redesign does: it converts run-1b-sized goals from 103 minutes
into roughly 40-60, and does not stretch further.

### The same sweep with slower workers

Run 1b's workers were Opus. If workers are routed to Sonnet or codex to save cost and turn out to need
more turns:

```
   budget  tasks       p50       p90       p99   under 60m at
      25m      1    51m11s    71m31s    91m01s   p50 only
      50m      2    57m20s    92m16s   128m20s   p50 only
      75m      3    71m33s   110m13s   152m54s   neither
     100m      4    96m41s   126m02s   180m56s   neither
```

At 2x slower workers even a single 25-minute task misses the bar at p90. Worker wall-clock on this repo
is unmeasured and is the second-largest open risk after decomposition latency.

---

## 7. Token economics

The stated purpose is "use Fable to act as a reliable orchestrator and dispatch workers (opus or sonnet)
to do task to save token." Two caveats, stated against that purpose directly:

- **Run 1b's lead token spend was never measured**, so no claim that the redesign saves tokens versus
  the old one is supported by evidence. What is supported: the delegation saving is structural — 74.9
  worker-minutes of code-writing happens in worker contexts the lead never holds.
- **The lead is the cost center, not the workers.** ~90-105k input tokens per run, nearly all cold, on a
  model priced above Opus per input token. Left as designed the lead dominates the bill. The stripped
  launch form (neutral cwd + injected brief) is the difference between ~100k and ~34k per run, and is
  the single highest-leverage change in the whole design.
- Long-lived leads do not fix this. A lead idle more than five minutes between events goes cold anyway,
  and children run 13-40 minutes apart.

---

## 8. Verdict

The redesign is worth building, but not on the claim that it makes runs fast. It removes 59m38s of real
structural ceremony and gets a run-1b-sized goal to a p50 around 46 minutes with a p90 at the bar.

**It does not make "under an hour" a property of the orchestrator. It makes it a property of goal size,
with the hand-off rule at ~75 worker-minutes.**

Three things follow for any design that gets written:

1. Keep the worker alive through verify. Largest single wall-clock win in the failure layer (p90 93m30s
   → 83m01s alone).
2. Run the lead from a neutral cwd with an injected brief. Largest single cost win (3x).
3. Drop the workspace pool. It buys 3.7 seconds.

And one for the merge gate: it must treat generated outputs as a shared resource. 21.2% of commits touch
them and 24.7% of all colliding pairs collide *only* through generated or doc files — a serialization
rule on that one class removes a quarter of the collisions for free.

### Open questions, in order of how much they could move the answer

1. **Fable's decomposition latency.** Unmeasured; the probe was declined. At 1 minute p90 is 61m12s, at
   15 minutes it is 74m21s. This is the largest unmeasured input.
2. **Worker wall-clock on this repo for non-Opus routes.** §6 shows a 2x slowdown breaks even a
   single-task goal. Directly attacks the cost-saving purpose.
3. **Decomposition quality.** Lower stakes than the earlier pass claimed: a naive split (18.4% adjacent
   collision rate) costs about 5 minutes at p90, not the run — *provided* the generated-output rule
   above is in place.
4. **Run 1b's lead token spend**, without which no token-saving claim can be made either way.
