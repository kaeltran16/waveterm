package wstore

import (
	"context"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestEffortCreateGetRoundTrip(t *testing.T) {
	ctx := context.Background()
	e := &waveobj.Effort{Title: "Scenario gate clearance", Ticket: "SIEM-1662", Status: "active"}
	e.Chunks = []waveobj.EffortChunk{{Label: "Phase 1", Status: "pending"}, {Label: "Phase 2", Status: "done"}}
	if err := CreateEffort(ctx, e); err != nil {
		t.Fatal(err)
	}
	got, err := GetEffort(ctx, e.OID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "Scenario gate clearance" || len(got.Chunks) != 2 {
		t.Fatalf("round-trip mismatch: %+v", got)
	}
	if got.Version != 1 || got.CreatedTs == 0 || got.UpdatedTs == 0 || got.Status != "active" {
		t.Fatalf("defaults not set: %+v", got)
	}
	if got.OID == "" {
		t.Fatal("OID not assigned")
	}
}

func TestEffortGetAllSortedByUpdatedDesc(t *testing.T) {
	ctx := context.Background()
	old := &waveobj.Effort{Title: "older", Status: "active"}
	if err := CreateEffort(ctx, old); err != nil {
		t.Fatal(err)
	}
	if err := UpdateEffort(ctx, old.OID, func(e *waveobj.Effort) error { return nil }); err != nil {
		t.Fatal(err)
	}
	// the store stamps millisecond precision; ensure old's update lands strictly before recent's
	// create so the updated-desc ordering has distinct keys (a tie would keep insertion order)
	time.Sleep(2 * time.Millisecond)
	recent := &waveobj.Effort{Title: "newer", Status: "active"}
	if err := CreateEffort(ctx, recent); err != nil {
		t.Fatal(err)
	}
	all, err := GetAllEfforts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) < 2 || all[0].OID != recent.OID {
		t.Fatalf("expected newest-updated first, got %+v", all)
	}
}

func TestEffortGetNotFound(t *testing.T) {
	_, err := GetEffort(context.Background(), "00000000-0000-0000-0000-000000000000")
	if err != ErrNotFound {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestEffortUpdateFnBumpsVersion(t *testing.T) {
	ctx := context.Background()
	e := &waveobj.Effort{Title: "v", Status: "active"}
	if err := CreateEffort(ctx, e); err != nil {
		t.Fatal(err)
	}
	if err := UpdateEffort(ctx, e.OID, func(e *waveobj.Effort) error { e.Title = "v2"; return nil }); err != nil {
		t.Fatal(err)
	}
	got, err := GetEffort(ctx, e.OID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Version != 2 || got.Title != "v2" {
		t.Fatalf("version/title not updated: %+v", got)
	}
}

func TestEffortUpdateFnErrorRollsBack(t *testing.T) {
	ctx := context.Background()
	e := &waveobj.Effort{Title: "v", Status: "active"}
	if err := CreateEffort(ctx, e); err != nil {
		t.Fatal(err)
	}
	err := UpdateEffort(ctx, e.OID, func(e *waveobj.Effort) error { e.Title = "bad"; return context.DeadlineExceeded })
	if err == nil {
		t.Fatal("want error")
	}
	got, err := GetEffort(ctx, e.OID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "v" || got.Version != 1 {
		t.Fatalf("rollback failed: %+v", got)
	}
}
