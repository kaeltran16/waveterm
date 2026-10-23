package jarvis

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
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
			{ID: "t-1", Label: "b", State: "done"},
		},
		UpdatedTs: 1000,
	}
}

// A dag stored as awaiting-review held a task gate, which no longer exists: the engine recomputes its status at
// the next tick, and nothing asks the human to approve it in the meantime.
func TestBuildAttentionRaisesNothingForAStoredGatedDag(t *testing.T) {
	in := AttentionInput{
		Channels: []AttentionChannel{{OID: "ch-1", Name: "proj", Runs: []*waveobj.Run{{ID: "run-1", Goal: "ship auth", Status: "executing"}}}},
		Dags:     []*waveobj.TaskGroup{dagWithStatus("awaiting-review")},
	}
	if out := BuildAttention(in); len(out) != 0 {
		t.Fatalf("want no attention item, got %+v", out)
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

func blockedItem(t *testing.T, g *waveobj.TaskGroup) wshrpc.AttentionItem {
	t.Helper()
	for _, it := range BuildAttention(AttentionInput{Dags: []*waveobj.TaskGroup{g}}) {
		if it.Kind == AttentionDagBlocked {
			return it
		}
	}
	t.Fatalf("dag-blocked attention item missing")
	return wshrpc.AttentionItem{}
}

// a blocked merge is not a failure: the row must say what to resolve and how to continue
func TestBuildAttentionNamesABlockedMerge(t *testing.T) {
	g := dagWithStatus("blocked")
	g.Tasks = []waveobj.TaskNode{{ID: "t-0", Label: "a", State: "done"}, {ID: "t-3", Label: "store layer", State: "blocked-merge"}}
	it := blockedItem(t, g)
	if strings.Contains(it.Text, "consecutive failures") || !strings.Contains(it.Text, "store layer") || !strings.Contains(it.Text, "blocked") {
		t.Fatalf("text = %q", it.Text)
	}
	if !strings.Contains(it.Why, "dag merge t-3 --continue") {
		t.Fatalf("why = %q, want the continue command", it.Why)
	}
}

func TestBuildAttentionNamesARefusedMerge(t *testing.T) {
	g := dagWithStatus("blocked")
	g.Tasks = []waveobj.TaskNode{{ID: "t-3", Label: "store layer", State: "blocked-merge", MergeError: "untracked file would be overwritten\nmore"}}
	if it := blockedItem(t, g); !strings.Contains(it.Text, "untracked file would be overwritten") || strings.Contains(it.Text, "\n") {
		t.Fatalf("text = %q, want the refusal's first line", it.Text)
	}
}

func TestBuildAttentionNamesAFailedVerify(t *testing.T) {
	g := dagWithStatus("blocked")
	g.Tasks = []waveobj.TaskNode{{ID: "t-2", Label: "api", State: "verify-failed"}}
	if it := blockedItem(t, g); !strings.Contains(it.Text, "Verify failed") || !strings.Contains(it.Text, "api") {
		t.Fatalf("text = %q", it.Text)
	}
}

func TestBuildAttentionKeepsTheFailureCountForFailedTasks(t *testing.T) {
	g := dagWithStatus("blocked")
	g.Failures = 3
	g.Tasks = []waveobj.TaskNode{{ID: "t-1", Label: "b", State: "failed"}}
	if it := blockedItem(t, g); it.Text != "3 consecutive failures — decide retry/skip." {
		t.Fatalf("text = %q", it.Text)
	}
}
