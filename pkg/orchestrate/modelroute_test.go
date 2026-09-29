// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestEffectiveTaskRoutePrecedence(t *testing.T) {
	owner := &waveobj.Run{Runtime: "claude", Model: "opus"}
	lead := waveobj.RoutePin{Runtime: "claude", Model: "opus"}
	pinned := waveobj.RoutePin{Runtime: "claude", Model: "sonnet"}
	workers := waveobj.RoutePin{Runtime: "claude", Model: "haiku"}
	groups := map[string]*waveobj.TaskGroup{
		"zero":    {},
		"workers": {WorkerRoute: &waveobj.RoutePin{Runtime: "claude", Model: "haiku"}},
		"picks":   {ReviewerPicks: true},
	}
	cases := []struct {
		source string
		pin    bool
		group  string
		want   waveobj.RoutePin
	}{
		// no pin: every source falls to the workers route, else the lead's
		{"", false, "zero", lead},
		{"", false, "workers", workers},
		{"", false, "picks", lead},
		{waveobj.TaskModelSource_Plan, false, "zero", lead},
		{waveobj.TaskModelSource_Plan, false, "workers", workers},
		{waveobj.TaskModelSource_Plan, false, "picks", lead},
		{waveobj.TaskModelSource_Reviewer, false, "zero", lead},
		{waveobj.TaskModelSource_Reviewer, false, "workers", workers},
		{waveobj.TaskModelSource_Reviewer, false, "picks", lead},
		{waveobj.TaskModelSource_Owner, false, "zero", lead},
		{waveobj.TaskModelSource_Owner, false, "workers", workers},
		{waveobj.TaskModelSource_Owner, false, "picks", lead},
		{waveobj.TaskModelSource_Escalation, false, "zero", lead},
		{waveobj.TaskModelSource_Escalation, false, "workers", workers},
		{waveobj.TaskModelSource_Escalation, false, "picks", lead},
		// a typed pin, the owner's and an escalation's always win
		{"", true, "zero", pinned},
		{"", true, "workers", pinned},
		{"", true, "picks", pinned},
		{waveobj.TaskModelSource_Owner, true, "zero", pinned},
		{waveobj.TaskModelSource_Owner, true, "workers", pinned},
		{waveobj.TaskModelSource_Owner, true, "picks", pinned},
		{waveobj.TaskModelSource_Escalation, true, "zero", pinned},
		{waveobj.TaskModelSource_Escalation, true, "workers", pinned},
		{waveobj.TaskModelSource_Escalation, true, "picks", pinned},
		// a plan line or reviewer pick counts only on Reviewer picks
		{waveobj.TaskModelSource_Plan, true, "zero", lead},
		{waveobj.TaskModelSource_Plan, true, "workers", workers},
		{waveobj.TaskModelSource_Plan, true, "picks", pinned},
		{waveobj.TaskModelSource_Reviewer, true, "zero", lead},
		{waveobj.TaskModelSource_Reviewer, true, "workers", workers},
		{waveobj.TaskModelSource_Reviewer, true, "picks", pinned},
	}
	for _, c := range cases {
		task := &waveobj.TaskNode{ModelSource: c.source}
		if c.pin {
			// the runtime is inherited from the owner, as a plan's Model line leaves it
			task.RunSpec.Model = "sonnet"
		}
		if got := effectiveTaskRoute(task, owner, groups[c.group]); got != c.want {
			t.Errorf("source %q pin %v group %s: got %+v, want %+v", c.source, c.pin, c.group, got, c.want)
		}
	}
	// a stored dag with none of the new fields and no runtime anywhere keeps today's default runtime
	if got := effectiveTaskRoute(&waveobj.TaskNode{}, &waveobj.Run{}, nil); got != (waveobj.RoutePin{Runtime: "claude"}) {
		t.Errorf("zero-value task, owner and group: got %+v", got)
	}
}

func TestApplyEscalationMarksSource(t *testing.T) {
	task := &waveobj.TaskNode{ID: "t-1", State: TaskState_Failed, ModelSource: waveobj.TaskModelSource_Reviewer, PickReason: "mechanical"}
	applyEscalation(task, waveobj.RoutePin{Runtime: "claude", Model: "opus"})
	if task.ModelSource != waveobj.TaskModelSource_Escalation {
		t.Fatalf("model source = %q, want escalation", task.ModelSource)
	}
	// an escalation wins even on a group that is not on Reviewer picks
	if got := effectiveTaskRoute(task, &waveobj.Run{Runtime: "claude"}, &waveobj.TaskGroup{}); got.Model != "opus" {
		t.Fatalf("escalated route = %+v", got)
	}
}

func TestTaskWaiting(t *testing.T) {
	cases := []struct {
		name string
		task waveobj.TaskNode
		want bool
	}{
		{"pending", waveobj.TaskNode{State: TaskState_Pending}, true},
		{"ready", waveobj.TaskNode{State: TaskState_Ready}, true},
		{"running", waveobj.TaskNode{State: TaskState_Running, RunID: "r"}, false},
		{"done", waveobj.TaskNode{State: TaskState_Done}, false},
		{"pending with a run", waveobj.TaskNode{State: TaskState_Pending, RunID: "r"}, false},
		{"pending after a failure", waveobj.TaskNode{State: TaskState_Pending, Attempts: 1}, false},
		{"pending after an escalation", waveobj.TaskNode{State: TaskState_Pending, Escalations: 1}, false},
		{"ready with activity seen", waveobj.TaskNode{State: TaskState_Ready, FirstActivity: 5}, false},
	}
	for _, c := range cases {
		if got := taskWaiting(&c.task); got != c.want {
			t.Errorf("%s: taskWaiting = %v, want %v", c.name, got, c.want)
		}
	}
}

// seedModelDag stores a dag of independent tasks on a claude/opus lead, lets edit set their fields, and returns it.
func seedModelDag(t *testing.T, ids []string, edit func(g *waveobj.TaskGroup)) (context.Context, *waveobj.TaskGroup) {
	t.Helper()
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "modelroute-seed", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner goal", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(), 1)
	owner.Runtime, owner.Model = "claude", "opus"
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	tasks := make([]waveobj.TaskNode, len(ids))
	for i, id := range ids {
		tasks[i] = waveobj.TaskNode{ID: id, Label: id}
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 1, false, tasks, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	g.ReviewerPicks = true
	if edit != nil {
		edit(&g)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	return ctx, &g
}

func reviewerPicked(task *waveobj.TaskNode) {
	task.RunSpec.Runtime, task.RunSpec.Model = LightPickRoute.Runtime, LightPickRoute.Model
	task.ModelSource = waveobj.TaskModelSource_Reviewer
	task.PickReason = "a field threaded through"
}

func TestSetModelOnWaitingTask(t *testing.T) {
	allowWorkerHarnessForTest(t)
	ctx, dag := seedModelDag(t, []string{"t-1"}, func(g *waveobj.TaskGroup) { reviewerPicked(&g.Tasks[0]) })

	// an explicit model with no runtime takes the task's current runtime, as escalate does
	if err := applyActionLocked(ctx, dag.OID, "t-1", "setmodel", waveobj.RoutePin{Model: "haiku"}); err != nil {
		t.Fatal(err)
	}
	got := mustLoadDag(t, ctx, dag.OID).Tasks[0]
	if got.RunSpec.Runtime != "claude" || got.RunSpec.Model != "haiku" || got.ModelSource != waveobj.TaskModelSource_Owner || got.PickReason != "a field threaded through" {
		t.Fatalf("explicit setmodel = %+v", got)
	}

	// the empty target is the lead's route
	if err := applyActionLocked(ctx, dag.OID, "t-1", "setmodel", waveobj.RoutePin{}); err != nil {
		t.Fatal(err)
	}
	g := mustLoadDag(t, ctx, dag.OID)
	got = g.Tasks[0]
	if got.RunSpec.Runtime != "" || got.RunSpec.Model != "" || got.ModelSource != waveobj.TaskModelSource_Owner || got.PickReason != "a field threaded through" {
		t.Fatalf("lead setmodel = %+v", got)
	}
	owner, err := wstore.GetRun(ctx, g.ChannelId, g.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if route := effectiveTaskRoute(&got, owner, g); route != (waveobj.RoutePin{Runtime: "claude", Model: "opus"}) {
		t.Fatalf("a task put back on the lead routes to %+v", route)
	}
}

func TestSetModelRefusedOnceStarted(t *testing.T) {
	allowWorkerHarnessForTest(t)
	cases := []struct {
		name  string
		state string
		edit  func(task *waveobj.TaskNode)
	}{
		{"running", TaskState_Running, func(task *waveobj.TaskNode) { task.State, task.RunID = TaskState_Running, "run-1" }},
		{"pending after a failure", TaskState_Pending, func(task *waveobj.TaskNode) { task.Attempts = 1 }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ctx, dag := seedModelDag(t, []string{"t-1"}, func(g *waveobj.TaskGroup) {
				reviewerPicked(&g.Tasks[0])
				c.edit(&g.Tasks[0])
			})
			before := mustLoadDag(t, ctx, dag.OID).Tasks[0]
			err := applyActionLocked(ctx, dag.OID, "t-1", "setmodel", waveobj.RoutePin{})
			if err == nil || !strings.Contains(err.Error(), "has started ("+c.state+")") {
				t.Fatalf("setmodel on a started task: err = %v", err)
			}
			after := mustLoadDag(t, ctx, dag.OID).Tasks[0]
			if after.RunSpec != before.RunSpec || after.ModelSource != before.ModelSource {
				t.Fatalf("refused setmodel changed the task: %+v", after)
			}
		})
	}
}

func TestSetModelRefusesUninstalledHarness(t *testing.T) {
	old := validateWorkerHarness
	validateWorkerHarness = func(runtime string) error { return errors.New(runtime + " is not installed") }
	restoreAfterStages(t, func() { validateWorkerHarness = old })
	ctx, dag := seedModelDag(t, []string{"t-1"}, nil)

	err := applyActionLocked(ctx, dag.OID, "t-1", "setmodel", waveobj.RoutePin{Runtime: "pi", Model: "opencode/deepseek-v4-pro"})
	if err == nil || !strings.Contains(err.Error(), "pi is not installed") {
		t.Fatalf("setmodel to an uninstalled harness: err = %v", err)
	}
	got := mustLoadDag(t, ctx, dag.OID).Tasks[0]
	if got.RunSpec.Runtime != "" || got.RunSpec.Model != "" || got.ModelSource != "" {
		t.Fatalf("refused setmodel changed the task: %+v", got)
	}
}

func TestLeadModelsResetsOnlyWaitingPicks(t *testing.T) {
	ctx, dag := seedModelDag(t, []string{"running", "waiting", "plan", "nopick", "leadpick"}, func(g *waveobj.TaskGroup) {
		reviewerPicked(&g.Tasks[0])
		g.Tasks[0].State, g.Tasks[0].RunID = TaskState_Running, "run-1"
		reviewerPicked(&g.Tasks[1])
		g.Tasks[2].RunSpec.Model = "sonnet"
		g.Tasks[2].ModelSource = waveobj.TaskModelSource_Plan
		// the reviewer left this one on the lead: an empty pin with a reason
		g.Tasks[4].ModelSource = waveobj.TaskModelSource_Reviewer
		g.Tasks[4].PickReason = "a design choice"
	})
	before := mustLoadDag(t, ctx, dag.OID)

	if err := applyActionLocked(ctx, dag.OID, "ignored", "leadmodels", waveobj.RoutePin{}); err != nil {
		t.Fatal(err)
	}
	after := mustLoadDag(t, ctx, dag.OID)
	for i, task := range after.Tasks {
		if task.ID == "waiting" {
			if task.RunSpec.Runtime != "" || task.RunSpec.Model != "" || task.ModelSource != waveobj.TaskModelSource_Owner || task.PickReason != "a field threaded through" {
				t.Fatalf("waiting pick after leadmodels = %+v", task)
			}
			continue
		}
		b := before.Tasks[i]
		if task.RunSpec != b.RunSpec || task.ModelSource != b.ModelSource || task.PickReason != b.PickReason {
			t.Fatalf("leadmodels changed %s: %+v, was %+v", task.ID, task, b)
		}
	}
}

func TestSetModelKeepsFailureStreak(t *testing.T) {
	allowWorkerHarnessForTest(t)
	ctx, dag := seedModelDag(t, []string{"t-1"}, func(g *waveobj.TaskGroup) {
		reviewerPicked(&g.Tasks[0])
		g.Failures = 2
	})
	if err := applyActionLocked(ctx, dag.OID, "t-1", "setmodel", waveobj.RoutePin{}); err != nil {
		t.Fatal(err)
	}
	if got := mustLoadDag(t, ctx, dag.OID).Failures; got != 2 {
		t.Fatalf("failures after setmodel = %d, want 2", got)
	}
	if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
		reviewerPicked(&g.Tasks[0])
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := applyActionLocked(ctx, dag.OID, "", "leadmodels", waveobj.RoutePin{}); err != nil {
		t.Fatal(err)
	}
	got := mustLoadDag(t, ctx, dag.OID)
	if got.Failures != 2 || got.Tasks[0].ModelSource != waveobj.TaskModelSource_Owner {
		t.Fatalf("after leadmodels: failures %d, task %+v", got.Failures, got.Tasks[0])
	}
}

func TestNewTaskGroupRefusesReviewerSource(t *testing.T) {
	cases := []struct {
		name    string
		task    waveobj.TaskNode
		errPart string
	}{
		{"reviewer source", waveobj.TaskNode{ModelSource: waveobj.TaskModelSource_Reviewer}, "modelsource"},
		{"owner source", waveobj.TaskNode{ModelSource: waveobj.TaskModelSource_Owner}, "modelsource"},
		{"escalation source", waveobj.TaskNode{ModelSource: waveobj.TaskModelSource_Escalation}, "modelsource"},
		{"pick reason", waveobj.TaskNode{PickReason: "mechanical"}, "pickreason"},
		{"plan source", waveobj.TaskNode{ModelSource: waveobj.TaskModelSource_Plan, RunSpec: waveobj.RunSpec{Model: "sonnet"}}, ""},
		{"no source", waveobj.TaskNode{}, ""},
	}
	for _, c := range cases {
		task := c.task
		task.ID, task.Label = "t-1", "a"
		_, err := NewTaskGroup("run", "ch", "g", 1, false, []waveobj.TaskNode{task}, 1, nil)
		if c.errPart == "" {
			if err != nil {
				t.Errorf("%s: %v", c.name, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), c.errPart) || !strings.Contains(err.Error(), `"t-1"`) {
			t.Errorf("%s: err = %v, want one naming t-1 and %s", c.name, err, c.errPart)
		}
	}
}

func TestSameDagProposalComparesModelSource(t *testing.T) {
	mk := func(source string) *waveobj.TaskGroup {
		return &waveobj.TaskGroup{Title: "g", Parallelism: 1, Tasks: []waveobj.TaskNode{
			{ID: "t-1", Label: "a", RunSpec: waveobj.RunSpec{Model: "sonnet"}, ModelSource: source},
		}}
	}
	if !SameDagProposal(mk(waveobj.TaskModelSource_Plan), mk(waveobj.TaskModelSource_Plan)) {
		t.Fatal("identical proposals must match")
	}
	// the same pin from a plan line and from a typed RunSpec route differently, so they are different proposals
	if SameDagProposal(mk(waveobj.TaskModelSource_Plan), mk("")) {
		t.Fatal("proposals differing only in model source must not match")
	}
}
