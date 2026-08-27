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
	g, err := NewTaskGroup("run-1", "ch-1", "g", 2, false, tasks, 1)
	if err != nil {
		t.Fatal(err)
	}
	return &g
}

func TestNewTaskGroupSetsIdentity(t *testing.T) {
	g, err := NewTaskGroup("run-1", "ch-1", "ship", 2, false, mkTasks(), 1000)
	if err != nil {
		t.Fatalf("NewTaskGroup: %v", err)
	}
	if g.RunID != "run-1" || g.ChannelId != "ch-1" || g.Parallelism != 2 || g.ID == "" {
		t.Fatalf("bad identity: %+v", g)
	}
}

func TestNewTaskGroupRejectsInvalidAuthoringAndEngineState(t *testing.T) {
	nineTasks := make([]waveobj.TaskNode, 9)
	for i := range nineTasks {
		nineTasks[i] = waveobj.TaskNode{ID: string(rune('a' + i)), Label: "task"}
	}
	cases := []struct {
		name        string
		title       string
		parallelism int
		tasks       []waveobj.TaskNode
	}{
		{name: "blank title", title: "   ", parallelism: 1, tasks: []waveobj.TaskNode{{ID: "t", Label: "a"}}},
		{name: "blank label", title: "g", parallelism: 1, tasks: []waveobj.TaskNode{{ID: "t", Label: "   "}}},
		{name: "duplicate dependency", title: "g", parallelism: 1, tasks: []waveobj.TaskNode{{ID: "a", Label: "a"}, {ID: "b", Label: "b", Deps: []string{"a", "a"}}}},
		{name: "too many tasks", title: "g", parallelism: 1, tasks: nineTasks},
		{name: "zero parallelism", title: "g", parallelism: 0, tasks: []waveobj.TaskNode{{ID: "t", Label: "a"}}},
		{name: "excess parallelism", title: "g", parallelism: 9, tasks: []waveobj.TaskNode{{ID: "t", Label: "a"}}},
		{name: "state", title: "g", parallelism: 1, tasks: []waveobj.TaskNode{{ID: "t", Label: "a", State: TaskState_Running}}},
		{name: "run id", title: "g", parallelism: 1, tasks: []waveobj.TaskNode{{ID: "t", Label: "a", RunID: "run"}}},
		{name: "released", title: "g", parallelism: 1, tasks: []waveobj.TaskNode{{ID: "t", Label: "a", Released: true}}},
		{name: "last activity", title: "g", parallelism: 1, tasks: []waveobj.TaskNode{{ID: "t", Label: "a", LastActivity: 1}}},
		{name: "attempts", title: "g", parallelism: 1, tasks: []waveobj.TaskNode{{ID: "t", Label: "a", Attempts: 1}}},
		{name: "lastfailurekind", title: "g", parallelism: 1, tasks: []waveobj.TaskNode{{ID: "t", Label: "a", LastFailureKind: "timeout"}}},
		{name: "escalations", title: "g", parallelism: 1, tasks: []waveobj.TaskNode{{ID: "t", Label: "a", Escalations: 1}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := NewTaskGroup("run", "channel", tc.title, tc.parallelism, false, tc.tasks, 1); err == nil {
				t.Fatal("want validation error")
			}
		})
	}
}

func TestNewTaskGroupSanitizesDeepCopy(t *testing.T) {
	tasks := []waveobj.TaskNode{
		{ID: "a", Label: "a", RunSpec: waveobj.RunSpec{Runtime: "pi", Tier: "mid"}},
		{ID: "b", Label: "b", Deps: []string{"a"}},
	}
	g, err := NewTaskGroup("run", "channel", "g", 1, false, tasks, 1)
	if err != nil {
		t.Fatal(err)
	}
	tasks[0].Label = "changed"
	tasks[1].Deps[0] = "changed"
	if g.Tasks[0].Label != "a" || g.Tasks[1].Deps[0] != "a" {
		t.Fatalf("group shares caller task data: %+v", g.Tasks)
	}
	for _, task := range g.Tasks {
		if task.State != TaskState_Pending {
			t.Fatalf("task %s state = %q, want pending", task.ID, task.State)
		}
	}
}

func TestSameDagProposalUsesOnlyAuthoringShape(t *testing.T) {
	a := mustGroup(t, mkTasks())
	b := *a
	b.Tasks = append([]waveobj.TaskNode(nil), a.Tasks...)
	b.OID = "different"
	b.ID = "different"
	b.Version = 99
	b.Status = DagStatus_Blocked
	b.Failures = 2
	b.CreatedTs = 50
	b.UpdatedTs = 60
	b.Tasks[0].State = TaskState_Done
	b.Tasks[0].RunID = "child"
	b.Tasks[0].Released = true
	b.Tasks[0].LastActivity = 100
	b.Tasks[0].Attempts = 2
	b.Tasks[0].LastFailureKind = FailureKindTimeout
	b.Tasks[0].Escalations = 1
	if !SameDagProposal(a, &b) {
		t.Fatal("engine state changed proposal identity")
	}
	b.Tasks[0].Label = "changed"
	if SameDagProposal(a, &b) {
		t.Fatal("authoring change treated as identical proposal")
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
		{"blank id", []waveobj.TaskNode{{ID: "   ", Label: "a"}}},
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
	if g.Status != DagStatus_AwaitingReview {
		t.Fatalf("gate still unreleased: want awaiting-review, got %s", g.Status)
	}
	g.Tasks[2].Released = true
	RecomputeDagStatus(g)
	if g.Status != DagStatus_Done {
		t.Fatalf("released gate: want done, got %s", g.Status)
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

func TestNewTaskGroupRejectsLifecycleFields(t *testing.T) {
	tasks := []waveobj.TaskNode{{
		ID: "t-1", Label: "one", Merged: true,
		CleanupPending: true, CleanupError: "locked",
	}}
	if _, err := NewTaskGroup("run", "channel", "title", 1, true, tasks, 1); err == nil {
		t.Fatal("caller-supplied merge and cleanup fields must be rejected")
	}
}

func TestNewTaskGroupPersistsMergeRequirement(t *testing.T) {
	g, err := NewTaskGroup("run", "channel", "title", 1, true, []waveobj.TaskNode{{ID: "t-1", Label: "one"}}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if !g.MergeRequired {
		t.Fatal("git-backed dag must require merged tasks")
	}
}
