// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisrecall

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
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

func TestRetrieveTraversesVaultAndResolvesRun(t *testing.T) {
	ctx := context.Background()
	v, _ := seedVault(t)
	restore := SetOpenVaultForTest(func(context.Context) (*wavevault.Vault, error) { return v, nil })
	defer SetOpenVaultForTest(restore)

	// the referenced run exists in wstore -> resolved live
	run := &waveobj.Run{OID: seedRunOID, ID: seedRunOID, Goal: "ship the thing", Status: "done", ProjectPath: `C:\src\demo`, Meta: make(waveobj.MetaMapType)}
	if err := wstore.DBInsert(ctx, run); err != nil {
		t.Fatalf("insert run: %v", err)
	}
	t.Cleanup(func() { _ = wstore.DBDelete(ctx, waveobj.OType_Run, seedRunOID) })

	cands, err := retrieve(ctx, ScopeArgs{Mode: "all"}, "why the widget approach for ABC-123")
	if err != nil {
		t.Fatalf("retrieve: %v", err)
	}
	var sawDossier, sawDecision, sawRun bool
	for _, c := range cands {
		switch c.sourceType {
		case "dossier":
			sawDossier = true
		case "decision":
			sawDecision = true
		case "run":
			sawRun = true
			if c.freshness != "fresh" {
				t.Errorf("resolved run freshness=%q want fresh", c.freshness)
			}
		}
	}
	if !sawDossier || !sawDecision || !sawRun {
		t.Fatalf("missing sources: dossier=%v decision=%v run=%v", sawDossier, sawDecision, sawRun)
	}
}

func TestRetrieveSurfacesUnavailableRun(t *testing.T) {
	ctx := context.Background()
	v, _ := seedVault(t) // references seedRunOID, which is NOT inserted into wstore here
	restore := SetOpenVaultForTest(func(context.Context) (*wavevault.Vault, error) { return v, nil })
	defer SetOpenVaultForTest(restore)

	cands, err := retrieve(ctx, ScopeArgs{Mode: "all"}, "ABC-123")
	if err != nil {
		t.Fatalf("retrieve: %v", err)
	}
	var unavailable bool
	for _, c := range cands {
		if c.sourceType == "run" && c.freshness == "unavailable" {
			unavailable = true
		}
	}
	if !unavailable {
		t.Fatalf("deleted run should surface as unavailable, got %+v", cands)
	}
}

func TestWorkerScopeCannotSeeTasks(t *testing.T) {
	v, dossierID := seedVault(t)
	// AllScope sees the dossier...
	if _, err := v.Retriever(wavevault.AllScope()).Read(dossierID); err != nil {
		t.Fatalf("AllScope should see the dossier: %v", err)
	}
	// ...WorkerScope (memory+decisions) physically cannot.
	if _, err := v.Retriever(wavevault.WorkerScope()).Read(dossierID); err == nil {
		t.Fatalf("WorkerScope must not see tasks/ dossiers")
	}
}
