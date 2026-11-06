package orchestrate

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// a dependent in flight read its ancestors' For later tasks at dispatch (predecessorHandoff), which an early start
// reaches while the predecessor is still under review, so typing the section again would repeat it
func TestForLaterNotRetypedToRunningDescendant(t *testing.T) {
	ctx, dag, worker := seedReviewDag(t)
	addRunningTask(t, ctx, dag, waveobj.TaskNode{ID: "t-2", Label: "b", Deps: []string{"t-0"}})
	setWorkerReport(t, ctx, dag.ChannelId, worker.ID, structuredReport("Added fmtDate.", "None", "None", forLaterText, "None"))
	stubReviewTree(t, worker.EndCommit)
	captureSpawns(t)
	f := newFakeLead(t)
	passPlain(t, ctx, dag)
	if got := taskNamed(t, ctx, dag.OID, "t-2"); len(got.LeadTold) != 0 || len(got.LeadNotes) != 0 {
		t.Fatalf("a running dependent read the section at dispatch, got told %q notes %q", got.LeadTold, got.LeadNotes)
	}
	joined := strings.Join(f.sends, "\n")
	if strings.Contains(joined, "passed review; its worker's For later tasks") {
		t.Fatalf("the section must not be typed again, got %q", f.sends)
	}
	PostWake(ctx, dag.ChannelId, dag.RunID, "wake: next")
	want := "t-0's For later tasks reached t-2 (at dispatch)"
	if joined = strings.Join(f.sends, "\n"); !strings.Contains(joined, want) {
		t.Fatalf("the lead's next wake must carry %q, got %q", want, f.sends)
	}
}

// the reviewer's downstream note exists only after the pass, so a running dependent never read it at dispatch
func TestReviewDownstreamTypedToRunningDependent(t *testing.T) {
	ctx, dag, worker := seedReviewDag(t)
	addRunningTask(t, ctx, dag, waveobj.TaskNode{ID: "t-2", Label: "b", Deps: []string{"t-0"}})
	stubReviewTree(t, worker.EndCommit)
	captureSpawns(t)
	f := newFakeLead(t)
	passWithDownstream(t, ctx, dag)
	want := "t-0 passed review with a note for your task: " + forLaterText
	if !strings.Contains(strings.Join(f.sends, "\n"), want) {
		t.Fatalf("want %q typed to t-2's worker, got %q", want, f.sends)
	}
	if got := taskNamed(t, ctx, dag.OID, "t-2").LeadTold; len(got) != 1 || got[0] != want {
		t.Fatalf("the typed note must be recorded as the engine's, got %q", got)
	}
}
