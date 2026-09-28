// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// two reviewed lanes land in one claim and share one Verify, scoped to both squash commits
func TestReadyLanesMergeAsOneBatchWithOneVerify(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "a"}, {ID: "t-1", Label: "b"}})
	f.setPlanCommands(t, verifyCmd, "")
	effort := f.effortFor(t, "#1 a's", "#2 b's")
	f.taskChunks(t, "t-0", "#1 a's")
	f.taskChunks(t, "t-1", "#2 b's")
	f.land(t)
	for _, id := range []string{"t-0", "t-1"} {
		f.finish(t, id)
		f.laneCommit(t, id, id+".txt")
	}
	calls := stubPlanCommand(t, func(context.Context, string, string) error { return nil })
	await := awaitVerify(t)

	AutoMergeReady(f.ctx, f.dagID)
	await()

	g := f.dag(t)
	for _, task := range g.Tasks {
		if task.State != TaskState_Done || !task.Merged {
			t.Fatalf("%s: want merged and done, got %s merged=%v", task.ID, task.State, task.Merged)
		}
	}
	for _, label := range []string{"#1 a's", "#2 b's"} {
		if c := chunkOf(t, f.ctx, effort, label); c.Status != "done" {
			t.Fatalf("a passing batch closes every lane's chunks: %q is %q", label, c.Status)
		}
	}
	got := calls.list()
	if len(got) != 1 {
		t.Fatalf("want one Verify for the batch, got %d", len(got))
	}
	lines := strings.Fields(readFile(t, envValue(got[0].env, verifyChangedEnv)))
	slices.Sort(lines)
	if !reflect.DeepEqual(lines, []string{"t-0.txt", "t-1.txt"}) {
		t.Fatalf("the Verify is scoped to both lanes, got %q", lines)
	}
}

// merges that cannot be read in git (stubbed shas) still get one Verify; a failure blames the oldest and holds the rest
func TestAFailedBatchBlamesTheOldestAndHoldsTheRest(t *testing.T) {
	lead := newFakeLead(t)
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "a"}, {ID: "t-1", Label: "b"}})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	f.finish(t, "t-1")
	stubMerge(t, func(_ context.Context, _, _, title string) (string, error) { return "sha-" + title, nil })
	calls := stubPlanCommand(t, func(context.Context, string, string) error {
		return &planCommandError{exitCode: 1, output: "--- FAIL: TestX"}
	})
	await := awaitVerify(t)

	AutoMergeReady(f.ctx, f.dagID)
	await()

	g := f.dag(t)
	if g.Tasks[0].State != TaskState_VerifyFailed {
		t.Fatalf("the oldest lane is blamed, got %s", g.Tasks[0].State)
	}
	if g.Tasks[1].State != TaskState_Verifying || g.Tasks[1].VerifyOutput != heldLine("t-0") {
		t.Fatalf("the later lane is held, got %s %q", g.Tasks[1].State, g.Tasks[1].VerifyOutput)
	}
	if n := len(calls.list()); n != 1 {
		t.Fatalf("unordered merges are not bisected, want 1 Verify, got %d", n)
	}
	if len(lead.sends) != 1 || !strings.Contains(lead.sends[0], "Verify failed after merging task t-0") {
		t.Fatalf("one wake for the blamed lane, got %q", lead.sends)
	}
	// the tick holds while a Verify failed: nothing resumes the held lane
	AutoMergeReady(f.ctx, f.dagID)
	if n := len(calls.list()); n != 1 {
		t.Fatalf("a held lane waits for --continue, got %d Verify runs", n)
	}
}

// --continue on the blamed lane runs one Verify that also judges the held lanes
func TestContinueVerifiesTheFailedLaneWithTheHeldOnes(t *testing.T) {
	newFakeLead(t)
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "a"}, {ID: "t-1", Label: "b"}})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	f.finish(t, "t-1")
	stubMerge(t, func(_ context.Context, _, _, title string) (string, error) { return "sha-" + title, nil })
	failed := false
	calls := stubPlanCommand(t, func(context.Context, string, string) error {
		if !failed {
			failed = true
			return &planCommandError{exitCode: 1, output: "--- FAIL: TestX"}
		}
		return nil
	})
	await := awaitVerify(t)
	AutoMergeReady(f.ctx, f.dagID)
	await()
	if got := f.dag(t).Tasks[0].State; got != TaskState_VerifyFailed {
		t.Fatalf("setup: t-0 must be verify-failed, got %s", got)
	}

	if err := ContinueMerge(f.ctx, f.channel, f.ownerID, "t-0"); err != nil {
		t.Fatal(err)
	}
	await()

	g := f.dag(t)
	for _, task := range g.Tasks {
		if task.State != TaskState_Done {
			t.Fatalf("the continue's Verify passes the failed lane and the held one, %s is %s", task.ID, task.State)
		}
	}
	if n := len(calls.list()); n != 2 {
		t.Fatalf("want the batch's Verify and the continue's, got %d", n)
	}
}

// a conflict mid-batch leaves the tree mid-merge: the lanes before it wait, unverified, for --continue
func TestAConflictMidBatchDefersTheBatchVerifyToTheContinue(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "a"}, {ID: "t-1", Label: "b"}})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	f.finish(t, "t-1")
	conflictKey := LaneWorktreeKey(f.dag(t), "t-1")
	stubMerge(t, func(_ context.Context, _, runID, _ string) (string, error) {
		if runID == conflictKey {
			return "", ErrMergeConflict
		}
		return "sha-a", nil
	})
	orig := continueMerge
	continueMerge = func(context.Context, string, string, MergeLane, []string) (string, error) { return "sha-b", nil }
	restoreAfterStages(t, func() { continueMerge = orig })
	calls := stubPlanCommand(t, func(context.Context, string, string) error { return nil })
	await := awaitVerify(t)
	finalDone := awaitFinal(t)

	AutoMergeReady(f.ctx, f.dagID)
	g := f.dag(t)
	if g.Tasks[0].State != TaskState_Verifying || !g.Tasks[0].Merged || g.Tasks[1].State != TaskState_BlockedMerge {
		t.Fatalf("want t-0 merged and verifying, t-1 blocked-merge, got %s merged=%v / %s", g.Tasks[0].State, g.Tasks[0].Merged, g.Tasks[1].State)
	}
	if n := len(calls.list()); n != 0 {
		t.Fatalf("no Verify runs over a tree mid-merge, got %d", n)
	}
	AutoMergeReady(f.ctx, f.dagID)
	if n := len(calls.list()); n != 0 {
		t.Fatalf("the conflict holds t-0's Verify until --continue, got %d", n)
	}

	if err := ContinueMerge(f.ctx, f.channel, f.ownerID, "t-1"); err != nil {
		t.Fatal(err)
	}
	await()
	finalDone() // every task lands here, so the tick starts the final stage, which must not outlive this test's stubs

	finalTree := worktreeDir(f.projectPath(t), f.ownerID+"-final")
	if n := len(calls.list()) - len(calls.in(finalTree)); n != 1 {
		t.Fatalf("the continue's Verify judges both lanes, want 1 run, got %d", n)
	}
	for _, task := range f.dag(t).Tasks {
		if task.State != TaskState_Done || !task.Merged {
			t.Fatalf("%s: want merged and done, got %s merged=%v", task.ID, task.State, task.Merged)
		}
	}
}

// a lane whose dependency merged earlier in the same batch is skipped, and the rest of the batch still lands
func TestALaneWaitingOnABatchMateIsSkippedNotTheBatch(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{
		{ID: "t-0", Label: "first"},
		// two dependents make t-0, t-1 and t-2 lanes of their own
		{ID: "t-1", Label: "second", Deps: []string{"t-0"}},
		{ID: "t-2", Label: "third", Deps: []string{"t-0"}},
		{ID: "t-3", Label: "fourth"},
	})
	f.setPlanCommands(t, verifyCmd, "")
	// t-1 is finished by hand while t-0 is unmerged: that is the lane a batch mate's Verify holds
	for _, id := range []string{"t-0", "t-1", "t-3"} {
		f.finish(t, id)
	}
	stubMerge(t, func(_ context.Context, _, _, title string) (string, error) { return "sha-" + title, nil })
	verify, calls := stubBlockingVerify(t)
	var spawned []string
	stubSpawn(t, &spawned)
	await := awaitVerify(t)

	AutoMergeReady(f.ctx, f.dagID)
	verify.waitStarted(t)

	g := f.dag(t)
	for _, id := range []string{"t-0", "t-3"} {
		if task := taskByID(g, id); task.State != TaskState_Verifying || !task.Merged {
			t.Fatalf("%s: want merged and verifying, got %s merged=%v", id, task.State, task.Merged)
		}
	}
	if task := taskByID(g, "t-1"); task.Merged || task.State != TaskState_Done || task.MergeError != "" {
		t.Fatalf("t-1 is skipped, not failed: got %s merged=%v error %q", task.State, task.Merged, task.MergeError)
	}
	if n := len(calls.list()); n != 1 {
		t.Fatalf("want one Verify for t-0 and t-3, got %d", n)
	}
	verify.open()
	await() // the batch's Verify; its tick lands t-1
	await() // t-1's Verify
	if task := taskByID(f.dag(t), "t-1"); task.State != TaskState_Done || !task.Merged {
		t.Fatalf("t-1 lands once t-0 passed, got %s merged=%v", task.State, task.Merged)
	}
}

// a lost claim resumes the whole batch's Verify, not one lane's
func TestResumeReverifiesTheWholeBatch(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "a"}, {ID: "t-1", Label: "b"}})
	f.setPlanCommands(t, verifyCmd, "")
	for i, id := range []string{"t-0", "t-1"} {
		child := f.finish(t, id)
		if err := wstore.UpdateRun(f.ctx, f.channel, child, func(r *waveobj.Run) error {
			r.EndCommit = "sha-" + id
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		// what a restart leaves: merged and persisted verifying, with no Verify running
		started := time.Now().UnixMilli() + int64(i)
		if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
			task := taskByID(cur, id)
			task.State, task.Merged, task.VerifyStartedTs = TaskState_Verifying, true, started
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	calls := stubPlanCommand(t, func(context.Context, string, string) error { return nil })
	await := awaitVerify(t)

	AutoMergeReady(f.ctx, f.dagID)
	await()

	if n := len(calls.list()); n != 1 {
		t.Fatalf("one Verify resumes the batch, got %d", n)
	}
	for _, task := range f.dag(t).Tasks {
		if task.State != TaskState_Done {
			t.Fatalf("the resumed Verify passes every tip, %s is %s", task.ID, task.State)
		}
	}
}
