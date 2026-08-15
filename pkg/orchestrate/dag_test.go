package orchestrate

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func mkTasks() []waveobj.TaskNode {
	return []waveobj.TaskNode{
		{ID: "t-0", Label: "setup"},
		{ID: "t-1", Label: "api", Deps: []string{"t-0"}},
		{ID: "t-2", Label: "ship", Deps: []string{"t-0", "t-1"}, Gate: true},
	}
}

func mustGroup(t *testing.T, tasks []waveobj.TaskNode) *waveobj.TaskGroup {
	t.Helper()
	g, err := NewTaskGroup("run-1", "ch-1", "g", 2, tasks, 1)
	if err != nil {
		t.Fatal(err)
	}
	return &g
}

func TestNewTaskGroupSetsIdentity(t *testing.T) {
	g, err := NewTaskGroup("run-1", "ch-1", "ship", 2, mkTasks(), 1000)
	if err != nil {
		t.Fatalf("NewTaskGroup: %v", err)
	}
	if g.RunID != "run-1" || g.ChannelId != "ch-1" || g.Parallelism != 2 || g.ID == "" {
		t.Fatalf("bad identity: %+v", g)
	}
}

func TestValidateRejects(t *testing.T) {
	cases := []struct {
		name  string
		tasks []waveobj.TaskNode
	}{
		{"dup id", []waveobj.TaskNode{{ID: "t-1"}, {ID: "t-1"}}},
		{"unknown dep", []waveobj.TaskNode{{ID: "t-1", Deps: []string{"nope"}}}},
		{"self dep", []waveobj.TaskNode{{ID: "t-1", Deps: []string{"t-1"}}}},
		{"cycle", []waveobj.TaskNode{{ID: "t-1", Deps: []string{"t-2"}}, {ID: "t-2", Deps: []string{"t-1"}}}},
		{"empty id", []waveobj.TaskNode{{ID: ""}}},
	}
	for _, c := range cases {
		if err := ValidateTasks(c.tasks); err == nil {
			t.Errorf("%s: expected error", c.name)
		}
	}
	if err := ValidateTasks(mkTasks()); err != nil {
		t.Errorf("valid tasks rejected: %v", err)
	}
}

func TestRecomputeStatusDerivation(t *testing.T) {
	g := mustGroup(t, []waveobj.TaskNode{
		{ID: "t-0", Label: "setup"},
		{ID: "t-1", Label: "api", Deps: []string{"t-0"}},
		{ID: "t-2", Label: "gate", Deps: []string{"t-0", "t-1"}, Gate: true},
		{ID: "t-3", Label: "ship", Deps: []string{"t-2"}},
	})
	g.Tasks[0].State = TaskState_Done
	g.Tasks[1].State = TaskState_Done
	RecomputeDagStatus(g)
	if g.Status != DagStatus_Running {
		t.Fatalf("gate not yet done: want running, got %s", g.Status)
	}
	g.Tasks[2].State = TaskState_Done // done, unreleased gate with open successor
	RecomputeDagStatus(g)
	if g.Status != DagStatus_AwaitingReview {
		t.Fatalf("want awaiting-review, got %s", g.Status)
	}
	g.Tasks[3].State = TaskState_Done
	RecomputeDagStatus(g)
	if g.Status != DagStatus_Done {
		t.Fatalf("want done, got %s", g.Status)
	}
	g2 := mustGroup(t, mkTasks())
	g2.Tasks[1].State = TaskState_Failed
	RecomputeDagStatus(g2)
	if g2.Status != DagStatus_Blocked {
		t.Fatalf("want blocked, got %s", g2.Status)
	}
	g3 := mustGroup(t, mkTasks())
	g3.Failures = 3
	RecomputeDagStatus(g3)
	if g3.Status != DagStatus_Blocked {
		t.Fatalf("want circuit-break blocked, got %s", g3.Status)
	}
}

func TestDeriveTaskStatesFromRuns(t *testing.T) {
	g := mustGroup(t, mkTasks())
	g.Tasks[0].State = TaskState_Running
	g.Tasks[0].RunID = "r-0"
	runs := map[string]*waveobj.Run{"r-0": {ID: "r-0", Status: jarvis.RunStatus_Done}}
	DeriveTaskStates(g, runs)
	if g.Tasks[0].State != TaskState_Done {
		t.Fatalf("want done, got %s", g.Tasks[0].State)
	}
}
