// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarviscapture

import (
	"context"
	"os/exec"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/effortstore"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

func TestExtractTicket(t *testing.T) {
	cases := map[string]string{
		"fix ABC-123 login bug":   "ABC-123",
		"no ticket here":          "",
		"lowercase abc-1 ignored": "",
		"WAVE-9 and JIRA-42":      "WAVE-9",
	}
	for goal, want := range cases {
		if got := extractTicket(goal); got != want {
			t.Errorf("extractTicket(%q)=%q want %q", goal, got, want)
		}
	}
}

// dossierTicket captures run into a fresh vault and returns the ticket id on the one dossier.
func dossierTicket(t *testing.T, run *waveobj.Run, want string) {
	t.Helper()
	ctx := context.Background()
	v, err := wavevault.OpenVaultAtForTest(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("open vault: %v", err)
	}
	if _, err := captureRunDossier(ctx, v, run); err != nil {
		t.Fatalf("captureRunDossier: %v", err)
	}
	hits, err := v.Retriever(wavevault.AllScope()).Query(wavevault.Filter{FrontmatterEquals: map[string]string{"ticket": want}})
	if err != nil || len(hits) != 1 {
		t.Fatalf("dossier with ticket %q: err=%v hits=%d (want 1)", want, err, len(hits))
	}
}

func newTicketedEffort(t *testing.T, ticket string) string {
	t.Helper()
	t.Cleanup(effortstore.UseRootForTest(t.TempDir()))
	e := &waveobj.Effort{Title: "initiative", Ticket: ticket}
	if err := effortstore.Create(context.Background(), e); err != nil {
		t.Fatalf("create effort: %v", err)
	}
	return e.OID
}

func TestCaptureUsesInitiativeTicket(t *testing.T) {
	oid := newTicketedEffort(t, "PAY-318")
	run := &waveobj.Run{OID: "aaaaaaaa-0000-0000-0000-000000000002", Goal: "fix OPS-77 too",
		EffortRef: &waveobj.RunEffortRef{EffortOID: oid, ChunkLabel: "one"}}
	dossierTicket(t, run, "PAY-318")
}

func TestCaptureFallsBackToGoal(t *testing.T) {
	t.Run("no effort ref", func(t *testing.T) {
		t.Cleanup(effortstore.UseRootForTest(t.TempDir()))
		dossierTicket(t, &waveobj.Run{OID: "aaaaaaaa-0000-0000-0000-000000000003", Goal: "fix OPS-77"}, "OPS-77")
	})
	t.Run("effort without ticket", func(t *testing.T) {
		oid := newTicketedEffort(t, "")
		run := &waveobj.Run{OID: "aaaaaaaa-0000-0000-0000-000000000004", Goal: "fix OPS-77",
			EffortRef: &waveobj.RunEffortRef{EffortOID: oid, ChunkLabel: "one"}}
		dossierTicket(t, run, "OPS-77")
	})
}

func TestCaptureMissingEffortFallsBack(t *testing.T) {
	t.Cleanup(effortstore.UseRootForTest(t.TempDir()))
	run := &waveobj.Run{OID: "aaaaaaaa-0000-0000-0000-000000000005", Goal: "fix OPS-77",
		EffortRef: &waveobj.RunEffortRef{EffortOID: "bbbbbbbb-0000-0000-0000-000000000000", ChunkLabel: "one"}}
	dossierTicket(t, run, "OPS-77")
}

func TestCaptureRunDossierLinksRunAndCommits(t *testing.T) {
	ctx := context.Background()
	v, err := wavevault.OpenVaultAtForTest(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("open vault: %v", err)
	}
	oid := "aaaaaaaa-0000-0000-0000-000000000001"
	run := &waveobj.Run{OID: oid, Goal: "ship ABC-7 the widget"}

	if _, err := captureRunDossier(ctx, v, run); err != nil {
		t.Fatalf("captureRunDossier: %v", err)
	}

	// the dossier links the run and carries the extracted ticket
	r := v.Retriever(wavevault.AllScope())
	linked, err := r.Query(wavevault.Filter{HasLink: "run-" + oid})
	if err != nil || len(linked) != 1 {
		t.Fatalf("HasLink query: err=%v hits=%d (want 1)", err, len(linked))
	}
	ticketed, _ := v.Retriever(wavevault.AllScope()).Query(wavevault.Filter{FrontmatterEquals: map[string]string{"ticket": "ABC-7"}})
	if len(ticketed) != 1 {
		t.Fatalf("ticket query hits=%d want 1", len(ticketed))
	}

	// the write landed in a commit (working tree clean)
	out, err := exec.CommandContext(ctx, "git", "-C", v.Root, "status", "--porcelain").Output()
	if err != nil {
		t.Fatalf("git status: %v", err)
	}
	if len(out) != 0 {
		t.Fatalf("working tree not clean after capture:\n%s", out)
	}
}
