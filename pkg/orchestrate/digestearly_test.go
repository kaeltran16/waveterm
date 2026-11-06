// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"reflect"
	"slices"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestDigestReportCountsRestarts(t *testing.T) {
	g := digestGroup(t, true, plainTasks())
	taskByID(g, "t-0").EarlyRestarts = 1
	taskByID(g, "t-2").EarlyRestarts = 2
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Report.Restarted != 3 {
		t.Fatalf("restarted = %d, want 3", d.Report.Restarted)
	}
}

// forkTasks is t-1 with two dependents, so t-1 is a lane of its own and t-2 -> t-3 is another.
func forkTasks() []waveobj.TaskNode {
	return []waveobj.TaskNode{
		{ID: "t-1", Label: "schema"},
		{ID: "t-2", Label: "api", Deps: []string{"t-1"}},
		{ID: "t-3", Label: "docs", Deps: []string{"t-2"}},
		{ID: "t-4", Label: "ui", Deps: []string{"t-1"}},
	}
}

func TestDigestShowsEarlyBaseAndHeldMerge(t *testing.T) {
	g := digestGroup(t, true, forkTasks())
	setTaskStates(g, map[string]string{"t-1": TaskState_Done, "t-2": TaskState_Done})
	taskByID(g, "t-2").EarlyBaseTask = "t-1"
	taskByID(g, "t-2").EarlyBaseCommit = "tip-1"
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Tasks[0].EarlyBase != "" || d.Tasks[3].EarlyBase != "" {
		t.Fatalf("lanes on the landing head have no early base, got %q / %q", d.Tasks[0].EarlyBase, d.Tasks[3].EarlyBase)
	}
	if d.Tasks[0].MergeState != "ready" {
		t.Fatalf("the base lane is the one offered, got %q", d.Tasks[0].MergeState)
	}
	for _, i := range []int{1, 2} {
		if d.Tasks[i].EarlyBase != "t-1" {
			t.Fatalf("%s: early base = %q, want t-1", g.Tasks[i].ID, d.Tasks[i].EarlyBase)
		}
	}

	// the dependent's lane finishes: its tip waits on the base's merge rather than reading terminal
	setTaskStates(g, map[string]string{"t-3": TaskState_Done})
	d = BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	tip := d.Tasks[2]
	if tip.WaitReason != "merge" || !reflect.DeepEqual(tip.BlockingTaskIds, []string{"t-1"}) {
		t.Fatalf("a held tip waits on the base's merge, got %q %v", tip.WaitReason, tip.BlockingTaskIds)
	}
	if tip.MergeState != "waiting" || tip.HumanActions != nil {
		t.Fatalf("a held tip offers no merge, got %q %v", tip.MergeState, tip.HumanActions)
	}
	if d.Tasks[1].WaitReason != "terminal" {
		t.Fatalf("only the tip is held, got %q for t-2", d.Tasks[1].WaitReason)
	}

	// once the base lane merges, the hold and the base are gone
	markMerged(g, "t-1")
	d = BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	tip = d.Tasks[2]
	if tip.EarlyBase != "" || tip.WaitReason != "terminal" || len(tip.BlockingTaskIds) != 0 || tip.MergeState != "ready" {
		t.Fatalf("a merged base releases the lane, got %+v", tip)
	}
}

// t-1 is done and waiting to merge, so its dependents start on its tip: neither waits on a dependency or on the merge.
func TestDigestEarlyReadyTaskNotWaitingOnDependency(t *testing.T) {
	g := digestGroup(t, true, forkTasks())
	setTaskStates(g, map[string]string{"t-1": TaskState_Done})
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	for _, i := range []int{1, 3} {
		if d.Tasks[i].WaitReason == "dependency" || len(d.Tasks[i].BlockingTaskIds) > 0 {
			t.Fatalf("%s starts early, got %q %v", g.Tasks[i].ID, d.Tasks[i].WaitReason, d.Tasks[i].BlockingTaskIds)
		}
	}
	// t-3 follows t-2 in its lane, which has not started
	if d.Tasks[2].WaitReason != "dependency" {
		t.Fatalf("t-3 waits on t-2, got %q", d.Tasks[2].WaitReason)
	}
	waiting, blocking := dependencyWait(g)
	if !slices.Equal(waiting, []string{"t-3"}) || !slices.Equal(blocking, []string{"t-2"}) {
		t.Fatalf("only t-3 waits on a dependency, got %v / %v", waiting, blocking)
	}
	if got := mergeReadyBlocking(g); slices.Contains(got, "t-2") || slices.Contains(got, "t-4") {
		t.Fatalf("an early-ready task is not blocked by the merge, got %v", got)
	}
}
