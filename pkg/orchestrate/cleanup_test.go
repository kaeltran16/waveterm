// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func newCleanupGroup(t *testing.T, ch *waveobj.Channel) *waveobj.TaskGroup {
	t.Helper()
	g, err := NewTaskGroup("run-1", ch.OID, "cleanup group", 2, false, []waveobj.TaskNode{
		// independent tasks: each is a lane of its own, so each cleanup keys its own tree
		{ID: "t-0", Label: "zero"},
		{ID: "t-1", Label: "one"},
		{ID: "t-2", Label: "two"},
		{ID: "t-3", Label: "three"},
		{ID: "t-4", Label: "four"},
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

func TestCleanupTaskWorktreeCountsAttempts(t *testing.T) {
	ch, err := wstore.CreateChannel(context.Background(), "cleanup-attempts", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	g := newCleanupGroup(t, ch)
	g.Tasks[0].State = TaskState_Done
	g.Tasks[0].Merged = true
	fail := true
	stubCleanupRemover(t, func(context.Context, string, string) error {
		if fail {
			return errors.New("being used by another process")
		}
		return nil
	})

	for want := 1; want <= 3; want++ {
		if err := CleanupTaskWorktree(context.Background(), g, "t-0"); err == nil {
			t.Fatal("stubbed removal must fail")
		}
		if g.Tasks[0].CleanupAttempts != want {
			t.Fatalf("attempts = %d, want %d", g.Tasks[0].CleanupAttempts, want)
		}
	}
	fail = false
	if err := CleanupTaskWorktree(context.Background(), g, "t-0"); err != nil {
		t.Fatalf("cleanup after the blocker clears: %v", err)
	}
	if g.Tasks[0].CleanupAttempts != 0 || g.Tasks[0].CleanupError != "" {
		t.Fatalf("success must reset attempts and error, got %d %q", g.Tasks[0].CleanupAttempts, g.Tasks[0].CleanupError)
	}
}

func TestRetryPendingCleanupSkipsTasksOverTheCap(t *testing.T) {
	ch, err := wstore.CreateChannel(context.Background(), "cleanup-cap", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	g := newCleanupGroup(t, ch)
	g.Tasks[1].Merged = true
	g.Tasks[1].CleanupError = "locked"
	g.Tasks[1].CleanupAttempts = MaxCleanupAttempts
	g.Tasks[4].Merged = true
	g.Tasks[4].CleanupError = "locked"
	g.Tasks[4].CleanupAttempts = 1
	var keys []string
	stubCleanupRemover(t, func(_ context.Context, _, key string) error {
		keys = append(keys, key)
		return nil
	})

	if err := RetryPendingCleanup(context.Background(), g); err != nil {
		t.Fatal(err)
	}
	if len(keys) != 1 || keys[0] != TaskWorktreeKey(g.RunID, "t-4") {
		t.Fatalf("only the task under the cap may be retried, got %v", keys)
	}
	if given := GiveUpCleanupTasks(g); len(given) != 1 || given[0].ID != "t-1" {
		t.Fatalf("GiveUpCleanupTasks = %v, want only t-1", given)
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
	if stored.Status != DagStatus_Finalizing {
		t.Fatalf("cleared cleanup debt must hand the DAG to the final stage, got %s", stored.Status)
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

// A worker harness sits at its prompt after reporting done instead of exiting, and its live cwd is what
// keeps the tree busy. Every task in a lane ran in the one shared tree, so the whole lane is reaped, and
// it happens before the removal, not after.
func TestCleanupTaskWorktreeReapsTheLanesWorkersFirst(t *testing.T) {
	ctx := context.Background()
	projectDir := newGitRepo(t)
	ch, err := wstore.CreateChannel(ctx, "cleanup-reap", projectDir)
	if err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup("run-1", ch.OID, "reap group", 2, false, []waveobj.TaskNode{
		{ID: "t-1", Label: "one"},
		{ID: "t-2", Label: "two", Deps: []string{"t-1"}}, // same lane, same worktree, own worker
		{ID: "t-3", Label: "three"},                      // a lane of its own: must not be reaped
	}, time.Now().UnixMilli(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for i := range g.Tasks {
		runID := "child-" + g.Tasks[i].ID
		g.Tasks[i].RunID = runID
		g.Tasks[i].State = TaskState_Done
		g.Tasks[i].Merged = true
		if err := wstore.AppendRun(ctx, ch.OID, waveobj.Run{
			ID:     runID,
			Phases: []waveobj.RunPhase{{WorkerOrefs: []string{"tab:" + runID}}},
		}); err != nil {
			t.Fatal(err)
		}
	}
	g.Tasks[1].CleanupPending = true

	var order []string
	oldStop := stopRunWorkers
	stopRunWorkers = func(_ context.Context, run *waveobj.Run) error {
		order = append(order, "stop:"+run.ID)
		return nil
	}
	t.Cleanup(func() { stopRunWorkers = oldStop })
	stubCleanupRemover(t, func(context.Context, string, string) error {
		order = append(order, "remove")
		return nil
	})

	if err := CleanupTaskWorktree(ctx, &g, "t-2"); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	want := []string{"stop:child-t-1", "stop:child-t-2", "remove"}
	if !slices.Equal(order, want) {
		t.Fatalf("cleanup of lane tip t-2 did %v, want %v", order, want)
	}
}

// A reviewer runs in the lane tree and stays at its prompt after its verdict, holding the tree as its cwd; the
// run's ReviewRunID is cleared by then, so only the tree path finds it (run 28caa81f lost five trees this way).
func TestCleanupTaskWorktreeReapsEveryRunInTheTree(t *testing.T) {
	ctx := context.Background()
	projectDir := newGitRepo(t)
	ch, err := wstore.CreateChannel(ctx, "cleanup-reap-tree", projectDir)
	if err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup("run-1", ch.OID, "reap tree group", 2, false, []waveobj.TaskNode{
		{ID: "t-1", Label: "one"},
		{ID: "t-2", Label: "two"},
	}, time.Now().UnixMilli(), nil)
	if err != nil {
		t.Fatal(err)
	}
	g.Tasks[0].RunID, g.Tasks[0].State, g.Tasks[0].Merged = "worker-t-1", TaskState_Done, true
	g.Tasks[0].CleanupPending = true
	tree := worktreeDir(projectDir, LaneWorktreeKey(&g, "t-1"))
	otherTree := worktreeDir(projectDir, LaneWorktreeKey(&g, "t-2"))
	for _, r := range []waveobj.Run{
		{ID: "worker-t-1", DagORef: g.OID, ProjectPath: tree},
		{ID: "reviewer-t-1", DagORef: g.OID, ProjectPath: tree},
		{ID: "reviewer-t-2", DagORef: g.OID, ProjectPath: otherTree},
		{ID: "other-dag", DagORef: "some-other-dag", ProjectPath: tree},
	} {
		r.Phases = []waveobj.RunPhase{{WorkerOrefs: []string{"tab:" + r.ID}}}
		if err := wstore.AppendRun(ctx, ch.OID, r); err != nil {
			t.Fatal(err)
		}
	}

	var stopped []string
	oldStop := stopRunWorkers
	stopRunWorkers = func(_ context.Context, run *waveobj.Run) error {
		stopped = append(stopped, run.ID)
		return nil
	}
	t.Cleanup(func() { stopRunWorkers = oldStop })
	stubCleanupRemover(t, func(context.Context, string, string) error { return nil })

	if err := CleanupTaskWorktree(ctx, &g, "t-1"); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	slices.Sort(stopped)
	if want := []string{"reviewer-t-1", "worker-t-1"}; !slices.Equal(stopped, want) {
		t.Fatalf("cleanup of t-1 stopped %v, want %v (never another tree's reviewer or another dag's run)", stopped, want)
	}
}

// seedCleanupDebt is a one-task dag whose merged task's tree failed removal until its attempts ran out.
func seedCleanupDebt(t *testing.T) (context.Context, *waveobj.TaskGroup) {
	t.Helper()
	ctx, dag := seedPendingDag(t)
	if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
		g.Tasks[0].State, g.Tasks[0].Merged = TaskState_Done, true
		g.Tasks[0].CleanupError = "removing worktree dir: unlinkat: The process cannot access the file"
		g.Tasks[0].CleanupAttempts = MaxCleanupAttempts
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	stubStopRunWorkers(t)
	return ctx, dag
}

func TestRetryCleanupClearsDebtOnceTheTreeGoes(t *testing.T) {
	ctx, dag := seedCleanupDebt(t)
	stubCleanupRemover(t, func(context.Context, string, string) error { return nil })
	if err := RetryCleanup(ctx, dag.OID, "t-0"); err != nil {
		t.Fatalf("retry-cleanup: %v", err)
	}
	task := firstTask(t, ctx, dag.OID)
	if task.CleanupError != "" || task.CleanupAttempts != 0 || task.CleanupPending {
		t.Fatalf("a removed tree clears the debt, got error %q attempts %d pending %v", task.CleanupError, task.CleanupAttempts, task.CleanupPending)
	}
}

// the attempts reset, so a tree still held counts one fresh failure and the watchdog keeps retrying it
func TestRetryCleanupThatFailsAgainRestartsTheAttempts(t *testing.T) {
	ctx, dag := seedCleanupDebt(t)
	stubCleanupRemover(t, func(context.Context, string, string) error { return errors.New("still locked") })
	err := RetryCleanup(ctx, dag.OID, "t-0")
	if err == nil || !strings.Contains(err.Error(), "still locked") {
		t.Fatalf("want the removal's error, got %v", err)
	}
	if task := firstTask(t, ctx, dag.OID); task.CleanupAttempts != 1 || task.CleanupError == "" {
		t.Fatalf("want one fresh attempt recorded, got attempts %d error %q", task.CleanupAttempts, task.CleanupError)
	}
}

func TestRetryCleanupRefusesATaskWithNoDebt(t *testing.T) {
	ctx, dag := seedPendingDag(t)
	if err := RetryCleanup(ctx, dag.OID, "t-0"); err == nil {
		t.Fatal("a task with no tree left must be refused")
	}
	if err := RetryCleanup(ctx, dag.OID, "t-404"); err == nil {
		t.Fatal("an unknown task must be refused")
	}
}

// cancelling queues every tree for cleanup, so a cancelled dag's debt must stay retryable
func TestRetryCleanupWorksOnACancelledDag(t *testing.T) {
	ctx, dag := seedCleanupDebt(t)
	if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
		g.Status = DagStatus_Cancelled
		g.Tasks[0].Merged = false
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	stubCleanupRemover(t, func(context.Context, string, string) error { return nil })
	if err := RetryCleanup(ctx, dag.OID, "t-0"); err != nil {
		t.Fatalf("retry-cleanup on a cancelled dag: %v", err)
	}
}
