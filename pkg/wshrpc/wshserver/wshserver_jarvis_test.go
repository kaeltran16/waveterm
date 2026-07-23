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
