// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"fmt"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarviscontinuity"
	"github.com/wavetermdev/waveterm/pkg/jarvisproactive"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// runWithMeta builds a run carrying meta the way the store hands it back — a decoded JSON map, not the Go
// struct that was written. A test that passes structs would never catch the decode this read depends on.
func runWithMeta(oid, channelOID, goal string, createdTs int64, meta waveobj.MetaMapType) *waveobj.Run {
	return &waveobj.Run{OID: oid, ID: oid, ChannelOID: channelOID, Goal: goal, CreatedTs: createdTs, Meta: meta}
}

func proactiveMeta(status, reason string) waveobj.MetaMapType {
	return waveobj.MetaMapType{
		jarvisproactive.MetaKeyProactive: map[string]any{"status": status, "reason": reason},
	}
}

func resumeMeta(taskID, summary, status string, updated int64) waveobj.MetaMapType {
	return waveobj.MetaMapType{
		jarviscontinuity.MetaKeyResume: map[string]any{
			"taskId": taskID, "summary": summary, "status": status, "updated": updated,
		},
	}
}

func TestBuildProactiveRefusalsKeepsOnlyRefusalsNewestFirst(t *testing.T) {
	runs := []*waveobj.Run{
		runWithMeta("r-hit", "c1", "a hit", 500, waveobj.MetaMapType{
			jarvisproactive.MetaKeyProactive: map[string]any{"status": "hit", "nodeId": "n1"},
		}),
		runWithMeta("r-old", "c1", "old refusal", 100, proactiveMeta("none", jarvisproactive.ReasonNoCandidates)),
		runWithMeta("r-new", "c2", "new refusal", 900, proactiveMeta("none", jarvisproactive.ReasonEmbeddingsOff)),
		runWithMeta("r-pending", "c1", "still evaluating", 800, proactiveMeta("pending", "")),
		runWithMeta("r-never", "c1", "never evaluated", 700, nil),
	}

	got := buildProactiveRefusals(runs, 0)

	if got.Total != 2 {
		t.Fatalf("total = %d, want 2 (a hit, a pending and a never-ran are not refusals): %+v", got.Total, got.Refusals)
	}
	if len(got.Refusals) != 2 {
		t.Fatalf("refusals = %+v", got.Refusals)
	}
	if got.Refusals[0].RunORef != "run:r-new" {
		t.Fatalf("newest refusal = %q, want run:r-new", got.Refusals[0].RunORef)
	}
	if got.Refusals[0].Reason != jarvisproactive.ReasonEmbeddingsOff {
		t.Fatalf("reason = %q, want %q", got.Refusals[0].Reason, jarvisproactive.ReasonEmbeddingsOff)
	}
	if got.Refusals[0].ChannelOid != "c2" || got.Refusals[0].Goal != "new refusal" || got.Refusals[0].Ts != 900 {
		t.Fatalf("refusal lost its context: %+v", got.Refusals[0])
	}
	if got.Refusals[1].RunORef != "run:r-old" {
		t.Fatalf("second refusal = %q, want run:r-old", got.Refusals[1].RunORef)
	}
}

// Total must count every refusal, not just the page: the useful diagnostic is the pattern, and it is the
// only thing that survives truncation.
func TestBuildProactiveRefusalsTruncatesButTotalsAll(t *testing.T) {
	const total = maxRefusalLimit + 10
	var runs []*waveobj.Run
	for i := 0; i < total; i++ {
		runs = append(runs, runWithMeta(
			fmt.Sprintf("r%d", i), "c1", "goal", int64(i),
			proactiveMeta("none", jarvisproactive.ReasonNoCandidates)))
	}

	got := buildProactiveRefusals(runs, 3)
	if len(got.Refusals) != 3 {
		t.Fatalf("refusals = %d, want 3", len(got.Refusals))
	}
	if got.Total != total {
		t.Fatalf("total = %d, want %d", got.Total, total)
	}
	if got.Refusals[0].Ts != total-1 {
		t.Fatalf("truncated the wrong end: first ts = %d, want %d", got.Refusals[0].Ts, total-1)
	}

	if capped := buildProactiveRefusals(runs, 999); len(capped.Refusals) != maxRefusalLimit {
		t.Fatalf("limit not capped: got %d, want %d", len(capped.Refusals), maxRefusalLimit)
	}
}

func TestBuildLatestResumePicksNewestNarrative(t *testing.T) {
	runs := []*waveobj.Run{
		runWithMeta("r-old", "c1", "older goal", 100, resumeMeta("task-1", "older text", "paused", 1000)),
		runWithMeta("r-new", "c2", "newer goal", 200, resumeMeta("task-2", "newer text", "completed", 5000)),
		runWithMeta("r-none", "c1", "no narrative", 900, nil),
	}
	runs[1].Status = "done"

	got := buildLatestResume(runs)

	if got.Card == nil {
		t.Fatal("no card returned")
	}
	if got.Card.Summary != "newer text" || got.Card.TaskId != "task-2" || got.Card.Updated != 5000 {
		t.Fatalf("card = %+v", got.Card)
	}
	if got.RunORef != "run:r-new" || got.ChannelOid != "c2" || got.RunStatus != "done" || got.RunGoal != "newer goal" {
		t.Fatalf("card lost the run it belongs to: %+v", got)
	}
}

// The run's own createdts must not decide the ordering: a run created long ago can hold the freshest
// narrative, because the narrative is rewritten at every rest transition.
func TestBuildLatestResumeRanksByNarrativeNotRunAge(t *testing.T) {
	runs := []*waveobj.Run{
		runWithMeta("r-young-run", "c1", "created later", 9000, resumeMeta("task-1", "stale text", "paused", 1000)),
		runWithMeta("r-old-run", "c1", "created earlier", 100, resumeMeta("task-2", "fresh text", "paused", 8000)),
	}

	got := buildLatestResume(runs)
	if got.Card == nil || got.Card.Summary != "fresh text" {
		t.Fatalf("ranked by run age instead of narrative age: %+v", got.Card)
	}
}

// A dismissal is the human saying "stop showing me this"; the launch read must honor it or dismissal only
// works on the one surface that already reads the card.
func TestBuildLatestResumeSkipsDismissedAndEmpty(t *testing.T) {
	dismissed := resumeMeta("task-1", "dismissed text", "paused", 9000)
	dismissed[jarviscontinuity.MetaKeyResumeDismissed] = true
	blank := resumeMeta("task-2", "   ", "paused", 8000)
	runs := []*waveobj.Run{
		runWithMeta("r-dismissed", "c1", "g", 1, dismissed),
		runWithMeta("r-blank", "c1", "g", 2, blank),
		runWithMeta("r-good", "c1", "g", 3, resumeMeta("task-3", "real text", "paused", 100)),
	}

	got := buildLatestResume(runs)
	if got.Card == nil || got.Card.Summary != "real text" {
		t.Fatalf("card = %+v, want the only showable narrative", got.Card)
	}
}

// Nothing to resume is an answer, not an error: a caller must be able to render silence.
func TestBuildLatestResumeWithNoNarratives(t *testing.T) {
	got := buildLatestResume([]*waveobj.Run{runWithMeta("r", "c", "g", 1, nil)})
	if got == nil {
		t.Fatal("returned nil instead of an empty answer")
	}
	if got.Card != nil {
		t.Fatalf("card = %+v, want nil", got.Card)
	}
}
