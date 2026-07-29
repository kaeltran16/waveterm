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
