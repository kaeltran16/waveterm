// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
)

func looseProducer(ds []jarvisdossier.Dossier, now int64) *LooseEndProducer {
	return &LooseEndProducer{
		listDossiers: func(context.Context) ([]jarvisdossier.Dossier, error) { return ds, nil },
		now:          func() int64 { return now },
	}
}

func TestLooseEndFiresOnStaleActiveDossier(t *testing.T) {
	const now int64 = 10 * stalenessMs
	ds := []jarvisdossier.Dossier{
		{ID: "task-a", Status: "active", Objective: "finish the migration", Updated: now - stalenessMs - 1},
	}
	got, err := looseProducer(ds, now).Candidates(context.Background(), &Trigger{Kind: TriggerSweep})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 candidate, got %d", len(got))
	}
	if got[0].Class != ClassLooseEnd {
		t.Fatalf("class = %q, want %q", got[0].Class, ClassLooseEnd)
	}
	if got[0].SourceRef != "task:task-a" {
		t.Fatalf("SourceRef = %q, want the dossier route", got[0].SourceRef)
	}
	if got[0].Title != "finish the migration" {
		t.Fatalf("Title = %q, want the objective", got[0].Title)
	}
}

// The vault's real status vocabulary is active | paused | completed | archived (jarvisdossier.SetStatus),
// NOT the run vocabulary. Measured 2026-08-06 against the real vault: 19 of 24 dossiers are "completed".
// Treating those as loose ends would have volunteered nineteen finished pieces of work.
func TestLooseEndIgnoresFreshAndTerminal(t *testing.T) {
	const now int64 = 10 * stalenessMs
	ds := []jarvisdossier.Dossier{
		{ID: "fresh", Status: "active", Updated: now - 1},
		{ID: "completed", Status: "completed", Updated: now - stalenessMs - 1},
		{ID: "archived", Status: "archived", Updated: now - stalenessMs - 1},
	}
	got, _ := looseProducer(ds, now).Candidates(context.Background(), &Trigger{Kind: TriggerSweep})
	if len(got) != 0 {
		t.Fatalf("a fresh or terminal dossier is not a loose end, got %+v", got)
	}
}

// Eligibility is an allowlist, not a denylist: an unrecognised status stays silent. The asymmetry is
// deliberate — a feature that underdelivers is recoverable, one that interrupts wrongly gets switched off.
func TestLooseEndStaysSilentOnUnknownStatus(t *testing.T) {
	const now int64 = 10 * stalenessMs
	ds := []jarvisdossier.Dossier{
		{ID: "weird", Status: "some-future-status", Updated: now - stalenessMs - 1},
		{ID: "blank", Status: "", Updated: now - stalenessMs - 1},
	}
	got, _ := looseProducer(ds, now).Candidates(context.Background(), &Trigger{Kind: TriggerSweep})
	if len(got) != 0 {
		t.Fatalf("an unrecognised status must not be volunteered, got %+v", got)
	}
}

func TestLooseEndFiresOnPausedDossier(t *testing.T) {
	const now int64 = 10 * stalenessMs
	ds := []jarvisdossier.Dossier{
		{ID: "paused", Status: "paused", Objective: "waiting", Updated: now - stalenessMs - 1},
	}
	got, _ := looseProducer(ds, now).Candidates(context.Background(), &Trigger{Kind: TriggerSweep})
	if len(got) != 1 {
		t.Fatalf("paused is non-terminal work and can go quiet, got %d", len(got))
	}
}

func TestLooseEndFiresOnBlockedRegardlessOfAge(t *testing.T) {
	const now int64 = 10 * stalenessMs
	ds := []jarvisdossier.Dossier{
		{ID: "blocked", Status: "active", Objective: "waiting on review", Updated: now - 1, Blockers: []string{"needs review"}},
	}
	got, _ := looseProducer(ds, now).Candidates(context.Background(), &Trigger{Kind: TriggerSweep})
	if len(got) != 1 {
		t.Fatalf("a blocked dossier is a loose end whatever its age, got %d", len(got))
	}
	if got[0].Snippet != "blocked on needs review" {
		t.Fatalf("snippet = %q, want the blocker named", got[0].Snippet)
	}
}

// The idempotence property: both ID and At floor to the same bucket, so re-reading an unchanged
// dossier produces a byte-identical (At, ID) pair. The frontend watermark compares At FIRST, so
// bucketing only the ID would let every re-emission slip past and re-speak forever.
func TestLooseEndPairIsStableWithinABucket(t *testing.T) {
	const base int64 = 100 * resurfaceBucketMs
	mk := func(updated int64) Candidate {
		ds := []jarvisdossier.Dossier{{ID: "task-a", Status: "active", Updated: updated}}
		got, _ := looseProducer(ds, base+50*stalenessMs).Candidates(context.Background(), &Trigger{Kind: TriggerSweep})
		if len(got) != 1 {
			t.Fatalf("expected a candidate for updated=%d", updated)
		}
		return got[0]
	}
	a := mk(base)
	b := mk(base + resurfaceBucketMs/2) // same bucket, different raw stamp
	if a.ID != b.ID {
		t.Fatalf("ID must be stable within a bucket: %q vs %q", a.ID, b.ID)
	}
	if a.At != b.At {
		t.Fatalf("At must ALSO floor to the bucket, else the watermark lets a repeat through: %d vs %d", a.At, b.At)
	}
	c := mk(base + resurfaceBucketMs*3)
	if c.ID == a.ID || c.At == a.At {
		t.Fatalf("a later bucket must produce a NEW pair so a resumed-then-abandoned loose end can resurface")
	}
}

func TestResurfaceBucketIsCoarserThanStaleness(t *testing.T) {
	if resurfaceBucketMs <= stalenessMs {
		t.Fatalf("resurfaceBucketMs (%d) must exceed stalenessMs (%d), else a loose end re-fires before it has gone stale again",
			resurfaceBucketMs, stalenessMs)
	}
}

// A dossier whose bucket floors to zero would be dropped by the gate's prefilter as unstampable, so
// the producer must not emit one. Guards the epoch edge rather than assuming it never occurs.
func TestLooseEndSkipsUnstampableDossier(t *testing.T) {
	const now int64 = 10 * stalenessMs
	ds := []jarvisdossier.Dossier{
		{ID: "no-stamp", Status: "active", Updated: 0},
		{ID: "epoch", Status: "active", Updated: resurfaceBucketMs - 1}, // floors to 0
	}
	got, _ := looseProducer(ds, now).Candidates(context.Background(), &Trigger{Kind: TriggerSweep})
	if len(got) != 0 {
		t.Fatalf("a dossier with no usable stamp must be skipped, got %+v", got)
	}
}

// Vault order is not guaranteed, and the shortlist cap means order decides what the judge ever sees.
func TestLooseEndOrderIsDeterministic(t *testing.T) {
	const now int64 = 10 * stalenessMs
	ds := []jarvisdossier.Dossier{
		{ID: "task-c", Status: "active", Updated: now - stalenessMs - 1},
		{ID: "task-a", Status: "active", Updated: now - stalenessMs - 1},
		{ID: "task-b", Status: "active", Updated: now - stalenessMs - 1},
	}
	got, _ := looseProducer(ds, now).Candidates(context.Background(), &Trigger{Kind: TriggerSweep})
	if len(got) != 3 {
		t.Fatalf("want 3 candidates, got %d", len(got))
	}
	if got[0].SourceRef != "task:task-a" || got[2].SourceRef != "task:task-c" {
		t.Fatalf("candidates must be ordered stably, got %s..%s", got[0].SourceRef, got[2].SourceRef)
	}
}
