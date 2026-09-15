// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const verifyCmd = "task test"

// awaitVerify returns a func that blocks until one more Verify run has recorded its result and ticked
// its dag.
func awaitVerify(t *testing.T) func() {
	t.Helper()
	done := make(chan struct{}, 16)
	orig := verifyFinished
	verifyFinished = func(string, string) { done <- struct{}{} }
	t.Cleanup(func() { verifyFinished = orig })
	return func() {
		t.Helper()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Fatal("verify did not finish")
		}
	}
}

// blockingVerify is a Verify that reports each start and passes only once released, or fails when its
// context is cancelled. A test that fails before releasing leaves it blocked, holding only its own
// temporary project.
type blockingVerify struct {
	started chan struct{}
	release chan struct{}
}

func stubBlockingVerify(t *testing.T) (*blockingVerify, *planCalls) {
	t.Helper()
	b := &blockingVerify{started: make(chan struct{}, 16), release: make(chan struct{})}
	calls := stubPlanCommand(t, func(ctx context.Context, _, _ string) error {
		b.started <- struct{}{}
		select {
		case <-b.release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	return b, calls
}

func (b *blockingVerify) open() { close(b.release) }

func (b *blockingVerify) waitStarted(t *testing.T) {
	t.Helper()
	select {
	case <-b.started:
	case <-time.After(10 * time.Second):
		t.Fatal("verify did not start")
	}
}

func (f *mergeFixture) projectPath(t *testing.T) string {
	t.Helper()
	owner, err := wstore.GetRun(f.ctx, f.channel, f.ownerID)
	if err != nil {
		t.Fatal(err)
	}
	return owner.ProjectPath
}

func landedSha(context.Context, string, string, string) (string, error) { return "sha-1", nil }

func TestVerifyPassAfterMergeUnblocksDependent(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{
		{ID: "t-0", Label: "first"},
		{ID: "t-1", Label: "second", Deps: []string{"t-0"}},
		// a second dependent makes t-0 a lane of its own, so it merges and verifies before either starts
		{ID: "t-2", Label: "third", Deps: []string{"t-0"}},
	})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	stubMerge(t, landedSha)
	verify, calls := stubBlockingVerify(t)
	var spawned []string
	stubSpawn(t, &spawned)
	await := awaitVerify(t)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	verify.waitStarted(t)
	g := f.dag(t)
	if g.Tasks[0].State != TaskState_Verifying || !g.Tasks[0].Merged {
		t.Fatalf("a merged task waits on Verify, got %s merged=%v", g.Tasks[0].State, g.Tasks[0].Merged)
	}
	if g.Tasks[1].State != TaskState_Pending || len(spawned) != 0 {
		t.Fatalf("the dependent waits for Verify to pass, got %s with %d spawns", g.Tasks[1].State, len(spawned))
	}
	verify.open()
	await()

	g = f.dag(t)
	if g.Tasks[0].State != TaskState_Done || g.Tasks[0].VerifyError != "" {
		t.Fatalf("a passing Verify leaves the task done, got %s %q", g.Tasks[0].State, g.Tasks[0].VerifyError)
	}
	if got := calls.list(); len(got) != 1 || got[0].dir != f.projectPath(t) || got[0].command != verifyCmd {
		t.Fatalf("want Verify once in the project checkout, got %+v", got)
	}
	if g.Tasks[1].State != TaskState_Running {
		t.Fatalf("the dependent dispatches once Verify passes, got %s", g.Tasks[1].State)
	}
}

func TestVerifyFailureBlocksTheDagAndWakesTheLead(t *testing.T) {
	lead := newFakeLead(t)
	f := newMergeFixture(t, []waveobj.TaskNode{
		{ID: "t-0", Label: "first"},
		{ID: "t-1", Label: "second", Deps: []string{"t-0"}},
		// a second dependent makes t-0 a lane of its own, so it merges and verifies before either starts
		{ID: "t-2", Label: "third", Deps: []string{"t-0"}},
	})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	stubMerge(t, landedSha)
	stubPlanCommand(t, func(context.Context, string, string) error {
		return &planCommandError{exitCode: 1, output: "FAIL pkg/orchestrate"}
	})
	var spawned []string
	stubSpawn(t, &spawned)
	await := awaitVerify(t)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	await()

	g := f.dag(t)
	if task := g.Tasks[0]; task.State != TaskState_VerifyFailed || task.VerifyError != "exit 1: FAIL pkg/orchestrate" {
		t.Fatalf("want verify-failed with the reason and output, got %s %q", task.State, task.VerifyError)
	}
	if g.Status != DagStatus_Blocked || g.Tasks[1].State != TaskState_Pending || len(spawned) != 0 {
		t.Fatalf("a failed Verify blocks the dag and its dependents, got %s / %s / %d spawns", g.Status, g.Tasks[1].State, len(spawned))
	}
	want := "wake: Verify failed after merging task t-0 (exit 1). wsh jarvis dag status"
	if len(lead.sends) != 1 || lead.sends[0] != want {
		t.Fatalf("want %q, got %q", want, lead.sends)
	}
}

func TestVerifyTimeoutIsAFailure(t *testing.T) {
	lead := newFakeLead(t)
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	stubMerge(t, landedSha)
	stubPlanCommand(t, func(context.Context, string, string) error {
		return &planCommandError{exitCode: -1, timeout: VerifyTimeout}
	})
	await := awaitVerify(t)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	await()

	if got := f.dag(t).Tasks[0].State; got != TaskState_VerifyFailed {
		t.Fatalf("a Verify past its timeout fails the task, got %s", got)
	}
	want := "wake: Verify failed after merging task t-0 (timed out after 20m). wsh jarvis dag status"
	if len(lead.sends) != 1 || lead.sends[0] != want {
		t.Fatalf("want %q, got %q", want, lead.sends)
	}
}

func TestNextMergeWaitsForRunningVerify(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}, {ID: "t-1", Label: "second"}})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	f.finish(t, "t-1")
	merges := stubMerge(t, landedSha)
	verify, _ := stubBlockingVerify(t)
	await := awaitVerify(t)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	verify.waitStarted(t)
	// a watchdog tick while t-0's Verify runs
	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	if *merges != 1 {
		t.Fatalf("a merge must wait for the running Verify, got %d merges", *merges)
	}
	verify.open()
	await() // t-0's Verify; its tick lands t-1
	await() // t-1's Verify

	g := f.dag(t)
	if *merges != 2 || g.Tasks[0].State != TaskState_Done || g.Tasks[1].State != TaskState_Done {
		t.Fatalf("both tasks land and verify in turn, got %d merges, %s, %s", *merges, g.Tasks[0].State, g.Tasks[1].State)
	}
}

func TestVerifyDoesNotHoldTheDagLock(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	stubMerge(t, landedSha)
	verify, _ := stubBlockingVerify(t)
	await := awaitVerify(t)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	verify.waitStarted(t)
	locked := make(chan struct{})
	go func() {
		_ = WithDagMutation(f.dagID, func() error { return nil })
		close(locked)
	}()
	select {
	case <-locked:
	case <-time.After(5 * time.Second):
		t.Fatal("a tick must get the dag lock while Verify runs")
	}
	verify.open()
	await()
}

func TestTickRestartsAVerifyTheServerLost(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	// what a restart leaves: merged and persisted verifying, with no Verify running
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		cur.Tasks[0].State, cur.Tasks[0].Merged = TaskState_Verifying, true
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	calls := stubPlanCommand(t, func(context.Context, string, string) error { return nil })
	await := awaitVerify(t)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	await()

	if n := len(calls.list()); n != 1 {
		t.Fatalf("the tick restarts the lost Verify once, got %d runs", n)
	}
	if got := f.dag(t).Tasks[0].State; got != TaskState_Done {
		t.Fatalf("the restarted Verify records its pass, got %s", got)
	}
}

func TestMergeWithoutVerifyLineIsDone(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	f.finish(t, "t-0")
	stubMerge(t, landedSha)
	calls := stubPlanCommand(t, func(context.Context, string, string) error { return nil })

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	task := f.dag(t).Tasks[0]
	if !task.Merged || task.State != TaskState_Done || len(calls.list()) != 0 {
		t.Fatalf("no Verify line: the merge is the end, got merged=%v %s with %d runs", task.Merged, task.State, len(calls.list()))
	}
}

func TestCancelStopsARunningVerify(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	stubMerge(t, landedSha)
	verify, _ := stubBlockingVerify(t)
	await := awaitVerify(t)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	verify.waitStarted(t)
	if err := Cancel(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	await() // returns only if cancel stopped the blocked Verify

	g := f.dag(t)
	if g.Status != DagStatus_Cancelled || g.Tasks[0].State != TaskState_Verifying {
		t.Fatalf("a cancelled dag records no Verify result, got %s / %s", g.Status, g.Tasks[0].State)
	}
}

func TestManualMergeRefusesWhileVerifyRuns(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}, {ID: "t-1", Label: "second"}})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	f.finish(t, "t-1")
	stubMerge(t, landedSha)
	verify, _ := stubBlockingVerify(t)
	await := awaitVerify(t)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	verify.waitStarted(t)
	err := MergeTask(f.ctx, f.channel, f.ownerID, "t-1")
	if !errors.Is(err, errProjectBusy) || !strings.Contains(err.Error(), "task t-0") {
		t.Fatalf("a merge while t-0's Verify runs must say who holds the checkout, got %v", err)
	}
	verify.open()
	await()
	await()
}
