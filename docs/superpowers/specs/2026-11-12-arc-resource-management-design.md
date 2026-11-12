# Memory and CPU management across Arc

Brainstorm: `.superpowers/brainstorm/run-memory-pressure/brainstorm.json` (11-12). Initiative:
`effort:de39be0f-317c-4b34-a243-5879a6e4d94c` ("Memory pressure during orchestrator runs").

## Intent

Memory shortage costs orchestrator runs a lot of wall-clock. Handle memory and CPU once, app-wide,
for everything Arc starts, instead of a fix per incident each time a problem shows up. The solution must
be general: Arc runs agents and plans on any project, so nothing in it may be keyed to this repo's
scripts or build.

Run d508bb65 (11-12) is one example, not the scope: Claude Code killed two worker scenario checks for low
memory, one task then completed unverified, its boot crash reached Final, and Final failed.

## Background (what exists today)

- **Worker spawn gate**: `pkg/orchestrate/workerslots.go` caps live run workers at `MaxLiveWorkers` (8)
  across runs and admits one per `WorkerMemoryReserve` (3.5 GB, sized from this repo's tsc peak) of available
  memory (`gopsutil mem.VirtualMemory`), less claims of workers not yet grown (`workerGrant`,
  `claimWorkers`). Checked only at spawn; blind to anything else.
- **CPU priority**: `jobobject.LowerPriority(blockId)` puts run workers and task reviewers at below-normal
  since 11-06 (effort `1e6ed7ab`). Verify/Final, stage sessions and interactive agents stay normal.
- **Every tree is already a job object**: `pkg/shellexec/conninterface.go` attaches every block process
  (interactive agents, run workers, leads, reviewers, plain terminals) to a job object and registers it with
  `Owner{Kind: block}`; `pkg/orchestrate/plancmd_windows.go` does the same for plan commands (Setup, Verify,
  Final, base check) with `Owner{Kind: runcmd, run, cmd, task}`. The registry is
  `pkg/util/jobobject/registry.go` (`Register`, `LiveJobs`). Commands an agent starts from its Bash tool
  (tsc, vitest, a build, a dev app) run inside that agent's job.
- Windows job objects report the tree's peak memory (`JOBOBJECT_EXTENDED_LIMIT_INFORMATION.PeakJobMemoryUsed`)
  and current usage, and can be suspended as a whole.
- `pkg/resmon` already samples machine memory and CPU for the cockpit.
- Earlier evidence: claude.exe is the bulk of the load (~0.4-0.7 GB each, 12 at once on 10-14); DAG width
  beyond 3 buys only ~2% of wall-clock, so holding work at the door is cheap; no OOMs in 3,793 transcripts
  over three weeks (pressure shows as slowdowns and kills, not crashes).
- Packaging is Windows-only.

## Design

### 1. Learned footprints gate every tree Arc starts

"Tree" throughout means a process tree: one job object holding an agent or plan command and every process
it started. It is not a git worktree. Learned peaks are keyed by project and role or plan command, never by
worktree path, so a run's worktrees being deleted when it lands loses nothing.

When a job tree Arc started closes, Arc records its peak memory, keyed by project and by role or plan
command (worker, reviewer, lead, judge, builder check, Setup, Verify, Check, Final, interactive agent,
terminal). Before starting a tree that can wait (run workers, task reviewers and plan commands; see "Scope and non-goals"), Arc admits it only when live free memory, less the
learned peaks still owed by trees that have not yet grown to them, covers the new tree's learned peak.
Otherwise the tree waits and is admitted as soon as it fits.

A running tree owes its learned peak minus its current use until its root process exits, not only until
it starts (today's `workerClaims` window): a worker's peak is its late tsc/vitest/build spike, and
reserving it keeps pauses rare at little cost, since DAG width beyond 3 buys ~2% of wall-clock.
Reconciliation only lowers what a tree owes once it has grown.

This generalizes `workerGrant`: the fixed `WorkerMemoryReserve` goes away, replaced by the learned
estimate. `MaxLiveWorkers` stays as a ceiling. With nothing live anywhere, one tree always starts (today's
rule), so memory used outside Arc slows runs instead of stalling them silently.

Commands an agent starts are covered as part of their agent's tree peak, not gated one by one.

### 2. Reconciliation

A periodic loop in wavesrv:

- **Corrects the books** every tick: compares each live tree's actual memory with its learned peak and the
  gate's view of free memory, drops claims of trees that died, and updates estimates while a run is still
  going.
- **Acts on drift**: when real free memory still falls below a low watermark, it pauses the
  lowest-priority background trees (reviewers first, then workers) and resumes them once free memory is
  back above a high watermark. A pause turns what would have been a kill into a wait.

### 3. What you start yourself

Interactive agents and terminals always start and are never paused. Their memory counts against the gate,
so runs wait or pause instead.

Agent's call: only their real use counts (what free memory already shows). They hold no owed peak, and
they do not count as live for the one-tree-always-starts rule, so an open agent never stops every run.

### 4. Visibility

A task held at the door or paused shows it on the run's task row, where its state shows today: "waiting
for memory" or "paused: memory", with the free and needed figures. The gate and the loop record held,
paused and resumed as run events, which feed that row state.

A held plan command (Setup, Verify, Check, Final) has no task row: it shows the hold on the run's step
where that command shows today, and the time it waits does not count against the command's timeout.

### 5. CPU

Priority by role only; nothing is held for CPU. Your agents and terminals, leads, and Verify/Final run at
normal priority (a flake in Verify/Final costs a retry round); run workers and reviewers run below-normal,
as since 11-06. Revisit only if effort `1e6ed7ab`'s pending lag measurement shows CPU still costing runs.

## Scope and non-goals

In: every job tree Arc starts (blocks via shellexec, plan commands via plancmd) is measured and counted, on any
project. Only run workers, task reviewers and the plan commands the engine runs on its own (Verify at merge
points and its bisect steps; Setup, Check, Verify and Final in the final stage; the Setup of a bisect tree) can
wait at the door, and only run workers and task reviewers can be paused: a paused plan command would spend its
wall-clock timeout. A task's dispatch-time Setup waits as part of its worker's admission, since it runs under the
dag lock. The base Check at submit, the landing tree's Setup at submit and the Check and Verify a land runs always
start: they run once per run, inside a caller's RPC or before any worker, and count only through their real use.
Leads, stage sessions (plan review, final verifier), judges and builder checks always
start, like your own agents, and count only through their real use: you are often waiting on them directly.

Not doing:

- Per-command gating or leases through PreToolUse hooks (the same idea as arcterm's heavy-job queue,
  declined 11-06).
- Hard per-tree memory caps: they fail work instead of delaying it.
- Hibernating idle agents.
- A CPU admission gate.
- Anything keyed to this repo's scripts. `scripts/cdp/final-verify.mjs` `BUILD_SLOTS` stays as the
  target-dir collision guard it is.

Supersedes: the fixed `WorkerMemoryReserve`; effort `9e6f68b5` chunk 8 (a machine-wide cap on
Verify/Check/Final); the memory half of this initiative.

## Left to the builder

- The estimate for a role or command with no history yet: start from today's 3.5 GB for workers and a
  conservative default for the others.
- How a learned peak ages (recent trees weighted, per project and role or plan command) and where it is
  stored.
- The low and high watermarks and the reconciliation tick rate.
- How long a pause may last before a paused claude risks its in-flight API request, and what happens then
  (resume and let it run, or flag it on the row).
- How a pause is done: job-wide suspend of the tree on Windows; a no-op is acceptable elsewhere.
- The run-event records for held, paused and resumed.
