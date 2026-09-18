# Orchestrator: lower-cost execution with bounded quality control

**Date:** 2026-09-18
**Status:** Deferred discussion brief. Revisit after the orchestrator walkthrough. Not an approved design or implementation plan.
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
4. If merge Verify remains dominant, investigate batching compatible ready lanes into one verification checkpoint. This is a later option with worse failure attribution, not an agreed change.
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

## Open decisions

- What completion-time budget is acceptable, and when should extra spend buy lower latency? The speed-first recommendation still needs owner agreement.
- Which representative tasks and independent acceptance checks establish the baseline?
- What shared task-contract format reaches workers without duplicating global constraints?
- Is review per lane, per coherent change, or another existing boundary?
- Which reviewer models and risk-based coverage are justified by results?
- How are review findings, repair budgets, approval, and escalation represented?
- Which cross-lane checks require model judgment beyond deterministic Verify?
- What actual billing/caching data can each supported harness supply?
- Which reliability findings must be resolved before the experiment is interpretable?

## Initiative chunks and resumption

All chunks remain pending while the initiative is paused:

1. **Revisit walkthrough findings and establish cost-quality baseline.** Include execution time explicitly: read this brief and the completed walkthrough; inspect existing instrumentation, critical-path delays, redundant checks, and reliability blockers. Agree on cost/time/quality trade-offs, comparison tasks, and acceptance standards.
2. **Approve task contracts and bounded review policy.** Brainstorm the smallest design warranted by the findings; get owner approval before implementation planning.
3. **Implement the approved quality-control slice.** Conditional on approval; scope and tests come from the later design, not this brief.
4. **Compare accepted-change cost and quality against strong-model end-to-end.** Include time to acceptance and compare streamlined Arc both with and without selective review. Report failures, repairs, human effort, missed defects, and variability; keep, adjust, or reject the approach based on evidence.

Resume only when the owner returns after the orchestrator walkthrough. Start a fresh session from this brief and current source. Do not treat this capture as authorization to build or run a paid experiment.
