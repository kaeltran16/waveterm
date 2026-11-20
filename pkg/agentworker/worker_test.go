// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentworker

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/memgate"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// seedWorker stores a tab and its block with the given meta, returning their ids.
func seedWorker(t *testing.T, tabMeta, blockMeta waveobj.MetaMapType) (tabId, blockId string) {
	t.Helper()
	ctx := context.Background()
	tab := &waveobj.Tab{OID: uuid.NewString(), Meta: tabMeta}
	block := &waveobj.Block{OID: uuid.NewString(), ParentORef: waveobj.MakeORef(waveobj.OType_Tab, tab.OID).String(), Meta: blockMeta}
	tab.BlockIds = []string{block.OID}
	if err := wstore.DBInsert(ctx, block); err != nil {
		t.Fatal(err)
	}
	if err := wstore.DBInsert(ctx, tab); err != nil {
		t.Fatal(err)
	}
	return tab.OID, block.OID
}

// isolateGate gives the test an empty book, no learned peaks and a free-memory reading it sets through the returned
// function; it starts unlimited.
func isolateGate(t *testing.T) (setFree func(uint64)) {
	t.Helper()
	t.Cleanup(memgate.SetStoreDirForTest(t.TempDir()))
	free := ^uint64(0)
	t.Cleanup(memgate.SetFreeForTest(func() (uint64, error) { return free, nil }))
	if n := memgate.LiveClaimsForTest(); n != 0 {
		t.Fatalf("the gate's book holds %d claims before the test", n)
	}
	return func(v uint64) { free = v }
}

func TestAdmitRefusalNamesFreeNeedAndEachHolder(t *testing.T) {
	setFree := isolateGate(t)
	runWorker, ok := memgate.TryAdmit(memgate.Request{Tag: memgate.Tag{RunId: "run-1", TaskId: "t-3", Role: memgate.RoleWorker}})
	if !ok {
		t.Fatal("an empty book must admit")
	}
	t.Cleanup(runWorker.Release)
	agentWorker, err := Admit(t.TempDir(), "tab-held")
	if err != nil {
		t.Fatalf("Admit with room: %v", err)
	}
	t.Cleanup(agentWorker.Release)
	// the two claims are still starting, so they owe 1 + 3.5 GB of the 6 GB free
	setFree(6 << 30)
	before := memgate.LiveClaimsForTest()

	claim, err := Admit(t.TempDir(), "tab-new")
	if err == nil {
		claim.Release()
		t.Fatal("want a refusal: a worker needs 3.5 GB and 1.5 GB is free")
	}
	if claim != nil {
		t.Error("a refusal returned a claim")
	}
	for _, want := range []string{"memory is short", "1.5 GB free", "3.5 GB", "run run-1 task t-3", "worker tab-held"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("refusal %q does not name %q", err, want)
		}
	}
	if after := memgate.LiveClaimsForTest(); after != before {
		t.Errorf("the refusal left a claim: book went from %d to %d", before, after)
	}
}

func TestBoundClaimCacheExpiryIsTranscriptWriteTimePlusFiveMinutes(t *testing.T) {
	transcript := filepath.Join(t.TempDir(), "session.jsonl")
	_, blockId := seedWorker(t, waveobj.MetaMapType{}, waveobj.MetaMapType{waveobj.MetaKey_AgentTranscriptPath: transcript})

	if _, ok := blockCacheExpiry(blockId); ok {
		t.Fatal("no transcript written yet: want the expiry unknown")
	}
	if err := os.WriteFile(transcript, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	wrote := time.Now().Add(-90 * time.Second).Truncate(time.Second)
	if err := os.Chtimes(transcript, wrote, wrote); err != nil {
		t.Fatal(err)
	}
	got, ok := blockCacheExpiry(blockId)
	if !ok || !got.Equal(wrote.Add(5*time.Minute)) {
		t.Fatalf("expiry = %v, %v; want %v, true", got, ok, wrote.Add(5*time.Minute))
	}

	_, noPathBlock := seedWorker(t, waveobj.MetaMapType{}, waveobj.MetaMapType{})
	if _, ok := blockCacheExpiry(noPathBlock); ok {
		t.Error("a block that reported no transcript: want the expiry unknown")
	}
}

func TestBindGivesTheClaimACacheExpiry(t *testing.T) {
	isolateGate(t)
	claim, err := Admit(t.TempDir(), "tab-1")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(claim.Release)
	if memgate.HasCacheExpiryForTest(claim) {
		t.Fatal("a fresh claim has no cache expiry")
	}
	Bind(claim, uuid.NewString())
	if !memgate.HasCacheExpiryForTest(claim) {
		t.Error("a bound claim learns its cache expiry, so the loop can end a pause before it")
	}
}

func TestPublishStatusReadsHarnessCwdAndTranscriptFromMeta(t *testing.T) {
	_, blockId := seedWorker(t,
		waveobj.MetaMapType{"session:agent": "pi"},
		waveobj.MetaMapType{waveobj.MetaKey_CmdCwd: "/work/proj", waveobj.MetaKey_AgentTranscriptPath: "/t/s.jsonl"})

	if err := PublishStatus(context.Background(), blockId, baseds.AgentState_Idle); err != nil {
		t.Fatalf("PublishStatus: %v", err)
	}
	oref := waveobj.MakeORef(waveobj.OType_Block, blockId).String()
	events := wps.Broker.ReadEventHistory(wps.Event_AgentStatus, oref, 1)
	if len(events) != 1 {
		t.Fatalf("want one retained agent:status for the block, got %d", len(events))
	}
	got, ok := events[0].Data.(baseds.AgentStatusData)
	if !ok {
		t.Fatalf("event data is %T, want baseds.AgentStatusData", events[0].Data)
	}
	if got.State != baseds.AgentState_Idle || got.Agent != "pi" || got.Cwd != "/work/proj" || got.TranscriptPath != "/t/s.jsonl" || got.ORef != oref || got.Ts == 0 {
		t.Errorf("published %+v, want idle pi at /work/proj with the transcript and a timestamp", got)
	}
}

func TestParentOfAndNoticeOwedRoundTripThroughMeta(t *testing.T) {
	ctx := context.Background()
	tabId, blockId := seedWorker(t, waveobj.MetaMapType{MetaParentTab: "parent-tab"}, waveobj.MetaMapType{})
	plainTab, plainBlock := seedWorker(t, waveobj.MetaMapType{}, waveobj.MetaMapType{})

	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		t.Fatal(err)
	}
	if got := ParentOf(tab); got != "parent-tab" {
		t.Errorf("ParentOf a worker's tab = %q, want parent-tab", got)
	}
	plain, err := wstore.DBMustGet[*waveobj.Tab](ctx, plainTab)
	if err != nil {
		t.Fatal(err)
	}
	if got := ParentOf(plain); got != "" {
		t.Errorf("ParentOf a tab that is not a worker = %q, want empty", got)
	}

	owed := func(id string) bool {
		t.Helper()
		b, err := wstore.DBMustGet[*waveobj.Block](ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		return b.Meta.GetBool(MetaNoticeOwed, false)
	}
	if err := SetNoticeOwed(ctx, blockId, true); err != nil {
		t.Fatal(err)
	}
	if !owed(blockId) || owed(plainBlock) {
		t.Error("SetNoticeOwed(true) must mark only its block")
	}
	if err := SetNoticeOwed(ctx, blockId, false); err != nil {
		t.Fatal(err)
	}
	if owed(blockId) {
		t.Error("SetNoticeOwed(false) must clear the mark")
	}
}
