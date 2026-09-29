package jarvisstate

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestTimelineEffortEventsFoldChunkLabel(t *testing.T) {
	eff := &waveobj.Effort{
		OID:   "eff-1",
		Title: "Scenario gate clearance",
		Events: []waveobj.EffortEvent{
			{Ts: 100, Kind: "chunk-done", Label: "Phase 3", Text: "marked done"},
		},
	}
	evs := Timeline(nil, nil, nil, nil, []*waveobj.Effort{eff}, 0)
	if len(evs) != 1 {
		t.Fatalf("expected 1 event, got %d", len(evs))
	}
	ev := evs[0]
	if ev.Title != "Scenario gate clearance" {
		t.Errorf("title = %q, want effort title", ev.Title)
	}
	if ev.Detail != "Phase 3 · marked done" {
		t.Errorf("detail = %q, want %q", ev.Detail, "Phase 3 · marked done")
	}
	if ev.NavTarget != "effort:eff-1" {
		t.Errorf("navtarget = %q, want effort:eff-1", ev.NavTarget)
	}
}

func TestEffortSummaryCarriesNewestNoteAcrossChunks(t *testing.T) {
	eff := &waveobj.Effort{
		OID:   "eff-2",
		Title: "Anomaly-driven hypothesis system",
		Notes: []waveobj.EffortNote{{Ts: 100, Text: "effort created"}},
		Chunks: []waveobj.EffortChunk{
			{Label: "A1", Status: "done", Notes: []waveobj.EffortNote{{Ts: 300, Text: "older", Author: "agent"}}},
			{Label: "C0", Status: "active", Notes: []waveobj.EffortNote{
				{Ts: 500, Text: "merged to LOCAL DEV, NOT pushed\nsecond line stays in the detail", Author: "agent", Session: "agent:tab-1"},
			}},
		},
	}
	got := EffortSummaryOf(eff).LastNote
	if got == nil {
		t.Fatal("no last note")
	}
	if got.Ts != 500 || got.Session != "agent:tab-1" || got.Chunk != "C0" {
		t.Errorf("last note = %+v, want ts 500 from agent:tab-1 on C0", got)
	}
	if got.Text != "merged to LOCAL DEV, NOT pushed" {
		t.Errorf("text = %q, want only the first line", got.Text)
	}
}

func TestEffortSummaryLastNoteIsCapped(t *testing.T) {
	long := strings.Repeat("x", LastNoteMaxChars+50)
	eff := &waveobj.Effort{OID: "eff-3", Notes: []waveobj.EffortNote{{Ts: 1, Text: long}}}
	got := EffortSummaryOf(eff).LastNote
	if got == nil || len([]rune(got.Text)) != LastNoteMaxChars {
		t.Fatalf("last note text not capped to %d: %+v", LastNoteMaxChars, got)
	}
}

func TestEffortSummaryWithoutNotesHasNoLastNote(t *testing.T) {
	if got := EffortSummaryOf(&waveobj.Effort{OID: "eff-4"}).LastNote; got != nil {
		t.Fatalf("last note = %+v, want nil", got)
	}
}
