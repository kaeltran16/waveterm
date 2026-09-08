package orchestrate

import (
	"context"
	"fmt"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

var workerOwnerOf = wstore.GetWorkerOwner

func init() {
	jarvis.ChildOutcomeHook = HandleChildOutcome
}

// HandleChildOutcome reacts to a dag child's worker process exiting. A "failed" outcome is classified
// and retried/escalated/counted. A "done" outcome matters too: the contract asks the child to run
// `wsh jarvis complete` before exiting, and a child that exited without doing so has not completed —
// noticing that here costs seconds, whereas waiting for the transcript to go quiet costs
// StallThreshold. "waiting" (blocked on an ask) is left alone; the ask machinery owns it.
func HandleChildOutcome(ctx context.Context, workerORef string, data jarvis.OutcomeData) error {
	if data.Status != "failed" && data.Status != "done" {
		return nil
	}
	runORef, channelORef, err := workerOwnerOf(ctx, workerORef)
	if err != nil {
		return fmt.Errorf("resolving owner for worker %s: %w", workerORef, err)
	}
	if runORef == "" || channelORef == "" {
		return nil
	}
	runRef, err := waveobj.ParseORef(runORef)
	if err != nil || runRef.OType != waveobj.OType_Run {
		return fmt.Errorf("worker %s has invalid run oref %q", workerORef, runORef)
	}
	channelRef, err := waveobj.ParseORef(channelORef)
	if err != nil || channelRef.OType != waveobj.OType_Channel {
		return fmt.Errorf("worker %s has invalid channel oref %q", workerORef, channelORef)
	}
	run, err := wstore.GetRun(ctx, channelRef.OID, runRef.OID)
	if err != nil {
		return fmt.Errorf("loading child run %s: %w", runRef.OID, err)
	}
	// a lead is not a task in its own dag, so the child path below can never account for it: before
	// submit there is no dag at all, and after submit taskByRunID misses it. Its worker exiting
	// without ever writing a transcript is the only evidence it is gone, and without this the run
	// keeps reading "executing" forever.
	if data.NoTranscript && isOrchestratorLead(ctx, run) {
		return failLeadRun(ctx, channelRef.OID, run)
	}
	if run.DagORef == "" {
		return nil
	}
	return withDagMutation(run.DagORef, func() error {
		g, err := wstore.GetDag(ctx, run.DagORef)
		if err != nil {
			return fmt.Errorf("loading dag for child outcome: %w", err)
		}
		task := taskByRunID(g, run.ID)
		if task == nil || !taskActive(task.State) {
			return nil
		}
		kind := classifyFailure(data.Summary, data.ExitCode)
		if data.Status == "done" {
			// re-read inside the lock: the child's `wsh jarvis complete` is a synchronous RPC that
			// lands just before the process exits, so a snapshot taken before the lock can race it.
			// Anything but a still-active run means the exit was accounted for (completed, cancelled
			// by skip/retry/cancel, already blocked) and there is nothing to record.
			fresh, ferr := wstore.GetRun(ctx, g.ChannelId, run.ID)
			if ferr != nil {
				return fmt.Errorf("re-loading child run %s: %w", run.ID, ferr)
			}
			if fresh.Status != jarvis.RunStatus_Executing && fresh.Status != jarvis.RunStatus_Planning {
				return nil
			}
			// the summary of a clean exit describes the work, not a fault — never classify it
			kind = FailureKindWorkerExit
		}
		if task.LastFailureKind != kind {
			task.Attempts = 0
		}
		task.LastFailureKind = kind
		mayRetry := retryDecision(kind, task.Attempts)
		task.Attempts++
		attempt := task.Attempts
		task.State = TaskState_Failed
		escalateTo, mayEscalate := autoEscalationTarget(ctx, g, task, kind)
		// a recoverable flake is retried, not a genuine failure: it must not push the streak
		// toward the circuit-break, or n concurrent one-shot flakes (plus any manual failure)
		// would block the DAG though every flake auto-recovers. only terminal failures count.
		// an auto-escalation is the same shape — the task is being re-dispatched, not abandoned.
		if !mayRetry && !mayEscalate {
			g.Failures++
		}
		if mayRetry {
			if err := RetryTask(g, task.ID); err != nil {
				return err
			}
		}
		if mayEscalate {
			applyEscalation(task, escalateTo)
		}
		g.UpdatedTs = time.Now().UnixMilli()
		RecomputeDagStatus(g)
		if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
			*cur = *g
			return nil
		}); err != nil {
			return err
		}
		// emit only after the persist lands so the event never describes state the store rejected
		if mayRetry || mayEscalate {
			detail := map[string]any{"taskid": task.ID, "kind": kind, "attempt": attempt}
			if mayEscalate {
				detail["escalatedto"] = escalateTo.Tier
			}
			publishDagEvent(DagEventTaskRetried, g, task.ID)
			appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskRetried, nil, detail)
		}
		return scheduleLocked(ctx, g.OID)
	})
}

// autoEscalationTarget resolves the one-tier-up route for a failure the engine should re-dispatch
// rather than fail (today: context-window, where the identical route cannot succeed). Every
// unresolvable case — no owning run, an exact-model pin with no tier to step, already at the top
// tier, the escalation cap already spent — degrades to no escalation, so the task simply fails and
// waits for a human. The task must already be in a failed state; escalationTarget enforces that.
func autoEscalationTarget(ctx context.Context, g *waveobj.TaskGroup, task *waveobj.TaskNode, kind string) (waveobj.RoutePin, bool) {
	if !escalateDecision(kind, task.Escalations) {
		return waveobj.RoutePin{}, false
	}
	owner, err := wstore.GetRun(ctx, g.ChannelId, g.RunID)
	if err != nil {
		return waveobj.RoutePin{}, false
	}
	up := nextTier(effectiveTaskRoute(task, owner, g).Tier)
	if up == "" {
		return waveobj.RoutePin{}, false
	}
	target, err := escalationTarget(task, owner, g, waveobj.RoutePin{Tier: up})
	if err != nil {
		return waveobj.RoutePin{}, false
	}
	return target, true
}

// isOrchestratorLead reports whether a run drives a dag rather than being driven by one. A dag names
// its lead in RunID, so a run holding a dag it does not own is a child; a run holding none at all is
// a lead only if it was launched as one.
func isOrchestratorLead(ctx context.Context, run *waveobj.Run) bool {
	if run.Mode != jarvis.RunMode_Orchestrator {
		return false
	}
	if run.DagORef == "" {
		return true
	}
	g, err := wstore.GetDag(ctx, run.DagORef)
	if err != nil {
		return false
	}
	return g.RunID == run.ID
}

// failLeadRun fails the lead's running phase so the run derives "blocked" instead of "executing".
// Only the phase is written: run status is derived from phases everywhere else, and a hand-set status
// would be a second source of truth for the same question.
func failLeadRun(ctx context.Context, channelId string, run *waveobj.Run) error {
	if run.Status != jarvis.RunStatus_Executing && run.Status != jarvis.RunStatus_Planning {
		return nil
	}
	idx := jarvis.RunningPhaseIndex(*run)
	if idx < 0 {
		return nil
	}
	return wstore.UpdateRun(ctx, channelId, run.ID, func(cur *waveobj.Run) error {
		// re-check under the update: the lead may have completed between the exit and this write
		if cur.Status != jarvis.RunStatus_Executing && cur.Status != jarvis.RunStatus_Planning {
			return nil
		}
		i := jarvis.RunningPhaseIndex(*cur)
		if i < 0 {
			return nil
		}
		updated, err := jarvis.FailPhase(*cur, i, time.Now().UnixMilli())
		if err != nil {
			return err
		}
		*cur = updated
		return nil
	})
}

func taskByRunID(g *waveobj.TaskGroup, runID string) *waveobj.TaskNode {
	for i := range g.Tasks {
		if g.Tasks[i].RunID == runID {
			return &g.Tasks[i]
		}
	}
	return nil
}
