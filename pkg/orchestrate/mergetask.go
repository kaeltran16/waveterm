// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/util/ds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// mergeWorktree is the squash-merge seam so tests can drive merge outcomes without a git repo.
var mergeWorktree = MergeRunWorktree

// continueMerge commits a squash merge the caller resolved; a seam so tests skip the real conflict.
var continueMerge = MergeContinue

// mergeLane is what the squash commit of lane names, less its skipped tasks, as laneMergeMessage leaves them
// out of the title.
func mergeLane(g *waveobj.TaskGroup, lane []string) MergeLane {
	var ids []string
	for _, id := range lane {
		if t := taskByID(g, id); t != nil && t.State != TaskState_Skipped {
			ids = append(ids, id)
		}
	}
	return MergeLane{Title: laneMergeMessage(g, lane), TaskIDs: ids}
}

// mergeFailureLimit is how many consecutive refusals the automatic path absorbs before the task blocks
// and asks. Three ticks is ~90s: long enough to ride out the case that motivated this — a stray file in
// the project tree that a human removes moments later — and short enough that nobody watches a run make
// no progress for long.
const mergeFailureLimit = 3

// MergeTask lands the finished lane holding a task on the project branch, stamps the merge and removes the
// lane's tree. It holds the dag mutation lock across reload -> merge -> stamp -> cleanup for two reasons:
// the engine persists a tick as a whole-object replace of a snapshot taken under that lock, so a
// stamp written outside it is silently reverted by any overlapping tick; and two mergers running a
// squash merge against one project tree collide on git's index lock. Nothing inside re-enters the
// lock (it is not reentrant).
func MergeTask(ctx context.Context, channelID, ownerRunID, taskID string) error {
	return mergeTaskEntry(ctx, channelID, ownerRunID, taskID, false)
}

// ContinueMerge is `dag merge <task> --continue`, the lead's way out of the two landing failures it is
// woken for: it commits a squash merge the caller resolved after a conflict, or re-runs Verify at the
// project's HEAD after the caller committed a fix. Either way the next merge waits for that Verify.
func ContinueMerge(ctx context.Context, channelID, ownerRunID, taskID string) error {
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
	g, err := wstore.GetDag(ctx, owner.DagORef)
	if err != nil {
		return err
	}
	task := taskByID(g, taskID)
	if task == nil {
		return fmt.Errorf("no task %q", taskID)
	}
	switch {
	case task.State == TaskState_VerifyFailed:
		return rerunVerify(ctx, channelID, owner, taskID)
	case task.Merged:
		if !task.CleanupPending && task.CleanupError == "" {
			return nil
		}
		return withDagMutation(owner.DagORef, func() error {
			return CleanupMergedTask(ctx, channelID, g, taskID)
		})
	case task.State == TaskState_BlockedMerge && task.MergeError != "":
		return retryRefusedMerge(ctx, channelID, owner, taskID)
	case task.State == TaskState_BlockedMerge:
		return continueBlockedMerge(ctx, channelID, owner, g, task)
	}
	return fmt.Errorf("task %s is %s, want blocked-merge or verify-failed", taskID, task.State)
}

// retryRefusedMerge is `--continue` for a merge git refused outright rather than conflicted. The squash
// never applied, so there is no resolved tree to commit: continuing it would run `git commit` over an
// index the merge never touched, and finishMerge reads an empty commit as an idempotent retry and stamps
// the task merged with none of its content. The only correct continuation is the whole merge again.
//
// The retry budget is cleared first so the timeline numbers the human's attempt 1 rather than 4. The task
// stays blocked-merge until it lands: once it has been handed over, the scheduler does not take it back.
func retryRefusedMerge(ctx context.Context, channelID string, owner *waveobj.Run, taskID string) error {
	if err := withDagMutation(owner.DagORef, func() error {
		return clearMergeFailureLocked(ctx, owner.DagORef, taskID)
	}); err != nil {
		return err
	}
	appendRunEvent(ctx, channelID, owner.ID, waveobj.RunEventKindTaskMergeContinued, nil, map[string]any{"taskid": taskID})
	return mergeTaskEntry(ctx, channelID, owner.ID, taskID, false)
}

// continueBlockedMerge commits the resolved project state of a conflicted squash merge, stamps it like
// any merge, and hands the checkout to Verify when the plan has one. The blocked task is its lane's tip.
func continueBlockedMerge(ctx context.Context, channelID string, owner *waveobj.Run, g *waveobj.TaskGroup, task *waveobj.TaskNode) error {
	if task.RunID == "" {
		return fmt.Errorf("task %s has no child run", task.ID)
	}
	if err := checkLandingTree(ctx, owner); err != nil {
		return err
	}
	l, err := claimProject(jarvis.LandPath(owner), owner.DagORef, task.ID)
	if err != nil {
		return err
	}
	appendRunEvent(ctx, channelID, owner.ID, waveobj.RunEventKindTaskMergeContinued, nil, map[string]any{"taskid": task.ID})
	sha, err := continueMerge(ctx, jarvis.LandPath(owner), LaneWorktreeKey(g, task.ID), mergeLane(g, laneOf(g, task.ID)), laneFold(g))
	if err != nil {
		releaseProject(jarvis.LandPath(owner), l)
		return err
	}
	var verify string
	// the stamp is a dag write, and the engine reverts any dag write made outside this lock
	err = withDagMutation(owner.DagORef, func() error {
		var ferr error
		verify, ferr = FinishMergedTask(ctx, channelID, owner.DagORef, task.RunID, task.ID, sha)
		return ferr
	})
	landAfterMerge(channelID, owner, task.ID, verify, l)
	return err
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
	l, err := claimProject(jarvis.LandPath(owner), owner.DagORef, taskID)
	if err != nil {
		return err
	}
	var verify string
	err = withDagMutation(owner.DagORef, func() error {
		var lerr error
		verify, lerr = mergeTaskLocked(ctx, channelID, owner, taskID, requireCleanIndex)
		return lerr
	})
	landAfterMerge(channelID, owner, taskID, verify, l)
	return err
}

// landAfterMerge hands the project claim to the Verify a landed merge waits on, or releases it.
func landAfterMerge(channelID string, owner *waveobj.Run, taskID, verify string, l *landing) {
	if verify == "" {
		releaseProject(jarvis.LandPath(owner), l)
		return
	}
	startVerify(channelID, owner.DagORef, owner.ID, taskID, jarvis.LandPath(owner), verify, l)
}

// errIndexNotClean is the automatic path's refusal: the squash commit commits whatever the index
// holds, so a human's staged edits would land inside the task's commit.
var errIndexNotClean = errors.New("project index is not clean")

// mergeTaskLocked lands the lane holding taskID and returns the plan's Verify command when the landed merge
// now waits on it. A lane lands as one squash commit recorded on its tip, whichever of its tasks was named,
// and only once every task in it is done or skipped.
func mergeTaskLocked(ctx context.Context, channelID string, owner *waveobj.Run, taskID string, requireCleanIndex bool) (string, error) {
	g, err := wstore.GetDag(ctx, owner.DagORef)
	if err != nil {
		return "", err
	}
	if taskByID(g, taskID) == nil {
		return "", fmt.Errorf("no task %q", taskID)
	}
	lane := laneOf(g, taskID)
	task := laneTip(g, lane)
	if task == nil {
		return "", fmt.Errorf("task %s: every task in lane %s was skipped, so there is nothing to merge", taskID, strings.Join(lane, ", "))
	}
	if task.Merged {
		if !task.CleanupPending && task.CleanupError == "" {
			return "", nil
		}
		return "", CleanupMergedTask(ctx, channelID, g, task.ID)
	}
	for _, id := range lane {
		t := taskByID(g, id)
		if t.State == TaskState_Done || t.State == TaskState_Skipped || (t.ID == task.ID && t.State == TaskState_BlockedMerge) {
			continue
		}
		return "", fmt.Errorf("task %s is %s, want done: lane %s lands as one merge once all of it is done", t.ID, t.State, strings.Join(lane, ", "))
	}
	if task.RunID == "" {
		return "", fmt.Errorf("task %s has no child run", task.ID)
	}
	if held := conflictAwaitingContinue(g, task.ID); held != "" {
		return "", fmt.Errorf("%w: task %s's merge conflict is waiting for `wsh jarvis dag merge %s --continue`", errProjectBusy, held, held)
	}
	// recorded like git's own refusals: a scheduler-driven merge has no other place to say it
	if err := checkLandingTree(ctx, owner); err != nil {
		if rerr := recordMergeFailureLocked(ctx, owner.DagORef, task.ID, err.Error(), mergeFailureLimit); rerr != nil {
			return "", errors.Join(err, rerr)
		}
		return "", err
	}
	if requireCleanIndex {
		// AutoMergeReady checks this from a read taken before the claim, which misses a Verify that failed
		// and released in between
		for _, state := range []string{TaskState_Verifying, TaskState_VerifyFailed} {
			if held := tasksInState(g, state); len(held) > 0 {
				return "", fmt.Errorf("%w: task %s is %s", errProjectBusy, held[0], state)
			}
		}
		clean, cerr := IndexClean(ctx, jarvis.LandPath(owner))
		if cerr != nil {
			return "", cerr
		}
		if !clean {
			return "", errIndexNotClean
		}
	}
	childRunID := task.RunID
	// merge-started closes the digest's merge-wait window (task-done -> here): the interval a
	// finished task spent waiting to be landed. Emitted only once the attempt is going ahead, so a
	// refused automatic attempt never opens a window it did not start.
	appendRunEvent(ctx, channelID, owner.ID, waveobj.RunEventKindTaskMergeStarted, nil, map[string]any{"taskid": task.ID})
	sha, err := mergeWorktree(ctx, jarvis.LandPath(owner), LaneWorktreeKey(g, task.ID), mergeLane(g, lane), laneFold(g))
	if err != nil {
		if errors.Is(err, ErrMergeConflict) {
			appendRunEvent(ctx, channelID, owner.ID, waveobj.RunEventKindTaskMergeBlocked, nil, map[string]any{"taskid": task.ID})
			if derr := markBlockedMergeLocked(ctx, owner.DagORef, childRunID); derr != nil {
				return "", derr
			}
			return "", err
		}
		// every other refusal is git declining the squash over the state of the project checkout. It is
		// recorded rather than only returned, because the caller is usually the scheduler, whose only
		// report is a server log line nobody is reading during a run.
		if rerr := recordMergeFailureLocked(ctx, owner.DagORef, task.ID, err.Error(), mergeFailureLimit); rerr != nil {
			return "", errors.Join(err, rerr)
		}
		return "", err
	}
	return FinishMergedTask(ctx, channelID, owner.DagORef, childRunID, task.ID, sha)
}

// conflictAwaitingContinue names a task other than except whose squash merge conflicted and has not been
// continued: blocked-merge with no MergeError. A refused merge records one, and its squash never touched
// the tree. Such a task owns the project: its resolver commits the fix and then continues, and a lane
// landing in between would be the HEAD that --continue credits.
func conflictAwaitingContinue(g *waveobj.TaskGroup, except string) string {
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.ID != except && t.State == TaskState_BlockedMerge && t.MergeError == "" {
			return t.ID
		}
	}
	return ""
}

// FinishMergedTask stamps a landed merge and then removes the worktree. It returns the plan's Verify
// command when the task now waits on it, even when the cleanup failed: the merge landed either way. The
// caller holds the dag mutation lock.
func FinishMergedTask(ctx context.Context, channelID, dagID, childRunID, taskID, sha string) (string, error) {
	if err := persistMergedTask(ctx, channelID, dagID, childRunID, taskID, sha); err != nil {
		return "", err
	}
	g, err := wstore.GetDag(ctx, dagID)
	if err != nil {
		return "", err
	}
	appendRunEvent(ctx, channelID, g.RunID, waveobj.RunEventKindTaskMerged, nil, map[string]any{"taskid": taskID, "commit": sha})
	appendRunEvent(ctx, channelID, g.RunID, waveobj.RunEventKindTaskCleanupPending, nil, map[string]any{"taskid": taskID})
	return g.Verify, CleanupMergedTask(ctx, channelID, g, taskID)
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
			// the squash landed every finished task in the lane; the commit, cleanup and Verify are the tip's
			for _, id := range laneOf(cur, taskID) {
				if t := taskByID(cur, id); t.State == TaskState_Done {
					t.Merged = true
				}
			}
			task.Merged = true
			task.CleanupPending = true
			task.CleanupError = ""
			task.CleanupAttempts = 0
			// the squash landed, so whatever git was refusing over is gone; a later lane must not
			// inherit this one's spent retry budget
			task.MergeFailures, task.MergeError = 0, ""
			// written here, not derived: a continued conflict leaves blocked-merge, which nothing re-derives
			task.State = TaskState_Done
			if cur.Verify != "" {
				task.State = TaskState_Verifying
				task.VerifyStartedTs = time.Now().UnixMilli()
			}
			RecomputeDagStatus(cur)
			return nil
		})
	}); err != nil {
		return err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, dagID))
	return nil
}

// AutoMergeReady lands every lane whose work is finished and whose gates a human already released.
// Under MergeRequired the merge is what unblocks a dependent in another lane, so leaving it to the
// lead put a language model on the critical path of every edge in the dag; dispatch has always been
// the watchdog's job and this makes the merge match. A conflict still stops at the human: the task
// goes blocked-merge exactly as it does from the RPC, and is not retried on the next tick. A merge also
// waits for the Verify of the one before it, and a failed Verify holds every later merge until it passes.
func AutoMergeReady(ctx context.Context, dagID string) {
	g, err := wstore.GetDag(ctx, dagID)
	if err != nil || g.Status == DagStatus_Cancelled || !g.MergeRequired {
		return
	}
	if ids := tasksInState(g, TaskState_Verifying); len(ids) > 0 {
		resumeVerify(ctx, g, ids[0])
		return
	}
	if len(tasksInState(g, TaskState_VerifyFailed)) > 0 {
		return
	}
	ready := autoMergeable(g)
	if len(ready) == 0 {
		// nothing is waiting, so nothing is held — including when the merges landed by another path
		noteMergesHeld(ctx, g, 0)
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
			noteMergesHeld(ctx, g, 0)
		case errors.Is(err, errProjectBusy):
			// a landing holds the checkout; its Verify ticks the dag when it finishes
			return
		case errors.Is(err, errIndexNotClean):
			// the human is mid-edit in the project tree; the tasks stay merge-ready for them and
			// the next tick retries. Reported once per tick, not once per task.
			log.Printf("dag %s: holding %d merge(s), project index is not clean", g.ID, len(ready))
			noteMergesHeld(ctx, g, len(ready))
			return
		default:
			log.Printf("dag %s: auto-merging task %s: %v", g.ID, taskID, err)
		}
	}
}

// mergesHeld remembers which dags are currently holding their merges on a dirty index, so the hold is
// recorded when it STARTS rather than on every tick. In memory only: a restart re-reports a hold that is
// still in force, which is the harmless direction — the alternative is a hold nobody is ever told about.
var mergesHeld = ds.MakeSyncMap[bool]()

// noteMergesHeld records the transition into holding merges on a dirty project index. held is how many
// merges are waiting, 0 to clear. SetUnless is the transition: only the publish that claims the key
// records a row, so re-entering this every tick says nothing further.
func noteMergesHeld(ctx context.Context, g *waveobj.TaskGroup, held int) {
	if held == 0 {
		mergesHeld.Delete(g.OID)
		return
	}
	if !mergesHeld.SetUnless(g.OID, true) {
		return
	}
	appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindMergeHeld, nil, map[string]any{
		"held": held, "reason": errIndexNotClean.Error(),
	})
}

// autoMergeable lists the lanes that can be landed without asking anyone, by their tip: every task
// finished or skipped, nothing merged yet, every gate released. blocked-merge is excluded — a conflicted
// tree is the human's.
func autoMergeable(g *waveobj.TaskGroup) []string {
	var out []string
	for _, lane := range jarvis.Lanes(g.Tasks) {
		if tip := laneMergeReady(g, lane); tip != nil {
			out = append(out, tip.ID)
		}
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
