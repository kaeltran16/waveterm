// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarviscontinuity"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// runWithMeta builds a run carrying meta the way the store hands it back — a decoded JSON map, not the Go
// struct that was written. A test that passes structs would never catch the decode this read depends on.
func runWithMeta(oid, channelOID, goal string, createdTs int64, meta waveobj.MetaMapType) *waveobj.Run {
	return &waveobj.Run{OID: oid, ID: oid, ChannelOID: channelOID, Goal: goal, CreatedTs: createdTs, Meta: meta}
}

func resumeMeta(taskID, summary, status string, updated int64) waveobj.MetaMapType {
	return waveobj.MetaMapType{
		jarviscontinuity.MetaKeyResume: map[string]any{
			"taskId": taskID, "summary": summary, "status": status, "updated": updated,
		},
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
