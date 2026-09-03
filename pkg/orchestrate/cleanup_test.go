// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func newCleanupGroup(t *testing.T, ch *waveobj.Channel) *waveobj.TaskGroup {
	t.Helper()
	g, err := NewTaskGroup("run-1", ch.OID, "cleanup group", 2, false, []waveobj.TaskNode{
		{ID: "t-0", Label: "zero"},
		{ID: "t-1", Label: "one", Deps: []string{"t-0"}},
		{ID: "t-2", Label: "two", Deps: []string{"t-1"}},
		{ID: "t-3", Label: "three", Deps: []string{"t-2"}},
		{ID: "t-4", Label: "four", Deps: []string{"t-3"}},
	}, time.Now().UnixMilli(), nil)
	if err != nil {
		t.Fatal(err)
	}
	return &g
}

func stubCleanupRemover(t *testing.T, fn func(context.Context, string, string) error) {
	t.Helper()
	old := RemoveTaskWorktree
	RemoveTaskWorktree = fn
	t.Cleanup(func() { RemoveTaskWorktree = old })
}

func TestCleanupTaskWorktreeIdempotent(t *testing.T) {
	projectDir := newGitRepo(t)
	ch, err := wstore.CreateChannel(context.Background(), "cleanup-idem", projectDir)
	if err != nil {
		t.Fatal(err)
	}
	g := newCleanupGroup(t, ch)
	g.Tasks[0].State = TaskState_Done
	g.Tasks[0].Merged = true
	g.Tasks[0].CleanupPending = true

	// no worktree exists: the real remover must treat repeated cleanup as success.
	if err := CleanupTaskWorktree(context.Background(), g, "t-0"); err != nil {
		t.Fatalf("first cleanup: %v", err)
	}
	if err := CleanupTaskWorktree(context.Background(), g, "t-0"); err != nil {
		t.Fatalf("second cleanup: %v", err)
	}
	if g.Tasks[0].CleanupPending {
		t.Fatal("cleanup pending must be cleared")
	}
	if g.Tasks[0].CleanupError != "" {
		t.Fatalf("cleanup error must be cleared, got %q", g.Tasks[0].CleanupError)
	}
}

func TestCleanupTaskWorktreeAllowsUnmergedOnlyAfterCancellation(t *testing.T) {
	ch, err := wstore.CreateChannel(context.Background(), "cleanup-cancelled", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	g := newCleanupGroup(t, ch)
	g.Tasks[0].CleanupPending = true
	calls := 0
	stubCleanupRemover(t, func(context.Context, string, string) error {
		calls++
		return nil
	})

	if err := CleanupTaskWorktree(context.Background(), g, "t-0"); err == nil {
		t.Fatal("active unmerged task must reject cleanup")
	}
	g.Status = DagStatus_Cancelled
	if err := CleanupTaskWorktree(context.Background(), g, "t-0"); err != nil {
		t.Fatalf("cancelled task cleanup: %v", err)
	}
	if calls != 1 {
		t.Fatalf("removal calls = %d, want 1", calls)
	}
}

func TestCleanupTaskWorktreeBoundedError(t *testing.T) {
	ch, err := wstore.CreateChannel(context.Background(), "cleanup-bounded", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	g := newCleanupGroup(t, ch)
	g.Tasks[0].State = TaskState_Done
	g.Tasks[0].Merged = true
	g.Tasks[0].CleanupPending = true
	longErr := "windows dir lock: " + strings.Repeat("x", 300)
	stubCleanupRemover(t, func(context.Context, string, string) error {
		return errors.New(longErr)
	})

	if err := CleanupTaskWorktree(context.Background(), g, "t-0"); err == nil {
		t.Fatal("cleanup must surface the removal error")
	}
	if len(g.Tasks[0].CleanupError) > MaxCleanupErrorLen {
		t.Fatalf("cleanup error must be bounded, got %d chars", len(g.Tasks[0].CleanupError))
	}
	if g.Tasks[0].CleanupError == "" {
		t.Fatal("cleanup error must be recorded on the task")
	}
	if g.Tasks[0].State != TaskState_Done {
		t.Fatalf("failure must not disturb task state, got %s", g.Tasks[0].State)
	}
	if !g.Tasks[0].Merged {
		t.Fatal("failure must not disturb merge identity")
	}
	if g.Tasks[0].CleanupPending {
		t.Fatal("cleanup pending must be cleared after an attempted cleanup")
	}
}

func TestRetryPendingCleanupMixedDebt(t *testing.T) {
	ch, err := wstore.CreateChannel(context.Background(), "cleanup-retry", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	g := newCleanupGroup(t, ch)
	g.Tasks[1].Merged = true
	g.Tasks[1].CleanupPending = false
	g.Tasks[1].CleanupError = "locked"
	g.Tasks[4].Merged = true
	g.Tasks[4].CleanupPending = true
	g.Tasks[4].CleanupError = ""
	calls := 0
	stubCleanupRemover(t, func(ctx context.Context, projectPath, runID string) error {
		calls++
		if runID == TaskWorktreeKey(g.RunID, "t-1") {
			return errors.New("still locked")
		}
		return nil
	})

	err = RetryPendingCleanup(context.Background(), g)
	if err == nil || !strings.Contains(err.Error(), "still locked") {
		t.Fatalf("first failure must surface, got %v", err)
	}
	if calls != 2 {
		t.Fatalf("both debt tasks must be attempted, got %d calls", calls)
	}
	if g.Tasks[1].CleanupError == "" || len(g.Tasks[1].CleanupError) > MaxCleanupErrorLen {
		t.Fatalf("still-failing debt must keep a bounded error, got %q", g.Tasks[1].CleanupError)
	}
	if g.Tasks[4].CleanupPending || g.Tasks[4].CleanupError != "" {
		t.Fatalf("later cleared debt must clear the task, got pending=%v err=%q", g.Tasks[4].CleanupPending, g.Tasks[4].CleanupError)
	}

	// retry again once the blocker clears: the full debt set clears.
	stubCleanupRemover(t, func(context.Context, string, string) error { return nil })
	if err := RetryPendingCleanup(context.Background(), g); err != nil {
		t.Fatalf("retry after blocker clears: %v", err)
	}
	if HasCleanupDebt(g) {
		t.Fatal("all debt must be cleared after the successful retry")
	}
}

func TestPersistCleanupStateRecomputesDag(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "cleanup-persist", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	g := newCleanupGroup(t, ch)
	g.MergeRequired = true
	g.Tasks[0].State = TaskState_Done
	g.Tasks[0].Merged = true
	g.Tasks[0].CleanupPending = true
	for i := 1; i < len(g.Tasks); i++ {
		g.Tasks[i].State = TaskState_Skipped
	}
	if err := wstore.AppendDag(ctx, g); err != nil {
		t.Fatal(err)
	}

	g.Tasks[0].CleanupPending = false
	g.Tasks[0].CleanupError = "locked"
	if err := PersistCleanupState(ctx, g); err != nil {
		t.Fatal(err)
	}
	stored, err := wstore.GetDag(ctx, g.OID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Tasks[0].CleanupPending || stored.Tasks[0].CleanupError != "locked" {
		t.Fatalf("persisted cleanup state = pending %v error %q", stored.Tasks[0].CleanupPending, stored.Tasks[0].CleanupError)
	}
	if stored.Status == DagStatus_Done {
		t.Fatal("failed cleanup debt must keep the DAG non-terminal")
	}

	g.Tasks[0].CleanupError = ""
	if err := PersistCleanupState(ctx, g); err != nil {
		t.Fatal(err)
	}
	stored, err = wstore.GetDag(ctx, g.OID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != DagStatus_Done {
		t.Fatalf("cleared cleanup debt must complete the DAG, got %s", stored.Status)
	}
}

func TestPendingCleanupTasksOrder(t *testing.T) {
	ch, err := wstore.CreateChannel(context.Background(), "cleanup-order", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	g := newCleanupGroup(t, ch)
	g.Tasks[1].Merged = true
	g.Tasks[1].CleanupPending = true
	g.Tasks[4].Merged = true
	g.Tasks[4].CleanupError = "locked"

	got := PendingCleanupTasks(g)
	if len(got) != 2 {
		t.Fatalf("want 2 debt tasks, got %d: %v", len(got), got)
	}
	if got[0].ID != "t-1" || got[1].ID != "t-4" {
		t.Fatalf("debt tasks must come back in DAG order, got %s, %s", got[0].ID, got[1].ID)
	}
	if !HasCleanupDebt(g) {
		t.Fatal("group with cleanup debt must report HasCleanupDebt")
	}
	g.Tasks[1].CleanupPending = false
	g.Tasks[4].CleanupError = ""
	if HasCleanupDebt(g) {
		t.Fatal("group without cleanup debt must not report HasCleanupDebt")
	}
	g.Tasks[0].CleanupError = "orphaned debt"
	if !HasCleanupDebt(g) {
		t.Fatal("persisted cleanup flags must report debt even before merge identity is present")
	}
	if got := PendingCleanupTasks(g); len(got) != 0 {
		t.Fatalf("active unmerged debt must not be retried, got %v", got)
	}
	g.Status = DagStatus_Cancelled
	if got := PendingCleanupTasks(g); len(got) != 1 || got[0].ID != "t-0" {
		t.Fatalf("cancelled unmerged debt must be retryable, got %v", got)
	}
}
