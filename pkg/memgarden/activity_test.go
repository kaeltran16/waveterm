// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memgarden

import (
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/memdistill"
	"github.com/wavetermdev/waveterm/pkg/memvault"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

// captureActivity intercepts the broker transport memdistill.PublishActivity writes to.
func captureActivity(t *testing.T) *[]baseds.MemoryActivityData {
	t.Helper()
	var got []baseds.MemoryActivityData
	restore := memdistill.SetActivitySinkForTest(func(ev wps.WaveEvent) {
		if data, ok := ev.Data.(baseds.MemoryActivityData); ok {
			got = append(got, data)
		} else {
			t.Errorf("payload type = %T, want baseds.MemoryActivityData", ev.Data)
		}
	})
	t.Cleanup(restore)
	return &got
}

// inertGardener is a gardener whose every side effect is injected, so a pass archives exactly what the
// test says it archives. State is in-memory: tests must never touch the real state file.
func inertGardener(now time.Time, archived *[]string) *gardener {
	g := testGardener(nil)
	g.now = func() time.Time { return now }
	g.repoPathFn = func(string) string { return "" }
	g.repoIndexFn = func(string) map[string]bool { return map[string]bool{} }
	g.archiveFn = func(path, reason string, _ time.Time) (string, error) {
		*archived = append(*archived, path)
		return path, nil
	}
	g.flagFn = func(string, string) error { return nil }
	g.llmFn = func(string, string, string) (string, bool) { return "", false }
	return g
}

func TestGardenProjectAnnouncesWhatItArchived(t *testing.T) {
	got := captureActivity(t)
	now := time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)
	oldCap := now.AddDate(0, 0, -40).Format(time.RFC3339)
	var archived []string
	g := inertGardener(now, &archived)
	notes := []memvault.NoteWithBody{
		{Note: memvault.Note{ID: "a", Path: "/h/a.md", Source: "agent", CapturedAt: oldCap}},
		{Note: memvault.Note{ID: "b", Path: "/h/b.md", Source: "agent", CapturedAt: oldCap}},
	}

	g.gardenScope("proj", notes)

	if len(archived) != 2 {
		t.Fatalf("premise broken: archived %v, want 2", archived)
	}
	if len(*got) != 1 {
		t.Fatalf("events = %+v, want one sweep", *got)
	}
	ev := (*got)[0]
	if ev.Kind != baseds.MemoryActivity_Sweep || ev.Cwd != "proj" || ev.Archived != 2 {
		t.Fatalf("sweep event = %+v", ev)
	}
	if ev.Id == "" || ev.Ts == 0 {
		t.Fatalf("event without an id/timestamp cannot be watermarked: %+v", ev)
	}
}

// The gardener runs hourly on every scope. A pass that removed nothing has nothing to say, and
// announcing it anyway is how an ambient signal becomes noise nobody reads.
func TestGardenProjectStaysSilentWhenNothingWasArchived(t *testing.T) {
	got := captureActivity(t)
	now := time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)
	var archived []string
	g := inertGardener(now, &archived)
	notes := []memvault.NoteWithBody{
		// fresh, human-sourced: neither pillar touches it
		{Note: memvault.Note{ID: "a", Path: "/h/a.md", Source: "human", CapturedAt: now.Format(time.RFC3339)}},
	}

	g.gardenScope("proj", notes)

	if len(archived) != 0 {
		t.Fatalf("premise broken: archived %v, want none", archived)
	}
	if len(*got) != 0 {
		t.Fatalf("a no-op sweep announced %+v", *got)
	}
}
