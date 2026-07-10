package memvault

import (
	"testing"
	"time"
)

func TestClassifyPrune(t *testing.T) {
	now := time.Date(2026, 7, 10, 0, 0, 0, 0, time.UTC)
	fresh := now.Add(-24 * time.Hour).Format(time.RFC3339)
	old := now.Add(-40 * 24 * time.Hour).Format(time.RFC3339)
	notes := []Note{
		{ID: "a", Title: "A", SupersededBy: "b", LastReferenced: fresh},
		{ID: "c", Title: "C", LastReferenced: old},
		{ID: "d", Title: "D", LastReferenced: fresh},
	}
	got := classifyPrune(notes, now)
	if len(got) != 2 {
		t.Fatalf("want 2 candidates, got %d: %+v", len(got), got)
	}
	if got[0].Reason != "superseded" || got[0].ID != "a" {
		t.Fatalf("superseded should sort first: %+v", got[0])
	}
	if got[1].Reason != "stale" || got[1].ID != "c" {
		t.Fatalf("stale second: %+v", got[1])
	}
}
