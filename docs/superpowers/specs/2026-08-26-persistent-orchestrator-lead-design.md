# Persistent orchestrator lead design

**Date:** 2026-08-26
**Status:** approved

## Problem

The Orchestrator composer currently runs a disposable headless consult before creating the real run. The consult must inspect the project, emit a strict one-to-eight-task JSON document, and finish inside nested RPC and backend deadlines. Real runs exposed four failure modes:

- frontend RPC cancellation before the planner's own deadline;
- provider unavailability;
- coding-agent exploration that outlives the planner deadline;
- useful plans narrated as Markdown instead of the required JSON schema.

Increasing deadlines or adding a second normalization call does not fix the architecture. It makes a temporary planner read project context that implementation workers later reconstruct, while keeping launch dependent on provider latency and output formatting.

Presenting every generated task list for approval also adds little value. The user already delegated routine decomposition by choosing Orchestrator. Approval is useful for consequential decisions, not for validating ordinary task grouping.

## Decision

Remove the disposable preflight planner and draft-approval flow.

Starting an Orchestrator run starts one persistent lead on the selected route. The lead inspects the goal and project context, chooses direct execution for cohesive work or creates typed DAG tasks for multi-part work, and remains available to coordinate the resulting execution.

A valid DAG starts automatically. The cockpit presents it for observability and intervention, not mandatory approval. Execution pauses only at explicit task decision gates or consequential questions.

## Goals

- Support arbitrary goals rather than only structured source documents.
- Read global planning context once in the persistent lead.
- Avoid strict assistant-output JSON as a planning protocol.
- Preserve exact run-route inheritance for lead and workers.
- Make planning activity visible instead of blocking behind a modal spinner.
- Keep DAG scheduling deterministic after the lead publishes valid tasks.
- Retain human control through cancel, retry, skip, reroute, escalation, and decision gates.

## Non-goals

- Eliminating workers' need to inspect code they modify.
- Automatically asking the user to approve every decomposition.
- Adding a plan-review preference or countdown.
- Using deterministic Markdown parsing as a general planner.
- Replacing the DAG engine, worktree isolation, or merge protocol.
- Making a one-task DAG mandatory for cohesive work.

## User workflow

1. The user enters a goal, selects **Orchestrator** and a run route, then presses **Run**.
2. Wave immediately creates and starts the real orchestrator run.
3. The selected lead appears in the roster and the channel shows `planning` activity.
4. The lead sizes up the work:
   - cohesive work is executed directly by the lead;
   - multi-part work becomes typed tasks with descriptions, dependencies, verification, gates, and exceptional routes when justified.
5. The lead publishes the task set to the DAG engine.
6. The server validates the proposal. A valid DAG becomes visible and ready tasks start automatically under the configured parallelism.
7. The lead receives engine control events and child questions while retaining its planning context.
8. The user observes progress and intervenes only when useful. Explicit consequential gates pause the affected path.
9. The engine merges completed child work according to dependency order; final verification tasks run after their dependencies.
10. The lead reports completion or residual failures.

There is no preflight draft modal, fallback draft, mandatory graph approval, or optional “review plan before execution” mode.

## Architecture

### Composer dispatch

`resolveRunCreationDecision` treats `orchestrator` like the other executable shapes and returns a normal `create-run` decision with mode `orchestrator`. The frontend calls `CreateRunCommand` without `deferStart`, selects the returned run, and clears the composer only after successful creation.

The composer does not call `JarvisPlanDagCommand` and does not open a local draft modal.

### Orchestrator plan-gate removal

The server always creates orchestrator runs with an ungated orchestrate phase. The legacy `defaultplangate` profile setting no longer controls orchestrator execution and its profile UI control is removed. Pipeline phase gates and explicit DAG task gates are separate mechanisms and remain unchanged.

This rule is enforced in `resolveRunPlan`, not only by a frontend request flag, so every orchestrator creation path has the same behavior. The orchestrator prompt no longer contains a plan-review branch.

### Persistent lead

`CreateRunCommand` persists the orchestrator run and spawns phase zero as it does for other non-deferred runs. The lead uses the exact selected route stored on the run.

The lead prompt defines two execution paths:

- **direct:** make a cohesive change itself, using in-context helpers only when useful;
- **DAG:** create typed task records, publish them through the existing Jarvis DAG bridge, then coordinate engine events without re-reading child transcripts.

Task descriptions must carry the task-specific goal, relevant evidence or constraints learned during planning, expected verification, and pinned decisions. Children still inspect their scoped implementation files; they do not receive only the original broad goal.

### Typed task publication

For the Pi runtime, the existing task tools and `wsh jarvis dag import-tasks` remain the publication boundary. The model creates task records rather than returning JSON in its final answer. The import path converts records to `TaskNode`s and submits them through the deterministic DAG RPC.

A validation failure returns to the same live lead. The lead repairs its task records and retries publication; Wave does not replace the result with a synthetic fallback task.

The initial implementation targets the Pi runtime used by the orchestrator route in this effort. Other runtimes retain their existing persistent-lead orchestration behavior; a shared typed task-authoring bridge for non-Pi runtimes is separate work.

### Automatic execution and graph visibility

`DagSubmitCommand` retains its current validate, persist, transition-to-executing, and schedule behavior. A successful import immediately exposes the persisted `TaskGroup` through existing Wave object updates, and the live DAG graph renders from that object. The current Pi import parallelism remains two unless changed through a separate engine setting.

The graph is an execution control surface, not a launch gate. Existing task actions remain available. A task marked as a gate uses the engine's existing `awaiting-review` transition only when that consequential gate is reached.

### Lead continuity

The planning lead remains the owner of the orchestrator run. The engine is responsible for scheduling and remains independent of lead availability. Control events keep the lead informed of child completion, blocking, asks, gates, and DAG completion.

If the lead disappears after DAG publication, the persisted DAG continues under engine supervision. Human task controls remain available. If the lead disappears before publication, the run remains visibly failed or blocked; the user can retry it where supported or cancel and start a replacement on another route.

## UI changes

- Orchestrator submission starts a run directly.
- Remove the `decomposing`, local `draft`, and `launching` modal states.
- Remove the fallback-draft and retry-planner UI.
- Preserve the live DAG graph/modal reached from a persisted run.
- Show the lead's ordinary planning activity through the channel and roster while no DAG exists yet.
- When a DAG appears, transition naturally to the existing live graph and task controls.
- Remove the orchestrator plan-gate control from the profile UI; do not add another plan-review toggle.

## Error handling

### Lead or provider failure before DAG publication

The run exposes the actual worker failure and offers ordinary retry or route-change recovery. It does not create a launchable fallback DAG.

### Invalid task proposal

The import command returns bounded validation detail to the lead. No `TaskGroup` is persisted and no child starts. The lead can fix task identifiers, cycles, limits, routes, or missing fields in the same session.

### Spawn or scheduling failure after publication

Existing DAG blocked/retry behavior applies. Persisted state remains the source of truth.

### Consequential ambiguity

The lead either pins the decision while planning or creates an explicit gate. A child can raise a consequential question through the existing child-ask channel. Routine task decomposition never creates a global approval stop.

## Token and context behavior

The lead pays the one-time cost of understanding the global goal. It converts that understanding into scoped task descriptions. Each child pays only for its task description and the implementation context it must inspect.

This does not promise zero repeated reads. A worker may need to verify source evidence relevant to its change. The design removes compulsory full-goal rediscovery by a disposable planner and every child.

## Commit semantics

The DAG engine currently depends on child worktree commits for evidence and merging. It can satisfy “do not push,” but not a literal “do not commit.” This design does not change that contract. Orchestrator goals must not instruct DAG children to leave their isolated worktrees uncommitted; internal commits are an engine transport mechanism and are never pushed automatically.

Supporting a fully uncommitted shared-tree execution mode is separate work and would forfeit the current isolation and merge guarantees.

## Removal scope

Once direct persistent-lead dispatch is covered by tests, remove the unused preflight planning path rather than retaining two sources of truth:

- frontend planner coordinator, timeout helper, local draft state, editing, and launch orchestration;
- orchestrator plan-gate profile controls and prompt branches;
- `JarvisPlanDagCommand` and its request/response types;
- `PlanDag`, prompt/parser/fallback code used only by that command;
- generated bindings regenerated from the remaining RPC surface.

The existing live DAG model, graph, engine, task import, and action commands remain.

## Testing

### Frontend

- Orchestrator selection resolves to `create-run` with mode `orchestrator` and the exact route.
- Submission does not open the DAG draft modal or call the planner RPC.
- Successful creation selects the live run.
- Failed creation preserves the goal and surfaces the actual error.
- Live persisted DAGs still open and render through the graph surface.

### Go

- `resolveRunPlan` always creates an ungated orchestrator phase, regardless of legacy profile data.
- Pi orchestrator prompts direct cohesive work or typed DAG publication without plan-approval language.
- Exact run model remains on the lead and inherited child route.
- Task import validation failures persist no DAG and start no children.
- Successful import transitions the run and schedules ready tasks as before.
- Explicit task gates still pause only when reached.

### Integration

Using the dev app and a real Pi route:

1. submit an arbitrary multi-part goal through the composer;
2. observe a real lead enter planning without a draft modal;
3. observe typed tasks become a persisted multi-task DAG;
4. verify ready children inherit the selected model and start automatically;
5. exercise one task action or consequential gate;
6. confirm the run completes or reports bounded residual failures.

## Consequences

### Benefits

- General across arbitrary goals.
- No duplicated disposable planning session.
- No strict final-response JSON dependency.
- No nested preflight timeout chain.
- Decomposition and execution share one lead context.
- User attention is reserved for real decisions.

### Costs

- The graph appears after the lead plans rather than before the run starts.
- Planning latency remains model-dependent, but it is visible and retryable.
- Pi is the first runtime with typed DAG publication; runtime-neutral authoring remains future work.
- DAG execution continues to require internal worker commits.
