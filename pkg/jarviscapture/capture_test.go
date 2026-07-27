// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarviscapture

import (
	"context"
	"os/exec"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavevault"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
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
