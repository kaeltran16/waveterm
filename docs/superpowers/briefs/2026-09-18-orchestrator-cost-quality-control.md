# Orchestrator: lower-cost execution with bounded quality control

**Date:** 2026-09-18
**Status:** Discussion brief, still paused. Not an approved design or implementation plan. The walkthrough it waited on is complete (`effort:5d11f853`, archived 43/46) and the baseline is measured, so the original resume condition is met; what now holds it is the owner threshold decision in chunk 2.
**Initiative:** `effort:84cbd1f4-c5dc-4307-9c40-676b0841a57c` (waveterm; paused).

## Goal

Reduce the total cost of an accepted change without materially degrading quality versus a strong model implementing end-to-end, while addressing the owner's existing execution-time problem. Cheap models should handle suitable implementation work; expensive judgment should be reserved for decisions and critical-path work that need it.

**Latest discussion:** the owner explicitly flagged slow execution and the risk that added quality control makes it worse. The assistant recommended prioritizing completion time, treating quality as a constraint and cost as the optimization. That ordering is a recommendation, not an owner-approved trade-off or latency budget. The latest proposal supersedes blanket expensive review of every lane: establish a faster baseline first, then evaluate selective review.

The owner clarified that the objective is lower monetary cost, not fewer tokens. More agents, fresh contexts, reviews, and repair loops may increase tokens while lowering cost, or erase the savings entirely. Savings are a hypothesis to measure, not a property guaranteed by orchestration.

This document captures the conversation for a later session. No implementation, model choice, review policy, budget, or quality threshold has been approved.

## Current architecture and gap

The September redesign already separates deterministic mechanics from model judgment:

- The engine schedules tasks, manages lane worktrees, merges, runs Verify, and retries.
- A lead plans goal-led work and handles judgment events. Plan-input runs can finish without starting a lead.
- Each task gets a fresh worker; tasks in a lane share filesystem continuity, not conversations.
- Worker tests and post-merge Verify catch visible failures. The lead handles questions and failures.

The missing assurance is independent assessment of a change against approved intent. A worker can misunderstand a requirement, write tests matching that misunderstanding, and pass the current checks. A failure-only lead wake does not catch that case.

Source review in this conversation, not a fresh execution test:

- `pkg/orchestrate/engine.go`: `workerContract`, `taskPrompt`, `predecessorHandoff`.
- `pkg/jarvis/plan.go`: `ParsePlan` retains task sections and Setup/Verify, not general preamble constraints.
- `pkg/orchestrate/mergetask.go` and `verify.go`: lane landing and post-merge verification.
- [Current redesign](../specs/2026-09-14-orchestrator-redesign-design.md).
- [Live-run guide and rough edges](../../orchestrator-guide.md).

Re-read these on resumption; the walkthrough may change the diagnosis.

## Candidate direction

### Spend strong-model reasoning before cheap execution

The lead should pin acceptance criteria, interfaces, shared constraints, scope exclusions, and consequential design decisions. Cheap workers execute those decisions instead of rediscovering them.

Shared constraints must reach every relevant worker explicitly. Repeating global rules manually in each task is not a satisfactory long-term contract; neither is relying on a worker to open a plan path on its own.

### Keep review separate from the persistent lead

The initial candidate pipeline below illustrates role separation, not a mandatory gate for every change. The later execution-time discussion proposes selective review and, where useful, concurrent checks and review against the same frozen revision.

1. Cheap worker implements and runs task-local checks.
2. Deterministic checks reject obvious failures before paid review.
3. A fresh reviewer assesses the change against acceptance criteria.
4. The cheap worker fixes actionable findings.
5. Approved work lands and integration Verify checks the combined result.
6. Unresolved architectural/product decisions or repeated repair failures go to the lead/human.

Lane completion before squash merge is a candidate review boundary, not a settled decision. Existing lanes optimize dependency chains and merge overhead; a long lane may be too large for one bounded review. Do not create a second graph until the need is established.

### Bound review context

The owner's main concern is review context ballooning. Do not feed every worker transcript and repair turn into the persistent lead.

A reviewer starts with relevant acceptance criteria, shared constraints, the scoped diff, and check results. It can read callers, surrounding code, and shared utilities when needed; a small packet must not prohibit the context required for correctness.

Persist findings rather than conversations: violated criterion, location, evidence, required correction, and resolution. A fresh repair review can start from those findings and the repair diff, widening scope when the repair affects other behavior. An oversized change should be flagged or deliberately split, never silently truncated.

Fresh sessions bound accumulated context but repeat some input and may lose caching benefits. Measure total cost, not just maximum context size. Cross-lane behavior may need focused integration review; avoid blindly reviewing the whole codebase again.

### Choose reviewer capability empirically

The discussion initially proposed an expensive reviewer for every lane. That was a conservative starting hypothesis, not a final recommendation.

The reviewer need not always be the most expensive model. Select a model and review coverage based on demonstrated defect detection, change risk, and total accepted-change cost. Frontier judgment is most defensible for ambiguous or high-consequence changes. Cheap self-review alone is not equivalent to an independent acceptance check.

Bound repair attempts and escalate repeated failure. Decide the actual budget and escalation rules during design; none are set here.

## Economics and evaluation

Compare representative work under:

- A strong model implementing end-to-end.
- A strong planner with cheaper workers and bounded independent review.
- Additional reviewer/model variants only if the initial comparison warrants them.

Hold starting code, requirements, acceptance standards, tools, and human intervention rules comparable. Include repetitive bounded work and tightly coupled or ambiguous work; do not generalize from the easiest tasks. Report variability rather than selecting one successful run.

Capture:

- Input, output, cache-read/write tokens and actual applicable pricing by role.
- Planning, implementation, review, repair, integration-fix, and failed-run costs.
- Wall clock, human interventions, escaped defects, and accepted-result rate.
- Review context size and repeated reads as diagnostics, not the objective.

Acceptance criteria should be independent of the worker's own assertions. Passing worker-authored tests alone is insufficient. Define quality thresholds and the required cost improvement with the owner before claiming success. If subscription billing hides marginal cost, distinguish estimated API-equivalent cost from actual spend and quota usage.

The economic condition is:

`cheap implementation + strong planning/review + repairs + orchestration < strong-model end-to-end`

Small tasks and changes whose review requires reconstructing the whole problem may belong on the direct strong-model path instead.

## External patterns discussed

Primary sources consulted on 2026-09-18; these are examples, not proof that Wave will save money.

- [Cursor: Agent swarms and the new model economics](https://cursor.com/blog/agent-swarm-model-economics). Strong planners, cheaper workers, separation of planner/worker context, and experiments with different review lenses and reviewer models. Their SQLite experiment reports large cost differences between mixed-model and all-frontier swarms. This is not a controlled comparison against one strong end-to-end agent, and benchmark success is not complete software-quality assurance.
- [Aider: Separating code reasoning and editing](https://aider.chat/2024/09/26/architect.html). Architect solves the problem; editor turns the solution into edits. Useful precedent for removing ambiguity before cheap execution. Published quality results do not establish universal cost savings.
- [Anthropic: How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system). Strong coordinator and cheaper isolated subagents returning condensed findings. Explicit delegation boundaries matter. The article warns about token overhead and coding tasks with tight dependencies; research performance is not coding-cost evidence.

## Related reliability work, not automatic scope

The walkthrough guide records restart reconciliation, Windows process-tree cancellation, merge-conflict ownership/commit attribution, and cockpit state inconsistencies. These can distort cost/quality measurements and should be checked when resuming, but this initiative does not silently absorb all orchestrator reliability work.

Also check the existing backlog item for lead-authored task routing and run evidence before adding route or cost instrumentation. Reuse existing data paths instead of creating a parallel accounting system.

The current worker contract also asks each worker to run plan-wide Verify, followed by engine Verify at each merge. Consider task-local checks versus integration Verify as part of the cost baseline; repeated full suites and timeouts can inflate repair and waiting costs.

## Execution-time follow-up: latest proposal

The owner challenged whether adding review would make an already slow orchestrator worse. The assistant agreed that blanket blocking review was too broad. No speedup is promised: independent review adds work unless it overlaps other work or prevents enough downstream repair to offset its cost.

### First establish a faster baseline

Use the walkthrough run and existing events before building new telemetry. Separate planning/dispatch, worker implementation/tests, dependency waiting, merge/Verify, and failures/retries/repairs. Identify the critical path: reducing the time of a task that already finishes early does not necessarily shorten the run.

Known concerns from the walkthrough guide and source review:

- Every worker receives the plan-wide Verify command, followed by another Verify at lane merges.
- Concurrent full suites compete for local resources, time out, and can resemble stalled workers.
- Dependency chains leave slots unused; raising parallelism does not shorten a serial dependency tail.
- Timed-out Windows verification descendants may keep running and compete with retries.

Candidate first changes, subject to design approval:

1. Give workers explicit task-local checks tied to acceptance criteria; do not silently accept missing checks.
2. Keep integration Verify on the combined project revision, initially at the existing merge cadence so the experiment changes one variable at a time.
3. Address orphaned verification processes before interpreting performance results.
4. If merge Verify remains dominant, investigate batching compatible ready lanes into one verification checkpoint. This is a later option with worse failure attribution, not an agreed change. **Answered 2026-09-22 and parked:** merge Verify is not dominant. The critical-path reconstruction below measures 2.6 min of merge-blocking against ~63 min of run, so batching has almost nothing to collect on this shape of run.
5. Route difficult critical-path work to a strong model when evidence warrants it. Cheap workers are not mandatory, and one capable session may be preferable for small or tightly coupled work.

### Evaluate selective review rather than universal review

Three alternatives were discussed:

| Approach | Benefit | Downside |
|---|---|---|
| Review every lane | Simple consistent gate | Adds latency everywhere and can create oversized reviews |
| Review only at run end | Fewer intermediate gates | Wrong decisions can propagate into dependent tasks |
| Review consequential boundaries | Targets expensive mistakes before they spread | Requires an explicit, evaluated coverage policy |

The assistant recommends the third as an experiment, starting with shared contracts and high-consequence changes. Planner or explicit policy assigns review needs; the worker does not declare its own work safe. Narrow mechanically verifiable changes might have no blocking model review only if evaluation supports that policy. Tests alone are not assumed equivalent to review.

For reviewed work, the candidate freezes a revision and runs read-only review and automated checks concurrently where resources permit. Both must pass before landing; integration Verify still checks the combined revision. Independent lanes continue. Dependent work waits where a wrong interface or contract would cause rework. Repair changes invalidate affected checks and approvals; approval must not attach to a moving diff.

An initial limit of one cheap repair attempt before escalation was suggested to bound loops. It is an experimental proposal, not an approved constant or measured optimum. Findings remain durable; review conversations do not accumulate in the lead.

### Compare three paths

1. Strong-model end-to-end.
2. Arc with streamlined checks and current quality controls.
3. Arc with streamlined checks plus selective independent review.

Measure time and cost through acceptance, including failed attempts, human correction, and missed defects. The first deliverable should be a faster measured baseline, not a reviewer subsystem. A review policy that only delays runs without useful defect prevention has not justified its place.

## Comparison with other coding-agent approaches

This is a source-based comparison, not a head-to-head benchmark. Competitor documentation changes; recheck it when designing. Distinguish Cursor's published research swarm from its Cloud Agents product.

| Approach | Coordination and context | Quality/cost/time implication |
|---|---|---|
| Arc today | Fixed plan/DAG executed by code; fresh task workers share lane filesystem state; exception-driven lead; Claude Code and pi routes | Avoids paid scheduling turns, but verification duplication, serial dependencies, recovery, and cross-harness integration still cost time. No independent acceptance gate today. |
| Arc proposed | Same engine, clearer task contracts, measured routing, isolated selective review | Aims to lower accepted-change cost without unacceptable latency. Deferred, unimplemented, and unproven. |
| Claude Code | Parent/subagents, lead-managed teams, and scripted workflows; isolated subagent contexts return summaries | Docs favor independent work for teams and single sessions/subagents for sequential, same-file, heavily dependent work. Completion hooks and specialist reviews are available; there is no universal mandatory review policy. |
| Codex subagents | Main agent delegates and consolidates; model and reasoning effort configurable per agent; summaries isolate noisy intermediate work | Allocate capability by role. Docs warn of additional token consumption; model selection is not proof of net savings. |
| Cursor Cloud Agents | Task execution in isolated VMs with prepared environments; branch/PR handoff | Build/test/browser verification and screenshots/videos/logs support inspection. Cloud isolation and asynchronous execution solve a different problem from proving cheaper multi-agent work. |
| Cursor research swarm | Strong planners resolve design and decompose; cheaper focused workers; independent review perspectives | Keeps implementation history out of planner context. Mixed-model swarm results support potential savings, not a universal per-feature latency benefit or an established selective-review policy. |
| Aider architect/editor | Architect describes the solution; editor produces edits; configured lint/tests drive correction | A small handoff can be cheaper and faster than a full DAG for bounded work. Reasoning/editing separation does not guarantee savings on every task. |

Additional primary sources consulted:

- [Claude Code: parallel-agent approaches](https://code.claude.com/docs/en/agents).
- [Claude Code: agent teams](https://code.claude.com/docs/en/agent-teams). Explicitly discusses coordination overhead, task sizing, independent work, and hook-based quality gates.
- [Codex: subagents](https://developers.openai.com/codex/subagents). Separate contexts, role-specific models/reasoning effort, and token overhead.
- [Cursor: Cloud Agents](https://cursor.com/docs/cloud-agent). VM environments, artifacts, verification, PR handoff, and model-based billing.
- [Cursor: scaling long-running autonomous coding](https://cursor.com/blog/scaling-agents). Research context, not a guarantee of shipped product behavior.
- [Aider: linting and testing](https://aider.chat/docs/usage/lint-test.html). Automatic linting and configurable tests/fixes.

The Cursor comparison in chat cited the article's roughly $1,339 mixed-model swarm versus $10,565 all-GPT-5.5 swarm in its SQLite experiment. Preserve the caveat: this compares swarm configurations, not mixed orchestration against one strong end-to-end session, and test-suite success does not prove complete software quality. These figures are not targets for Arc.

### Positioning and lessons for Arc

The assistant's proposed positioning is a local, multi-harness execution engine that turns approved plans into verified changes using expensive judgment selectively—not an autonomous swarm or merely a launcher for cheaper subagents.

Strengths to preserve:

- Code owns execution state and mechanics, not the lead's conversation.
- Lead-free clean plan runs avoid unnecessary coordination.
- Lanes share filesystem continuity without carrying full worker conversations.
- Quick and Orchestrator remain sufficient shapes; do not restore tiers or extra modes merely to express review policy.
- Explicit question ownership and human escalation are preferable to silent guessing.

Trade-offs to acknowledge:

- Native Claude/Codex delegation already offers context isolation and model selection; these alone do not differentiate Arc.
- Cross-harness support adds lifecycle, wake, ask, and evidence normalization responsibilities.
- Git worktrees isolate changes, not processes, secrets, resource usage, or machine failure, unlike VM isolation.
- The fixed submitted DAG favors control and inspectability but cannot autonomously re-plan when decomposition is wrong. Preserve this constraint initially rather than add unbounded replanning/repair.
- Execution lanes are not automatically review-sized units.
- Arc currently establishes that tasks finish and Verify passes more directly than it establishes semantic acceptance.

Candidate work-shape policy:

| Work | Candidate approach |
|---|---|
| Small or tightly coupled | One capable agent with targeted checks |
| Clear implementation after design decisions | Strong reasoning followed by cheap implementation |
| Genuinely independent changes | Engine-managed parallel workers |
| Shared contract/high-consequence change | Focused independent review before dependents proceed |

The common lesson is fewer unnecessary handoffs, explicit task boundaries, isolated context, and appropriate capability. Selective review is our proposal, not a claimed industry consensus.

## Conversation progression and corrections

This is a substantive discussion record, not a verbatim transcript:

1. The owner asked for an assessment of the current orchestrator. The assistant favored hardening rather than another redesign and identified recovery, redundant Verify, merge ownership/attribution, dropped shared constraints, and inconsistent cockpit projections as concerns.
2. The owner emphasized cheap workers as the main value proposition. The assistant identified missing independent semantic quality control and initially proposed expensive pre-merge review on every lane.
3. The owner challenged review context ballooning. The proposal separated fresh reviewers from the persistent lead and retained findings rather than transcripts. Fresh context bounds accumulation but does not guarantee lower total tokens or cost.
4. The owner asked who reviews and whether this beats expensive end-to-end implementation. The assistant initially recommended strong reviewers, then clarified that total cost includes planning, duplicated context, review, repairs, and caching. The owner clarified the goal is money, not token count.
5. External examples showed strong planning/cheap execution and role-specific models, but did not establish a universal best reviewer or savings guarantee. Reviewer capability became an empirical decision rather than always the most expensive model.
6. The owner requested a Markdown brief and initiative, deferred until after the walkthrough. Both were created; no implementation was approved.
7. The owner requested comparison of Arc with other apps. The assistant distinguished deterministic execution from conversational delegation, research swarms from products, and local worktrees from VM isolation.
8. The owner raised existing execution time as a main problem. The assistant withdrew blanket blocking review as the default recommendation and proposed removing redundant checks, measuring the critical path, and evaluating selective review.
9. Asked for a concrete proposal and recommendation, the assistant suggested a faster baseline first, task-local versus integration checks, stronger models for difficult critical-path work, frozen-revision concurrent checks/review, and bounded repair. Speed-first subject to quality was recommended, not approved.
10. The final competitor discussion reinforced avoiding orchestration for unsuitable work, minimizing handoffs, allocating capability by role, and not portraying selective review as a proven industry standard.
11. The owner requested that the full discussion be retained in this file and the paused initiative. This update records that discussion, not permission to execute it.

## Measured baseline: Arc engine versus native delegation (2026-09-21)

The same six-task plan was executed twice from the same base commit, once through the Arc orchestrator
engine and once through native Claude Code delegation, to put numbers against this brief's
"Economics and evaluation" list. This is the first chunk's baseline measurement. It is a single run per
arm, not a variability study.

### Setup held common

- Plan: `docs/superpowers/plans/2026-09-18-orch-gaps-six-fixes.md`, six tasks drawn from chunks #8, #6,
  #12, #11, #10 and #19 of `effort:5d11f853` (orchestrator guide gaps). Well-defined work only.
- Base commit `7a4155cb`, whose Verify passes clean (tsc 37s, vitest 55s, go 217s), so any failure
  during a run is attributable to the run.
- Sonnet workers in both arms, width 3, one worktree per unit of work, the same worker-contract
  wording, and the plan's full Verify as the acceptance check.
- Cost is API-equivalent, computed from transcript token counts at list prices (Opus 5 $5 in / $10
  cache write / $0.50 cache read / $25 out per MTok; Sonnet 5 $2 / $4 / $0.20 / $10). It is not actual
  spend under subscription billing.

### Results

|                              | Arc engine                               | Native delegation             |
| ---------------------------- | ---------------------------------------- | ----------------------------- |
| Wall clock                   | ~1h10m active                            | 64m25s continuous, unattended |
| API-equivalent cost          | $15.73                                   | $19.09                        |
| Orchestration cost           | $0 (deterministic engine, no lead model) | $4.23 (Opus parent)           |
| Worker cost                  | $15.73 Sonnet                            | $14.86 Sonnet                 |
| Calls / cache reads / output | 384 / 46.9M / 0.21M                      | 411 / 43.4M / 0.20M           |
| Cost per task                | $2.62                                    | $3.18                         |
| Questions asked              | 0                                        | 0                             |
| Human interventions          | 4                                        | 0                             |
| Landed as                    | 4 squash merges                          | 6 commits                     |
| Diff                         | 30 files, +1097/-80                      | 31 files, +764/-88            |
| Acceptance check             | passed at every merge point              | passed at the end             |

Arc's wall clock is active time only; the run was calendar-spread across three days by an operator
error (the dev app was launched from a session-bound shell and died), which is not an engine property.
Two of its four interventions were that same operator error; the other two were engine gaps already
recorded on `effort:5d11f853` - a stalled task whose lead process is gone is never retried, and
cleanup debt on a held worktree wedges a finished dag. Arc's insertion count includes the 214-line plan
document, which `laneFold` folds into the first squash commit by design.

### Contention, measured

The Arc run is direct evidence for the execution-time problem this brief names. Under the old contract
every worker ran the plan's full Verify itself. With three workers doing that beside the merge-point
Verify, that Verify took 883s; the three later merge Verifies, run without competition, took 299s, 354s
and 398s. One worker hung inside its own full suite and had to be retried by hand. Per-task worker time
ranged from 13 to 38 minutes. The Check/Verify split (chunk #6, landed in `e2f3d68e`) comes from this
measurement.

### Critical path, reconstructed from run events (2026-09-22)

The section above sums Verify wall clock. That sum is **not** the critical path, and reading it as one
would have sent the next slice at the wrong target. The run's stored events settle it: Arc run
`1c0f0a91-ed12-4f2a-b028-328ff81fbc05` in the dev app's `db_runevent`, read-only, whose four
`task-verify-passed` durations are 883132 / 298596 / 354087 / 398455 ms — the same figures as above, so
this is the same run. Minutes are relative to `run-created`:

```
+0.2   t-1, t-2, t-5 spawned (width 3)
+20.0  t-1 done -> t-6 spawned        +20.2 t-1 merged, Verify starts
+24.0  t-2 done -> t-3 spawned
+33.5  t-6 done ......................... merge held 1.4m
+34.9  t-1 Verify passed (14.7m) -> t-6 merges, Verify starts
+38.7  t-5 done ......................... merge held 1.2m
+38.9  t-3 done -> t-4 spawned
+39.9  t-6 Verify passed (5.0m) -> t-5 merges, Verify starts
+45.8  t-5 Verify passed (5.9m)
+118.5 t-4 stalled -> lead-launched -> nothing for 63 hours
```

Every Verify ran while other workers were still executing. Total merge-blocking is **2.6 minutes** —
t-6 held 1.4m behind t-1's Verify, t-5 held 1.2m behind t-6's. Not 32.

The critical path is the dependency chain of worker execution: t-2 (24.0m) → t-3 (14.9m) → t-4 (17.0m
on its clean retry) ≈ 56m, plus the final Verify ≈ 6.6m. **Roughly 63 minutes, of which Verify is about
8m — ~13%, not ~46%.** Six tasks produced four merges; t-2 and t-3 have no merge events of their own.

What this reorders:

- **Verify scoping is a third-order lever.** Only the *final* Verify sits on the critical path, so
  dropping `go` (217s of the 309s baseline) saves ~3-4 min of a 63-min run. Real, cheap, not the story.
- **Batching merge Verifies (candidate 4 under "First establish a faster baseline") is worth close to nothing on this shape of run** — a
  better reason to leave it alone than the failure-attribution hedge it currently carries. It only pays
  where many lanes finish together; this run thinned to one active task by +38m.
- **The Check/Verify split still matters, for a different reason than recorded above.** It does not
  shorten the landing path; it shortens *workers*, and worker time is the critical path. The 883s Verify
  was not expensive because it blocked — it is the visible fingerprint of contention that was
  simultaneously inflating every worker on the chain.
- **Width was never the constraint.** Three tasks ran at the start and it decayed to one. The serial
  chain is 56 of the 63 minutes. A plan authored with more independence would beat every engine change
  on this list, which lands back on the Depends lines being what set a plan's width.
- **The run's wall clock is not a clean measurement, and the cause is operational, not economic.** t-4
  stalled at +118.5m, a lead was launched to judge it, and then nothing happened for 63 hours until a
  manual respawn, with `task-cleanup-failed` and a terminal `lead-wake-failed` alongside. That gap is
  the dev app dying — the operator error this section's parent already records — not an engine bug.
  `autoRetryStalled` (`pkg/orchestrate/engine.go:161`) declines while a lead is alive by design, so the
  auto-retry path was never the one that should have fired. Nothing engine-side needs fixing before the
  re-baseline; it needs the dev app launched so it outlives its shell.

Caveats: one run; t-4's 17.0m comes from its uncontended retry, so the 63m projection flatters the
contended arm; and the merge/Verify overlap measured here is a property of this plan's dependency
shape, not a general guarantee.

### Worker time, measured from transcripts (2026-09-22)

The reconstruction above names worker execution as the critical path but not where worker time goes.
The worker transcripts settle it: seven sessions under `1c0f0a91` and eight under `92987b0e`, timed by
the gap between each Bash `tool_use` and its `tool_result` (one 61.8-hour outlier spanning the dead-app
gap excluded). A lane shares one worktree, so a lane's directory holds every task that ran in it.

**Workers ran the full Verify despite being told not to.** `1c0f0a91`'s plan sets `Verify:` and
`Setup:` but no `Check:`. Five of its seven worker sessions ran the full suite anyway — the exact
command `workerContract` (`pkg/orchestrate/engine.go`) interpolates into their prompt as the thing not
to run:

| session | command | wall clock |
|---|---|---|
| t-1 | `go test ./pkg/... ./cmd/...` | 368s |
| t-2 | `go test ./pkg/... ./cmd/...` | 602s |
| t-6 | `go test ./pkg/... ./cmd/...` | 302s |
| t-4 retry | `tsc --noEmit && npx vitest run && go test ...` | 449s |
| t-5 | `go test ./pkg/... ./cmd/...` | 1s (failed immediately) |

28.7 minutes of worker time on the suite the engine was about to run for them. The prompt's failure mode
is structural, not a model defect: it hands the worker one concrete command labelled "don't run this",
and otherwise says to run "the tests your task names" — which that plan names nowhere.

**A `Check:` line fixes the behaviour and not the clock.** The 2026-09-21 nine-fixes plan added one.
Run `92987b0e` executed it, and the full-suite invocations went to zero — workers ran `go test
./pkg/orchestrate/`, `./pkg/wshrpc/...`, `./pkg/jarvis/` instead. But total worker test/check time was
flat:

```
1c0f0a91 (no Check)  7 sessions   full-suite: 5 calls, 28.7m   all test/check: 49.7m
92987b0e (Check)     8 sessions   full-suite: 0 calls,  0.0m   all test/check: 49.0m
```

The time relocated rather than disappearing: one worker spent 472s on `go test ./pkg/orchestrate/`
alone, another 379s on two packages.

**Because the cost is compilation, not test execution.** `pkg/orchestrate`'s tests contain two
`time.Sleep` calls totalling 105ms. A scoped `go test` still builds the package's whole import graph,
cgo included, and in a fresh worktree that graph is cold. Narrowing which tests run cannot avoid it.

**The cold-worktree penalty resists every cheap fix tried.** All runs at `c2180121`, identical source,
`go test ./pkg/... ./cmd/...`:

```
main     + shared -I   (populate) : 183s      main     + trimpath, -g   (populate) : 165s
main     + shared -I   (repeat)   :  49s      main     + trimpath, -g   (repeat)   :  72s
WORKTREE + shared -I              : 146s      WORKTREE + trimpath, -g              : 151s
WORKTREE + shared -I   (repeat)   :  55s      main     + trimpath, NO -g (populate): 175s
WORKTREE + own -I      (today)    : 176s      WORKTREE + trimpath, NO -g           : 142s
```

Every worktree first run lands at 142-151s regardless of flags. **`-trimpath` does not help, and
dropping `-g` from `CGO_CFLAGS` does not help** (142 vs 151 is noise) — so the penalty is not Go or cgo
debug info pinning absolute source paths, which was the hypothesis. Its cause is unidentified. Two
things are known: the unstable `-I` path accounts for ~30s of it (176 vs 146), and a worktree's second
run is warm (55s), so the ~90s is one-time per *worktree* — and since a lane shares a worktree, one-time
per lane, not per task. On the t-2 → t-3 → t-4 chain only t-2 paid it.

**Verdict on the verifying gate: closed, not worth optimizing.** Merge Verify blocks 2.6 min of a 63-min
run; the cold-worktree penalty is ~90s per lane; the stable `-I` is ~30s; `-trimpath` and `-g` are
measured dead ends; parallelizing the `&&`-chained Verify stages remains unmeasured with a ceiling of
~90s per merge Verify, mostly off the critical path. Summed generously that is single-digit minutes
against 63. No engine change is justified by this evidence. What the measurement does support is two
authoring rules: **give every plan a `Check:` line** (without one, workers default to the most expensive
command in their prompt), and **keep the longest `Depends on:` chain short** — 56 of the 63 minutes were
one serial chain of three tasks, which no engine change can reach.

### Quality: a weak discriminator by construction

Both arms produced a clean full suite. Cross-diffing them found four real defects, none caught by either
arm's own tests:

- Arc set `exec.Cmd.Cancel` after `Start`, racing the `watchCtx` goroutine Start launches (`go test
-race` confirms; native is clean). In the losing interleaving a timeout kills only the shell - the
  failure the change exists to prevent.
- Both half-updated `SameDagProposal`, in complementary halves: Arc compared the effort fields but not
  Check or Preamble, native the reverse. Either way a re-submit silently keeps stale values.
- Native's plan-header handling used `strings.TrimSpace`, which strips an indented first line, against a
  spec that said verbatim.
- Native skipped two validations Arc added, including a guard against a numeric chunk label resolving by
  position and closing the wrong chunk.

Neither arm was landable unmodified. `e2f3d68e` landed the Arc result plus two ported fixes.

The important caveat: the plan named exact packages, exact type fields with json tags, exact test
function names, and for one task the literal contract sentences. Both arms therefore converged -
`pkg/orchestrate/engine.go` came out byte-identical - and every difference above sits where the plan was
silent or loose. Neither arm's workers invoked a single skill (zero Skill calls across 7 Arc and 6
native worker transcripts), so the convergence is the plan's prescriptiveness, not a shared process
skill. A comparison of orchestration quality needs a deliberately looser plan: acceptance criteria
without named functions and test names.

### What this establishes, and what it does not

Established: the engine's orchestration is free where a model parent costs about 22% of the run; both
paths complete comparable work in comparable time on well-defined tasks; the contention cost of the old
worker contract is real and large; and a second independent execution is a cheap defect detector for
work whose own tests pass.

Established 2026-09-22 from the run events: the critical path is worker execution on the dependency
chain, not verification, and merge-blocking is ~2.6 min of a ~63 min run. The run's single largest time
loss — 63 hours — was the dev app dying, an operator error rather than an engine or economic property.
Both engine gaps this section originally charged to the run have since been fixed: a stalled task with
no live lead is auto-retried once (`d5169449`), and cleanup debt degrades to a warning after five failed
retries instead of wedging the dag (`31e7d685`).

Not established: variability (one run per arm), behaviour on ambiguous or tightly coupled work, any
reviewer policy, or whether a cheaper worker model changes the picture. Nothing here sets the required
cost improvement or the quality threshold - those remain owner decisions in the next chunk.

Also unexamined, and the largest single cost line: worker cache reads. Arc's orchestration is free, so
100% of its $15.73 is worker tokens, and at the brief's own prices 46.9M cache reads is about $9.38 of
it - roughly 60% of the bill, averaging ~122k cache read per call across 384 calls. Whether that is
suite output, contract preamble, or accumulated tool results is answerable from the transcripts already
captured and has not been checked. This is arithmetic over the Results table, not a measured breakdown.

## Open decisions

- What completion-time budget is acceptable, and when should extra spend buy lower latency? The speed-first recommendation still needs owner agreement.
- Which representative tasks and independent acceptance checks establish the baseline?
- What shared task-contract format reaches workers without duplicating global constraints?
- Is review per lane, per coherent change, or another existing boundary?
- Which reviewer models and risk-based coverage are justified by results?
- How are review findings, repair budgets, approval, and escalation represented?
- Which cross-lane checks require model judgment beyond deterministic Verify?
- What actual billing/caching data can each supported harness supply?
- Which reliability findings must be resolved before the experiment is interpretable? **Answered 2026-09-22: none block it.** The two engine gaps run `1c0f0a91` hit are fixed (`d5169449`, `31e7d685`), and its 63-hour gap was the dev app dying, not an engine fault. What the re-baseline needs is operational — launch the dev app so it outlives the launching shell — not another fix.

## Initiative chunks and resumption

Restructured 2026-09-22. The original chunk 1 bundled a measurement an agent can do with thresholds only
the owner can set, so it could never close; it is split, and the measurement half is done. The
re-baseline and loose-plan runs are separate because they change different variables — one isolates the
Check/Verify split's effect on the critical path, the other tests orchestration quality — and the brief's
own rule is one variable at a time.

1. **Baseline measured: Arc engine versus native delegation.** `done` — the 2026-09-21 two-arm measurement, the 2026-09-22 critical-path reconstruction, and the 2026-09-22 worker-transcript breakdown above.
2. **Owner sets the cost, time and quality thresholds and the comparison tasks.** `blocked` on the owner. Nothing below can conclude without a required cost improvement, an acceptable completion-time budget, and a quality bar; the Open decisions list is the agenda.
3. **Re-measure the critical path after the Check/Verify split.** `deferred` — its prediction was tested for free and half of it failed. The 09-21 nine-fixes plan carries a `Check:` line and run `92987b0e` executed it, so it serves as a natural experiment against `1c0f0a91`. Behaviourally the split works: full-suite invocations went 5 → 0. On the clock it does not: total worker test/check time was 49.7m → 49.0m. The confound is real — two different plans doing different work, not one variable — so this is suggestive, not decisive. What makes a paid clean re-run hard to justify is the mechanism the transcripts exposed: worker time is compile-bound in a cold worktree, not test-scope-bound, and no `Check:` wording reaches that. Revive only if the owner wants the clean number anyway; the operational precondition (launch the dev app so it outlives its shell) still stands.
4. **Re-run with a deliberately loose plan to test orchestration quality.** `pending`. Acceptance criteria without named functions, fields or test names. The 09-21 plan was prescriptive enough that `pkg/orchestrate/engine.go` came out byte-identical across both arms, so quality was never discriminated.
5. **Approve task contracts and bounded review policy.** `pending`. Brainstorm the smallest design warranted by the findings; owner approval before implementation planning. Ranked below the measurement chunks deliberately — the evidence so far argues against a reviewer subsystem as the first deliverable.
6. **Implement the approved quality-control slice.** `pending`. Conditional on chunk 5; scope and tests come from that design, not this brief.
7. **Compare accepted-change cost and quality against strong-model end-to-end.** `pending`. Time to acceptance, streamlined Arc with and without selective review, plus failures, repairs, human effort, missed defects and variability. Keep, adjust or reject on evidence.

The initiative stays `paused`: chunks 3, 4 and 7 each cost real API spend and wall time, and no paid
experiment is authorized. Start a fresh session from this brief and current source. Do not treat this
capture as authorization to build or run a paid experiment.
