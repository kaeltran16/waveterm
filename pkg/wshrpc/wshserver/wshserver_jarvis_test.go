// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisrecall"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestJarvisConverseCreatesAndPersistsTurns(t *testing.T) {
	old := jarvisrecall.SetSynthesizeForTest(func(ctx context.Context, cwd, prompt string, onChunk func(string)) (string, error) {
		onChunk("grounded answer [1]")
		return "grounded answer [1]", nil
	})
	defer jarvisrecall.SetSynthesizeForTest(old)

	ctx := context.Background()
	convoID := "dddddddd-0000-0000-0000-000000000001"
	t.Cleanup(func() {
		if err := wstore.DBDelete(ctx, waveobj.OType_JarvisConversation, convoID); err != nil {
			t.Errorf("cleanup conversation: %v", err)
		}
	})
	ws := &WshServer{}
	data := wshrpc.CommandJarvisConverseData{
		ConversationId: convoID,
		Prompt:         "why?",
		ScopeMode:      "all",
		RequestId:      "r1",
	}
	for range ws.JarvisConverseCommand(ctx, data) {
	}
	convo, err := wstore.GetJarvisConversation(ctx, data.ConversationId)
	if err != nil {
		t.Fatalf("conversation not created/persisted: %v", err)
	}
	if len(convo.Turns) != 2 {
		t.Fatalf("want 2 persisted turns (user + jarvis), got %d: %+v", len(convo.Turns), convo.Turns)
	}
	if convo.Turns[0].Role != "user" || convo.Turns[0].Text != "why?" {
		t.Fatalf("user turn mismatch: %+v", convo.Turns[0])
	}
	if convo.Turns[1].Role != "jarvis" || convo.Turns[1].Terminal == "" {
		t.Fatalf("answer turn mismatch: %+v", convo.Turns[1])
	}
	if convo.Title != "why?" {
		t.Fatalf("title = %q, want first prompt", convo.Title)
	}
}

func TestJarvisConverseRejectsInvalidConversationID(t *testing.T) {
	ctx := context.Background()
	const convoID = "not-a-uuid"
	t.Cleanup(func() {
		_ = wstore.DBDelete(ctx, waveobj.OType_JarvisConversation, convoID)
	})
	var streamErr error
	for result := range (&WshServer{}).JarvisConverseCommand(ctx, wshrpc.CommandJarvisConverseData{
		ConversationId: convoID,
		Prompt:         "why?",
		ScopeMode:      "all",
	}) {
		if result.Error != nil {
			streamErr = result.Error
		}
	}
	if streamErr == nil {
		t.Fatal("expected invalid conversation id to be rejected")
	}
}

// newTestConvo creates a conversation with a deterministic UUID and removes it when the test ends.
func newTestConvo(t *testing.T, ctx context.Context, oid, title string, orefs []string) *waveobj.JarvisConvo {
	t.Helper()
	convo, err := wstore.CreateJarvisConversation(ctx, oid, title, "all", "", orefs)
	if err != nil {
		t.Fatalf("creating conversation: %v", err)
	}
	t.Cleanup(func() {
		// already-deleted is fine: the delete test removes it itself
		_ = wstore.DBDelete(ctx, waveobj.OType_JarvisConversation, oid)
	})
	return convo
}

func TestDeleteJarvisConversationCommandRemovesIt(t *testing.T) {
	ctx := context.Background()
	convo := newTestConvo(t, ctx, "dddddddd-0000-0000-0000-0000000000d1", "throwaway", nil)
	ws := &WshServer{}
	if err := ws.DeleteJarvisConversationCommand(ctx, wshrpc.CommandDeleteJarvisConversationData{ConversationId: convo.OID}); err != nil {
		t.Fatalf("deleting: %v", err)
	}
	if _, err := wstore.GetJarvisConversation(ctx, convo.OID); err == nil {
		t.Fatal("expected the conversation to be gone")
	}
}

func TestDeleteJarvisConversationCommandRequiresAnId(t *testing.T) {
	err := (&WshServer{}).DeleteJarvisConversationCommand(context.Background(), wshrpc.CommandDeleteJarvisConversationData{})
	if err == nil {
		t.Fatal("expected an error for an empty conversationid")
	}
}

func TestArchiveJarvisConversationCommandRoundTrips(t *testing.T) {
	ctx := context.Background()
	convo := newTestConvo(t, ctx, "dddddddd-0000-0000-0000-0000000000d2", "keep me", nil)
	ws := &WshServer{}
	data := wshrpc.CommandArchiveJarvisConversationData{ConversationId: convo.OID, Archived: true}
	if err := ws.ArchiveJarvisConversationCommand(ctx, data); err != nil {
		t.Fatalf("archiving: %v", err)
	}
	// the summary is the only shape the frontend sees, so a flag it does not carry is write-only
	summary := findSummary(t, ws, ctx, convo.OID)
	if !summary.Archived {
		t.Fatal("expected the summary to report archived")
	}
	data.Archived = false
	if err := ws.ArchiveJarvisConversationCommand(ctx, data); err != nil {
		t.Fatalf("unarchiving: %v", err)
	}
	if findSummary(t, ws, ctx, convo.OID).Archived {
		t.Fatal("expected unarchive to clear the flag")
	}
}

func TestListJarvisConversationsCarriesAttachedORefs(t *testing.T) {
	ctx := context.Background()
	orefs := []string{"run:dddddddd-0000-0000-0000-0000000000f1"}
	convo := newTestConvo(t, ctx, "dddddddd-0000-0000-0000-0000000000d3", "about a run", orefs)
	got := findSummary(t, &WshServer{}, ctx, convo.OID).AttachedORefs
	if len(got) != 1 || got[0] != orefs[0] {
		t.Fatalf("expected the summary to carry %v, got %v", orefs, got)
	}
}

func findSummary(t *testing.T, ws *WshServer, ctx context.Context, oid string) wshrpc.JarvisConversationSummary {
	t.Helper()
	rtn, err := ws.ListJarvisConversationsCommand(ctx)
	if err != nil {
		t.Fatalf("listing: %v", err)
	}
	for _, s := range rtn.Conversations {
		if s.Id == oid {
			return s
		}
	}
	t.Fatalf("conversation %s missing from the list", oid)
	return wshrpc.JarvisConversationSummary{}
}

func TestListDetachedEdgesRequiresAnId(t *testing.T) {
	ws := &WshServer{}
	if _, err := ws.ListDetachedEdgesCommand(context.Background(), wshrpc.CommandListDetachedEdgesData{}); err == nil {
		t.Fatal("an unfiltered detached-edge read must be rejected, not answered with every correction ever made")
	}
}

func TestDossierEdgeCommandsRequireBothIds(t *testing.T) {
	ws := &WshServer{}
	ctx := context.Background()
	if err := ws.DetachDossierEdgeCommand(ctx, wshrpc.CommandDossierEdgeData{RunORef: "run:r1"}); err == nil {
		t.Fatal("detach without a dossierid must be rejected")
	}
	if err := ws.AcceptDossierEdgeCommand(ctx, wshrpc.CommandDossierEdgeData{DossierId: "task-a"}); err == nil {
		t.Fatal("accept without a runoref must be rejected")
	}
}

func TestJarvisStateCommandReturnsFixtureRun(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	ch, err := wstore.CreateChannel(ctx, "rpc", "/p/one")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	if err := wstore.AppendRun(ctx, ch.OID, waveobj.Run{OID: "r-ledger-1", ID: "r-ledger-1", Goal: "ship the ledger", Status: "done", ProjectPath: "/p/one", CreatedTs: 100}); err != nil {
		t.Fatalf("append run: %v", err)
	}
	// Seal evidence the way the server does at completion.
	if err := wstore.UpdateRun(ctx, ch.OID, "r-ledger-1", func(r *waveobj.Run) error {
		r.CompletedTs = 500
		r.Evidence = &waveobj.RunEvidence{Summary: "ledger shipped", Files: []waveobj.EvidenceFile{{Path: "a.go", Stat: "M", Add: 3, Del: 1}}}
		return nil
	}); err != nil {
		t.Fatalf("update run: %v", err)
	}
	rtn, err := ws.JarvisStateCommand(ctx, wshrpc.CommandJarvisStateData{})
	if err != nil {
		t.Fatalf("JarvisStateCommand: %v", err)
	}
	if !rtn.State.Sources.Runs {
		t.Fatalf("sources=%+v want runs leg healthy", rtn.State.Sources)
	}
	var found bool
	for _, p := range rtn.State.Projects {
		for _, s := range p.Shipped {
			if s.RunOID == "r-ledger-1" && s.Summary == "ledger shipped" {
				found = true
			}
		}
	}
	if !found {
		t.Fatalf("state=%+v want the fixture run in Shipped", rtn.State)
	}
}

func TestJarvisStatusCommandReturnsSections(t *testing.T) {
	ws := &WshServer{}
	rtn, err := ws.JarvisStatusCommand(context.Background(), wshrpc.CommandJarvisStatusData{})
	if err != nil {
		t.Fatalf("JarvisStatusCommand: %v", err)
	}
	if rtn.Status.NoteCounts == nil {
		t.Fatalf("status=%+v want non-nil note counts (may be empty)", rtn.Status)
	}
	if rtn.Status.DistillQueue == nil {
		t.Fatalf("status=%+v want non-nil distill queue (may be empty)", rtn.Status)
	}
}

func TestJarvisAskCommandAttachesLedgerFacts(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	ch, err := wstore.CreateChannel(ctx, "rpc", "/p/one")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	if err := wstore.AppendRun(ctx, ch.OID, waveobj.Run{OID: "r-ask-1", ID: "r-ask-1", Goal: "the ask bridge", Status: "executing", ProjectPath: "/p/one", CreatedTs: 100}); err != nil {
		t.Fatalf("append run: %v", err)
	}
	// "all" is the documented keep-all judge reply (no digits → ambiguous → keep everything). The
	// plan's "1" only works when prose retrieval returns nothing; the real vault returns candidates
	// that would outrank the appended ledger fact.
	restoreJ := jarvisrecall.SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "all", nil })
	defer restoreJ()
	restoreS := jarvisrecall.SetSynthesizeForTest(func(_ context.Context, _, _ string, _ func(string)) (string, error) {
		return "the ask bridge is executing [1]", nil
	})
	defer jarvisrecall.SetSynthesizeForTest(restoreS)
	rtn, err := ws.JarvisAskCommand(ctx, wshrpc.CommandJarvisAskData{Prompt: "what is the status of the ask bridge", Cwd: "/p/one"})
	if err != nil {
		t.Fatalf("JarvisAskCommand: %v", err)
	}
	if rtn.Answer != "the ask bridge is executing [1]" {
		t.Fatalf("answer=%q want the stub synthesize output", rtn.Answer)
	}
	var foundLedger bool
	for _, s := range rtn.Sources {
		if s.SourceType == "status" && s.ORef == "run:r-ask-1" {
			foundLedger = true
		}
	}
	if !foundLedger {
		t.Fatalf("sources=%+v want the ledger fact from FetchWorkState", rtn.Sources)
	}
}

func TestJarvisStatusIncludesEfforts(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	rtn, err := ws.EffortCreateCommand(ctx, wshrpc.CommandEffortCreateData{
		Title:  "status-effort",
		Chunks: []wshrpc.CommandEffortChunkSeed{{Label: "a"}, {Label: "b"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	cleanupEffort(t, rtn.EffortOID)
	if _, err := ws.EffortMutateCommand(ctx, wshrpc.CommandEffortMutateData{
		EffortOID: rtn.EffortOID,
		Ops:       []wshrpc.EffortOp{{Op: "setChunkStatus", Chunk: "a", Status: "done"}},
	}); err != nil {
		t.Fatal(err)
	}
	st, err := ws.JarvisStatusCommand(ctx, wshrpc.CommandJarvisStatusData{})
	if err != nil {
		t.Fatal(err)
	}
	if st.Status.Efforts.Active < 1 || st.Status.Efforts.ChunksDone < 1 || st.Status.Efforts.ChunksTotal < 2 {
		t.Fatalf("efforts accounting: %+v", st.Status.Efforts)
	}
}
