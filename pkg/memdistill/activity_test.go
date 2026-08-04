// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memdistill

import (
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/memvault"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

// captureActivity swaps the broker transport for the test's lifetime and returns the collected payloads.
// It intercepts below PublishActivity so the id/timestamp stamping and the event name are under test too.
func captureActivity(t *testing.T) *[]baseds.MemoryActivityData {
	t.Helper()
	var got []baseds.MemoryActivityData
	prev := publishActivitySink
	publishActivitySink = func(ev wps.WaveEvent) {
		if ev.Event != wps.Event_MemoryActivity {
			t.Errorf("published under %q, want %q", ev.Event, wps.Event_MemoryActivity)
		}
		if ev.Persist <= 0 {
			t.Error("activity must be retained, or a frontend that connects after the pass never sees it")
		}
		if len(ev.Scopes) != 0 {
			t.Errorf("activity must stay scope-less for an unscoped subscription to receive it: %v", ev.Scopes)
		}
		data, ok := ev.Data.(baseds.MemoryActivityData)
		if !ok {
			t.Fatalf("payload type = %T, want baseds.MemoryActivityData", ev.Data)
		}
		got = append(got, data)
	}
	t.Cleanup(func() { publishActivitySink = prev })
	return &got
}

func TestFlushAnnouncesBatchAndNotesSeparately(t *testing.T) {
	got := captureActivity(t)
	d := newDistiller(filepath.Join(t.TempDir(), "q.json"))
	d.distillFn = func(claudePath, model, corpus string) (string, bool) {
		return `{"candidates":[{"type":"feedback","body":"x"}],"references":[]}`, true
	}
	d.routeFn = func(string, []memvault.LearnCandidate, []string) (int, int, error) { return 1, 2, nil }
	d.enqueue("/repo/a", "/t/1.jsonl", "")
	d.flush("/repo/a")

	if len(*got) != 2 {
		t.Fatalf("events = %d (%+v), want a batch and a notes-written", len(*got), *got)
	}
	batch, notes := (*got)[0], (*got)[1]
	if batch.Kind != baseds.MemoryActivity_DistillBatch || batch.Cwd != "/repo/a" || batch.Sessions != 1 {
		t.Fatalf("batch event = %+v", batch)
	}
	if notes.Kind != baseds.MemoryActivity_NotesWritten || notes.Committed != 1 || notes.Queued != 2 {
		t.Fatalf("notes event = %+v", notes)
	}
	for _, e := range *got {
		if e.Id == "" || e.Ts == 0 {
			t.Fatalf("event without an id/timestamp cannot be watermarked: %+v", e)
		}
	}
	if batch.Id == notes.Id {
		t.Fatal("two events share one id; a watermark would swallow the second")
	}
}

// A batch that wrote nothing still did work worth reporting, but it has nothing to say it believes.
func TestFlushWithNoRoutedNotesAnnouncesOnlyTheBatch(t *testing.T) {
	got := captureActivity(t)
	d := newDistiller(filepath.Join(t.TempDir(), "q.json"))
	d.distillFn = func(claudePath, model, corpus string) (string, bool) {
		return `{"candidates":[],"references":[]}`, true
	}
	d.routeFn = func(string, []memvault.LearnCandidate, []string) (int, int, error) {
		t.Fatal("routeFn must not run with nothing to route")
		return 0, 0, nil
	}
	d.enqueue("/repo/a", "/t/1.jsonl", "")
	d.flush("/repo/a")

	if len(*got) != 1 || (*got)[0].Kind != baseds.MemoryActivity_DistillBatch {
		t.Fatalf("events = %+v, want one distill-batch", *got)
	}
}

// A failed batch is retried later; announcing it would report work that did not happen.
func TestFailedFlushAnnouncesNothing(t *testing.T) {
	got := captureActivity(t)
	d := newDistiller(filepath.Join(t.TempDir(), "q.json"))
	d.distillFn = func(claudePath, model, corpus string) (string, bool) { return "", false }
	d.enqueue("/repo/a", "/t/1.jsonl", "")
	d.flush("/repo/a")

	if len(*got) != 0 {
		t.Fatalf("a failed flush announced %+v", *got)
	}
}
