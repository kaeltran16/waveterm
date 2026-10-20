// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"fmt"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const plentyOfMemory = 100 * WorkerMemoryReserve

func TestWorkerGrant(t *testing.T) {
	cases := []struct {
		name       string
		want, mine int
		load       workerLoad
		avail      uint64
		grant      int
	}{
		{"an idle machine grants all it asks", 3, 0, workerLoad{}, plentyOfMemory, 3},
		{"other runs' workers count against the cap", 4, 1, workerLoad{live: 6}, plentyOfMemory, 1},
		{"a full cap grants nothing", 2, 0, workerLoad{live: MaxLiveWorkers}, plentyOfMemory, 0},
		{"a waiting run holds this one to its share", 4, 3, workerLoad{live: 3, waiting: 1}, plentyOfMemory, 1},
		{"at its share a run leaves the free slots to the waiting one", 2, 4, workerLoad{live: 2, waiting: 1}, plentyOfMemory, 0},
		{"one worker per reserve of memory", 4, 1, workerLoad{}, 2*WorkerMemoryReserve + 1, 2},
		{"workers other dispatches just started take their reserve", 4, 1, workerLoad{live: 1, claimed: 1}, 2 * WorkerMemoryReserve, 1},
		{"short of memory with workers live, the task waits", 2, 1, workerLoad{}, WorkerMemoryReserve - 1, 0},
		{"short of memory with nothing live, one worker still starts", 3, 0, workerLoad{}, WorkerMemoryReserve - 1, 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := workerGrant(c.want, c.mine, c.load, c.avail); got != c.grant {
				t.Fatalf("workerGrant(%d, %d, %+v, %d) = %d, want %d", c.want, c.mine, c.load, c.avail, got, c.grant)
			}
		})
	}
}

// slotDag is a dag of n independent tasks, the first running of them live.
func slotDag(t *testing.T, id string, n, running int) *waveobj.TaskGroup {
	t.Helper()
	var tasks []waveobj.TaskNode
	for i := range n {
		tasks = append(tasks, waveobj.TaskNode{ID: fmt.Sprintf("t-%d", i), Label: "task"})
	}
	g, err := NewTaskGroup("run-"+id, "ch-"+id, id, MaxParallelism, false, tasks, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	g.OID = id
	for i := range running {
		g.Tasks[i].State = TaskState_Running
	}
	return &g
}

func TestWorkerLoadOf(t *testing.T) {
	dags := []*waveobj.TaskGroup{
		slotDag(t, "self", 3, 1),
		slotDag(t, "waiting", 3, 2),     // one ready task left
		slotDag(t, "full", 2, 2),        // nothing ready
		slotDag(t, "dispatching", 3, 0), // ready, but its claim is already spawning it
	}
	got := workerLoadOf(dags, "self", map[string]int{"self": 2, "dispatching": 2})
	want := workerLoad{live: 6, claimed: 2, waiting: 1}
	if got != want {
		t.Fatalf("got %+v, want %+v: self is left out, a dispatching dag counts its claim and does not wait", got, want)
	}
}

// A dag ready to dispatch while other runs fill the cap starts nothing, its task stays pending, and the next
// tick after a slot frees dispatches it. The claim is gone once the tick ends.
func TestScheduleWaitsForAWorkerSlotHeldByAnotherRun(t *testing.T) {
	allowWorkerHarnessForTest(t)
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "worker-slots", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner goal", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(), 1)
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 2, false, []waveobj.TaskNode{{ID: "t-0", Label: "a"}}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	spawns := 0
	old := spawnWorker
	spawnWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
		spawns++
		return "tab:worker", nil
	}
	others := []*waveobj.TaskGroup{slotDag(t, "other-run", MaxLiveWorkers, MaxLiveWorkers)}
	oldLive := liveDags
	liveDags = func(context.Context) ([]*waveobj.TaskGroup, error) { return others, nil }
	restoreAfterStages(t, func() { spawnWorker, liveDags = old, oldLive })

	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if spawns != 0 || g.Tasks[0].State != TaskState_Pending {
		t.Fatalf("a full cap must hold the task pending: %d spawns, state %s", spawns, g.Tasks[0].State)
	}

	others[0].Tasks[0].State = TaskState_Done
	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if spawns != 1 || g.Tasks[0].State != TaskState_Running {
		t.Fatalf("a freed slot must dispatch the task: %d spawns, state %s", spawns, g.Tasks[0].State)
	}
	workerClaims.Lock()
	defer workerClaims.Unlock()
	if n := workerClaims.byDag[g.OID]; n != 0 {
		t.Fatalf("the tick's claim must be released once it persisted, still holds %d", n)
	}
}
