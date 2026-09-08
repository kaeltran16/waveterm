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
	if task.State != TaskState_Failed && task.State != TaskState_Stalled && task.State != TaskState_BlockedMerge {
		return waveobj.RoutePin{}, fmt.Errorf("task %q cannot be escalated from state %q", task.ID, task.State)
	}
	if task.Escalations >= 1 {
		return waveobj.RoutePin{}, fmt.Errorf("task %q is already escalated; it is blocked for the human", task.ID)
	}
	current := effectiveTaskRoute(task, owner, group)
	if target.Runtime == "" {
		target.Runtime = current.Runtime
	}
	if target.Model != "" {
		if _, err := runroute.Resolve(target); err != nil {
			return waveobj.RoutePin{}, fmt.Errorf("escalating %q: %w", task.ID, err)
		}
		return target, nil
	}
	if target.Tier == "" {
		return waveobj.RoutePin{}, fmt.Errorf("escalating %q: a target model or tier is required", task.ID)
	}
	if !isHigherTier(current.Tier, target.Tier) {
		return waveobj.RoutePin{}, fmt.Errorf("task %q tier %q is not higher than %q", task.ID, target.Tier, current.Tier)
	}
	target = waveobj.RoutePin{Runtime: target.Runtime, Tier: target.Tier}
	if _, err := runroute.Resolve(target); err != nil {
		return waveobj.RoutePin{}, fmt.Errorf("escalating %q: %w", task.ID, err)
	}
	return target, nil
}

// applyEscalation repins a task to a higher-tier route and returns it to pending so the next tick
// dispatches it fresh. Shared by the human escalate action and the automatic context-window hop, so
// both leave the node in exactly one shape.
func applyEscalation(task *waveobj.TaskNode, target waveobj.RoutePin) {
	task.RunSpec.Runtime = target.Runtime
	task.RunSpec.Tier = target.Tier
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
	switch action {
	case "approve":
		g2, err := ApproveGate(g, taskID)
		if err != nil {
			return err
		}
		g = g2
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
		if task.State != TaskState_Failed && task.State != TaskState_Stalled && task.State != TaskState_Ready {
			return fmt.Errorf("task %q cannot be skipped from state %q", taskID, task.State)
		}
		if err := cancelAndStopTaskRun(ctx, g, taskID); err != nil {
			return err
		}
		if err := SkipTask(g, taskID); err != nil {
			return err
		}
	case "retry":
		if err := cancelAndStopTaskRun(ctx, g, taskID); err != nil {
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
		if err := cancelAndStopTaskRun(ctx, g, taskID); err != nil {
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
	return nil
}

func MarkBlockedMerge(ctx context.Context, dagID, childRunID string) error {
	return withDagMutation(dagID, func() error {
		g, err := wstore.GetDag(ctx, dagID)
		if err != nil {
			return fmt.Errorf("loading dag: %w", err)
		}
		if g.Status == DagStatus_Cancelled {
			return fmt.Errorf("dag %s is cancelled", dagID)
		}
		found := false
		for i := range g.Tasks {
			if g.Tasks[i].RunID == childRunID {
				g.Tasks[i].State = TaskState_BlockedMerge
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
				*r = jarvis.CancelRun(*r)
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
			key := TaskWorktreeKey(gCopy.RunID, taskID)
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
