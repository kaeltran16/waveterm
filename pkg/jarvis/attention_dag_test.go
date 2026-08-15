package jarvis

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// dagWithStatus builds the minimal dag group for attention tests. Status strings mirror
// orchestrate.DagStatus_* (jarvis cannot import orchestrate — it is the engine's client).
func dagWithStatus(status string) *waveobj.TaskGroup {
	return &waveobj.TaskGroup{
		ID:        "dag-1",
		RunID:     "run-1",
		ChannelId: "ch-1",
		Title:     "ship auth",
		Status:    status,
		Tasks: []waveobj.TaskNode{
			{ID: "t-0", Label: "a", State: "done"},
			{ID: "t-1", Label: "gate", State: "done", Gate: true},
		},
		UpdatedTs: 1000,
	}
}

func TestBuildAttentionDagGate(t *testing.T) {
	in := AttentionInput{
		Channels: []AttentionChannel{{OID: "ch-1", Name: "proj", Runs: []*waveobj.Run{{ID: "run-1", Goal: "ship auth", Status: "executing"}}}},
		Dags:     []*waveobj.TaskGroup{dagWithStatus("awaiting-review")},
	}
	out := BuildAttention(in)
	found := false
	for _, it := range out {
		if it.Kind == AttentionDagGate && it.RunId == "run-1" {
			found = true
		}
	}
	if !found {
		t.Fatalf("dag-gate attention item missing: %+v", out)
	}
}

func TestBuildAttentionDagBlocked(t *testing.T) {
	in := AttentionInput{Dags: []*waveobj.TaskGroup{dagWithStatus("blocked")}}
	out := BuildAttention(in)
	for _, it := range out {
		if it.Kind == AttentionDagBlocked {
			return
		}
	}
	t.Fatalf("dag-blocked attention item missing: %+v", out)
}
