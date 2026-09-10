// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/jobcontroller"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

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
