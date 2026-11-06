// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/util/jobobject"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const lowerCallWait = 5 * time.Second

// newWorkerTabWithBlock stores a worker tab with one block, returning the tab's oref and the block id.
func newWorkerTabWithBlock(t *testing.T) (string, string) {
	t.Helper()
	tabID, blockID := uuid.NewString(), uuid.NewString()
	if err := wstore.DBInsert(context.Background(), &waveobj.Tab{OID: tabID, BlockIds: []string{blockID}, Meta: waveobj.MetaMapType{}}); err != nil {
		t.Fatal(err)
	}
	return waveobj.MakeORef(waveobj.OType_Tab, tabID).String(), blockID
}

// stubLowerPriority answers each call with the next of results (the last repeats) and reports the block ids asked.
func stubLowerPriority(t *testing.T, results ...error) <-chan string {
	t.Helper()
	calls := make(chan string, 16)
	n := 0
	old := lowerWorkerPriority
	lowerWorkerPriority = func(blockId string) error {
		calls <- blockId
		err := results[min(n, len(results)-1)]
		n++
		return err
	}
	restoreAfterStages(t, func() { lowerWorkerPriority = old })
	return calls
}

func wantLowered(t *testing.T, calls <-chan string, blockID string) {
	t.Helper()
	select {
	case got := <-calls:
		if got != blockID {
			t.Fatalf("lowered block %q, want the worker's block %q", got, blockID)
		}
	case <-time.After(lowerCallWait):
		t.Fatalf("block %s was never lowered", blockID)
	}
}

func TestDispatchLowersTheWorkersPriority(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
	}{{"lowered", nil}, {"lowering fails", errors.New("access denied")}} {
		t.Run(tc.name, func(t *testing.T) {
			allowWorkerHarnessForTest(t)
			ctx, g, _, _ := seedDispatchDag(t, "dispatch-lower-priority-"+uuid.NewString())
			worker, blockID := newWorkerTabWithBlock(t)
			stubSpawnWorker(t, worker, nil)
			calls := stubLowerPriority(t, tc.err)
			if err := ScheduleOnce(ctx, g); err != nil {
				t.Fatal(err)
			}
			wantLowered(t, calls, blockID)
			if g.Tasks[0].State != TaskState_Running {
				t.Fatalf("task state = %s, want running whether or not its priority was lowered", g.Tasks[0].State)
			}
		})
	}
}

// the shell starts on its own goroutine after startWorker returns, so its job may not be registered yet
func TestDispatchWaitsForTheWorkersJobToRegister(t *testing.T) {
	allowWorkerHarnessForTest(t)
	ctx, g, _, _ := seedDispatchDag(t, "dispatch-lower-priority-wait")
	worker, blockID := newWorkerTabWithBlock(t)
	stubSpawnWorker(t, worker, nil)
	calls := stubLowerPriority(t, jobobject.ErrNotMember, nil)
	if err := ScheduleOnce(ctx, g); err != nil {
		t.Fatal(err)
	}
	wantLowered(t, calls, blockID)
	wantLowered(t, calls, blockID)
}

func TestSpawnReviewerLowersTheReviewersPriority(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
	}{{"lowered", nil}, {"lowering fails", errors.New("access denied")}} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, dag, worker := seedReviewDag(t)
			stubReviewTree(t, worker.EndCommit)
			allowWorkerHarnessForTest(t)
			reviewer, blockID := newWorkerTabWithBlock(t)
			stubSpawnWorker(t, reviewer, nil)
			calls := stubLowerPriority(t, tc.err)
			schedule(t, ctx, dag.OID)
			wantLowered(t, calls, blockID)
			task := firstTask(t, ctx, dag.OID)
			if task.State != TaskState_Reviewing || task.ReviewRunID == "" {
				t.Fatalf("want reviewing with a reviewer whether or not its priority was lowered, got %s reviewer %q", task.State, task.ReviewRunID)
			}
		})
	}
}
