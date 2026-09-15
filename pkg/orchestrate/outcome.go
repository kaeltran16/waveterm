package orchestrate

import (
	"context"
	"fmt"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

var workerOwnerOf = wstore.GetWorkerOwner

func init() {
	jarvis.ChildOutcomeHook = HandleChildOutcome
	jarvis.LeadExitHook = HandleLeadExit
}

// HandleChildOutcome reacts to a dag child's worker process exiting. A "failed" outcome is classified
// and retried or counted. A "done" outcome matters too: the contract asks the child to run
// `wsh jarvis complete` before exiting, and a child that exited without doing so has not completed —
// noticing that here costs seconds, whereas waiting for the transcript to go quiet costs
// StallThreshold. "waiting" (blocked on an ask) is left alone; the ask machinery owns it.
func HandleChildOutcome(ctx context.Context, workerORef string, data jarvis.OutcomeData) error {
	if data.Status != "failed" && data.Status != "done" {
		return nil
	}
	channelId, runId, err := workerRunIds(ctx, workerORef)
	if err != nil || runId == "" {
		return err
	}
	run, err := wstore.GetRun(ctx, channelId, runId)
	if err != nil {
		return fmt.Errorf("loading child run %s: %w", runId, err)
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
		// a recoverable flake is retried, not a genuine failure: it must not push the streak
		// toward the circuit-break, or n concurrent one-shot flakes (plus any manual failure)
		// would block the DAG though every flake auto-recovers. only terminal failures count.
		if !mayRetry {
			g.Failures++
		}
		if mayRetry {
			if err := RetryTask(g, task.ID); err != nil {
				return err
			}
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
		if mayRetry {
			detail := map[string]any{"taskid": task.ID, "kind": kind, "attempt": attempt}
			publishDagEvent(DagEventTaskRetried, g, task.ID)
			appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskRetried, nil, detail)
		} else {
			PostWake(ctx, g.ChannelId, g.RunID, taskFailedWake(task.ID, kind))
		}
		return scheduleLocked(ctx, g.OID)
	})
}

// workerRunIds resolves the channel and run a worker tab was spawned for; empty ids for a tab no run owns.
func workerRunIds(ctx context.Context, workerORef string) (string, string, error) {
	runORef, channelORef, err := workerOwnerOf(ctx, workerORef)
	if err != nil {
		return "", "", fmt.Errorf("resolving owner for worker %s: %w", workerORef, err)
	}
	if runORef == "" || channelORef == "" {
		return "", "", nil
	}
	runRef, err := waveobj.ParseORef(runORef)
	if err != nil || runRef.OType != waveobj.OType_Run {
		return "", "", fmt.Errorf("worker %s has invalid run oref %q", workerORef, runORef)
	}
	channelRef, err := waveobj.ParseORef(channelORef)
	if err != nil || channelRef.OType != waveobj.OType_Channel {
		return "", "", fmt.Errorf("worker %s has invalid channel oref %q", workerORef, channelORef)
	}
	return channelRef.OID, runRef.OID, nil
}

// leadExitedNote is why a run whose lead exited before submitting a plan stopped (spec §2, G8).
const leadExitedNote = "lead exited before submitting a plan"

// HandleLeadExit fails an orchestrator run whose lead exited before it submitted a plan: nothing else will
// move the run, and the human needs to see why it stopped. A lead that already submitted leaves its dag
// running, and the wake adapter hands its judgment to the human instead (G8).
func HandleLeadExit(ctx context.Context, workerORef string) error {
	channelId, runId, err := workerRunIds(ctx, workerORef)
	if err != nil || runId == "" {
		return err
	}
	// every agent tab exit lands here, dag children included; only a lead with no dag is worth a write
	run, err := wstore.GetRun(ctx, channelId, runId)
	if err != nil {
		return fmt.Errorf("loading run %s: %w", runId, err)
	}
	if run.Mode != jarvis.RunMode_Orchestrator || run.DagORef != "" {
		return nil
	}
	failed := false
	err = wstore.UpdateRun(ctx, channelId, runId, func(cur *waveobj.Run) error {
		failed = false
		// decided under the update: a submit or a completion that lands just before the exit wins
		if cur.Mode != jarvis.RunMode_Orchestrator || cur.DagORef != "" {
			return nil
		}
		if cur.Status != jarvis.RunStatus_Executing && cur.Status != jarvis.RunStatus_Planning {
			return nil
		}
		i := jarvis.RunningPhaseIndex(*cur)
		if i < 0 {
			return nil
		}
		updated, ferr := jarvis.FailPhase(*cur, i, time.Now().UnixMilli())
		if ferr != nil {
			return ferr
		}
		*cur = updated
		failed = true
		return nil
	})
	if err != nil || !failed {
		return err
	}
	appendRunEvent(ctx, channelId, runId, waveobj.RunEventKindLeadExited, nil, map[string]any{"reason": leadExitedNote})
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Run, runId))
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, channelId))
	return nil
}

func taskByRunID(g *waveobj.TaskGroup, runID string) *waveobj.TaskNode {
	for i := range g.Tasks {
		if g.Tasks[i].RunID == runID {
			return &g.Tasks[i]
		}
	}
	return nil
}
