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

// One event per pass, always — the frontend decides whether it is worth saying. This replaced a pair of
// events ("I did some work", then a count of notes): suppressing a barren pass here would leave the peek's
// last-pass row with no data, which is how a pipeline that runs and writes nothing becomes invisible.
func TestFlushPublishesOneActivityPerPassCarryingItsNotes(t *testing.T) {
	got := captureActivity(t)
	d := newDistiller(filepath.Join(t.TempDir(), "q.json"))
	d.distillFn = func(claudePath, model, corpus string) (string, bool) {
		return `{"candidates":[{"type":"feedback","body":"x"}],"references":[]}`, true
	}
	d.routeFn = func(string, []memvault.LearnCandidate, []string) (memvault.RouteResult, error) {
		return memvault.RouteResult{
			Committed: 1,
			Queued:    2,
			Written:   []memvault.WrittenNote{{ID: "prefer-x-ab12", Title: "prefer x"}},
		}, nil
	}
	d.enqueue("/repo/a", "/t/1.jsonl", "")
	d.flush("/repo/a")

	if len(*got) != 1 {
		t.Fatalf("published %d events, want exactly 1 per pass: %+v", len(*got), *got)
	}
	ev := (*got)[0]
	if ev.Kind != baseds.MemoryActivity_DistillBatch || ev.Cwd != "/repo/a" || ev.Sessions != 1 {
		t.Fatalf("pass event = %+v", ev)
	}
	if ev.Committed != 1 || ev.Queued != 2 {
		t.Errorf("Committed/Queued = %d/%d, want 1/2", ev.Committed, ev.Queued)
	}
	if len(ev.Notes) != 1 || ev.Notes[0].Id != "prefer-x-ab12" || ev.Notes[0].Title != "prefer x" {
		t.Errorf("Notes = %+v, want the one note the pass wrote", ev.Notes)
	}
	if ev.Id == "" || ev.Ts == 0 {
		t.Fatalf("event without an id/timestamp cannot be watermarked: %+v", ev)
	}
}

// A pass that wrote nothing is still a pass the panel reports — as a level, not an utterance.
func TestFlushPublishesABarrenPassWithNoNotes(t *testing.T) {
	got := captureActivity(t)
	d := newDistiller(filepath.Join(t.TempDir(), "q.json"))
	d.distillFn = func(claudePath, model, corpus string) (string, bool) {
		return `{"candidates":[],"references":[]}`, true
	}
	d.routeFn = func(string, []memvault.LearnCandidate, []string) (memvault.RouteResult, error) {
		t.Fatal("routeFn must not run with nothing to route")
		return memvault.RouteResult{}, nil
	}
	d.enqueue("/repo/a", "/t/1.jsonl", "")
	d.flush("/repo/a")

	if len(*got) != 1 || (*got)[0].Kind != baseds.MemoryActivity_DistillBatch {
		t.Fatalf("events = %+v, want one distill-batch", *got)
	}
	if len((*got)[0].Notes) != 0 {
		t.Errorf("Notes = %+v, want none", (*got)[0].Notes)
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
