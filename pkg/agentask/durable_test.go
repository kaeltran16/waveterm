// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentask

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/jobcontroller"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// TestMain points the wave data dir at a throwaway temp dir and initializes the wstore DB, because
// ask durability is only testable against a real store: the restore decision reads a Block's JobId and
// that Job's manager status, and stubbing those out would test the stub rather than the rule.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "agentask-test-*")
	if err != nil {
		panic(err)
	}
	wavebase.DataHome_VarCache = dir
	if err := wavebase.EnsureWaveDBDir(); err != nil {
		panic(err)
	}
	if err := wstore.InitWStore(); err != nil {
		panic(err)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

func question(q string) baseds.AgentAskQuestion {
	return baseds.AgentAskQuestion{Question: q, Options: []baseds.AgentAskOption{{Label: "yes"}}}
}

// blockWithJob inserts a block and, when status is non-empty, a job manager in that state. An empty
// status means an in-process shell: a block with no JobId at all.
func blockWithJob(t *testing.T, status string) (blockId string, oref string) {
	t.Helper()
	ctx := context.Background()
	blockId = uuid.NewString()
	block := &waveobj.Block{OID: blockId, Meta: waveobj.MetaMapType{}}
	if status != "" {
		jobId := uuid.NewString()
		job := &waveobj.Job{OID: jobId, JobManagerStatus: status, AttachedBlockId: blockId, Meta: waveobj.MetaMapType{}}
		if err := wstore.DBInsert(ctx, job); err != nil {
			t.Fatalf("insert job: %v", err)
		}
		block.JobId = jobId
	}
	if err := wstore.DBInsert(ctx, block); err != nil {
		t.Fatalf("insert block: %v", err)
	}
	oref = waveobj.MakeORef(waveobj.OType_Block, blockId).String()
	t.Cleanup(func() {
		_ = wstore.DeletePendingAsk(ctx, oref)
		withoutDurableHook(func() { GlobalRegistry.Drop(oref) })
	})
	return blockId, oref
}

// withoutDurableHook runs f with the write-through disabled, which is how a test empties the in-memory
// registry without touching the stored rows — precisely what a wavesrv restart does to it.
func withoutDurableHook(f func()) {
	saved := DurableHook
	DurableHook = nil
	f()
	DurableHook = saved
}

func storedAsk(t *testing.T, oref string) (wstore.PendingAskRow, bool) {
	t.Helper()
	rows, err := wstore.GetPendingAsks(context.Background())
	if err != nil {
		t.Fatalf("get pending asks: %v", err)
	}
	for _, r := range rows {
		if r.ORef == oref {
			return r, true
		}
	}
	return wstore.PendingAskRow{}, false
}

// raise puts an ask in the registry the way AskCommand does, with the write-through live.
func raise(t *testing.T, oref, blockId string, p PendingAsk) {
	t.Helper()
	if err := InitDurablePendingAsks(context.Background()); err != nil {
		t.Fatalf("init durable: %v", err)
	}
	p.BlockId = blockId
	GlobalRegistry.Set(oref, p)
}

func TestSetMirrorsThePendingAskThroughTheHook(t *testing.T) {
	var gotORef string
	var got *PendingAsk
	saved := DurableHook
	DurableHook = func(oref string, pending *PendingAsk) { gotORef, got = oref, pending }
	t.Cleanup(func() { DurableHook = saved; withoutDurableHook(func() { GlobalRegistry.Drop("block:hook-set") }) })

	GlobalRegistry.Set("block:hook-set", PendingAsk{AskId: "a-1", BlockId: "b-1", Questions: []baseds.AgentAskQuestion{question("Go?")}})
	if gotORef != "block:hook-set" || got == nil {
		t.Fatalf("hook not called with the oref and pending ask: %q %v", gotORef, got)
	}
	if got.AskId != "a-1" || len(got.Questions) != 1 {
		t.Fatalf("hook received an incomplete ask: %+v", got)
	}
}

// nil is the forget signal, and Drop sends it even with nothing pending: a repeat clear, or the first
// clear after a restart that declined to restore the ask, still has to remove the stored row.
func TestDropForgetsThroughTheHookEvenWithNothingPending(t *testing.T) {
	calls := 0
	var got *PendingAsk = &PendingAsk{}
	saved := DurableHook
	DurableHook = func(oref string, pending *PendingAsk) { calls++; got = pending }
	t.Cleanup(func() { DurableHook = saved })

	GlobalRegistry.Drop("block:hook-never-pending")
	if calls != 1 || got != nil {
		t.Fatalf("want one forget call with nil, got %d calls, pending=%v", calls, got)
	}
}

func TestClaimForgetsThroughTheHookOnlyWhenItClaims(t *testing.T) {
	calls := 0
	saved := DurableHook
	DurableHook = func(oref string, pending *PendingAsk) {
		if pending == nil {
			calls++
		}
	}
	t.Cleanup(func() { DurableHook = saved; withoutDurableHook(func() { GlobalRegistry.Drop("block:hook-claim") }) })

	GlobalRegistry.Set("block:hook-claim", PendingAsk{AskId: "a-1"})
	if _, ok := GlobalRegistry.Claim("block:hook-claim", "a-stale"); ok {
		t.Fatalf("a stale askid must not claim")
	}
	if calls != 0 {
		t.Fatalf("a refused claim forgot the stored row (%d calls)", calls)
	}
	if _, ok := GlobalRegistry.Claim("block:hook-claim", "a-1"); !ok {
		t.Fatalf("claim failed")
	}
	if calls != 1 {
		t.Fatalf("want one forget after a real claim, got %d", calls)
	}
}

func TestRestartRestoresAJobBackedAsk(t *testing.T) {
	blockId, oref := blockWithJob(t, jobcontroller.JobManagerStatus_Running)
	raise(t, oref, blockId, PendingAsk{AskId: "a-1", Ts: 4242, Prose: true, Questions: []baseds.AgentAskQuestion{question("Deploy?")}})
	if _, ok := storedAsk(t, oref); !ok {
		t.Fatalf("raising the ask did not store it")
	}
	withoutDurableHook(func() { GlobalRegistry.Drop(oref) })

	if err := InitDurablePendingAsks(context.Background()); err != nil {
		t.Fatalf("init durable: %v", err)
	}
	got, ok := GlobalRegistry.Get(oref)
	if !ok {
		t.Fatalf("ask was not restored")
	}
	if got.AskId != "a-1" || got.BlockId != blockId || got.Ts != 4242 || !got.Prose {
		t.Fatalf("restored ask lost fields: %+v", got)
	}
	if len(got.Questions) != 1 || got.Questions[0].Question != "Deploy?" {
		t.Fatalf("restored ask lost its questions: %+v", got.Questions)
	}
	// a restored ask must never claim to have a --wait caller: the channel it would resolve is gone
	if got.Wait {
		t.Fatalf("restored ask claims a waiter")
	}
}

// the job that was holding the question ended while wavesrv was down. Nothing will ever send a clear
// for it — the daemon that would have is the thing that died — so the restore is what has to drop it.
func TestRestartDropsAnAskWhoseJobHasStopped(t *testing.T) {
	blockId, oref := blockWithJob(t, jobcontroller.JobManagerStatus_Running)
	raise(t, oref, blockId, PendingAsk{AskId: "a-1", Questions: []baseds.AgentAskQuestion{question("Deploy?")}})
	withoutDurableHook(func() { GlobalRegistry.Drop(oref) })
	block, err := wstore.DBGet[*waveobj.Block](context.Background(), blockId)
	if err != nil {
		t.Fatalf("get block: %v", err)
	}
	if err := wstore.DBUpdateFn(context.Background(), block.JobId, func(j *waveobj.Job) {
		j.JobManagerStatus = jobcontroller.JobManagerStatus_Done
	}); err != nil {
		t.Fatalf("update job: %v", err)
	}

	if err := InitDurablePendingAsks(context.Background()); err != nil {
		t.Fatalf("init durable: %v", err)
	}
	if _, ok := GlobalRegistry.Get(oref); ok {
		t.Fatalf("ask for a stopped job was restored")
	}
	if _, ok := storedAsk(t, oref); ok {
		t.Fatalf("ask for a stopped job kept its stored row")
	}
}

// an in-process shell is a child of the wavesrv that spawned it, so a restart killed the agent. Its
// question cannot be answered by anyone and must not come back.
func TestRestartDropsAnAskFromAnInProcessShell(t *testing.T) {
	blockId, oref := blockWithJob(t, "")
	raise(t, oref, blockId, PendingAsk{AskId: "a-1", Questions: []baseds.AgentAskQuestion{question("Deploy?")}})
	withoutDurableHook(func() { GlobalRegistry.Drop(oref) })

	if err := InitDurablePendingAsks(context.Background()); err != nil {
		t.Fatalf("init durable: %v", err)
	}
	if _, ok := GlobalRegistry.Get(oref); ok {
		t.Fatalf("ask from an in-process shell was restored")
	}
	if _, ok := storedAsk(t, oref); ok {
		t.Fatalf("ask from an in-process shell kept its stored row")
	}
}

// the delivery for a --wait ask is an in-memory channel, so a stored copy could only be a question
// nobody is listening to.
func TestAWaitAskIsNeverStored(t *testing.T) {
	blockId, oref := blockWithJob(t, jobcontroller.JobManagerStatus_Running)
	raise(t, oref, blockId, PendingAsk{AskId: "a-1", Wait: true, Questions: []baseds.AgentAskQuestion{question("Deploy?")}})
	if _, ok := storedAsk(t, oref); ok {
		t.Fatalf("a --wait ask was stored")
	}
}

// oref is the primary key, so a --wait ask replacing a keystroke ask has to take the stored row with
// it; otherwise the old question outlives the ask it described.
func TestAWaitAskClearsAnEarlierStoredAsk(t *testing.T) {
	blockId, oref := blockWithJob(t, jobcontroller.JobManagerStatus_Running)
	raise(t, oref, blockId, PendingAsk{AskId: "a-1", Questions: []baseds.AgentAskQuestion{question("First?")}})
	if _, ok := storedAsk(t, oref); !ok {
		t.Fatalf("first ask was not stored")
	}
	GlobalRegistry.Set(oref, PendingAsk{AskId: "a-2", BlockId: blockId, Wait: true, Questions: []baseds.AgentAskQuestion{question("Second?")}})
	if _, ok := storedAsk(t, oref); ok {
		t.Fatalf("the superseded row survived a --wait ask")
	}
}

// the hook is installed before the restore runs, so an ask raised in that window is already in memory.
// Overwriting it with the stored one would type keystrokes for one picker into a different one.
func TestARestoredAskNeverOverwritesALiveOne(t *testing.T) {
	blockId, oref := blockWithJob(t, jobcontroller.JobManagerStatus_Running)
	raise(t, oref, blockId, PendingAsk{AskId: "a-stored", Questions: []baseds.AgentAskQuestion{question("Old?")}})
	withoutDurableHook(func() {
		GlobalRegistry.Set(oref, PendingAsk{AskId: "a-live", BlockId: blockId, Questions: []baseds.AgentAskQuestion{question("New?")}})
	})

	if err := InitDurablePendingAsks(context.Background()); err != nil {
		t.Fatalf("init durable: %v", err)
	}
	got, _ := GlobalRegistry.Get(oref)
	if got.AskId != "a-live" {
		t.Fatalf("the stored ask overwrote the live one: %+v", got)
	}
}

func TestRestoreDropsARowWithUnreadableQuestions(t *testing.T) {
	_, oref := blockWithJob(t, jobcontroller.JobManagerStatus_Running)
	if err := wstore.PutPendingAsk(context.Background(), wstore.PendingAskRow{
		ORef: oref, AskId: "a-1", BlockId: "b-1", Ts: 1, Questions: []byte("not json"),
	}); err != nil {
		t.Fatalf("put: %v", err)
	}

	if err := InitDurablePendingAsks(context.Background()); err != nil {
		t.Fatalf("init durable: %v", err)
	}
	if _, ok := GlobalRegistry.Get(oref); ok {
		t.Fatalf("an unreadable ask was restored")
	}
	if _, ok := storedAsk(t, oref); ok {
		t.Fatalf("an unreadable ask kept its stored row")
	}
}

func TestDurableAgentGoneOnlySpeaksForJobBackedBlocks(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name   string
		status string
		want   bool
	}{
		// a block with no job is not a claim that its shell is alive, only that the store cannot say
		{"in-process shell", "", false},
		{"running job", jobcontroller.JobManagerStatus_Running, false},
		{"finished job", jobcontroller.JobManagerStatus_Done, true},
		{"job that never started", jobcontroller.JobManagerStatus_Init, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			blockId, _ := blockWithJob(t, c.status)
			got, err := DurableAgentGone(ctx, blockId)
			if err != nil {
				t.Fatalf("durable agent gone: %v", err)
			}
			if got != c.want {
				t.Fatalf("want %v, got %v", c.want, got)
			}
		})
	}
}

func TestDurableAgentGoneIsFalseForAnUnknownBlock(t *testing.T) {
	got, err := DurableAgentGone(context.Background(), uuid.NewString())
	if err != nil {
		t.Fatalf("unknown block: %v", err)
	}
	if got {
		t.Fatalf("an unknown block reported a gone durable agent, which would double up with the attention list's own block-existence prune")
	}
}
