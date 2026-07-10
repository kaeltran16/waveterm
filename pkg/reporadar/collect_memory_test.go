// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/memvault"
)

func TestMemoryEvidenceFilter(t *testing.T) {
	notes := []memvault.Note{
		{ID: "n1", Scope: "pay", Source: "claude", Type: "feedback", Description: "retries are idempotent", UpdatedTs: 100},
		{ID: "n2", Scope: "pay", Source: "vault", Type: "project", Description: "free-form context"},
		{ID: "n3", Scope: "other", Source: "claude", Type: "feedback", Description: "unrelated project"},
	}
	sigs := memorySignals(notes, "pay", "pay")
	if len(sigs) != 1 {
		t.Fatalf("expected 1 evidence signal (n1), got %d", len(sigs))
	}
	if sigs[0].SourceRef != "memory:n1" {
		t.Fatalf("unexpected signal: %s", sigs[0].SourceRef)
	}
}
