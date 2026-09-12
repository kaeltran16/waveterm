// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// mergeFixture is one owner run plus a persisted merge-required dag over a real git repo.
type mergeFixture struct {
	ctx     context.Context
	channel string
	ownerID string
	dagID   string
	project string
}

func newMergeFixture(t *testing.T, tasks []waveobj.TaskNode) *mergeFixture {
	t.Helper()
	ctx := context.Background()
	project := newGitRepo(t)
	ch, err := wstore.CreateChannel(ctx, "merge-"+t.Name(), project)
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner goal", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 2, true, tasks, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	owner.DagORef = g.OID
	if err := wstore.UpdateRun(ctx, ch.OID, owner.ID, func(r *waveobj.Run) error {
		r.DagORef = g.OID
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// the plan gate is what holds an unapproved dag; these fixtures start past it
	g.PlanApprovedTs = 1
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	return &mergeFixture{ctx: ctx, channel: ch.OID, ownerID: owner.ID, dagID: g.OID, project: project}
}

// finish marks a task done with a child run, the state the merge path expects.
func (f *mergeFixture) finish(t *testing.T, taskID string) string {
	t.Helper()
	child := jarvis.NewRun("child goal", "ws-1", f.project, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	if err := wstore.AppendRun(f.ctx, f.channel, child); err != nil {
		t.Fatal(err)
	}
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		task := taskByID(cur, taskID)
		task.State = TaskState_Done
		task.RunID = child.ID
		RecomputeDagStatus(cur)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return child.ID
}

func (f *mergeFixture) dag(t *testing.T) *waveobj.TaskGroup {
	t.Helper()
	g, err := wstore.GetDag(f.ctx, f.dagID)
	if err != nil {
		t.Fatal(err)
	}
	return g
}

// stubMerge replaces the squash so a test can drive the outcome without a real branch.
func stubMerge(t *testing.T, fn func(ctx context.Context, projectPath, runID, goal string) (string, error)) *int {
	t.Helper()
	calls := 0
	old := mergeWorktree
	mergeWorktree = func(ctx context.Context, projectPath, runID, goal string) (string, error) {
		calls++
		return fn(ctx, projectPath, runID, goal)
	}
	t.Cleanup(func() { mergeWorktree = old })
	return &calls
}

func stubSpawn(t *testing.T, spawned *[]string) {
	t.Helper()
	allowWorkerHarnessForTest(t)
	old := spawnWorker
	spawnWorker = func(ctx context.Context, cap runroute.Capability, workspaceId, projectName, cwd, prompt string, _ jarvis.RunWorkerOptions) (string, error) {
		*spawned = append(*spawned, prompt)
		return "tab:worker", nil
	}
	t.Cleanup(func() { spawnWorker = old })
}

// the whole point of the change: a finished task lands and its dependent starts, with nobody asked.
func TestScheduleMergesDoneTaskAndUnblocksDependent(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{
		{ID: "t-0", Label: "first"},
		{ID: "t-1", Label: "second", Deps: []string{"t-0"}},
	})
	child := f.finish(t, "t-0")
	calls := stubMerge(t, func(context.Context, string, string, string) (string, error) { return "sha-1", nil })
	var spawned []string
	stubSpawn(t, &spawned)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}

	g := f.dag(t)
	if !g.Tasks[0].Merged {
		t.Fatal("t-0 must be merged by the schedule tick")
	}
	if *calls != 1 {
		t.Fatalf("want 1 merge, got %d", *calls)
	}
	if g.Tasks[1].State != TaskState_Running {
		t.Fatalf("t-1 must be dispatched once its dep landed, got %s", g.Tasks[1].State)
	}
	run, err := wstore.GetRun(f.ctx, f.channel, child)
	if err != nil {
		t.Fatal(err)
	}
	if run.EndCommit != "sha-1" {
		t.Fatalf("child must carry the merge commit, got %q", run.EndCommit)
	}
}

// a gate is the human's checkpoint; automatic merging must not step over it.
func TestScheduleLeavesGatedTaskUnmergedUntilReleased(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "gated", Gate: true}})
	f.finish(t, "t-0")
	calls := stubMerge(t, func(context.Context, string, string, string) (string, error) { return "sha-1", nil })

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	if *calls != 0 {
		t.Fatalf("a held gate must block the merge, got %d attempts", *calls)
	}
	if f.dag(t).Tasks[0].Merged {
		t.Fatal("gated task must stay unmerged")
	}

	if err := ApplyAction(f.ctx, f.dagID, "t-0", "approve", waveobj.RoutePin{}); err != nil {
		t.Fatal(err)
	}
	if *calls != 1 {
		t.Fatalf("want 1 merge after release, got %d", *calls)
	}
	if !f.dag(t).Tasks[0].Merged {
		t.Fatal("released task must merge")
	}
}

// a conflict is the one thing that still needs a person: it must stop, and stay stopped.
func TestScheduleLeavesConflictBlockedAndDoesNotRetry(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "conflicts"}})
	f.finish(t, "t-0")
	calls := stubMerge(t, func(context.Context, string, string, string) (string, error) { return "", ErrMergeConflict })

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	g := f.dag(t)
	if g.Tasks[0].State != TaskState_BlockedMerge {
		t.Fatalf("want blocked-merge, got %s", g.Tasks[0].State)
	}
	if g.Tasks[0].Merged {
		t.Fatal("a conflicted task must not read as merged")
	}

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	if *calls != 1 {
		t.Fatalf("a blocked merge must not be retried every tick, got %d attempts", *calls)
	}
}

// the squash commits the index with no pathspec, so staged edits would land inside the task's commit.
func TestScheduleHoldsMergeWhileProjectIndexIsDirty(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	f.finish(t, "t-0")
	calls := stubMerge(t, func(context.Context, string, string, string) (string, error) { return "sha-1", nil })

	staged := filepath.Join(f.project, "staged.txt")
	if err := os.WriteFile(staged, []byte("mine\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, f.project, "add", "staged.txt")

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	if *calls != 0 {
		t.Fatalf("a dirty index must hold the automatic merge, got %d attempts", *calls)
	}
	if f.dag(t).Tasks[0].Merged {
		t.Fatal("task must stay unmerged while the index is dirty")
	}

	// a human landing it themselves is still allowed — they chose this moment
	if err := MergeTask(f.ctx, f.channel, f.ownerID, "t-0"); err != nil {
		t.Fatal(err)
	}
	if !f.dag(t).Tasks[0].Merged {
		t.Fatal("the explicit merge must land regardless of the index")
	}
}

// an already-merged task is re-entered on every tick; it must not merge twice.
func TestScheduleDoesNotRemergeALandedTask(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	f.finish(t, "t-0")
	calls := stubMerge(t, func(context.Context, string, string, string) (string, error) { return "sha-1", nil })

	for i := 0; i < 3; i++ {
		if err := Schedule(f.ctx, f.dagID); err != nil {
			t.Fatal(err)
		}
	}
	if *calls != 1 {
		t.Fatalf("want exactly 1 merge across repeated ticks, got %d", *calls)
	}
}
