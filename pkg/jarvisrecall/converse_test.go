// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisrecall

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestConverseThreadsPriorContextAndTerminal(t *testing.T) {
	var seenPrompt string
	old := SetSynthesizeForTest(func(ctx context.Context, cwd, prompt string, onChunk func(string)) (string, error) {
		seenPrompt = prompt
		onChunk("because of [1]")
		return "because of [1]", nil
	})
	defer SetSynthesizeForTest(old)

	prior := []waveobj.JarvisConvoTurn{
		{Role: "user", Text: "what changed?"},
		{Role: "jarvis", Prose: "we dropped worktrees"},
	}
	var terminals []string
	turn, err := Converse(context.Background(), ScopeArgs{Mode: "all"}, prior, "why?", func(chunk wshrpc.JarvisConverseChunk) {
		if chunk.Kind == "terminal" {
			terminals = append(terminals, chunk.Terminal)
		}
	})
	if err != nil {
		t.Fatalf("Converse: %v", err)
	}
	if turn.Role != "jarvis" {
		t.Fatalf("answer turn role = %q", turn.Role)
	}
	if len(terminals) != 1 {
		t.Fatalf("want exactly one terminal, got %v", terminals)
	}
	_ = seenPrompt
}

func TestConversePinsAttachedAndThreadsContext(t *testing.T) {
	ctx := context.Background()
	runID := "cccccccc-0000-0000-0000-000000000001"
	run := &waveobj.Run{OID: runID, ID: runID, Goal: "ship worktrees removal", Status: "done", Meta: make(waveobj.MetaMapType)}
	if err := wstore.DBInsert(ctx, run); err != nil {
		t.Fatalf("insert run: %v", err)
	}
	t.Cleanup(func() {
		if err := wstore.DBDelete(ctx, waveobj.OType_Run, runID); err != nil {
			t.Errorf("cleanup run: %v", err)
		}
	})

	var seenPrompt string
	old := SetSynthesizeForTest(func(ctx context.Context, cwd, prompt string, onChunk func(string)) (string, error) {
		seenPrompt = prompt
		onChunk("answer [1]")
		return "answer [1]", nil
	})
	defer SetSynthesizeForTest(old)

	prior := []waveobj.JarvisConvoTurn{{Role: "user", Text: "what changed?"}}
	scope := ScopeArgs{Mode: "attached", AttachedORefs: []string{"run:" + runID}}
	turn, err := Converse(ctx, scope, prior, "why?", func(wshrpc.JarvisConverseChunk) {})
	if err != nil {
		t.Fatalf("Converse: %v", err)
	}
	if !strings.Contains(seenPrompt, "what changed?") {
		t.Fatalf("prior context not threaded into prompt:\n%s", seenPrompt)
	}
	if !strings.Contains(seenPrompt, "ship worktrees removal") {
		t.Fatalf("attached run not pinned into prompt sources:\n%s", seenPrompt)
	}
	if turn.Terminal != "answered" || turn.Prose != "answer [1]" || len(turn.Grounding) == 0 {
		t.Fatalf("answer turn mismatch: %+v", turn)
	}
}
