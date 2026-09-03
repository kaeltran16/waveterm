// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// MaxCleanupErrorLen bounds the persisted per-task cleanup error detail.
const MaxCleanupErrorLen = 200

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
		return err
	}
	err = RemoveTaskWorktree(ctx, projectPath, TaskWorktreeKey(g.RunID, taskID))
	task.CleanupPending = false
	if err != nil {
		task.CleanupError = boundedCleanupError(err)
		return err
	}
	task.CleanupError = ""
	return nil
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
// (including ones that failed before); the caller persists the group and publishes.
func RetryPendingCleanup(ctx context.Context, g *waveobj.TaskGroup) error {
	var firstErr error
	for _, task := range PendingCleanupTasks(g) {
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
	states := make(map[string]struct {
		pending bool
		err     string
	}, len(g.Tasks))
	for i := range g.Tasks {
		states[g.Tasks[i].ID] = struct {
			pending bool
			err     string
		}{pending: g.Tasks[i].CleanupPending, err: g.Tasks[i].CleanupError}
	}
	if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
		for i := range cur.Tasks {
			state, ok := states[cur.Tasks[i].ID]
			if !ok {
				continue
			}
			cur.Tasks[i].CleanupPending = state.pending
			cur.Tasks[i].CleanupError = state.err
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
