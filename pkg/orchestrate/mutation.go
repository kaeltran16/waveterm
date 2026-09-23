// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/util/keyedmutex"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

var dagMutationLocks = keyedmutex.New()

// WithDagMutation serializes every read-modify-write of one DAG. The engine's scheduling write is a
// whole-object replace of a snapshot loaded under this lock, so any writer that skips it has its
// changes silently reverted by an overlapping tick. Exported because the merge handlers live in
// wshserver (which imports this package) and are dag writers too. Not reentrant.
func WithDagMutation(dagID string, fn func() error) error {
	if dagID == "" {
		return fmt.Errorf("dag id is required")
	}
	dagMutationLocks.Lock(dagID)
	defer dagMutationLocks.Unlock(dagID)
	return fn()
}

// TryWithDagMutation runs fn only if the dag's lock is free, reporting whether it ran. For a write with
// nothing to gain by waiting: the plan's Setup command holds this lock for up to SetupTimeout, and a
// cosmetic write that queues behind it delays whatever its own caller does next.
func TryWithDagMutation(dagID string, fn func() error) (bool, error) {
	if dagID == "" {
		return false, fmt.Errorf("dag id is required")
	}
	if !dagMutationLocks.TryLock(dagID) {
		return false, nil
	}
	defer dagMutationLocks.Unlock(dagID)
	return true, fn()
}

func withDagMutation(dagID string, fn func() error) error {
	return WithDagMutation(dagID, fn)
}

var stopRunWorkers = jarvis.StopRunWorkers
var withMutationTx = wstore.WithTx

const cancelCleanupTimeout = 10 * time.Second

func childRunIDs(g *waveobj.TaskGroup) []string {
	var out []string
	for i := range g.Tasks {
		if g.Tasks[i].RunID != "" {
			out = append(out, g.Tasks[i].RunID)
		}
		// a live reviewer is a child too: cancelling the dag must stop it
		if g.Tasks[i].ReviewRunID != "" {
			out = append(out, g.Tasks[i].ReviewRunID)
		}
	}
	return out
}

func ApplyAction(ctx context.Context, dagID, taskID, action string, target waveobj.RoutePin) error {
	err := withDagMutation(dagID, func() error {
		return applyActionLocked(ctx, dagID, taskID, action, target)
	})
	if err != nil {
		return err
	}
	return Schedule(ctx, dagID)
}

func cancelAndStopTaskRun(ctx context.Context, g *waveobj.TaskGroup, taskID string) error {
	task := taskByID(g, taskID)
	if task == nil {
		return fmt.Errorf("no task %q", taskID)
	}
	if task.RunID == "" {
		return nil
	}
	if err := wstore.UpdateRun(ctx, g.ChannelId, task.RunID, func(r *waveobj.Run) error {
		*r = jarvis.CancelRun(*r)
		return nil
	}); err != nil {
		return fmt.Errorf("cancelling old run %s: %w", task.RunID, err)
	}
	run, err := wstore.GetRun(ctx, g.ChannelId, task.RunID)
	if err != nil {
		return fmt.Errorf("loading old run %s after cancellation: %w", task.RunID, err)
	}
	if err := stopRunWorkers(ctx, run); err != nil {
		return fmt.Errorf("stopping old run %s: %w", task.RunID, err)
	}
	return nil
}

func escalationTarget(task *waveobj.TaskNode, owner *waveobj.Run, group *waveobj.TaskGroup, target waveobj.RoutePin) (waveobj.RoutePin, error) {
	if task == nil {
		return waveobj.RoutePin{}, fmt.Errorf("task is required")
	}
	if task.State != TaskState_Failed && task.State != TaskState_Stalled && task.State != TaskState_BlockedMerge && task.State != TaskState_ReviewFailed {
		return waveobj.RoutePin{}, fmt.Errorf("task %q cannot be escalated from state %q", task.ID, task.State)
	}
	if task.Escalations >= 1 {
		return waveobj.RoutePin{}, fmt.Errorf("task %q is already escalated; it is blocked for the human", task.ID)
	}
	if target.Model == "" {
		return waveobj.RoutePin{}, fmt.Errorf("escalating %q: a target model is required", task.ID)
	}
	if target.Runtime == "" {
		target.Runtime = effectiveTaskRoute(task, owner, group).Runtime
	}
	target = waveobj.RoutePin{Runtime: target.Runtime, Model: target.Model}
	if _, err := runroute.Resolve(target); err != nil {
		return waveobj.RoutePin{}, fmt.Errorf("escalating %q: %w", task.ID, err)
	}
	return target, nil
}

// applyEscalation repins a task to a chosen model and returns it to pending so the next tick
// dispatches it fresh.
func applyEscalation(task *waveobj.TaskNode, target waveobj.RoutePin) {
	task.RunSpec.Runtime = target.Runtime
	task.RunSpec.Model = target.Model
	task.Attempts = 0
	task.LastFailureKind = ""
	task.Escalations++
	task.State = TaskState_Pending
	task.RunID = ""
}

func applyActionLocked(ctx context.Context, dagID, taskID, action string, target waveobj.RoutePin) error {
	g, err := wstore.GetDag(ctx, dagID)
	if err != nil {
		return fmt.Errorf("loading dag: %w", err)
	}
	if g.Status == DagStatus_Cancelled {
		return fmt.Errorf("dag %s is cancelled", dagID)
	}
	var emit []func()
	switch action {
	case "approve":
		if reviewFailed(g, taskID) {
			// the lead overrules the reviewer: the worker's commit lands as it is
			taskByID(g, taskID).State = TaskState_Done
			emit = append(emit, func() {
				appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindReviewOverruled, nil, map[string]any{"taskid": taskID})
			})
		} else {
			g2, err := ApproveGate(g, taskID)
			if err != nil {
				return err
			}
			g = g2
		}
	case "sendback":
		g2, err := SendBackGate(g, taskID)
		if err != nil {
			return err
		}
		g = g2
	case "skip":
		task := taskByID(g, taskID)
		if task == nil {
			return fmt.Errorf("no task %q", taskID)
		}
		if task.State != TaskState_Failed && task.State != TaskState_Stalled && task.State != TaskState_Ready && task.State != TaskState_ReviewFailed {
			return fmt.Errorf("task %q cannot be skipped from state %q", taskID, task.State)
		}
		// a failed review's worker already finished: cancelling its run would rewrite a done run. Its rejected
		// commit is still on the lane branch, which lands by squashing, so the branch goes back to before the task.
		if task.State == TaskState_ReviewFailed {
			if err := dropRejectedCommit(ctx, g, task); err != nil {
				return err
			}
		} else if err := cancelAndStopTaskRun(ctx, g, taskID); err != nil {
			return err
		}
		if err := SkipTask(g, taskID); err != nil {
			return err
		}
	case "retry":
		if task := taskByID(g, taskID); task != nil && task.State == TaskState_Reviewing {
			// its worker finished and a reviewer is judging it; the review's own guards end a stuck reviewer
			return fmt.Errorf("task %q is under review; wait for the verdict (a reviewer silent past %s is replaced)", taskID, ReviewTimeout)
		}
		if reviewFailed(g, taskID) {
			// the rounds start over from the findings; the worker's run already finished
			taskByID(g, taskID).ReviewRound = 0
		} else if err := cancelAndStopTaskRun(ctx, g, taskID); err != nil {
			return err
		}
		if err := RetryTask(g, taskID); err != nil {
			return err
		}
	case "escalate":
		task := taskByID(g, taskID)
		if task == nil {
			return fmt.Errorf("no task %q", taskID)
		}
		owner, err := wstore.GetRun(ctx, g.ChannelId, g.RunID)
		if err != nil {
			return fmt.Errorf("loading owner run: %w", err)
		}
		target, err := escalationTarget(task, owner, g, target)
		if err != nil {
			return err
		}
		if task.State == TaskState_ReviewFailed {
			task.ReviewRound = 0
		} else if err := cancelAndStopTaskRun(ctx, g, taskID); err != nil {
			return err
		}
		applyEscalation(task, target)
		RecomputeDagStatus(g)
	default:
		return fmt.Errorf("unknown dag action %q", action)
	}
	// the circuit-break's contract is "stop and ask a human", and this action is the answer — so the
	// streak is spent. Without this the dispatch guard deadlocks: nothing spawns, so no fresh success
	// can ever arrive to clear the counter that is stopping the spawns. Terminal task state still
	// blocks the dag on its own, so this only forgives the counter, never a real failure.
	g.Failures = 0
	RecomputeDagStatus(g)
	g.UpdatedTs = time.Now().UnixMilli()
	if err := wstore.UpdateDag(ctx, dagID, func(cur *waveobj.TaskGroup) error {
		*cur = *g
		return nil
	}); err != nil {
		return err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, g.OID))
	for _, fn := range emit {
		fn()
	}
	return nil
}

func MarkBlockedMerge(ctx context.Context, dagID, childRunID string) error {
	return withDagMutation(dagID, func() error {
		return markBlockedMergeLocked(ctx, dagID, childRunID)
	})
}

// markBlockedMergeLocked is the body of MarkBlockedMerge for callers already holding the dag
// mutation lock (the merge path takes it before running git, so it cannot re-enter).
func markBlockedMergeLocked(ctx context.Context, dagID, childRunID string) error {
	g, err := wstore.GetDag(ctx, dagID)
	if err != nil {
		return fmt.Errorf("loading dag: %w", err)
	}
	if g.Status == DagStatus_Cancelled {
		return fmt.Errorf("dag %s is cancelled", dagID)
	}
	found := false
	taskID := ""
	for i := range g.Tasks {
		if g.Tasks[i].RunID == childRunID {
			g.Tasks[i].State = TaskState_BlockedMerge
			taskID = g.Tasks[i].ID
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("no task owns run %s", childRunID)
	}
	RecomputeDagStatus(g)
	g.UpdatedTs = time.Now().UnixMilli()
	if err := wstore.UpdateDag(ctx, dagID, func(cur *waveobj.TaskGroup) error {
		*cur = *g
		return nil
	}); err != nil {
		return err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, g.OID))
	PostWake(ctx, g.ChannelId, g.RunID, mergeConflictWake(taskID))
	return nil
}

// recordMergeFailureLocked stamps a squash git refused outright — not a conflict, which leaves the tree
// mid-merge and has its own state. The automatic path re-claims a merge-ready lane every tick, so a
// refusal that is only returned to the caller is a loop nobody can see: the S5b live check spent five
// minutes retrying a squash an untracked file was blocking, with ten identical task-merge-started rows
// and a healthy-looking run. The count is what ends it. Up to the limit the refusal stays retryable,
// because the refusals worth retrying are exactly the ones a human clears out from under the run; at the
// limit the task blocks, which takes it out of autoMergeable and puts it in front of the lead.
// The caller holds the dag mutation lock.
func recordMergeFailureLocked(ctx context.Context, dagID, taskID, errText string, limit int) error {
	g, err := wstore.GetDag(ctx, dagID)
	if err != nil {
		return fmt.Errorf("loading dag: %w", err)
	}
	task := taskByID(g, taskID)
	if task == nil {
		return fmt.Errorf("no task %q", taskID)
	}
	task.MergeFailures++
	task.MergeError = errText
	blocked := task.MergeFailures >= limit
	if blocked {
		task.State = TaskState_BlockedMerge
	}
	RecomputeDagStatus(g)
	g.UpdatedTs = time.Now().UnixMilli()
	if err := wstore.UpdateDag(ctx, dagID, func(cur *waveobj.TaskGroup) error {
		*cur = *g
		return nil
	}); err != nil {
		return err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, g.OID))
	appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskMergeFailed, nil, map[string]any{
		"taskid":  taskID,
		"error":   errText,
		"attempt": task.MergeFailures,
		"blocked": blocked,
	})
	if blocked {
		PostWake(ctx, g.ChannelId, g.RunID, mergeFailedWake(taskID, errText))
	}
	return nil
}

// clearMergeFailureLocked gives a task its full retry budget back, for the human's explicit
// `dag merge --continue` after they cleared whatever git was refusing over. Without it a retry starts
// already at the limit and blocks again on its first refusal. The caller holds the dag mutation lock.
func clearMergeFailureLocked(ctx context.Context, dagID, taskID string) error {
	return wstore.UpdateDag(ctx, dagID, func(cur *waveobj.TaskGroup) error {
		task := taskByID(cur, taskID)
		if task == nil {
			return fmt.Errorf("no task %q", taskID)
		}
		task.MergeFailures, task.MergeError = 0, ""
		return nil
	})
}

func Cancel(ctx context.Context, dagID string) error {
	return withDagMutation(dagID, func() error {
		return cancelLocked(ctx, dagID)
	})
}

func cancelLocked(ctx context.Context, dagID string) error {
	var gCopy *waveobj.TaskGroup
	var runIDs []string
	var projectPath string
	if err := withMutationTx(ctx, func(tx *wstore.TxWrap) error {
		txCtx := tx.Context()
		g, err := wstore.GetDag(txCtx, dagID)
		if err != nil {
			return err
		}
		owner, err := wstore.GetRun(txCtx, g.ChannelId, g.RunID)
		if err != nil {
			return err
		}
		projectPath = owner.ProjectPath
		CancelGroup(g)
		if IsGitRepo(projectPath) {
			for i := range g.Tasks {
				g.Tasks[i].CleanupPending = true
				g.Tasks[i].CleanupError = ""
				g.Tasks[i].CleanupAttempts = 0
			}
		}
		if err := wstore.UpdateDag(txCtx, dagID, func(cur *waveobj.TaskGroup) error {
			*cur = *g
			return nil
		}); err != nil {
			return err
		}
		gCopy = g
		runIDs = append([]string{g.RunID}, childRunIDs(g)...)
		for _, runID := range runIDs {
			if runID == "" {
				continue
			}
			if err := wstore.UpdateRun(txCtx, g.ChannelId, runID, func(r *waveobj.Run) error {
				// a landed task's run keeps its outcome, as CancelGroup keeps the done task; its worker is still stopped below
				if r.Status != jarvis.RunStatus_Done {
					*r = jarvis.CancelRun(*r)
				}
				return nil
			}); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return err
	}

	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, dagID))
	// dag-cancelled: the terminal lifecycle boundary, recorded only after the cancelled state persists.
	appendRunEvent(ctx, gCopy.ChannelId, gCopy.RunID, waveobj.RunEventKindDagCancelled, nil, map[string]any{"source": "cancel"})
	stopDagVerify(dagID)
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cancelCleanupTimeout)
	defer cancel()
	var errs []error
	for _, runID := range runIDs {
		if runID == "" {
			continue
		}
		run, err := wstore.GetRun(cleanupCtx, gCopy.ChannelId, runID)
		if err != nil {
			errs = append(errs, fmt.Errorf("loading run %s: %w", runID, err))
			continue
		}
		if err := stopRunWorkers(cleanupCtx, run); err != nil {
			errs = append(errs, fmt.Errorf("run %s: %w", runID, err))
		}
	}
	// cancelled work is abandoned, so every task's tree goes through the same durable cleanup path.
	// dump dirty state first; each cleanup outcome persists and publishes before the next task.
	if IsGitRepo(projectPath) {
		for i := range gCopy.Tasks {
			taskID := gCopy.Tasks[i].ID
			// a lane's tasks share one key: the first removes the tree, the rest find nothing left to do
			key := LaneWorktreeKey(gCopy, taskID)
			DumpRecoveryPatch(cleanupCtx, projectPath, key) // best effort
			cleanupErr := CleanupTaskWorktree(cleanupCtx, gCopy, taskID)
			if err := PersistCleanupState(cleanupCtx, gCopy); err != nil {
				errs = append(errs, fmt.Errorf("persisting worktree %s cleanup: %w", key, err))
			}
			if cleanupErr != nil {
				errs = append(errs, fmt.Errorf("worktree %s: %w", key, cleanupErr))
			}
		}
	}
	for _, runID := range runIDs {
		if runID != "" {
			wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Run, runID))
			wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, gCopy.ChannelId))
		}
	}
	return errors.Join(errs...)
}
