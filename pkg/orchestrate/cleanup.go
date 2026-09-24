// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"fmt"
	"log"
	"path/filepath"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// MaxCleanupErrorLen bounds the persisted per-task cleanup error detail.
const MaxCleanupErrorLen = 200

// MaxCleanupAttempts is how many failed removals a task's cleanup debt survives before it stops
// blocking the dag from finishing (about two and a half minutes at one retry per watchdog tick).
const MaxCleanupAttempts = 5

// RemoveTaskWorktree is the injectable tree-removal step so tests can stub failures without a
// real git repository (mirrors the exported jarvis.SpawnRunWorker seam; in the merge/retry paths
// the caller goes through CleanupTaskWorktree, never this var directly).
var RemoveTaskWorktree = RemoveRunWorktree

// PendingCleanupTasks returns merged tasks carrying cleanup debt, in DAG order.
func PendingCleanupTasks(g *waveobj.TaskGroup) []*waveobj.TaskNode {
	var out []*waveobj.TaskNode
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if (t.Merged || g.Status == DagStatus_Cancelled) && (t.CleanupPending || t.CleanupError != "") {
			out = append(out, t)
		}
	}
	return out
}

// cleanupGivenUp reports whether a task's cleanup debt has exhausted its retries.
func cleanupGivenUp(t *waveobj.TaskNode) bool {
	return t.CleanupAttempts >= MaxCleanupAttempts
}

// GiveUpCleanupTasks returns the tasks whose cleanup debt is over the retry cap, so the digest can
// name the trees that need removing by hand.
func GiveUpCleanupTasks(g *waveobj.TaskGroup) []*waveobj.TaskNode {
	var out []*waveobj.TaskNode
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if (t.CleanupPending || t.CleanupError != "") && cleanupGivenUp(t) {
			out = append(out, t)
		}
	}
	return out
}

// HasCleanupDebt reports whether any merged task still owns a worktree waiting
// on cleanup, so digest health can keep terminal DAGs with debt in needs-you.
func HasCleanupDebt(g *waveobj.TaskGroup) bool {
	for i := range g.Tasks {
		if g.Tasks[i].CleanupPending || g.Tasks[i].CleanupError != "" {
			return true
		}
	}
	return false
}

// CleanupTaskWorktree removes one merged task's worktree idempotently and records the outcome on the
// task node; the caller persists the group and publishes. Task state and merge identity are never
// disturbed: a cleanup failure cannot turn an already-landed merge back into a failed task. The
// removal half is the same RemoveRunWorktree used elsewhere; the helper only guarantees the state
// bookkeeping around it (pending always clears; success clears error; failure records a bounded
// error).
func CleanupTaskWorktree(ctx context.Context, g *waveobj.TaskGroup, taskID string) error {
	task := taskByID(g, taskID)
	if task == nil {
		return fmt.Errorf("no task %q", taskID)
	}
	if !task.Merged && g.Status != DagStatus_Cancelled {
		return fmt.Errorf("task %s is not merged", taskID)
	}
	projectPath, err := cleanupProjectPath(ctx, g)
	if err != nil {
		task.CleanupPending = false
		task.CleanupError = boundedCleanupError(err)
		task.CleanupAttempts++
		return err
	}
	key := LaneWorktreeKey(g, taskID)
	reapLaneWorkers(ctx, g, taskID, worktreeDir(projectPath, key))
	err = RemoveTaskWorktree(ctx, projectPath, key)
	task.CleanupPending = false
	if err != nil {
		task.CleanupError = boundedCleanupError(err)
		task.CleanupAttempts++
		return err
	}
	task.CleanupError = ""
	task.CleanupAttempts = 0
	return nil
}

// reapLaneWorkers stops every run still holding the tree about to be removed. A harness sits at its prompt after
// reporting done instead of exiting, and on Windows a live process holding the tree as its cwd is what makes
// git's removal leave the directory behind. The lane's own tasks are reaped by id; everything else this dag ran
// in the tree - reviewers, whose ReviewRunID is cleared once their verdict applies, and replacements - is found
// by path. Best effort: the removal below is what decides whether cleanup succeeded.
func reapLaneWorkers(ctx context.Context, g *waveobj.TaskGroup, taskID, tree string) {
	reaped := map[string]bool{}
	stop := func(run *waveobj.Run) {
		if run == nil || reaped[run.ID] {
			return
		}
		reaped[run.ID] = true
		if err := stopRunWorkers(ctx, run); err != nil {
			log.Printf("dag %s run %s: stopping worker in %s: %v", g.OID, run.ID, tree, err)
		}
	}
	for _, id := range laneOf(g, taskID) {
		task := taskByID(g, id)
		if task == nil || task.RunID == "" {
			continue
		}
		child, err := wstore.GetRun(ctx, g.ChannelId, task.RunID)
		if err != nil {
			log.Printf("dag %s task %s: loading child run to stop its worker: %v", g.OID, id, err)
			continue
		}
		stop(child)
	}
	runs, err := wstore.GetChannelRuns(ctx, g.ChannelId)
	if err != nil {
		log.Printf("dag %s: listing runs to reap %s: %v", g.OID, tree, err)
		return
	}
	for _, run := range runs {
		if run.DagORef == g.OID && run.ProjectPath != "" && filepath.Clean(run.ProjectPath) == filepath.Clean(tree) {
			stop(run)
		}
	}
}

// cleanupProjectPath resolves the repo a task's worktree belongs to. The owning run is the authority
// because that is what the merge path uses (owner.ProjectPath); resolving cleanup from a different
// source risks removing a worktree from a different repo than the one merged into. The channel is
// only a fallback for a group whose run row is unreadable.
func cleanupProjectPath(ctx context.Context, g *waveobj.TaskGroup) (string, error) {
	if run, err := wstore.GetRun(ctx, g.ChannelId, g.RunID); err == nil && run.ProjectPath != "" {
		return run.ProjectPath, nil
	}
	ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, g.ChannelId)
	if err != nil {
		return "", fmt.Errorf("loading channel for cleanup: %w", err)
	}
	return ch.ProjectPath, nil
}

// RetryPendingCleanup runs the idempotent helper over every task carrying cleanup debt, in DAG
// order, and returns the first cleanup error it hits. Tasks whose retry succeeds are cleared
// (including ones that failed before); tasks over the attempt cap are left alone. The caller
// persists the group and publishes.
func RetryPendingCleanup(ctx context.Context, g *waveobj.TaskGroup) error {
	var firstErr error
	for _, task := range PendingCleanupTasks(g) {
		if cleanupGivenUp(task) {
			continue
		}
		if err := CleanupTaskWorktree(ctx, g, task.ID); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// PersistCleanupState copies only cleanup fields onto the current stored DAG, recomputes status,
// then publishes the committed version. Callers can safely persist a stale cleanup snapshot without
// overwriting unrelated scheduler mutations.
func PersistCleanupState(ctx context.Context, g *waveobj.TaskGroup) error {
	type cleanupState struct {
		pending  bool
		err      string
		attempts int
	}
	states := make(map[string]cleanupState, len(g.Tasks))
	for i := range g.Tasks {
		states[g.Tasks[i].ID] = cleanupState{pending: g.Tasks[i].CleanupPending, err: g.Tasks[i].CleanupError, attempts: g.Tasks[i].CleanupAttempts}
	}
	if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
		for i := range cur.Tasks {
			state, ok := states[cur.Tasks[i].ID]
			if !ok {
				continue
			}
			cur.Tasks[i].CleanupPending = state.pending
			cur.Tasks[i].CleanupError = state.err
			cur.Tasks[i].CleanupAttempts = state.attempts
		}
		RecomputeDagStatus(cur)
		cur.UpdatedTs = time.Now().UnixMilli()
		return nil
	}); err != nil {
		return err
	}
	fresh, err := wstore.GetDag(ctx, g.OID)
	if err != nil {
		return err
	}
	*g = *fresh
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, g.OID))
	return nil
}

func boundedCleanupError(err error) string {
	if err == nil {
		return ""
	}
	msg := strings.TrimSpace(err.Error())
	if len(msg) > MaxCleanupErrorLen {
		msg = msg[:MaxCleanupErrorLen]
	}
	return msg
}
