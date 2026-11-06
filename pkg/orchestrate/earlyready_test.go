// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// fork is t-1 with two dependents, so each of the three is a lane of its own.
func forkGroup(t *testing.T, mergeRequired bool, states map[string]string) *waveobj.TaskGroup {
	t.Helper()
	g, err := NewTaskGroup("run-1", "ch-1", "g", 4, mergeRequired, []waveobj.TaskNode{
		{ID: "t-1", Label: "schema"},
		{ID: "t-2", Label: "api", Deps: []string{"t-1"}},
		{ID: "t-3", Label: "ui", Deps: []string{"t-1"}},
	}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	setStatesWithRuns(&g, states)
	return &g
}

// join is t-3 depending on t-1 and t-2, each a lane of its own.
func joinGroup(t *testing.T, states map[string]string) *waveobj.TaskGroup {
	t.Helper()
	g, err := NewTaskGroup("run-1", "ch-1", "g", 4, true, []waveobj.TaskNode{
		{ID: "t-1", Label: "schema"},
		{ID: "t-2", Label: "api"},
		{ID: "t-3", Label: "ui", Deps: []string{"t-1", "t-2"}},
	}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	setStatesWithRuns(&g, states)
	return &g
}

// every task given a state past pending gets a run, as a dispatched one has
func setStatesWithRuns(g *waveobj.TaskGroup, states map[string]string) {
	for id, s := range states {
		task := taskByID(g, id)
		task.State = s
		if s != TaskState_Pending && s != TaskState_Skipped {
			task.RunID = "run-" + id
		}
	}
	RecomputeDagStatus(g)
}

func assertStartBase(t *testing.T, g *waveobj.TaskGroup, taskID, wantBase string, wantReady bool) {
	t.Helper()
	base, ready := startBase(g, taskID)
	got := ""
	if base != nil {
		got = base.ID
	}
	if ready != wantReady || got != wantBase {
		t.Fatalf("startBase(%s) = (%q, %v), want (%q, %v)", taskID, got, ready, wantBase, wantReady)
	}
}

func TestStartBaseForkStartsOnDonePredecessor(t *testing.T) {
	g := forkGroup(t, true, map[string]string{"t-1": TaskState_Reviewing})
	assertStartBase(t, g, "t-2", "t-1", true)
	assertStartBase(t, g, "t-3", "t-1", true)
	if got := ReadyTasks(g); !reflect.DeepEqual(got, []string{"t-2", "t-3"}) {
		t.Fatalf("ReadyTasks = %v, want both dependents", got)
	}
	// once the predecessor's lane merged, the dependents start on the landing head as today
	markMerged(g, "t-1")
	taskByID(g, "t-1").State = TaskState_Done
	assertStartBase(t, g, "t-2", "", true)
}

func TestStartBaseJoinOneUnmergedPredecessor(t *testing.T) {
	g := joinGroup(t, map[string]string{"t-1": TaskState_Done, "t-2": TaskState_Reviewing})
	markMerged(g, "t-1")
	assertStartBase(t, g, "t-3", "t-2", true)
}

func TestStartBaseJoinTwoUnmergedPredecessorsWaits(t *testing.T) {
	g := joinGroup(t, map[string]string{"t-1": TaskState_Reviewing, "t-2": TaskState_Done})
	assertStartBase(t, g, "t-3", "", false)
	if got := ReadyTasks(g); len(got) != 0 {
		t.Fatalf("a join on two unmerged lanes waits, got %v", got)
	}
}

func TestStartBaseSameLaneUnchanged(t *testing.T) {
	for _, s := range []string{TaskState_Running, TaskState_Reviewing, TaskState_ReviewFailed} {
		g := laneGroup(t, true, map[string]string{"t-1": s})
		taskByID(g, "t-1").RunID = "run-t-1"
		assertStartBase(t, g, "t-2", "", false)
	}
	g := laneGroup(t, true, map[string]string{"t-1": TaskState_Done})
	assertStartBase(t, g, "t-2", "", true)
}

func TestStartBaseNotWhilePredecessorRunningOrReviewFailed(t *testing.T) {
	for _, s := range []string{TaskState_Pending, TaskState_Running, TaskState_ReviewFailed, TaskState_Failed, TaskState_Stalled} {
		g := forkGroup(t, true, map[string]string{"t-1": s})
		assertStartBase(t, g, "t-2", "", false)
	}
	// a tip under review but with an earlier task of its lane not done is not worker-done either
	g := laneGroup(t, true, map[string]string{"t-1": TaskState_Done, "t-2": TaskState_Reviewing, "t-3": TaskState_Reviewing})
	taskByID(g, "t-2").RunID, taskByID(g, "t-3").RunID = "run-t-2", "run-t-3"
	assertStartBase(t, g, "t-4", "", false)
}

func TestStartBaseWithoutMergesUnchanged(t *testing.T) {
	g := forkGroup(t, false, map[string]string{"t-1": TaskState_Reviewing})
	assertStartBase(t, g, "t-2", "", false)
	g = forkGroup(t, false, map[string]string{"t-1": TaskState_Done})
	assertStartBase(t, g, "t-2", "", true)
	g = forkGroup(t, false, map[string]string{"t-1": TaskState_Skipped})
	assertStartBase(t, g, "t-2", "", true)
}

func TestStartBaseDigestDoesNotHoldEarlyReady(t *testing.T) {
	g := forkGroup(t, true, map[string]string{"t-1": TaskState_Done})
	t2 := taskByID(g, "t-2")
	if hasUnsatDep(g, t2) || !taskReady(g, t2) || taskWaitReason(g, t2) == "dependency" {
		t.Fatalf("an early-ready task is not waiting on a dependency, wait reason %q", taskWaitReason(g, t2))
	}
	if waiting, blocking := dependencyWait(g); len(waiting) != 0 || len(blocking) != 0 {
		t.Fatalf("dependencyWait = %v %v, want none", waiting, blocking)
	}
	if got := mergeReadyBlocking(g); len(got) != 0 {
		t.Fatalf("an early-ready task is not blocked by a merge, got %v", got)
	}
	// the same predecessor still under its worker holds both
	g = forkGroup(t, true, map[string]string{"t-1": TaskState_Running})
	if waiting, blocking := dependencyWait(g); !reflect.DeepEqual(waiting, []string{"t-2", "t-3"}) || !reflect.DeepEqual(blocking, []string{"t-1"}) {
		t.Fatalf("dependencyWait = %v %v, want [t-2 t-3] on [t-1]", waiting, blocking)
	}
}

// earlyFixture is the fork on real git: t-1 dispatched in its own tree, one commit made there, then put under review
// with a run whose evidence is sealed or not.
func earlyFixture(t *testing.T, sealed bool) (*mergeFixture, string) {
	t.Helper()
	f := newMergeFixture(t, []waveobj.TaskNode{
		{ID: "t-1", Label: "schema"},
		{ID: "t-2", Label: "api", Deps: []string{"t-1"}},
		{ID: "t-3", Label: "ui", Deps: []string{"t-1"}},
	})
	var spawned []string
	stubSpawn(t, &spawned)
	stubStopWorkers(t)
	f.dispatch(t, "t-1")
	tip := commitInTree(t, worktreeDir(f.project, TaskWorktreeKey(f.ownerID, "t-1")), "schema.txt")
	runID := taskByID(f.dag(t), "t-1").RunID
	if err := wstore.UpdateRun(f.ctx, f.channel, runID, func(r *waveobj.Run) error {
		r.Status = jarvis.RunStatus_Done
		r.EndCommit = tip
		if sealed {
			r.Evidence = &waveobj.RunEvidence{CapturedTs: time.Now().UnixMilli()}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	f.setTaskState(t, "t-1", TaskState_Reviewing)
	return f, tip
}

// dispatch runs dispatchTasks on ids against the stored dag, as a tick does, and stores the result.
func (f *mergeFixture) dispatch(t *testing.T, ids ...string) {
	t.Helper()
	g := f.dag(t)
	owner := f.owner(t)
	runs, _ := loadTaskRuns(f.ctx, g)
	head, err := landingHead(f.ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	budget := spawnBudget{parent: context.WithoutCancel(f.ctx)}
	defer budget.release()
	var afterCommit []func()
	if _, err := dispatchTasks(f.ctx, &budget, g, owner, head, runs, nil, ids, time.Now().UnixMilli(), &afterCommit); err != nil {
		t.Fatal(err)
	}
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		*cur = *g
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, fn := range afterCommit {
		fn()
	}
}

func TestDispatchEarlyStartWaitsForBaseEvidence(t *testing.T) {
	f, _ := earlyFixture(t, false)
	f.dispatch(t, "t-2")
	if task := taskByID(f.dag(t), "t-2"); task.State != TaskState_Pending || task.RunID != "" {
		t.Fatalf("t-2 waits for t-1's evidence, got %s run %q", task.State, task.RunID)
	}
	runID := taskByID(f.dag(t), "t-1").RunID
	if err := wstore.UpdateRun(f.ctx, f.channel, runID, func(r *waveobj.Run) error {
		r.Evidence = &waveobj.RunEvidence{CapturedTs: time.Now().UnixMilli()}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	f.dispatch(t, "t-2")
	if task := taskByID(f.dag(t), "t-2"); task.State != TaskState_Running {
		t.Fatalf("t-2 starts once t-1's evidence is sealed, got %s (%s)", task.State, task.LastFailureKind)
	}
}

func TestDispatchEarlyStartBranchesFromPredecessorTip(t *testing.T) {
	f, tip := earlyFixture(t, true)
	f.dispatch(t, "t-2")
	task := taskByID(f.dag(t), "t-2")
	if task.State != TaskState_Running {
		t.Fatalf("t-2 starts early, got %s (%s)", task.State, task.LastFailureKind)
	}
	wt := worktreeDir(f.project, TaskWorktreeKey(f.ownerID, "t-2"))
	if got := gitCmd(t, wt, "rev-parse", "HEAD"); got != tip {
		t.Fatalf("t-2's tree starts at t-1's tip %s, got %s", tip, got)
	}
	if task.EarlyBaseTask != "t-1" || task.EarlyBaseCommit != tip {
		t.Fatalf("t-2 records its base, got %q %q", task.EarlyBaseTask, task.EarlyBaseCommit)
	}
	if got := f.taskRun(t, "t-2").BaseCommit; got != tip {
		t.Fatalf("t-2's run starts at t-1's tip %s, got %s", tip, got)
	}
}

func TestDispatchEarlyStartRetryKeepsBase(t *testing.T) {
	f, tip := earlyFixture(t, true)
	f.dispatch(t, "t-2")
	// the retry runs on the branch t-2 already made, which still holds t-1's work
	commitInTree(t, worktreeDir(f.project, TaskWorktreeKey(f.ownerID, "t-2")), "api.txt")
	f.setTaskState(t, "t-2", TaskState_Failed)
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		return RetryTask(cur, "t-2")
	}); err != nil {
		t.Fatal(err)
	}
	f.dispatch(t, "t-2")
	task := taskByID(f.dag(t), "t-2")
	if task.State != TaskState_Running {
		t.Fatalf("the retry starts, got %s (%s)", task.State, task.LastFailureKind)
	}
	if task.EarlyBaseTask != "t-1" || task.EarlyBaseCommit != tip {
		t.Fatalf("the retry keeps the base record, got %q %q", task.EarlyBaseTask, task.EarlyBaseCommit)
	}
}
