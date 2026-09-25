// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const fixPlanSrc = "# Fix the board\n\n**Verify:** `echo fix-verify`\n**Check:** `echo fix-check`\n**Final:** `echo fix-final`\n\n" +
	"### Task 1: restore the column width\nwiden the board column\n\n### Task 2: cover it\n**Depends on:** Task 1\nadd the layout test\n"

func fixPlanTasks(t *testing.T) []waveobj.TaskNode {
	t.Helper()
	plan, err := jarvis.ParsePlan(fixPlanSrc)
	if err != nil {
		t.Fatal(err)
	}
	return plan.Tasks
}

// failedFinalFixture is a branch-landed dag of seven landed tasks whose final stage failed in the given round.
func failedFinalFixture(t *testing.T, round int) (*mergeFixture, string) {
	t.Helper()
	var tasks []waveobj.TaskNode
	for i := 1; i <= 7; i++ {
		tasks = append(tasks, waveobj.TaskNode{ID: fmt.Sprintf("t-%d", i), Label: fmt.Sprintf("task %d", i)})
	}
	f := newMergeFixture(t, tasks)
	tree := f.land(t)
	for _, task := range tasks {
		f.finish(t, task.ID)
	}
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		for i := range cur.Tasks {
			cur.Tasks[i].Merged = true
		}
		cur.Verify, cur.Check, cur.FinalCmd = verifyCmd, "echo run-check", "echo run-final"
		cur.PlanPath = "docs/plan.md"
		cur.Final = &waveobj.FinalStage{State: FinalState_Failed, Round: round, Detail: "FAIL board-layout"}
		RecomputeDagStatus(cur)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if g := f.dag(t); g.Status != DagStatus_Blocked {
		t.Fatalf("fixture: a failed final stage blocks the dag, got %s", g.Status)
	}
	return f, tree
}

func TestAppendRoundExtendsTheDagAndCutsFromTheLandingHead(t *testing.T) {
	f, tree := failedFinalFixture(t, 1)
	// the fix plan committed at the round's submit is on the landing branch, ahead of the checkout
	if err := os.MkdirAll(filepath.Join(tree, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tree, "docs", "fix.md"), []byte(fixPlanSrc), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, tree, "add", ".")
	gitCmd(t, tree, "commit", "-m", "docs: fix plan")
	tip := gitCmd(t, tree, "rev-parse", "HEAD")

	g, err := AppendRound(f.ctx, f.dagID, "docs/fix.md", fixPlanTasks(t))
	if err != nil {
		t.Fatal(err)
	}
	got := make([]string, 0, 2)
	for _, task := range g.Tasks[7:] {
		got = append(got, task.ID+" <- "+strings.Join(task.Deps, ","))
	}
	if len(g.Tasks) != 9 || !reflect.DeepEqual(got, []string{"t-8 <- ", "t-9 <- t-8"}) {
		t.Fatalf("the fix tasks are t-8 and t-9, t-9 after t-8, got %d tasks %v", len(g.Tasks), got)
	}
	if !reflect.DeepEqual(g.Final, &waveobj.FinalStage{Round: 2}) || g.Status != DagStatus_Running {
		t.Fatalf("round 2 is set up but not started and the dag runs again, got %+v / %s", g.Final, g.Status)
	}
	if g.Verify != verifyCmd || g.Check != "echo run-check" || g.FinalCmd != "echo run-final" || g.PlanReview != nil {
		t.Fatalf("the dag keeps its own commands and opens no plan review, got %q %q %q %+v", g.Verify, g.Check, g.FinalCmd, g.PlanReview)
	}

	allowWorkerHarnessForTest(t)
	type spawn struct{ cwd, prompt string }
	var spawned []spawn
	old := spawnWorker
	spawnWorker = func(_ context.Context, _ runroute.Capability, _, _, cwd, prompt string, _ jarvis.RunWorkerOptions) (string, error) {
		spawned = append(spawned, spawn{cwd, prompt})
		return "tab:worker", nil
	}
	t.Cleanup(func() { spawnWorker = old })
	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	if len(spawned) != 1 || f.dag(t).Tasks[7].State != TaskState_Running {
		t.Fatalf("only t-8 is ready, got %d spawns, t-8 %s", len(spawned), f.dag(t).Tasks[7].State)
	}
	if got := gitCmd(t, f.project, "rev-parse", "wave/"+LaneWorktreeKey(f.dag(t), "t-8")); got != tip {
		t.Fatalf("t-8 starts at %s, want the landing head %s", got, tip)
	}
	// the worker reads the fix plan's snapshot in its own tree, by the plan's own task number
	want := "Fix round 2: this is task 1 of the fix plan at " + filepath.Join(spawned[0].cwd, "docs/fix.md") + "; re-read it there, not the run plan"
	if !strings.Contains(spawned[0].prompt, want) || !strings.Contains(spawned[0].prompt, "widen the board column") {
		t.Fatalf("the prompt must name the fix plan in the worker's tree and task 1, want %q in:\n%s", want, spawned[0].prompt)
	}
}

// a round is refused unless the final stage failed with a round left (Review Focus)
func TestCheckFixRoundRefuses(t *testing.T) {
	cases := []struct {
		name    string
		final   *waveobj.FinalStage
		status  string
		errPart string
	}{
		{"no final stage yet", nil, "", "the final stage has not failed"},
		{"a round not started", &waveobj.FinalStage{Round: 2}, "", "the final stage has not failed"},
		{"running its commands", &waveobj.FinalStage{State: FinalState_Checking, Round: 1}, "", "the final stage has not failed"},
		{"its verifier judging", &waveobj.FinalStage{State: FinalState_Verifying, Round: 1}, "", "the final stage has not failed"},
		{"passed", &waveobj.FinalStage{State: FinalState_Passed, Round: 1}, "", "the final stage has not failed"},
		{"unverified", &waveobj.FinalStage{State: FinalState_Unverified, Round: 1}, "", "the final stage has not failed"},
		{"failed the last round", &waveobj.FinalStage{State: FinalState_Failed, Round: MaxFinalRounds}, "", "no fix rounds left; forward to the human"},
		{"cancelled", &waveobj.FinalStage{State: FinalState_Failed, Round: 1}, DagStatus_Cancelled, "cancelled"},
		{"failed with a round left", &waveobj.FinalStage{State: FinalState_Failed, Round: 1}, "", ""},
	}
	for _, c := range cases {
		g := mustGroup(t, []waveobj.TaskNode{{ID: "t-1", Label: "a"}})
		g.Final, g.Status = c.final, c.status
		err := CheckFixRound(g)
		if c.errPart == "" {
			if err != nil {
				t.Fatalf("%s: want no refusal, got %v", c.name, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), c.errPart) {
			t.Fatalf("%s: error %v should say %q", c.name, err, c.errPart)
		}
	}
}

func TestAppendRoundRefusedLeavesTheDagAlone(t *testing.T) {
	f, _ := failedFinalFixture(t, MaxFinalRounds)
	before := f.dag(t)

	_, err := AppendRound(f.ctx, f.dagID, "docs/fix.md", fixPlanTasks(t))
	if err == nil || !strings.Contains(err.Error(), "no fix rounds left; forward to the human") {
		t.Fatalf("round %d failed: want the refusal, got %v", MaxFinalRounds, err)
	}
	if after := f.dag(t); len(after.Tasks) != len(before.Tasks) || !reflect.DeepEqual(after.Final, before.Final) {
		t.Fatalf("a refused round changes nothing, got %d tasks, final %+v", len(after.Tasks), after.Final)
	}
}

func TestRoundTasksRefuseADependsOutsideTheFixPlan(t *testing.T) {
	_, err := roundTasks(7, 2, "fix.md", []waveobj.TaskNode{{ID: "t-1", Label: "a", Deps: []string{"t-3"}}})
	if err == nil || !strings.Contains(err.Error(), "not in the fix plan") {
		t.Fatalf("want a refusal naming the fix plan, got %v", err)
	}
}

func TestRoundDescriptionResolvesThePlanInTheReadersTree(t *testing.T) {
	g := &waveobj.TaskGroup{}
	abs := filepath.Join(t.TempDir(), "fix.md")
	tree := filepath.Join(t.TempDir(), "lane")
	cases := []struct{ desc, want string }{
		{fmt.Sprintf(fixRoundLineFmt, 2, 1, "docs/fix.md") + "\n\nbody", fmt.Sprintf(fixRoundLineFmt, 2, 1, filepath.Join(tree, "docs/fix.md")) + "\n\nbody"},
		// a checkout-landed dag keeps its docs absolute, shared by every reader
		{fmt.Sprintf(fixRoundLineFmt, 2, 1, abs), fmt.Sprintf(fixRoundLineFmt, 2, 1, abs)},
		{"docs/fix.md is mentioned, but this is no fix-round task", "docs/fix.md is mentioned, but this is no fix-round task"},
	}
	for _, c := range cases {
		if got := roundDescription(g, c.desc, tree); got != c.want {
			t.Fatalf("roundDescription(%q) = %q, want %q", c.desc, got, c.want)
		}
	}
}
