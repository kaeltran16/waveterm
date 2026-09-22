package memgarden

import (
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/memvault"
)

func TestClassifyDecay(t *testing.T) {
	now := time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)
	oldCap := now.AddDate(0, 0, -40).Format(time.RFC3339)
	freshCap := now.AddDate(0, 0, -5).Format(time.RFC3339)
	oldRef := now.AddDate(0, 0, -40).Format(time.RFC3339)
	freshRef := now.AddDate(0, 0, -2).Format(time.RFC3339)

	notes := []memvault.Note{
		// machine, never referenced, old -> auto-archive
		{ID: "m-neverref-old", Path: "/h/m1.md", Source: "agent", CapturedAt: oldCap},
		// machine, referenced but stale, old -> auto-archive
		{ID: "m-staleref-old", Path: "/h/m2.md", Source: "codex", CapturedAt: oldCap, LastReferenced: oldRef},
		// machine, recently referenced -> leave alone
		{ID: "m-fresh", Path: "/h/m3.md", Source: "agent", CapturedAt: oldCap, LastReferenced: freshRef},
		// machine, old-referenced but young capture -> leave alone (not old enough)
		{ID: "m-young", Path: "/h/m4.md", Source: "agent", CapturedAt: freshCap, LastReferenced: oldRef},
		// human, never referenced, old -> flag (never auto-archive)
		{ID: "h-neverref-old", Path: "/h/h1.md", Source: "vault", CapturedAt: oldCap},
		// human, referenced-stale -> left to classifyPrune, NOT flagged by decay
		{ID: "h-staleref", Path: "/h/h2.md", Source: "vault", CapturedAt: oldCap, LastReferenced: oldRef},
		// superseded machine -> left to superseded queue
		{ID: "m-superseded", Path: "/h/m5.md", Source: "agent", CapturedAt: oldCap, SupersededBy: "x"},
	}
	got := classifyDecay(notes, now, 30, now.AddDate(0, 0, -60))
	byID := map[string]DecayAction{}
	for _, a := range got {
		byID[a.NoteID] = a
	}
	if a, ok := byID["m-neverref-old"]; !ok || !a.Archive || a.Reason != "decay" {
		t.Fatalf("m-neverref-old should auto-archive: %+v", a)
	}
	if a, ok := byID["m-staleref-old"]; !ok || !a.Archive {
		t.Fatalf("m-staleref-old should auto-archive: %+v", a)
	}
	if a, ok := byID["h-neverref-old"]; !ok || a.Archive || a.Reason != "stale" {
		t.Fatalf("h-neverref-old should flag stale, never archive: %+v", a)
	}
	for _, id := range []string{"m-fresh", "m-young", "h-staleref", "m-superseded"} {
		if _, ok := byID[id]; ok {
			t.Fatalf("%s should be left alone, got %+v", id, byID[id])
		}
	}
}

func TestIsMachineSources(t *testing.T) {
	for _, src := range []string{"agent", "codex", "claude", "pi"} {
		if !isMachine(src) {
			t.Errorf("isMachine(%q) = false, want true (harvested source)", src)
		}
	}
	if isMachine("vault") || isMachine("") {
		t.Errorf("isMachine(human source) = true, want false")
	}
}

func TestClassifyDecayRespectsTheEpoch(t *testing.T) {
	now := time.Date(2026, 9, 22, 0, 0, 0, 0, time.UTC)
	oldCap := now.AddDate(0, 0, -40).Format(time.RFC3339)
	oldRef := now.AddDate(0, 0, -40).Format(time.RFC3339)

	machineNever := memvault.Note{ID: "m-never", Path: "/h/m1.md", Source: "agent", CapturedAt: oldCap}
	machineStale := memvault.Note{ID: "m-stale", Path: "/h/m2.md", Source: "codex", CapturedAt: oldCap, LastReferenced: oldRef}
	notes := []memvault.Note{machineNever, machineStale}

	byID := func(actions []DecayAction) map[string]DecayAction {
		out := map[string]DecayAction{}
		for _, a := range actions {
			out[a.NoteID] = a
		}
		return out
	}

	// no epoch recorded: never-referenced is not evidence, so it may only be flagged
	got := byID(classifyDecay(notes, now, 30, time.Time{}))
	if a, ok := got["m-never"]; !ok || a.Archive || a.Reason != "stale" {
		t.Fatalf("no epoch: m-never = %+v, want a non-archiving stale flag", a)
	}
	if a, ok := got["m-stale"]; !ok || !a.Archive {
		t.Fatalf("no epoch: m-stale = %+v, want archive (a real stamp went cold)", a)
	}

	// epoch newer than the cutoff: the signal has not had a full window to fire
	got = byID(classifyDecay(notes, now, 30, now.AddDate(0, 0, -5)))
	if a := got["m-never"]; a.Archive {
		t.Fatalf("immature epoch: m-never archived, want flag only")
	}

	// epoch older than the cutoff: the note was observable for a full window and never surfaced
	got = byID(classifyDecay(notes, now, 30, now.AddDate(0, 0, -60)))
	if a, ok := got["m-never"]; !ok || !a.Archive || a.Reason != "decay" {
		t.Fatalf("mature epoch: m-never = %+v, want archive/decay", a)
	}
}

func TestClassifyDecayNeverArchivesHumanNotes(t *testing.T) {
	now := time.Date(2026, 9, 22, 0, 0, 0, 0, time.UTC)
	oldCap := now.AddDate(0, 0, -40).Format(time.RFC3339)
	notes := []memvault.Note{{ID: "h", Path: "/h/h.md", Source: "vault", CapturedAt: oldCap}}
	for _, epoch := range []time.Time{{}, now.AddDate(0, 0, -60)} {
		for _, a := range classifyDecay(notes, now, 30, epoch) {
			if a.Archive {
				t.Fatalf("human note archived under epoch %v; human notes are flagged, never archived", epoch)
			}
		}
	}
}
