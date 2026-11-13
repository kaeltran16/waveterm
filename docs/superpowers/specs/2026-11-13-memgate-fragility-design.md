# Memory gate: progress never waits, and a fairer book

Brainstorm: `.superpowers/brainstorm/memgate-fragility/brainstorm.json` (11-13). Builds on
`docs/superpowers/specs/2026-11-12-arc-resource-management-design.md`, which introduced `pkg/memgate`.

## Intent

The memory gate proved too fragile in the 11-13 runs. It never paused a tree or prevented a kill; what it did
was hold work. The fix keeps memory-aware admission for new workers only, so the gate can delay a run but
never stall one, and stops the book from reserving memory that running trees are not using.

## What happened (context)

`db_runevent`, last 3 days: memory events only in the three 11-13 runs (a417825c, f9327aeb, 4fc14db0): 37
held, 25 admitted, 0 paused, 0 resumed.

- 05:05-05:44 UTC: reviewers held at free=0 in a417825c (t-1, t-2, t-3) and f9327aeb (t-2, t-4) while finished
  workers idled with their claims. Commit 12c95b0c5 (installed 13:05 local) fixed that deadlock by releasing a
  session's claims when its run is done.
- After the install, workers still waited: a417825c t-7 613 s, 4fc14db0 t-2 331 s with 5.0 GB free against a
  5.2 GB need.
- Commit 0c293eaae (13:28 local, merged as 252816a25, landed while this brainstorm ran) replaced learned peaks
  with a fixed `memgate.Headroom` (3 GiB): a tree is admitted when available memory covers it; a running tree
  owes nothing; a just-admitted one counts its Headroom only until the loop sees its job or 30 s pass
  (`startupGrace`, `Claim.startingLocked`). It deleted `footprints.go`, `Estimate()`, `memfootprints.json` and
  the need/use fields. The facts below about estimates describe the code before that commit.
- `memfootprints.json`: waveterm worker peaks 4.6, 4.8, 4.2, 4.1, 5.3 GB, and `Estimate()` takes the max. An
  idle claude sits at ~0.35-0.7 GB, so a fresh worker owes ~4-5 GB for its whole life under `Claim.owed()`
  (need less current use, until its job closes). One agent peak of 19.8 GB sits in the kept set. Machine: 32 GB.

## Goals

- Work that finishes or lands a task never waits at the gate, so the gate cannot deadlock a run.
- A worker is charged for memory it is likely to use soon, not for its whole life.
- A verify step is not killed for memory, without turning that lost time into waiting or into prompt-cache
  rewrites (workers, reviewers and verifiers run on the 5-minute cache).
- One outlier peak does not set the estimate.

## Non-goals

- No change to `MaxLiveWorkers`, the per-run fair share, CPU priority, or interactive agents and terminals.
- No new tuning of the pause loop's watermarks and limits (see Decisions, 5).

## Anti-goals

- A fix that adds a new subsystem or more moving parts than it removes.

## Approaches

Weighed by the brainstorm's judge over seven directions. Picked: **Progress never waits, and a fairer book**,
the only option that removes both of 11-13's failure modes (the progress deadlock and the max-of-peaks,
whole-life over-reservation). Considered and not picked:

- **Count cap only** (delete memory admission, cap live workers at 3-4): simpler, but accepts the low-memory
  kills run d508bb65 (11-12) showed.
- **Gate the heavy command, not the agent** (a FIFO slot for tsc/vitest/builds inside agents): needs a per-
  harness hook on the Bash tool; the earlier jobqueue doing this was replaced by memgate.
- **Escape hatch only** (admit anything held past a time limit): keeps the wrong book and turns stalls into
  fixed delays.

For how a running worker is charged, the brainstorm first picked a 5-minute grace window; the builder check
found 0c293eaae had replaced learned peaks with a fixed 3 GiB Headroom meanwhile, and both were then rejected:
the window turns a killed verify step's lost time into waiting, and one fixed size is wrong for most projects.
Picked instead: **typical peak at start, cache-bounded pause** (Decisions 2-4), modelled on GNU parallel's
`--memfree` / `--memsuspend`. Not picked: the typical peak with no pausing (coinciding spikes still kill a verify
step), and never holding at the door while suspending the youngest (pauses would be common, and each risks a
5-minute prompt-cache rewrite).

## Decisions

1. **Progress is counted, never held.** Task reviewers (`spawnReviewer`, `pkg/orchestrate/review.go`) and every
   plan command (`admitPlanCommand`, `pkg/orchestrate/memadmit.go`, called from `plancmd.go`: Verify, Check,
   Final, base check) always start: they take a claim through a never-blocking admit beside `TryAdmit` and
   `Wait`. The claim counts their learned median against available memory until their job is seen or 30 s pass,
   like a worker's (Decision 3), so a worker is not admitted onto memory a starting Final is about to use, and it
   keeps the book non-empty, so the one-tree-always-starts rule cannot admit a worker beside a running Final. A
   worker's Setup keeps riding its worker's admission (`WithGateAdmitted`). Leads, plan reviewers and stage
   sessions stay ungated; interactive agents and terminals unchanged. Only new workers (`claimWorkers`,
   `workerslots.go`) can be held. (Builder question 2.)
2. **Typical peak at start.** Learned footprints come back: the store, recording a job's peak on close, the owner
   resolver and jobobject's peak reads that 0c293eaae removed, keyed by project and role. A worker is admitted
   when available memory covers the median of its key's kept peaks (waveterm workers ~4.6 GB, interview-coach
   ~1.4 GB), replacing the fixed 3 GiB `Headroom`: one number for every project was the wrong size for most.
   Defaults for an unseen key stay as before 0c293eaae. A worker is sized on its own median only: the old
   max(worker, Setup) goes, since Setup takes no claim (Decision 1), so its peak is never recorded, and a Setup
   runs while its worker's claim is still starting, inside that claim's charge. (Changed at planning, 11-13.)
3. **Short charge.** A just-admitted worker counts its median against available memory only until the loop sees
   its job or 30 s pass (main's `startingLocked` rule, with the learned size); after that it owes nothing beyond
   what free memory shows. There is no grace window: a long charge only moves the time a killed verify
   step wastes into waiting at the door. Waiting at the door costs no tokens, since the worker has no cache yet.
4. **Cache-bounded pause.** The reconciliation loop (`pkg/memgate/reconcile.go`) pauses only when free memory
   nears the point where Claude Code kills a command. It suspends one worker per tick: the youngest among the
   workers that are spiking (memory well above their idle use and still rising), following GNU parallel's
   `--memsuspend` youngest-first order (the oldest is likely verifying near its end). An idle worker frees
   nothing by pausing and is never paused, nor is a reviewer (`pausable()` drops `RoleReviewer`). A pause stops a
   spike from growing; it does not release memory already held, so peaks that have fully landed together can
   still end in a kill. Running workers' coinciding spikes are this loop's job, not admission's: after its 30 s
   charge a worker owes nothing. A pause ends before the worker's 5-minute prompt cache (`ShortCache`) would expire: 5
   minutes less the time since its last model turn (its transcript's last write, `lastActivityForRun`,
   `pkg/orchestrate/liveness.go`), less a margin; a worker too close to expiry is not paused. When no worker can
   be paused, none is, and a kill can still happen. Kubernetes' order (evict what exceeds its typical size first)
   was rejected: it would suspend the spiking verify.

Decisions 2-4 settle builder question 1.

## Constraints

- Windows-only packaging; job objects are the unit of measurement and suspension.
- `docs/superpowers/plans/2026-11-13-dispatch-off-dag-lock.md` (untracked, not on main) moves the worker claim
  into a `treePrep` registry and keeps Setup's `WithGateAdmitted` context. It had neither merged nor started when
  this was planned (11-13), so this is planned against current main; the overlap is two call sites in
  `engine.go` (`claimWorkers`, `bindToBlock`), and whichever lands second adapts them. (Changed at planning,
  11-13; first written as "lands after that plan".)

## Left to the builder

- How the median is taken for an even count of kept peaks.
- The free memory at which Claude Code kills a command, and a low watermark set above it.
- The pause margin under the 5-minute cache.
- The rule for a spiking worker (e.g. current use above its learned idle use, and rising since the last tick).
- Replacing the reviewer `TryAdmit` and `admitPlanCommand`'s `Wait` with the never-blocking admit; `WithGateAdmitted`
  stays for Setup.
- Tests through the `now` / `freeMem` / `liveUsage` seams: an idle finished worker never blocks a reviewer or
  Verify; a worker counts its median only until seen; a 4.6 GB median admits a worker with 5.0 GB free; the loop
  pauses the youngest worker, never a reviewer, and never one whose cache is near expiry; a pause ends before the
  cache would.
- Updating `docs/orchestrator-guide.md` and `docs/reference/architecture.md` where they describe the gate.
