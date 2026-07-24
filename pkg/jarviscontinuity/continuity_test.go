// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarviscontinuity

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

const testRunOID = "cccccccc-0000-0000-0000-000000000001"

// seedDossier builds a fixture vault with a dossier that references testRunOID and one decision.
func seedDossier(t *testing.T) (*wavevault.Vault, string) {
	t.Helper()
	ctx := context.Background()
	v, err := wavevault.OpenVaultAtForTest(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("open vault: %v", err)
	}
	id, hash, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{
		Ticket: "ABC-7", Objective: "ship the widget", Confidence: "med",
	})
	if err != nil {
		t.Fatalf("create dossier: %v", err)
	}
	if _, err := jarvisdossier.SetRefs(v, id, []string{"run-" + testRunOID}, hash); err != nil {
		t.Fatalf("set refs: %v", err)
	}
	if _, err := jarvisdossier.AppendDecision(v, jarvisdossier.DecisionFacts{
		TaskID: id, Actor: "jarvis", Provenance: "test",
		Summary: "middleware", Rationale: "chose middleware extraction because it isolates auth",
	}); err != nil {
		t.Fatalf("append decision: %v", err)
	}
	return v, id
}

func TestIsRestState(t *testing.T) {
	for _, s := range []string{"awaiting-review", "blocked", "done"} {
		if !IsRestState(s) {
			t.Errorf("IsRestState(%q) = false, want true", s)
		}
	}
	for _, s := range []string{"planning", "executing", "cancelled", ""} {
		if IsRestState(s) {
			t.Errorf("IsRestState(%q) = true, want false", s)
		}
	}
}

func TestCaptureWritesNarrativeAndFlipsPaused(t *testing.T) {
	ctx := context.Background()
	v, id := seedDossier(t)
	restore := SetSummarizeForTest(func(context.Context, string, string) (string, error) {
		return "Blocked on the token-refresh test; middleware extracted.", nil
	})
	defer SetSummarizeForTest(restore)

	run := &waveobj.Run{OID: testRunOID, ID: testRunOID, Goal: "ship ABC-7 the widget", Status: "blocked"}
	if err := captureRunBoundary(ctx, v, run); err != nil {
		t.Fatalf("captureRunBoundary: %v", err)
	}

	d, err := jarvisdossier.LoadDossier(v.Retriever(wavevault.AllScope()), id)
	if err != nil {
		t.Fatalf("load dossier: %v", err)
	}
	if !strings.Contains(d.State, "token-refresh") {
		t.Errorf("state = %q, want the mocked narrative", d.State)
	}
	if d.Status != "paused" {
		t.Errorf("status = %q, want paused", d.Status)
	}
}

func TestCaptureDoneFlipsCompleted(t *testing.T) {
	ctx := context.Background()
	v, id := seedDossier(t)
	restore := SetSummarizeForTest(func(context.Context, string, string) (string, error) { return "Done.", nil })
	defer SetSummarizeForTest(restore)

	run := &waveobj.Run{OID: testRunOID, ID: testRunOID, Goal: "ship it", Status: "done", EndCommit: "abc123"}
	if err := captureRunBoundary(ctx, v, run); err != nil {
		t.Fatalf("capture: %v", err)
	}
	d, _ := jarvisdossier.LoadDossier(v.Retriever(wavevault.AllScope()), id)
	if d.Status != "completed" {
		t.Errorf("status = %q, want completed", d.Status)
	}
}

func TestCaptureNoDossierIsNoOpNoModel(t *testing.T) {
	ctx := context.Background()
	v, err := wavevault.OpenVaultAtForTest(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("open vault: %v", err)
	}
	called := false
	restore := SetSummarizeForTest(func(context.Context, string, string) (string, error) { called = true; return "x", nil })
	defer SetSummarizeForTest(restore)

	run := &waveobj.Run{OID: "no-such-run", Status: "done"}
	if err := captureRunBoundary(ctx, v, run); err != nil {
		t.Fatalf("capture: %v", err)
	}
	if called {
		t.Fatal("no dossier for the run -> must not call the model")
	}
}

func TestCaptureEmptyTaskWritesTerseNoModel(t *testing.T) {
	ctx := context.Background()
	v, err := wavevault.OpenVaultAtForTest(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("open vault: %v", err)
	}
	id, hash, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Objective: "empty task", Confidence: "med"})
	if err != nil {
		t.Fatalf("create dossier: %v", err)
	}
	if _, err := jarvisdossier.SetRefs(v, id, []string{"run-" + testRunOID}, hash); err != nil {
		t.Fatalf("set refs: %v", err)
	}
	called := false
	restore := SetSummarizeForTest(func(context.Context, string, string) (string, error) { called = true; return "x", nil })
	defer SetSummarizeForTest(restore)

	run := &waveobj.Run{OID: testRunOID, Status: "blocked"} // no blockers/decisions, no EndCommit
	if err := captureRunBoundary(ctx, v, run); err != nil {
		t.Fatalf("capture: %v", err)
	}
	if called {
		t.Fatal("empty task -> terse deterministic line, no model call")
	}
	d, _ := jarvisdossier.LoadDossier(v.Retriever(wavevault.AllScope()), id)
	if !strings.Contains(d.State, "no recorded progress") {
		t.Errorf("state = %q, want the terse fallback", d.State)
	}
}

func TestResumeReadsPrecomputedState(t *testing.T) {
	ctx := context.Background()
	v, id := seedDossier(t)
	restore := SetSummarizeForTest(func(context.Context, string, string) (string, error) { return "narrative here", nil })
	defer SetSummarizeForTest(restore)

	run := &waveobj.Run{OID: testRunOID, ID: testRunOID, Goal: "g", Status: "blocked", EndCommit: "x"}
	if err := captureRunBoundary(ctx, v, run); err != nil {
		t.Fatalf("capture: %v", err)
	}

	n, err := Resume(v.Retriever(wavevault.AllScope()), id)
	if err != nil {
		t.Fatalf("resume: %v", err)
	}
	if !strings.Contains(n.Summary, "narrative here") {
		t.Errorf("resume summary = %q", n.Summary)
	}
	if n.Status != "paused" {
		t.Errorf("resume status = %q, want paused", n.Status)
	}
	found := false
	for _, r := range n.RunRefs {
		if r == "run-"+testRunOID {
			found = true
		}
	}
	if !found {
		t.Errorf("resume runRefs = %v, missing the run ref", n.RunRefs)
	}
}
