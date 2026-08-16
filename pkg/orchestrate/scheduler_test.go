package orchestrate

import (
	"context"
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func groupWith(states ...string) *waveobj.TaskGroup {
	tasks := []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
		{ID: "t-1", Label: "b", Deps: []string{"t-0"}},
		{ID: "t-2", Label: "c", Deps: []string{"t-0"}},
		{ID: "t-3", Label: "d", Deps: []string{"t-1", "t-2"}},
	}
	for i, s := range states {
		tasks[i].State = s
	}
	g, err := NewTaskGroup("run-1", "ch-1", "g", 2, tasks, 1)
	if err != nil {
		panic(err)
	}
	return &g
}

func TestReadyTasksDepsAndOrder(t *testing.T) {
	g := groupWith(TaskState_Done)
	if got := ReadyTasks(g); !reflect.DeepEqual(got, []string{"t-1", "t-2"}) {
		t.Fatalf("want [t-1 t-2], got %v", got)
	}
}

func TestReadyTasksGateHalt(t *testing.T) {
	g := groupWith(TaskState_Done, TaskState_Done, TaskState_Done)
	g.Tasks[2].Gate = true // done gate with open successor t-3
	if got := ReadyTasks(g); len(got) != 0 {
		t.Fatalf("gate must halt ready tasks, got %v", got)
	}
	ApproveGate(g)
	if got := ReadyTasks(g); !reflect.DeepEqual(got, []string{"t-3"}) {
		t.Fatalf("after approve want [t-3], got %v", got)
	}
}

func TestNextToSpawnParallelismCap(t *testing.T) {
	g := groupWith(TaskState_Done, TaskState_Running)
	// one running (t-1), cap 2 -> only one more may spawn
	if got := NextToSpawn(g); !reflect.DeepEqual(got, []string{"t-2"}) {
		t.Fatalf("want [t-2], got %v", got)
	}
	g2 := groupWith(TaskState_Done)
	if got := NextToSpawn(g2); !reflect.DeepEqual(got, []string{"t-1", "t-2"}) {
		t.Fatalf("want [t-1 t-2], got %v", got)
	}
}

func TestSendBackAndRetryReset(t *testing.T) {
	g := groupWith(TaskState_Done, TaskState_Done, TaskState_Done)
	g.Tasks[2].Gate = true
	ApproveGate(g)
	g.Tasks[3].State = TaskState_Running
	g.Tasks[3].RunID = "r-3"
	SendBackGate(g) // reopens the gate for re-spawn
	if g.Tasks[2].State != TaskState_Running || g.Tasks[2].RunID != "" {
		t.Fatalf("sendback must reopen gate and clear runid: %+v", g.Tasks[2])
	}
	g2 := groupWith(TaskState_Done, TaskState_Failed)
	g2.Failures = 2
	if err := RetryTask(context.Background(), g2, "t-1"); err != nil {
		t.Fatal(err)
	}
	// a retried task must return to pending so NextToSpawn picks it up again — "running"
	// with no runid would count against the parallelism budget yet never spawn (deadlock).
	if g2.Tasks[1].State != TaskState_Pending || g2.Tasks[1].RunID != "" || g2.Failures != 0 {
		t.Fatalf("retry must re-open the task for spawn and reset failures: %+v", g2.Tasks[1])
	}
	got := NextToSpawn(g2)
	if len(got) != 2 || got[0] != "t-1" {
		t.Fatalf("retried task must be spawnable again, NextToSpawn=%v", got)
	}
}

func TestCancelGroup(t *testing.T) {
	g := groupWith(TaskState_Done, TaskState_Running)
	g.Tasks[1].RunID = "r-1"
	CancelGroup(g)
	if g.Tasks[1].State != TaskState_Cancelled || g.Status != DagStatus_Cancelled {
		t.Fatalf("cancel: %s %s", g.Tasks[1].State, g.Status)
	}
}
