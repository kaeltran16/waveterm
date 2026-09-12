// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"log"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// mergeWorktree is the squash-merge seam so tests can drive merge outcomes without a git repo.
var mergeWorktree = MergeRunWorktree

// MergeTask lands one done task's worktree on the project branch, stamps the merge and removes the
// tree. It holds the dag mutation lock across reload -> merge -> stamp -> cleanup for two reasons:
// the engine persists a tick as a whole-object replace of a snapshot taken under that lock, so a
// stamp written outside it is silently reverted by any overlapping tick; and two mergers running a
// squash merge against one project tree collide on git's index lock. Nothing inside re-enters the
// lock (it is not reentrant).
func MergeTask(ctx context.Context, channelID, ownerRunID, taskID string) error {
	return mergeTaskEntry(ctx, channelID, ownerRunID, taskID, false)
}

func mergeTaskEntry(ctx context.Context, channelID, ownerRunID, taskID string, requireCleanIndex bool) error {
	if channelID == "" || ownerRunID == "" || taskID == "" {
		return fmt.Errorf("channelid, runid and taskid are required")
	}
	owner, err := wstore.GetRun(ctx, channelID, ownerRunID)
	if err != nil {
		return fmt.Errorf("loading run: %w", err)
	}
	if owner.DagORef == "" {
		return fmt.Errorf("run has no dag")
	}
	return withDagMutation(owner.DagORef, func() error {
		return mergeTaskLocked(ctx, channelID, owner, taskID, requireCleanIndex)
	})
}

// errIndexNotClean is the automatic path's refusal: the squash commit commits whatever the index
// holds, so a human's staged edits would land inside the task's commit.
var errIndexNotClean = errors.New("project index is not clean")

func mergeTaskLocked(ctx context.Context, channelID string, owner *waveobj.Run, taskID string, requireCleanIndex bool) error {
	g, err := wstore.GetDag(ctx, owner.DagORef)
	if err != nil {
		return err
	}
	task := taskByID(g, taskID)
	if task == nil {
		return fmt.Errorf("no task %q", taskID)
	}
	if task.Merged {
		if !task.CleanupPending && task.CleanupError == "" {
			return nil
		}
		return CleanupMergedTask(ctx, channelID, g, taskID)
	}
	if task.State != TaskState_Done && task.State != TaskState_BlockedMerge {
		return fmt.Errorf("task %s is %s, want done", taskID, task.State)
	}
	if task.RunID == "" {
		return fmt.Errorf("task %s has no child run", taskID)
	}
	if requireCleanIndex {
		clean, cerr := IndexClean(ctx, owner.ProjectPath)
		if cerr != nil {
			return cerr
		}
		if !clean {
			return errIndexNotClean
		}
	}
	childRunID := task.RunID
	// commit message should be the task label, not the full child goal (which embeds plan
	// description + headless contract).
	mergeMsg := task.Label
	if mergeMsg == "" {
		mergeMsg = task.ID
	}
	// merge-started closes the digest's merge-wait window (task-done -> here): the interval a
	// finished task spent waiting to be landed. Emitted only once the attempt is going ahead, so a
	// refused automatic attempt never opens a window it did not start.
	appendRunEvent(ctx, channelID, owner.ID, waveobj.RunEventKindTaskMergeStarted, nil, map[string]any{"taskid": taskID})
	sha, err := mergeWorktree(ctx, owner.ProjectPath, TaskWorktreeKey(owner.ID, taskID), mergeMsg)
	if err != nil {
		if errors.Is(err, ErrMergeConflict) {
			appendRunEvent(ctx, channelID, owner.ID, waveobj.RunEventKindTaskMergeBlocked, nil, map[string]any{"taskid": taskID})
			if derr := markBlockedMergeLocked(ctx, owner.DagORef, childRunID); derr != nil {
				return derr
			}
		}
		return err
	}
	return FinishMergedTask(ctx, channelID, owner.DagORef, childRunID, taskID, sha)
}

// FinishMergedTask stamps a landed merge and then removes the worktree. The caller holds the dag
// mutation lock.
func FinishMergedTask(ctx context.Context, channelID, dagID, childRunID, taskID, sha string) error {
	if err := persistMergedTask(ctx, channelID, dagID, childRunID, taskID, sha); err != nil {
		return err
	}
	g, err := wstore.GetDag(ctx, dagID)
	if err != nil {
		return err
	}
	appendRunEvent(ctx, channelID, g.RunID, waveobj.RunEventKindTaskMerged, nil, map[string]any{"taskid": taskID, "commit": sha})
	appendRunEvent(ctx, channelID, g.RunID, waveobj.RunEventKindTaskCleanupPending, nil, map[string]any{"taskid": taskID})
	return CleanupMergedTask(ctx, channelID, g, taskID)
}

// CleanupMergedTask removes a merged task's worktree, persists the outcome and seals the child's
// evidence. The caller holds the dag mutation lock.
func CleanupMergedTask(ctx context.Context, channelID string, g *waveobj.TaskGroup, taskID string) error {
	task := taskByID(g, taskID)
	if task == nil {
		return fmt.Errorf("no task %q", taskID)
	}
	childRunID := task.RunID
	cleanupErr := CleanupTaskWorktree(ctx, g, taskID)
	if err := PersistCleanupState(ctx, g); err != nil {
		return err
	}
	if cleanupErr != nil {
		appendRunEvent(ctx, channelID, g.RunID, waveobj.RunEventKindTaskCleanupFailed, nil, map[string]any{"taskid": taskID, "error": cleanupErr.Error()})
		return cleanupErr
	}
	appendRunEvent(ctx, channelID, g.RunID, waveobj.RunEventKindTaskCleanupCompleted, nil, map[string]any{"taskid": taskID})
	child, err := wstore.GetRun(ctx, channelID, childRunID)
	if err != nil {
		return fmt.Errorf("loading child run: %w", err)
	}
	return jarvis.SealEvidence(ctx, child)
}

func persistMergedTask(ctx context.Context, channelID, dagID, childRunID, taskID, sha string) error {
	if err := withMutationTx(ctx, func(tx *wstore.TxWrap) error {
		txCtx := tx.Context()
		if err := wstore.UpdateRun(txCtx, channelID, childRunID, func(r *waveobj.Run) error {
			r.EndCommit = sha
			return nil
		}); err != nil {
			return err
		}
		return wstore.UpdateDag(txCtx, dagID, func(cur *waveobj.TaskGroup) error {
			task := taskByID(cur, taskID)
			if task == nil {
				return fmt.Errorf("no task %q", taskID)
			}
			task.Merged = true
			task.CleanupPending = true
			task.CleanupError = ""
			RecomputeDagStatus(cur)
			return nil
		})
	}); err != nil {
		return err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, dagID))
	return nil
}

// AutoMergeReady lands every task whose work is finished and whose gate, if it has one, a human
// already released. Under MergeRequired the merge is what unblocks a dependent, so leaving it to the
// lead put a language model on the critical path of every edge in the dag; dispatch has always been
// the watchdog's job and this makes the merge match. A conflict still stops at the human: the task
// goes blocked-merge exactly as it does from the RPC, and is not retried on the next tick.
func AutoMergeReady(ctx context.Context, dagID string) {
	g, err := wstore.GetDag(ctx, dagID)
	if err != nil || g.Status == DagStatus_Cancelled || !g.MergeRequired {
		return
	}
	ready := autoMergeable(g)
	if len(ready) == 0 {
		return
	}
	owner, err := wstore.GetRun(ctx, g.ChannelId, g.RunID)
	if err != nil {
		return
	}
	for _, taskID := range ready {
		err := mergeTaskEntry(ctx, g.ChannelId, owner.ID, taskID, true)
		switch {
		case err == nil, errors.Is(err, ErrMergeConflict):
		case errors.Is(err, errIndexNotClean):
			// the human is mid-edit in the project tree; the tasks stay merge-ready for them and
			// the next tick retries. Reported once per tick, not once per task.
			log.Printf("dag %s: holding %d merge(s), project index is not clean", g.ID, len(ready))
			return
		default:
			log.Printf("dag %s: auto-merging task %s: %v", g.ID, taskID, err)
		}
	}
}

// autoMergeable lists tasks whose merge can be landed without asking anyone: finished, not yet
// merged, past their gate. blocked-merge is excluded — a conflicted tree is the human's.
func autoMergeable(g *waveobj.TaskGroup) []string {
	var out []string
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.State != TaskState_Done || t.Merged || t.RunID == "" {
			continue
		}
		if t.Gate && !t.Released {
			continue
		}
		out = append(out, t.ID)
	}
	return out
}

// IndexClean reports whether the project has nothing staged. Unstaged edits are left alone by the
// squash commit (it commits the index, with no pathspec) and an overlapping one makes git refuse the
// merge outright, so the index is the whole hazard. Unmerged entries from an earlier conflict also
// read as not clean, which is what keeps the automatic path off a tree mid-merge.
func IndexClean(ctx context.Context, projectPath string) (bool, error) {
	if _, err := git(ctx, projectPath, "diff", "--cached", "--quiet"); err != nil {
		// exit 1 is "there are staged changes", not a failure to ask about.
		return false, nil
	}
	return true, nil
}
