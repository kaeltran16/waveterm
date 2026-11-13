// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// stubSpawnCwd is stubSpawn for a test that needs each spawned worker's cwd.
func stubSpawnCwd(t *testing.T) *[]string {
	t.Helper()
	allowWorkerHarnessForTest(t)
	var cwds []string
	old := spawnWorker
	spawnWorker = func(_ context.Context, _ runroute.Capability, _, _, cwd, _ string, _ jarvis.RunWorkerOptions) (string, error) {
		cwds = append(cwds, cwd)
		return "tab:worker", nil
	}
	restoreAfterStages(t, func() { spawnWorker = old })
	return &cwds
}

func newPrepFixture(t *testing.T) *mergeFixture {
	t.Helper()
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	f.setPlanCommands(t, "", setupCmd)
	return f
}

func (f *mergeFixture) schedule(t *testing.T) {
	t.Helper()
	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
}

func (f *mergeFixture) wantRunning(t *testing.T, calls *planCalls, spawned int) {
	t.Helper()
	if n := len(calls.list()); n != 1 {
		t.Fatalf("want Setup once, got %d: %+v", n, calls.list())
	}
	if spawned != 1 {
		t.Fatalf("want one spawn, got %d", spawned)
	}
	if got := f.dag(t).Tasks[0].State; got != TaskState_Running {
		t.Fatalf("want t-0 running, got %s", got)
	}
}

func TestDispatchRunsSetupOutsideTheDagLock(t *testing.T) {
	f := newPrepFixture(t)
	ran := false
	calls := stubPlanCommand(t, func(context.Context, string, string) error {
		ran, _ = TryWithDagMutation(f.dagID, func() error { return nil })
		return nil
	})
	var spawned []string
	stubSpawn(t, &spawned)

	f.schedule(t)
	if !ran {
		t.Fatal("Setup ran while the tick held the dag lock")
	}
	f.wantRunning(t, calls, len(spawned))
}

func TestATaskIsPreparingWhileItsSetupRuns(t *testing.T) {
	f := newPrepFixture(t)
	var during string
	stubPlanCommand(t, func(context.Context, string, string) error {
		if g, err := wstore.GetDag(f.ctx, f.dagID); err == nil {
			during = g.Tasks[0].State
		}
		return nil
	})
	stubSpawn(t, new([]string))

	f.schedule(t)
	if during != TaskState_Preparing {
		t.Fatalf("want the stored task preparing during Setup, got %q", during)
	}
}

// a worker exit or an rpc ticks the dag while the first tick's Setup runs
func TestAPreparingTaskIsPreparedOnce(t *testing.T) {
	f := newPrepFixture(t)
	first := true
	calls := stubPlanCommand(t, func(context.Context, string, string) error {
		if first {
			first = false
			if err := Schedule(f.ctx, f.dagID); err != nil {
				t.Errorf("second tick: %v", err)
			}
		}
		return nil
	})
	var spawned []string
	stubSpawn(t, &spawned)

	f.schedule(t)
	f.wantRunning(t, calls, len(spawned))
}

// EnsureRunWorktree rebuilds a tree with untracked files, so the spawn pass must not call it on the prepared tree
func TestASetupThatLeavesUntrackedFilesRunsOnce(t *testing.T) {
	f := newPrepFixture(t)
	calls := stubPlanCommand(t, func(_ context.Context, dir, _ string) error {
		return os.WriteFile(filepath.Join(dir, "setup-output.txt"), []byte("built"), 0o644)
	})
	cwds := stubSpawnCwd(t)

	f.schedule(t)
	f.wantRunning(t, calls, len(*cwds))
	if _, err := os.Stat(filepath.Join((*cwds)[0], "setup-output.txt")); err != nil {
		t.Fatalf("Setup's output is gone from the worker's tree: %v", err)
	}
}

func TestADispatchFailedAfterItsPrepareWaitsForTheNextTick(t *testing.T) {
	f := newPrepFixture(t)
	calls := stubPlanCommand(t, func(context.Context, string, string) error { return nil })
	allowWorkerHarnessForTest(t)
	stubFlakySpawn(t, 1)

	f.schedule(t)
	task := f.dag(t).Tasks[0]
	if task.State != TaskState_Pending || task.Attempts != 1 {
		t.Fatalf("want pending with one attempt after the first tick, got %s with %d", task.State, task.Attempts)
	}
	if n := len(calls.list()); n != 1 {
		t.Fatalf("want Setup once, got %d", n)
	}

	f.schedule(t)
	if got := f.dag(t).Tasks[0].State; got != TaskState_Running {
		t.Fatalf("want running after the second tick, got %s", got)
	}
}

func TestCancelDuringSetupSpawnsNothing(t *testing.T) {
	f := newPrepFixture(t)
	stubPlanCommand(t, func(context.Context, string, string) error {
		if err := Cancel(f.ctx, f.dagID); err != nil {
			t.Errorf("cancel: %v", err)
		}
		return nil
	})
	var spawned []string
	stubSpawn(t, &spawned)

	f.schedule(t)
	if len(spawned) != 0 {
		t.Fatalf("a cancelled dag spawned %d workers", len(spawned))
	}
	if got := f.dag(t).Tasks[0].State; got != TaskState_Cancelled {
		t.Fatalf("want cancelled, got %s", got)
	}
	if n := treePrepCount(f.dagID); n != 0 {
		t.Fatalf("the registry still holds %d prepares for the cancelled dag", n)
	}
	if _, err := os.Stat(worktreeDir(f.project, TaskWorktreeKey(f.ownerID, "t-0"))); !os.IsNotExist(err) {
		t.Fatalf("the prepared tree of a cancelled dag must go; stat err = %v", err)
	}
}

func TestSkipDuringSetupSpawnsNothing(t *testing.T) {
	f := newPrepFixture(t)
	stubPlanCommand(t, func(context.Context, string, string) error {
		if err := ApplyAction(f.ctx, f.dagID, "t-0", "skip", ActionByHuman, waveobj.RoutePin{}); err != nil {
			t.Errorf("skip: %v", err)
		}
		return nil
	})
	var spawned []string
	stubSpawn(t, &spawned)

	f.schedule(t)
	if len(spawned) != 0 {
		t.Fatalf("a skipped task spawned %d workers", len(spawned))
	}
	if got := f.dag(t).Tasks[0].State; got != TaskState_Skipped {
		t.Fatalf("want skipped, got %s", got)
	}
	if n := treePrepCount(f.dagID); n != 0 {
		t.Fatalf("the registry still holds %d prepares for the skipped task", n)
	}
}

// wavesrv restarted mid-prepare: the stored state survived, the registry did not
func TestAPreparingTaskLostToARestartIsPreparedAgain(t *testing.T) {
	f := newPrepFixture(t)
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		cur.Tasks[0].State = TaskState_Preparing
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	calls := stubPlanCommand(t, func(context.Context, string, string) error { return nil })
	var spawned []string
	stubSpawn(t, &spawned)

	f.schedule(t)
	f.wantRunning(t, calls, len(spawned))
}

func TestSpawnedEventCarriesThePrepareTimings(t *testing.T) {
	f := newPrepFixture(t)
	stubPlanCommand(t, func(context.Context, string, string) error {
		time.Sleep(50 * time.Millisecond)
		return nil
	})
	stubSpawn(t, new([]string))

	f.schedule(t)
	detail := firstEventDetail(t, f.ctx, f.channel, f.ownerID, waveobj.RunEventKindTaskSpawned)
	if ms, _ := detail["setupms"].(float64); ms < 50 {
		t.Fatalf("want setupms >= 50 from the prepare, got %+v", detail)
	}
}
