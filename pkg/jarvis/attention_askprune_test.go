// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/jobcontroller"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// stubControllerStatus swaps controllerStatusFn for a fixed answer and restores it on cleanup.
func stubControllerStatus(t *testing.T, status *blockcontroller.BlockControllerRuntimeStatus) {
	t.Helper()
	orig := controllerStatusFn
	controllerStatusFn = func(string) *blockcontroller.BlockControllerRuntimeStatus { return status }
	t.Cleanup(func() { controllerStatusFn = orig })
}

// askBlock inserts a block and returns its oref. jobStatus "" means an in-process shell (no job);
// "absent" means no block is inserted at all, i.e. the terminal was closed.
func askBlock(t *testing.T, jobStatus string) string {
	t.Helper()
	ctx := context.Background()
	blockId := uuid.NewString()
	oref := waveobj.MakeORef(waveobj.OType_Block, blockId).String()
	if jobStatus == "absent" {
		return oref
	}
	block := &waveobj.Block{OID: blockId, Meta: waveobj.MetaMapType{}}
	if jobStatus != "" {
		jobId := uuid.NewString()
		if err := wstore.DBInsert(ctx, &waveobj.Job{
			OID: jobId, JobManagerStatus: jobStatus, AttachedBlockId: blockId, Meta: waveobj.MetaMapType{},
		}); err != nil {
			t.Fatalf("insert job: %v", err)
		}
		block.JobId = jobId
	}
	if err := wstore.DBInsert(ctx, block); err != nil {
		t.Fatalf("insert block: %v", err)
	}
	return oref
}

// pruneCase registers one pending ask against a freshly built block and reports whether the ask
// survived the poll's liveness check, both in the returned map and in the registry itself.
func pruneCase(t *testing.T, jobStatus string) (inList bool, inRegistry bool) {
	t.Helper()
	oref := askBlock(t, jobStatus)
	old := agentask.GlobalRegistry
	agentask.GlobalRegistry = agentask.MakeRegistry()
	defer func() { agentask.GlobalRegistry = old }()
	agentask.GlobalRegistry.Set(oref, agentask.PendingAsk{AskId: "a-1", BlockId: uuid.NewString(), Ts: 1})

	live, err := livePendingAsks(context.Background())
	if err != nil {
		t.Fatalf("livePendingAsks: %v", err)
	}
	_, inList = live[oref]
	_, inRegistry = agentask.GlobalRegistry.Get(oref)
	return inList, inRegistry
}

// a restored ask has no other retirement path — the daemon that would have sent a clear is the thing
// that died — so the poll is what has to notice the job ended.
func TestLivePendingAsksRetiresAnAskWhoseJobHasStopped(t *testing.T) {
	inList, inRegistry := pruneCase(t, jobcontroller.JobManagerStatus_Done)
	if inList {
		t.Fatalf("an ask for a stopped job stayed in the attention list")
	}
	if inRegistry {
		t.Fatalf("the ask was filtered out of one response but not retired")
	}
}

func TestLivePendingAsksKeepsAnAskWhoseJobIsRunning(t *testing.T) {
	inList, _ := pruneCase(t, jobcontroller.JobManagerStatus_Running)
	if !inList {
		t.Fatalf("an ask for a running job was pruned")
	}
}

// the local case, and the one the job check must not misfire on: an in-process shell's liveness is not
// in the store, so a block with no job says nothing about whether its agent is blocked.
func TestLivePendingAsksKeepsAnAskFromABlockWithNoJob(t *testing.T) {
	inList, _ := pruneCase(t, "")
	if !inList {
		t.Fatalf("an ask from an in-process shell was pruned")
	}
}

// pins the behaviour the job check was folded in beside, rather than replacing
func TestLivePendingAsksRetiresAnAskWhoseBlockIsGone(t *testing.T) {
	inList, inRegistry := pruneCase(t, "absent")
	if inList || inRegistry {
		t.Fatalf("an ask for a deleted block survived: list=%v registry=%v", inList, inRegistry)
	}
}

// a kept, non-job-backed block whose process ended has no clear coming — the agent that would send it
// is gone — so the poll has to notice the controller's own status, not just durability.
func TestLivePendingAsksRetiresAnAskFromALocalBlockWhoseProcessEnded(t *testing.T) {
	stubControllerStatus(t, &blockcontroller.BlockControllerRuntimeStatus{ShellProcStatus: blockcontroller.Status_Done})
	inList, inRegistry := pruneCase(t, "")
	if inList || inRegistry {
		t.Fatalf("an ask for a finished local block survived: list=%v registry=%v", inList, inRegistry)
	}
}

func TestLivePendingAsksKeepsAnAskFromALocalBlockWhoseProcessIsRunning(t *testing.T) {
	stubControllerStatus(t, &blockcontroller.BlockControllerRuntimeStatus{ShellProcStatus: blockcontroller.Status_Running})
	inList, _ := pruneCase(t, "")
	if !inList {
		t.Fatalf("an ask for a running local block was pruned")
	}
}

// before the frontend re-mounts a durable block's controller (e.g. right after boot), there is no
// controller to ask yet — that silence must not be misread as the process having ended.
func TestLivePendingAsksKeepsAnAskFromALocalBlockWithNoController(t *testing.T) {
	stubControllerStatus(t, nil)
	inList, _ := pruneCase(t, "")
	if !inList {
		t.Fatalf("an ask for a block with no controller yet was pruned")
	}
}
