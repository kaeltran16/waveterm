// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestSignalIDStableAndDedupes(t *testing.T) {
	a := newSignal(CollectorGit, "commit:a3f9c1", 100, []string{"src/x.ts"}, "changed x", nil, "")
	b := newSignal(CollectorGit, "commit:a3f9c1", 100, []string{"src/x.ts"}, "changed x", nil, "")
	if a.ID != b.ID {
		t.Fatalf("same source identity must yield same ID: %q vs %q", a.ID, b.ID)
	}
	c := newSignal(CollectorGit, "commit:7b20e4", 100, []string{"src/x.ts"}, "changed x", nil, "")
	if a.ID == c.ID {
		t.Fatal("different source ref must yield different ID")
	}
	deduped := dedupSignals([]waveobj.RadarSignal{a, b, c})
	if len(deduped) != 2 {
		t.Fatalf("expected 2 after dedup, got %d", len(deduped))
	}
}
