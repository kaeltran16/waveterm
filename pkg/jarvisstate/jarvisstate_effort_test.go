package jarvisstate

import (
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
