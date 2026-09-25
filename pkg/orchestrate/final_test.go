// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// finalFixture is a checkout-landed git dag whose one task has landed, with the plan's Verify, Check and
// Final commands set. Its next tick starts the final stage.
func finalFixture(t *testing.T, verify, check, finalCmd string) *mergeFixture {
	t.Helper()
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	f.finish(t, "t-0")
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		cur.Tasks[0].Merged = true
		cur.Verify, cur.Check, cur.FinalCmd = verify, check, finalCmd
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return f
}

// awaitFinal returns a func that blocks until one more final stage's commands have run, their result is
// recorded, and the dag was ticked.
func awaitFinal(t *testing.T) func() {
	t.Helper()
	done := make(chan struct{}, 16)
	orig := finalFinished
	finalFinished = func(string) { done <- struct{}{} }
	t.Cleanup(func() { finalFinished = orig })
	return func() {
		t.Helper()
		select {
		case <-done:
		case <-time.After(60 * time.Second):
			t.Fatal("the final stage did not finish")
		}
	}
}

// runFinal ticks f's dag and waits for its final commands to finish.
func runFinal(t *testing.T, f *mergeFixture) *waveobj.TaskGroup {
	t.Helper()
	await := awaitFinal(t)
	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	await()
	return f.dag(t)
}

func TestLandedDagStatusFollowsTheFinalStage(t *testing.T) {
	cases := []struct {
		final *waveobj.FinalStage
		want  string
	}{
		{nil, DagStatus_Finalizing},
		{&waveobj.FinalStage{Round: 2}, DagStatus_Finalizing},
		{&waveobj.FinalStage{State: FinalState_Checking, Round: 1}, DagStatus_Finalizing},
		{&waveobj.FinalStage{State: FinalState_Final, Round: 1}, DagStatus_Finalizing},
		{&waveobj.FinalStage{State: FinalState_Verifying, Round: 1}, DagStatus_Finalizing},
		{&waveobj.FinalStage{State: FinalState_Passed, Round: 1}, DagStatus_Done},
		{&waveobj.FinalStage{State: FinalState_Unverified, Round: 1}, DagStatus_Done},
		{&waveobj.FinalStage{State: FinalState_Failed, Round: 1}, DagStatus_Blocked},
	}
	for _, c := range cases {
		g := mustGroup(t, []waveobj.TaskNode{{ID: "t-0", Label: "a"}})
		g.Tasks[0].State = TaskState_Done
		g.Final = c.final
		RecomputeDagStatus(g)
		if g.Status != c.want {
			t.Fatalf("final %+v: want %s, got %s", c.final, c.want, g.Status)
		}
	}
	// a dag done before the final stage existed is not judged again
	g := mustGroup(t, []waveobj.TaskNode{{ID: "t-0", Label: "a"}})
	g.Tasks[0].State = TaskState_Done
	g.Status = DagStatus_Done
	RecomputeDagStatus(g)
	if g.Status != DagStatus_Done || g.Final != nil {
		t.Fatalf("an old done dag stays done, got %s / %+v", g.Status, g.Final)
	}
}

func TestFinalCheckFailureFailsTheStageWithItsTailAndWakesTheLead(t *testing.T) {
	lead := newFakeLead(t)
	// the branch name shows the Check ran in a detached tree, not in the shared checkout
	f := finalFixture(t, verifyCmd, "git rev-parse --abbrev-ref HEAD; echo 'vet: x.go:3: unreachable code'; exit 1", "")

	g := runFinal(t, f)

	if g.Final.State != FinalState_Failed || g.Status != DagStatus_Blocked || BlockingKind(g) != BlockingKindFinalFailed {
		t.Fatalf("a failing Check fails the stage and blocks the dag, got %s / %s / %q", g.Final.State, g.Status, BlockingKind(g))
	}
	if !strings.Contains(g.Final.Detail, "(exit 1)") || !strings.Contains(g.Final.Detail, "HEAD\nvet: x.go:3: unreachable code") {
		t.Fatalf("Detail holds the exit and the output tail from the detached tree, got %q", g.Final.Detail)
	}
	if len(lead.sends) != 1 || !strings.Contains(lead.sends[0], g.Final.Detail) || !strings.Contains(lead.sends[0], "wsh jarvis dag submit --round") {
		t.Fatalf("the lead is woken with the Detail whole and the fix round, got %q", lead.sends)
	}
	if _, err := os.Stat(worktreeDir(f.project, f.ownerID+"-final")); !os.IsNotExist(err) {
		t.Fatalf("the detached final tree is removed once the stage ends, stat err %v", err)
	}
}

func TestFinalExit3IsUnverifiedWithItsLastLine(t *testing.T) {
	f := finalFixture(t, verifyCmd, "", "echo booting; echo 'no dev app: cargo missing'; exit 3")

	g := runFinal(t, f)

	if g.Final.State != FinalState_Unverified || g.Status != DagStatus_Done {
		t.Fatalf("exit 3 is unverified and the dag is done, got %s / %s", g.Final.State, g.Status)
	}
	if want := []string{"no dev app: cargo missing"}; !reflect.DeepEqual(g.Final.Unverified, want) {
		t.Fatalf("the reason is the last output line, got %q", g.Final.Unverified)
	}
}

func TestFinalOtherExitFails(t *testing.T) {
	f := finalFixture(t, verifyCmd, "", "echo 'FAIL board-layout'; exit 2")

	g := runFinal(t, f)

	if g.Final.State != FinalState_Failed || !strings.Contains(g.Final.Detail, "(exit 2)") || !strings.Contains(g.Final.Detail, "FAIL board-layout") {
		t.Fatalf("exit 2 fails with the exit and the tail, got %s %q", g.Final.State, g.Final.Detail)
	}
}

func TestAFinalCommandThatHangsTimesOut(t *testing.T) {
	orig := finalCommandTimeout
	finalCommandTimeout = time.Second
	t.Cleanup(func() { finalCommandTimeout = orig })
	f := finalFixture(t, verifyCmd, "", "sleep 30")

	start := time.Now()
	g := runFinal(t, f)

	if g.Final.State != FinalState_Failed || !strings.Contains(g.Final.Detail, "timed out") {
		t.Fatalf("a hanging Final fails with timed out, got %s %q", g.Final.State, g.Final.Detail)
	}
	if took := time.Since(start); took > 20*time.Second {
		t.Fatalf("the timeout must end the command, took %s", took)
	}
}

func TestFinalWithNothingToRunPassesInTheTick(t *testing.T) {
	lead := newFakeLead(t)
	f := finalFixture(t, verifyCmd, "", "")

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}

	g := f.dag(t)
	if g.Final == nil || g.Final.State != FinalState_Passed || g.Final.Round != 1 || g.Status != DagStatus_Done {
		t.Fatalf("no Check, no Final and nothing unverified passes in the same tick, got %+v / %s", g.Final, g.Status)
	}
	if want := runFinishedWake + "\nThe final stage passed on the merged result."; len(lead.sends) != 1 || lead.sends[0] != want {
		t.Fatalf("want %q, got %q", want, lead.sends)
	}
}

func TestFinalCountsReviewCaveatsAndAMissingVerify(t *testing.T) {
	f := finalFixture(t, "", "", "")
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		cur.Tasks[0].ReviewUnverified = "the timeout path has no test"
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}

	g := f.dag(t)
	want := []string{"t-0: the timeout path has no test", "the plan has no Verify"}
	if g.Final.State != FinalState_Unverified || !reflect.DeepEqual(g.Final.Unverified, want) {
		t.Fatalf("want unverified with %q, got %s %q", want, g.Final.State, g.Final.Unverified)
	}
}

func TestANonGitDagIsUnverified(t *testing.T) {
	newFakeLead(t)
	h := newNotifyHarness(t, 1, []waveobj.TaskNode{{ID: "t-0", Label: "a"}})
	h.finishTask(t, "t-0", jarvis.RunStatus_Done)

	h.scheduleTimes(t, 1)

	g := h.loadDag(t)
	if g.Status != DagStatus_Done || g.Final.State != FinalState_Unverified || !strings.Contains(g.Final.Unverified[0], "not a git repository") {
		t.Fatalf("want done and unverified naming the missing repository, got %s / %+v", g.Status, g.Final)
	}
}

func TestAFixRoundsStageKeepsItsRound(t *testing.T) {
	f := finalFixture(t, verifyCmd, "", "")
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		cur.Final = &waveobj.FinalStage{Round: 2}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}

	g := f.dag(t)
	if g.Final.Round != 2 || g.Final.State != FinalState_Passed || !strings.HasSuffix(g.Final.OutDir, "/2") {
		t.Fatalf("the round a fix round set up runs as that round, got %+v", g.Final)
	}
}

func TestCancelStopsARunningFinalCommand(t *testing.T) {
	f := finalFixture(t, verifyCmd, "", "sleep 30")
	await := awaitFinal(t)
	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for f.dag(t).Final.State != FinalState_Final {
		if time.Now().After(deadline) {
			t.Fatal("the Final command did not start")
		}
		time.Sleep(20 * time.Millisecond)
	}

	if err := Cancel(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	await() // returns well before the sleep only if cancel stopped the command

	g := f.dag(t)
	if g.Status != DagStatus_Cancelled || g.Final.State != FinalState_Final {
		t.Fatalf("a cancelled dag records no final result, got %s / %s", g.Status, g.Final.State)
	}
}

func TestFinalTree(t *testing.T) {
	ctx := context.Background()
	t.Run("a checkout-landed dag gets a detached tree at HEAD, prepared by Setup and removed by cleanup", func(t *testing.T) {
		repo := newGitRepo(t)
		owner := &waveobj.Run{ID: "run-f", ProjectPath: repo}
		g := &waveobj.TaskGroup{OID: "dag-f", Setup: "echo prepared > setup.txt"}
		tree, cleanup, err := finalTree(ctx, g, owner)
		if err != nil {
			t.Fatal(err)
		}
		if tree == repo || gitCmd(t, tree, "rev-parse", "--abbrev-ref", "HEAD") != "HEAD" {
			t.Fatalf("want a detached tree of its own, got %s", tree)
		}
		if gitCmd(t, tree, "rev-parse", "HEAD") != gitCmd(t, repo, "rev-parse", "HEAD") {
			t.Fatal("the tree is at the checkout's HEAD")
		}
		if _, err := os.Stat(filepath.Join(tree, "setup.txt")); err != nil {
			t.Fatalf("Setup ran in the tree: %v", err)
		}
		cleanup()
		if _, err := os.Stat(tree); !os.IsNotExist(err) {
			t.Fatalf("cleanup removes the tree, stat err %v", err)
		}
		if strings.Contains(gitCmd(t, repo, "worktree", "list"), filepath.Base(tree)) {
			t.Fatal("cleanup unregisters the tree")
		}
	})
	t.Run("a branch-landed dag runs in its landing tree", func(t *testing.T) {
		repo := newGitRepo(t)
		wt, err := CreateRunWorktree(ctx, repo, "run-b", "")
		if err != nil {
			t.Fatal(err)
		}
		owner := &waveobj.Run{ID: "run-b", ProjectPath: repo, LandPath: wt}
		tree, cleanup, err := finalTree(ctx, &waveobj.TaskGroup{OID: "dag-b"}, owner)
		if err != nil || tree != wt {
			t.Fatalf("want the landing tree %s, got %s (%v)", wt, tree, err)
		}
		cleanup()
		if _, err := os.Stat(wt); err != nil {
			t.Fatalf("cleanup leaves the landing tree: %v", err)
		}
	})
	t.Run("a dag outside git has no tree", func(t *testing.T) {
		owner := &waveobj.Run{ID: "run-n", ProjectPath: t.TempDir()}
		if _, _, err := finalTree(ctx, &waveobj.TaskGroup{OID: "dag-n"}, owner); err == nil || !strings.Contains(err.Error(), "not a git repository") {
			t.Fatalf("want not a git repository, got %v", err)
		}
	})
}

func TestFinalCommandGetsAFreshOutDir(t *testing.T) {
	out := filepath.ToSlash(filepath.Join(t.TempDir(), "arc-final", "1"))
	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(out, "stale.png")
	if err := os.WriteFile(stale, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}

	exit, tail, err := runFinalCommand(context.Background(), t.TempDir(), `test -d "$ARC_FINAL_OUT" && echo "$ARC_FINAL_OUT"`, out, time.Minute)

	if err != nil || exit != 0 || tail != out {
		t.Fatalf("ARC_FINAL_OUT is set to an existing directory, got exit %d tail %q err %v", exit, tail, err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("an earlier attempt's output is cleared, stat err %v", err)
	}
}

func TestRunFinishedWakeStatesTheOutcome(t *testing.T) {
	long := strings.Repeat("the board's filter row is missing its count ", 40)
	w := RunFinishedWake(&waveobj.FinalStage{State: FinalState_Unverified, Unverified: []string{"no dev app: cargo missing", long}})
	lines := strings.Split(w, "\n")
	if lines[0] != runFinishedWake {
		t.Fatalf("the first line stays the finished line, got %q", lines[0])
	}
	for _, want := range []string{"- no dev app: cargo missing", "- " + long} {
		if !strings.Contains(w, want) {
			t.Fatalf("every reason is listed whole; missing %q in %q", want, w)
		}
	}
	if RunFinishedWake(nil) != runFinishedWake {
		t.Fatal("a dag with no final stage gets the plain finished line")
	}
}

func TestAFinishedRunWithNoLeadLaunchesNoneUnlessTheFinalStageFailed(t *testing.T) {
	f := newFakeLead(t)
	f.state = leadState{NoLead: true}
	launched := stubLaunch(t)
	ctx := context.Background()

	PostWake(ctx, wakeChannel, wakeRun, RunFinishedWake(&waveobj.FinalStage{State: FinalState_Passed}))
	PostWake(ctx, wakeChannel, wakeRun, RunFinishedWake(&waveobj.FinalStage{State: FinalState_Unverified, Unverified: []string{"no dev app"}}))
	if len(*launched) != 0 {
		t.Fatalf("a passed or unverified finish launches no lead, got %q", *launched)
	}

	PostWake(ctx, wakeChannel, wakeRun, finalFailedWake(1, "Check failed", false))
	if len(*launched) != 1 || !strings.Contains((*launched)[0], "the final stage failed") {
		t.Fatalf("a failed final stage launches the lead, got %q", *launched)
	}
}

func TestFinalFailedWakeAfterTheLastRoundGoesToTheHuman(t *testing.T) {
	w := finalFailedWake(MaxFinalRounds, "Final failed (exit 1):\nFAIL board", true)
	if !strings.Contains(w, "the last") || !strings.Contains(w, "Put it to the human") || strings.Contains(w, "--round") {
		t.Fatalf("after the last round the lead forwards, got %q", w)
	}
	if !strings.HasSuffix(w, "Final failed (exit 1):\nFAIL board") {
		t.Fatalf("the detail is carried whole, got %q", w)
	}
}
