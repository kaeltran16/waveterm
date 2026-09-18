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

// one row per gated task, not one per group: a dag holding three gates used to render a single row
// and the human could not tell which task was waiting.
func TestBuildAttentionUnrollsEveryGatedTask(t *testing.T) {
	g := dagWithStatus("awaiting-review")
	g.Tasks = []waveobj.TaskNode{
		{ID: "t-0", Label: "scaffold", State: "done", Gate: true, LastActivity: 300},
		{ID: "t-1", Label: "migrate", State: "done", Gate: true, LastActivity: 100},
		{ID: "t-2", Label: "released", State: "done", Gate: true, Released: true},
		{ID: "t-3", Label: "running", State: "running", Gate: true},
	}
	out := BuildAttention(AttentionInput{Dags: []*waveobj.TaskGroup{g}})
	var keys []string
	for _, it := range out {
		if it.Kind == AttentionDagGate {
			keys = append(keys, it.Key)
		}
	}
	if len(keys) != 2 {
		t.Fatalf("want 2 dag-gate rows (released and still-running tasks excluded), got %d: %+v", len(keys), out)
	}
	if keys[0] != "dag-gate:dag-1:t-1" || keys[1] != "dag-gate:dag-1:t-0" {
		// oldest first inside the kind, which only means anything because each row carries its own
		// task's LastActivity rather than the group's UpdatedTs.
		t.Fatalf("per-task rows not ordered oldest-first: %v", keys)
	}
	for _, it := range out {
		if it.Kind == AttentionDagGate && !strings.Contains(it.Text, "migrate") && !strings.Contains(it.Text, "scaffold") {
			t.Fatalf("row does not name its task: %q", it.Text)
		}
	}
}

// a gate the engine says it is holding must never vanish from the queue because the task state was a
// combination we did not anticipate.
func TestBuildAttentionKeepsAHeldDagWithNoMatchingTask(t *testing.T) {
	g := dagWithStatus("awaiting-review")
	g.Tasks = []waveobj.TaskNode{{ID: "t-0", Label: "a", State: "running"}}
	out := BuildAttention(AttentionInput{Dags: []*waveobj.TaskGroup{g}})
	for _, it := range out {
		if it.Kind == AttentionDagGate && it.Key == "dag-gate:dag-1" {
			return
		}
	}
	t.Fatalf("held dag lost its gate row entirely: %+v", out)
}

func TestBuildAttentionFallsBackToTheTaskIdWhenUnlabelled(t *testing.T) {
	g := dagWithStatus("awaiting-review")
	g.Tasks = []waveobj.TaskNode{{ID: "t-7", State: "done", Gate: true}}
	out := BuildAttention(AttentionInput{Dags: []*waveobj.TaskGroup{g}})
	for _, it := range out {
		if it.Kind == AttentionDagGate && strings.Contains(it.Text, "t-7") {
			return
		}
	}
	t.Fatalf("unlabelled gated task is unidentifiable: %+v", out)
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
