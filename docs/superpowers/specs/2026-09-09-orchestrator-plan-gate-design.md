# The orchestrator plan gate — design

**Date:** 2026-09-09
**Status:** implemented
**Source:** `Wave-orchestrator-flow.dc.html` (claude.ai/design project "Claude design project handoff")

## Problem

The design's end-to-end orchestrator flow runs `idle → planning → gate → exec`. The gate — a published
plan, held for the human, shown as a numbered task table with dependencies — did not exist.

`DagSubmitCommand` (`pkg/wshrpc/wshserver/wshserver_dag.go`) set the run to executing and called
`orchestrate.Schedule` in the same breath, so the first workers spawned the instant the lead published.
The one thing that could have stopped it was dead code: `resolveRunPlan` (`wshserver_runs.go`) hardcodes
`DefaultOrchestratorPlaybook(false)` with the comment "legacy gate fields remain readable for RPC
compatibility but do not affect orchestrator creation", which means `HoldPhase` — the phase-level plan
gate an orchestrator lead would call — errors "phase is not gated" for every orchestrator run created
today.

The existing `ReviewGateCard` also previews a plan *file*. The design shows the *DAG*: 9 tasks, 4
layers, each row naming what it waits for. That data only exists after `dag submit`.

## Decision

Gate at DAG submit, not at phase hold. Submit is the moment the plan first exists in structured form,
and it is the last moment before the decomposition costs anything: no child run, no worktree, no tokens.

Three decisions the user made when this was scoped:

1. **Always on for a top-level plan.** The design shows no toggle, and a gate you can forget to turn on
   is not a gate. A *child's* plan is never gated — its parent's already was, and a child that halted
   for human review would strand a fan-out nobody is watching (`childRunPlan` strips phase gates for
   exactly this reason). The discriminator is `run.ParentLeadORef == ""`.
2. **Send back discards the plan**, returns the lead to planning, and carries the human's notes.
3. Notes are optional free text; "no, think again" is a real answer.

## Mechanism

**The gate is a pair of fields, not a status.** `TaskGroup.PlanGate` + `TaskGroup.PlanApprovedTs`
(`pkg/waveobj/wtype.go`). `RecomputeDagStatus` derives status from task state on every mutation, so a
gate that lived in the status string alone would be released by the next unrelated recompute.
`PlanGatePending(g)` is what every guard reads.

**One dispatch guard.** `NextToSpawn` (`pkg/orchestrate/scheduler.go`) returns nil while pending. That
is the single choke point every spawn passes through — `Schedule` is reached from the watchdog, from
every terminal child, and from every human dag action, and a guard at the submit call site would let the
next entry point through. It sits beside the circuit-break and the gate halt for the same reason. Note
that `Schedule` is still called at submit: it is the tick that derives and publishes, and holding it
back would only mean the reader's first view is a group nothing has looked at.

`ReadyTasks` stays unguarded, so the digest can still report what is being held back.

**A distinct status.** `DagStatus_AwaitingPlan = "awaiting-plan"`, derived below the cancelled override
so a cancel at the gate stays a cancel. Without it the modal's pill reads "running" while nothing runs.
Deliberately *not* added to `watchdogStatuses`: a gated dag has no live children, and the watchdog skips
parked dags with no busy tasks anyway.

**A distinct digest step.** `buildNext` gains a step 0, `Kind: "plan-gate"`, ranked above every task
condition (none exist yet) and above the wait kinds. Without it a gated dag reports `dependency-wait` —
true of its later layers, and a complete misread of why nothing is moving. It carries no `Actions`, so
`waitDecision` leaves the lead blocked in `dag wait`: the approval is not the lead's to make.
`buildHealth` returns `needs-you`.

**Send back deletes the group.** `orchestrate.DiscardPlan` unlinks `run.DagORef`, writes
`run.PlanFeedback`, returns the run to planning, and deletes the row — all in one transaction under the
dag mutation lock. Deleting is what lets the lead submit a revised plan at all: `CreateDagForRun` refuses
a run that already holds a dag, and that invariant has to keep holding for every plan that was ever
scheduled. It only applies to a plan still at its gate, where there is provably nothing to lose. Past
the gate it refuses, and the recovery is a per-task action.

**Two deliveries to the lead**, because the two runtimes are woken differently:

- `steerRunLead` types the rejection and the notes straight into the lead's block. Works for both.
- `DagStatusCommand` returns `PlanFeedback` with a nil `Group` instead of erroring "run has no dag", so
  a claude lead blocked in `wsh jarvis dag wait` returns `woke: plan-sent-back` with the notes. pi leads
  never run the wait loop, so their prompt says they are told directly.

The next accepted submission clears `PlanFeedback`, so a redraft is never answered with the notes that
produced it.

**The prompt states the gate up front.** A lead that does not know its submission is a proposal reads
the pause afterwards as the engine failing to dispatch.

## Frontend

`plangate.ts` is the derivation, `plangatecard.tsx` renders it. Rows are ordered by dependency depth
(longest-path over a topological sweep, so a cycle or a dangling dep degrades instead of hanging) and
then by the lead's own submission order within a layer — the submitted order is not necessarily
topological, and a plan whose row 2 depends on row 7 cannot be read top to bottom.

The card is in the run transcript, above `ReviewGateCard`, where the lead's account of what it is
proposing is directly above it. It is not an `AttentionCard`: warning tone is for something that went
wrong, and a lead publishing a plan is the flow working.

`workerRouteText` claims "managed worktrees" only when `group.mergerequired`. A non-git project runs
children in the project directory, and promising isolation that is not there is the one wrong thing to
say at an approval gate.

## Deliberately not done

- **The composer's per-phase footer text** ("→ approve the plan to start workers"). It would mean
  threading a dag fetch into `TalkComposer` for one line, when the gate card immediately above already
  carries the same statement and the button that acts on it.
- **The rail's health wording.** The design says "Needs you" / "Executing" / "Done"; `healthView` renders
  the digest's raw enum. Pre-existing, and orthogonal to the gate.
