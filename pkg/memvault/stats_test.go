// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memvault

import (
	"testing"
	"time"
)

func TestComputeStatsCountsUtilization(t *testing.T) {
	now := time.Date(2026, 9, 22, 0, 0, 0, 0, time.UTC)
	recent := now.AddDate(0, 0, -3).Format(time.RFC3339)
	cold := now.AddDate(0, 0, -90).Format(time.RFC3339)
	oldCap := now.AddDate(0, 0, -90).Format(time.RFC3339)

	notes := []Note{
		{ID: "a", Source: "claude", CapturedAt: oldCap, LastReferenced: recent, ReferenceCount: 4},
		{ID: "b", Source: "codex", CapturedAt: oldCap, LastReferenced: cold, ReferenceCount: 1},
		{ID: "c", Source: "agent", CapturedAt: oldCap},
		{ID: "d", Source: "vault", CapturedAt: oldCap},
		{ID: "e", CapturedAt: oldCap},
	}
	indexes := []IndexFile{{Label: "waveterm", Bytes: 17556}}

	// immature epoch: nothing is archive-eligible
	s := ComputeStats(notes, indexes, now, 30, now.AddDate(0, 0, -5))
	if s.Total != 5 || s.Machine != 3 || s.Human != 2 {
		t.Fatalf("totals = %d/%d/%d, want 5/3/2", s.Total, s.Machine, s.Human)
	}
	if s.Referenced != 2 {
		t.Fatalf("referenced = %d, want 2", s.Referenced)
	}
	if s.ReferencedRecently != 1 {
		t.Fatalf("referenced in window = %d, want 1", s.ReferencedRecently)
	}
	if s.NeverReferenced != 3 {
		t.Fatalf("never referenced = %d, want 3", s.NeverReferenced)
	}
	if s.ArchiveEligible != 1 {
		t.Fatalf("archive-eligible = %d, want 1 (only the cold stamped machine note)", s.ArchiveEligible)
	}

	// mature epoch: the unstamped machine note becomes eligible too
	s = ComputeStats(notes, indexes, now, 30, now.AddDate(0, 0, -90))
	if s.ArchiveEligible != 2 {
		t.Fatalf("archive-eligible with a mature epoch = %d, want 2", s.ArchiveEligible)
	}
}

func TestComputeStatsReportsIndexBudget(t *testing.T) {
	now := time.Date(2026, 9, 22, 0, 0, 0, 0, time.UTC)
	s := ComputeStats(nil, []IndexFile{
		{Label: "waveterm", Bytes: 17556},
		{Label: "opal", Bytes: 4000},
	}, now, 30, time.Time{})
	if len(s.Indexes) != 2 {
		t.Fatalf("indexes = %d, want 2", len(s.Indexes))
	}
	if !s.Indexes[0].OverBudget || s.Indexes[0].OverBy != 17556-IndexBudgetBytes {
		t.Fatalf("waveterm index = %+v, want over budget by %d", s.Indexes[0], 17556-IndexBudgetBytes)
	}
	if s.Indexes[1].OverBudget {
		t.Fatalf("opal index = %+v, want under budget", s.Indexes[1])
	}
	if s.TotalIndexBytes != 21556 {
		t.Fatalf("total index bytes = %d, want 21556", s.TotalIndexBytes)
	}
}
