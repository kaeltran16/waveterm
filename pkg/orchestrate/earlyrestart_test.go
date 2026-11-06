// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// earlyBased marks a dispatched dependent as started on base's tip.
func earlyBased(g *waveobj.TaskGroup, id, state, base string) {
	task := taskByID(g, id)
	task.State, task.RunID = state, "run-"+id
	task.EarlyBaseTask, task.EarlyBaseCommit = base, "tip-"+base
}

// runAfterCommit runs what a tick publishes once its dag commits.
func runAfterCommit(fns []func()) {
	for _, fn := range fns {
		fn()
	}
}

func assertRestarted(t *testing.T, g *waveobj.TaskGroup, id string) {
	t.Helper()
	task := taskByID(g, id)
	if task.State != TaskState_Pending || task.RunID != "" || !task.DiscardTree || task.EarlyRestarts != 1 ||
		task.EarlyBaseTask != "" || task.EarlyBaseCommit != "" || task.RestartTs == 0 {
		t.Fatalf("%s restarted: want pending, no run, discard, one restart, no base; got %+v", id, *task)
	}
}

func restartedRow(t *testing.T, f *fakeLead, taskID string) map[string]any {
	t.Helper()
	for _, r := range f.rows {
		if r["eventkind"] == waveobj.RunEventKindTaskRestarted && r["taskid"] == taskID {
			return r
		}
	}
	t.Fatalf("no task-restarted row for %s in %v", taskID, f.rows)
	return nil
}

func TestPredecessorReviewRejectRestartsDependent(t *testing.T) {
	f, tip := earlyFixture(t, true)
	f.dispatch(t, "t-2")
	depRun := taskByID(f.dag(t), "t-2").RunID
	if depRun == "" || taskByID(f.dag(t), "t-2").EarlyBaseTask != "t-1" {
		t.Fatalf("t-2 starts early on t-1, got %+v", *taskByID(f.dag(t), "t-2"))
	}
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		taskByID(cur, "t-1").ReviewRunID = "reviewer-t-1"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := RecordReviewVerdict(f.ctx, f.dagID, "reviewer-t-1", ReviewVerdict_Fail, "misses the index", "", "", nil); err != nil {
		t.Fatal(err)
	}
	stubReviewTree(t, tip)
	var stopped []string
	old := stopRunWorkers
	stopRunWorkers = func(_ context.Context, r *waveobj.Run) error {
		stopped = append(stopped, r.ID)
		return nil
	}
	restoreAfterStages(t, func() { stopRunWorkers = old })
	calls := captureSpawns(t)
	lead := newFakeLead(t)

	schedule(t, f.ctx, f.dagID)

	g := f.dag(t)
	if base := taskByID(g, "t-1"); base.State != TaskState_Running || base.ReviewRound != 1 {
		t.Fatalf("t-1 goes back for its fix round, got %s round %d", base.State, base.ReviewRound)
	}
	assertRestarted(t, g, "t-2")
	if g.Failures != 0 || taskByID(g, "t-2").Attempts != 0 {
		t.Fatalf("a restart is not a failure, got failures %d attempts %d", g.Failures, taskByID(g, "t-2").Attempts)
	}
	run, err := wstore.GetRun(f.ctx, f.channel, depRun)
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != jarvis.RunStatus_Cancelled || !slices.Contains(stopped, depRun) {
		t.Fatalf("t-2's worker run is cancelled and stopped, got %s, stopped %v", run.Status, stopped)
	}
	if got := restartedRow(t, lead, "t-2"); got["basetask"] != "t-1" || got["reason"] != "predecessor review failed" {
		t.Fatalf("task-restarted row = %v", got)
	}
	for _, c := range *calls {
		if c.opts.TaskId == "t-2" {
			t.Fatal("t-2 must not be dispatched in the tick that restarted it")
		}
	}
}

func TestPredecessorVerifyFailLeavesDependentRunning(t *testing.T) {
	g := forkGroup(t, true, map[string]string{"t-1": TaskState_VerifyFailed})
	markMerged(g, "t-1")
	earlyBased(g, "t-2", TaskState_Running, "t-1")
	var afterCommit []func()
	if got := restartEarlyDependents(context.Background(), g, &afterCommit); len(got) != 0 {
		t.Fatalf("a merged base lane restarts nothing, got %v", got)
	}
	if task := taskByID(g, "t-2"); task.State != TaskState_Running || task.RunID != "run-t-2" || task.EarlyBaseTask != "t-1" {
		t.Fatalf("t-2 keeps running, got %+v", *task)
	}
}

func TestPredecessorReviewFailedKeepsDependent(t *testing.T) {
	g := forkGroup(t, true, map[string]string{"t-1": TaskState_ReviewFailed})
	earlyBased(g, "t-2", TaskState_Running, "t-1")
	var afterCommit []func()
	if got := restartEarlyDependents(context.Background(), g, &afterCommit); len(got) != 0 || len(afterCommit) != 0 {
		t.Fatalf("the lead judges a review-failed base, so nothing restarts, got %v", got)
	}
	if task := taskByID(g, "t-2"); task.State != TaskState_Running || task.RunID != "run-t-2" || task.DiscardTree {
		t.Fatalf("t-2 is untouched, got %+v", *task)
	}
}

func TestPredecessorSkippedOrRetriedRestartsDependent(t *testing.T) {
	for _, base := range []string{TaskState_Skipped, TaskState_Pending} {
		g := forkGroup(t, true, map[string]string{"t-1": base})
		// t-2 finished and passed its review, held only by the merge order
		earlyBased(g, "t-2", TaskState_Done, "t-1")
		dep := taskByID(g, "t-2")
		dep.ReviewVerdict, dep.ReviewNote, dep.ReviewBase, dep.ReviewCommit = ReviewVerdict_Pass, "ok", "tip-t-1", "c-2"
		dep.LeadNotes = []string{"keep me"}
		lead := newFakeLead(t)
		var afterCommit []func()
		if got := restartEarlyDependents(context.Background(), g, &afterCommit); !slices.Equal(got, []string{"t-2"}) {
			t.Fatalf("base %s: want t-2 restarted, got %v", base, got)
		}
		assertRestarted(t, g, "t-2")
		if dep.ReviewVerdict != "" || dep.ReviewNote != "" || dep.ReviewBase != "" || dep.ReviewCommit != "" || len(dep.LeadNotes) != 1 {
			t.Fatalf("base %s: review outcome cleared and lead notes kept, got %+v", base, *dep)
		}
		runAfterCommit(afterCommit)
		if got := restartedRow(t, lead, "t-2"); got["reason"] != "predecessor "+base {
			t.Fatalf("base %s: reason %v", base, got["reason"])
		}
	}
}

// t-1 forks to t-2 and t-4, t-2 to t-3 and t-5: each is a lane of its own, so t-3 can start early on t-2 and t-2 on t-1
func TestRestartCascadesAlongEarlyChain(t *testing.T) {
	gv, err := NewTaskGroup("run-1", "ch-1", "g", 4, true, []waveobj.TaskNode{
		{ID: "t-1", Label: "a"},
		{ID: "t-2", Label: "b", Deps: []string{"t-1"}},
		{ID: "t-4", Label: "d", Deps: []string{"t-1"}},
		{ID: "t-3", Label: "c", Deps: []string{"t-2"}},
		{ID: "t-5", Label: "e", Deps: []string{"t-2"}},
	}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	g := &gv
	// the reviewer sent t-1 back for a fix round
	taskByID(g, "t-1").ReviewRound = 1
	earlyBased(g, "t-2", TaskState_Done, "t-1")
	earlyBased(g, "t-3", TaskState_Done, "t-2")
	lead := newFakeLead(t)
	var afterCommit []func()
	got := restartEarlyDependents(context.Background(), g, &afterCommit)
	slices.Sort(got)
	if !slices.Equal(got, []string{"t-2", "t-3"}) {
		t.Fatalf("want t-2 and t-3 restarted, got %v", got)
	}
	assertRestarted(t, g, "t-2")
	assertRestarted(t, g, "t-3")
	for _, id := range []string{"t-4", "t-5"} {
		if task := taskByID(g, id); task.State != TaskState_Pending || task.DiscardTree || task.EarlyRestarts != 0 {
			t.Fatalf("%s was never started early and is untouched, got %+v", id, *task)
		}
	}
	runAfterCommit(afterCommit)
	if r := restartedRow(t, lead, "t-2"); r["reason"] != "predecessor review failed" {
		t.Fatalf("t-2 reason %v", r["reason"])
	}
	if r := restartedRow(t, lead, "t-3"); r["basetask"] != "t-2" || r["reason"] != "predecessor pending" {
		t.Fatalf("t-3 row %v", r)
	}
}

func TestRestartKeepsSkippedTask(t *testing.T) {
	// t-2 -> t-3 is one lane, early-based on t-1's
	gv, err := NewTaskGroup("run-1", "ch-1", "g", 4, true, []waveobj.TaskNode{
		{ID: "t-1", Label: "a"},
		{ID: "t-2", Label: "b", Deps: []string{"t-1"}},
		{ID: "t-4", Label: "d", Deps: []string{"t-1"}},
		{ID: "t-3", Label: "c", Deps: []string{"t-2"}},
	}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	g := &gv
	taskByID(g, "t-1").ReviewRound = 1
	earlyBased(g, "t-2", TaskState_Done, "t-1")
	taskByID(g, "t-3").State = TaskState_Skipped
	var afterCommit []func()
	if got := restartEarlyDependents(context.Background(), g, &afterCommit); !slices.Equal(got, []string{"t-2"}) {
		t.Fatalf("want t-2 restarted, got %v", got)
	}
	if s := taskByID(g, "t-3").State; s != TaskState_Skipped {
		t.Fatalf("a skipped task keeps its state, got %s", s)
	}
}

func TestDiscardLaneTreeDropsBranchAndTree(t *testing.T) {
	ctx := context.Background()
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	key := TaskWorktreeKey("owner-1", "t-2")
	wt, _, _, err := EnsureRunWorktree(ctx, dir, key, base)
	if err != nil {
		t.Fatal(err)
	}
	commitInTree(t, wt, "api.txt")
	gitCmd(t, dir, "commit", "--allow-empty", "-m", "fixed base")
	newBase := gitCmd(t, dir, "rev-parse", "HEAD")

	if err := discardLaneTree(ctx, dir, key); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(wt); !os.IsNotExist(err) {
		t.Fatalf("the tree is removed, stat: %v", err)
	}
	if _, err := WorktreeHeadCommit(ctx, dir, key); err == nil {
		t.Fatal("the branch is deleted")
	}
	if _, err := os.Stat(filepath.Join(dir, ".waveterm", "recovery", key+".patch")); err != nil {
		t.Fatalf("the discarded work is saved: %v", err)
	}
	// nothing left to discard is not an error
	if err := discardLaneTree(ctx, dir, key); err != nil {
		t.Fatalf("a missing tree and branch: %v", err)
	}
	wt, head, _, err := EnsureRunWorktree(ctx, dir, key, newBase)
	if err != nil {
		t.Fatal(err)
	}
	if got := gitCmd(t, wt, "rev-parse", "HEAD"); head != newBase || got != newBase {
		t.Fatalf("the new tree starts at the new base %s, got %s (%s)", newBase, got, head)
	}
}

func TestDispatchDiscardsTreeBeforeRebranching(t *testing.T) {
	f, _ := earlyFixture(t, true)
	f.dispatch(t, "t-2")
	commitInTree(t, worktreeDir(f.project, TaskWorktreeKey(f.ownerID, "t-2")), "api.txt")
	baseRun := taskByID(f.dag(t), "t-1").RunID
	// the reviewer rejects t-1, and the tick restarts t-2; outside the dag's write, as in the tick, since cancelling the
	// worker's run writes the store
	g := f.dag(t)
	base := taskByID(g, "t-1")
	base.State, base.RunID, base.ReviewRound = TaskState_Pending, "", 1
	var afterCommit []func()
	restartEarlyDependents(f.ctx, g, &afterCommit)
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		*cur = *g
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if !taskByID(f.dag(t), "t-2").DiscardTree {
		t.Fatal("t-2 is restarted")
	}
	// t-1's fix round commits on its branch and goes back under review
	newTip := commitInTree(t, worktreeDir(f.project, TaskWorktreeKey(f.ownerID, "t-1")), "schema-fix.txt")
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		base := taskByID(cur, "t-1")
		base.State, base.RunID = TaskState_Reviewing, baseRun
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	f.dispatch(t, "t-2")

	task := taskByID(f.dag(t), "t-2")
	if task.State != TaskState_Running || task.DiscardTree {
		t.Fatalf("t-2 starts again with its tree discarded, got %s discard %v (%s)", task.State, task.DiscardTree, task.LastFailureKind)
	}
	wt := laneTree(f.ctx, f.project, TaskWorktreeKey(f.ownerID, "t-2"))
	if got := gitCmd(t, wt, "rev-parse", "HEAD"); got != newTip {
		t.Fatalf("t-2's new tree starts at t-1's fixed tip %s, got %s", newTip, got)
	}
	if _, err := os.Stat(filepath.Join(wt, "api.txt")); !os.IsNotExist(err) {
		t.Fatalf("the discarded attempt's commit is gone from the tree, stat: %v", err)
	}
	if task.EarlyBaseTask != "t-1" || task.EarlyBaseCommit != newTip {
		t.Fatalf("t-2 records its new base, got %q %q", task.EarlyBaseTask, task.EarlyBaseCommit)
	}
	if got := f.taskRun(t, "t-2").BaseCommit; got != newTip {
		t.Fatalf("t-2's new run starts at the fixed tip %s, not the discarded branch point, got %s", newTip, got)
	}
}

// the defect: a skipped head is never dispatched again, so the discard set on it never ran, and the lane's next task
// reused the branch holding the base's rejected commits.
func TestRestartWithSkippedHeadDiscardsTreeForNextTask(t *testing.T) {
	// t-2 -> t-3 is one lane, early-based on t-1's; t-4 makes t-1 a fork so t-2 is not in its lane
	f := newMergeFixture(t, []waveobj.TaskNode{
		{ID: "t-1", Label: "schema"},
		{ID: "t-2", Label: "api", Deps: []string{"t-1"}},
		{ID: "t-4", Label: "ui", Deps: []string{"t-1"}},
		{ID: "t-3", Label: "client", Deps: []string{"t-2"}},
	})
	var spawned []string
	stubSpawn(t, &spawned)
	stubStopWorkers(t)
	f.dispatch(t, "t-1")
	baseTip := commitInTree(t, worktreeDir(f.project, TaskWorktreeKey(f.ownerID, "t-1")), "schema.txt")
	if err := wstore.UpdateRun(f.ctx, f.channel, taskByID(f.dag(t), "t-1").RunID, func(r *waveobj.Run) error {
		r.Status, r.EndCommit = jarvis.RunStatus_Done, baseTip
		r.Evidence = &waveobj.RunEvidence{CapturedTs: time.Now().UnixMilli()}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	f.setTaskState(t, "t-1", TaskState_Reviewing)
	f.dispatch(t, "t-2")
	if task := taskByID(f.dag(t), "t-2"); task.EarlyBaseTask != "t-1" {
		t.Fatalf("t-2 starts early on t-1, got %+v", *task)
	}
	key := TaskWorktreeKey(f.ownerID, "t-2")
	commitInTree(t, worktreeDir(f.project, key), "api.txt")
	f.setTaskState(t, "t-2", TaskState_Skipped)
	f.dispatch(t, "t-3")
	if s := taskByID(f.dag(t), "t-3").State; s != TaskState_Running {
		t.Fatalf("t-3 runs on the lane's branch, got %s", s)
	}
	oldHead := commitInTree(t, worktreeDir(f.project, key), "client.txt")

	// the reviewer rejects t-1; outside the dag's write, as in the tick, since cancelling t-3's run writes the store
	g := f.dag(t)
	base := taskByID(g, "t-1")
	base.State, base.RunID, base.ReviewRound = TaskState_Pending, "", 1
	var afterCommit []func()
	if got := restartEarlyDependents(f.ctx, g, &afterCommit); !slices.Equal(got, []string{"t-3"}) {
		t.Fatalf("want t-3 restarted, got %v", got)
	}
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		*cur = *g
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	runAfterCommit(afterCommit)

	g = f.dag(t)
	if head := taskByID(g, "t-2"); head.State != TaskState_Skipped || head.DiscardTree {
		t.Fatalf("the skipped head keeps its state and is not marked, got %s discard %v", head.State, head.DiscardTree)
	}
	if next := taskByID(g, "t-3"); next.State != TaskState_Pending || !next.DiscardTree {
		t.Fatalf("t-3 is the first task to dispatch on the branch and discards it, got %s discard %v", next.State, next.DiscardTree)
	}

	f.dispatch(t, "t-3")

	if task := taskByID(f.dag(t), "t-3"); task.State != TaskState_Running || task.DiscardTree {
		t.Fatalf("t-3 starts again with its tree discarded, got %s discard %v (%s)", task.State, task.DiscardTree, task.LastFailureKind)
	}
	if branchHead, err := WorktreeHeadCommit(f.ctx, f.project, key); err != nil || branchHead == oldHead {
		t.Fatalf("the old branch is gone, got head %s err %v", branchHead, err)
	}
	wt := laneTree(f.ctx, f.project, key)
	if got := gitCmd(t, wt, "rev-parse", "HEAD"); got == oldHead {
		t.Fatalf("t-3's new tree is not cut from the old branch %s", oldHead)
	}
	for _, name := range []string{"schema.txt", "api.txt", "client.txt"} {
		if _, err := os.Stat(filepath.Join(wt, name)); !os.IsNotExist(err) {
			t.Fatalf("the discarded branch's %s is gone from the tree, stat: %v", name, err)
		}
	}
}
