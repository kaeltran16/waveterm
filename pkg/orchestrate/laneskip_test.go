// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

type laneFixture struct {
	ctx     context.Context
	dag     *waveobj.TaskGroup
	repo    string
	wt      string
	key     string
	doneTip string // the lane's head once its first task is done: where the second task started
}

func commitFile(t *testing.T, dir, name, body string) string {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, dir, "add", name)
	gitCmd(t, dir, "commit", "-m", name)
	return gitCmd(t, dir, "rev-parse", "HEAD")
}

// seedLaneFixture is a two-task lane in a real repo: t-0 is done with a commit on the lane branch, and t-1's
// worker ended in state, having committed attempt.txt.
func seedLaneFixture(t *testing.T, state string) laneFixture {
	t.Helper()
	ctx := context.Background()
	repo := newGitRepo(t)
	ch, err := wstore.CreateChannel(ctx, "lane-skip", repo)
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner goal", "ws-1", repo, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(), 1)
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 1, false, []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
		{ID: "t-1", Label: "b", Deps: []string{"t-0"}},
	}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	key := LaneWorktreeKey(&g, "t-1")
	wt, err := CreateRunWorktree(ctx, repo, key, gitCmd(t, repo, "rev-parse", "HEAD"))
	if err != nil {
		t.Fatal(err)
	}
	gitCmd(t, wt, "config", "user.email", "t@test")
	gitCmd(t, wt, "config", "user.name", "t")
	doneTip := commitFile(t, wt, "first.txt", "first task\n")
	worker := jarvis.NewRun("worker goal", "ws-1", wt, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	worker.Status = jarvis.RunStatus_Blocked
	worker.BaseCommit = doneTip
	worker.DagORef = g.OID
	if err := wstore.AppendRun(ctx, ch.OID, worker); err != nil {
		t.Fatal(err)
	}
	commitFile(t, wt, "attempt.txt", "the failed attempt\n")
	if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
		cur.Tasks[0].State = TaskState_Done
		cur.Tasks[1].State = state
		cur.Tasks[1].RunID = worker.ID
		cur.Tasks[1].StartBase = doneTip
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return laneFixture{ctx: ctx, dag: &g, repo: repo, wt: wt, key: key, doneTip: doneTip}
}

func (f laneFixture) branchHead(t *testing.T) string {
	t.Helper()
	return gitCmd(t, f.repo, "rev-parse", "wave/"+f.key)
}

func (f laneFixture) skip(t *testing.T) {
	t.Helper()
	stubStopRunWorkers(t)
	if err := ApplyAction(f.ctx, f.dag.OID, "t-1", "skip", waveobj.RoutePin{}); err != nil {
		t.Fatal(err)
	}
	if got := mustLoadDag(t, f.ctx, f.dag.OID).Tasks[1].State; got != TaskState_Skipped {
		t.Fatalf("want t-1 skipped, got %s", got)
	}
}

func TestSkipAFailedOrStalledTaskDropsItsCommitsFromTheLane(t *testing.T) {
	for _, state := range []string{TaskState_Failed, TaskState_Stalled} {
		t.Run(state, func(t *testing.T) {
			f := seedLaneFixture(t, state)
			f.skip(t)
			if got := f.branchHead(t); got != f.doneTip {
				t.Fatalf("lane head = %s, want the done task's tip %s", got, f.doneTip)
			}
			if _, err := os.Stat(filepath.Join(f.wt, "first.txt")); err != nil {
				t.Fatalf("the earlier done task's work must stay: %v", err)
			}
			if _, err := os.Stat(filepath.Join(f.wt, "attempt.txt")); !os.IsNotExist(err) {
				t.Fatalf("the skipped attempt's file must leave the lane tree, stat err = %v", err)
			}
			patch, err := os.ReadFile(filepath.Join(f.repo, ".waveterm", "recovery", f.key+"-t-1.patch"))
			if err != nil {
				t.Fatalf("the skipped work must stay recoverable: %v", err)
			}
			if !strings.Contains(string(patch), "the failed attempt") || strings.Contains(string(patch), "first task") {
				t.Fatalf("recovery patch must hold exactly the skipped attempt's work, got:\n%s", patch)
			}
		})
	}
}

func TestSkipRecoversUncommittedTrackedEditsToo(t *testing.T) {
	f := seedLaneFixture(t, TaskState_Failed)
	if err := os.WriteFile(filepath.Join(f.wt, "first.txt"), []byte("edited late\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f.skip(t)
	patch, err := os.ReadFile(filepath.Join(f.repo, ".waveterm", "recovery", f.key+"-t-1.patch"))
	if err != nil || !strings.Contains(string(patch), "edited late") {
		t.Fatalf("an uncommitted edit must be in the recovery patch, got %q err %v", patch, err)
	}
}

func TestSkipWithNothingToRollBackLeavesTheLane(t *testing.T) {
	t.Run("attempt committed nothing", func(t *testing.T) {
		f := seedLaneFixture(t, TaskState_Failed)
		gitCmd(t, f.wt, "reset", "--hard", f.doneTip)
		f.skip(t)
		if got := f.branchHead(t); got != f.doneTip {
			t.Fatalf("lane head moved to %s", got)
		}
		if _, err := os.Stat(filepath.Join(f.repo, ".waveterm", "recovery", f.key+"-t-1.patch")); !os.IsNotExist(err) {
			t.Fatalf("no patch is written when nothing is dropped, stat err = %v", err)
		}
	})
	t.Run("task never started", func(t *testing.T) {
		f := seedLaneFixture(t, TaskState_Failed)
		if err := wstore.UpdateDag(f.ctx, f.dag.OID, func(g *waveobj.TaskGroup) error {
			g.Tasks[1].StartBase, g.Tasks[1].RunID = "", ""
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		before := f.branchHead(t)
		f.skip(t)
		if got := f.branchHead(t); got != before {
			t.Fatalf("a task with no start base must not rewind the lane: head %s, was %s", got, before)
		}
	})
}

// a lane tree that is no longer the branch's checkout must not be reset: git run there acts on the project
func TestSkipNeverResetsATreeThatIsNotTheLanesCheckout(t *testing.T) {
	f := seedLaneFixture(t, TaskState_Failed)
	projectHead := gitCmd(t, f.repo, "rev-parse", "HEAD")
	stubStopRunWorkers(t)
	if err := os.RemoveAll(f.wt); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, f.repo, "worktree", "prune")
	if err := ApplyAction(f.ctx, f.dag.OID, "t-1", "skip", waveobj.RoutePin{}); err != nil {
		t.Fatal(err)
	}
	if got := f.branchHead(t); got != f.doneTip {
		t.Fatalf("a lane whose tree is gone is still rewound, head %s want %s", got, f.doneTip)
	}
	if got := gitCmd(t, f.repo, "rev-parse", "HEAD"); got != projectHead {
		t.Fatalf("the project checkout moved from %s to %s", projectHead, got)
	}
}

func TestRewindLaneLeavesASymlinkTargetIntact(t *testing.T) {
	f := seedLaneFixture(t, TaskState_Failed)
	shared := t.TempDir()
	keep := filepath.Join(shared, "keep.txt")
	if err := os.WriteFile(keep, []byte("keep\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(shared, filepath.Join(f.wt, "node_modules")); err != nil {
		t.Skipf("no symlink support here: %v", err)
	}
	f.skip(t)
	if b, err := os.ReadFile(keep); err != nil || string(b) != "keep\n" {
		t.Fatalf("a link target outside the lane tree must survive the rollback, got %q err %v", b, err)
	}
}

// a retry's child run starts at the base of the task's first attempt, so its evidence includes what the failed
// attempt committed
func TestRetryKeepsTheFirstAttemptsBase(t *testing.T) {
	ctx, dag := seedPendingDag(t)
	repo := newGitRepo(t)
	if err := wstore.UpdateRun(ctx, dag.ChannelId, dag.RunID, func(r *waveobj.Run) error {
		r.ProjectPath = repo
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	base := gitCmd(t, repo, "rev-parse", "HEAD")
	captureSpawns(t)
	stubStopRunWorkers(t)
	schedule(t, ctx, dag.OID)
	first := firstTask(t, ctx, dag.OID)
	if first.State != TaskState_Running || first.StartBase != base {
		t.Fatalf("first dispatch must stamp the start base %s, got state %s base %q", base, first.State, first.StartBase)
	}
	wt := worktreeDir(repo, LaneWorktreeKey(dag, "t-0"))
	gitCmd(t, wt, "config", "user.email", "t@test")
	gitCmd(t, wt, "config", "user.name", "t")
	attemptTip := commitFile(t, wt, "attempt.txt", "the failed attempt\n")
	if err := wstore.UpdateRun(ctx, dag.ChannelId, first.RunID, func(r *waveobj.Run) error {
		r.Status = jarvis.RunStatus_Blocked
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	schedule(t, ctx, dag.OID)
	if err := ApplyAction(ctx, dag.OID, "t-0", "retry", waveobj.RoutePin{}); err != nil {
		t.Fatal(err)
	}
	retried := firstTask(t, ctx, dag.OID)
	if retried.State != TaskState_Running || retried.RunID == "" || retried.RunID == first.RunID {
		t.Fatalf("want a new running attempt, got state %s run %q", retried.State, retried.RunID)
	}
	run, err := wstore.GetRun(ctx, dag.ChannelId, retried.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if run.BaseCommit != base {
		t.Fatalf("retry's base = %s, want the first attempt's %s (branch head is %s)", run.BaseCommit, base, attemptTip)
	}
	if retried.StartBase != base {
		t.Fatalf("start base must survive the retry, got %q", retried.StartBase)
	}
}
