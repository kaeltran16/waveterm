// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// chainTasks (digest_test.go) is one lane: t-0 -> t-1 -> t-2.

func TestDigestFinishedLaneIsMergedAtItsTip(t *testing.T) {
	g := digestGroup(t, true, chainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done, "t-1": TaskState_Done, "t-2": TaskState_Done})
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Next.Kind != "merge-ready" || !reflect.DeepEqual(d.Next.TaskIds, []string{"t-2"}) {
		t.Fatalf("a finished lane is one merge, named by its last task, got %+v", d.Next)
	}
	if d.Counts.MergeReady != 1 {
		t.Fatalf("one lane is one merge, got %d", d.Counts.MergeReady)
	}
	for i, want := range []string{"waiting", "waiting", "ready"} {
		if d.Tasks[i].MergeState != want {
			t.Fatalf("task %s merge state = %q, want %q", g.Tasks[i].ID, d.Tasks[i].MergeState, want)
		}
	}
	if d.Tasks[0].HumanActions != nil || !reflect.DeepEqual(d.Tasks[2].HumanActions, []string{"resolve-merge"}) {
		t.Fatalf("only the tip offers the merge, got %v / %v", d.Tasks[0].HumanActions, d.Tasks[2].HumanActions)
	}
}

func TestDigestDoneTaskMidLaneDoesNotHoldItsSuccessor(t *testing.T) {
	g := digestGroup(t, true, chainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done})
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Next.Kind != "dispatch" || !reflect.DeepEqual(d.Next.TaskIds, []string{"t-1"}) {
		t.Fatalf("the next task in the lane starts without a merge, got %+v", d.Next)
	}
	if d.Counts.MergeReady != 0 {
		t.Fatalf("a lane still running has nothing to merge, got %d", d.Counts.MergeReady)
	}
}

func TestDigestReportListsOneCommitPerLane(t *testing.T) {
	g := digestGroup(t, true, chainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done, "t-1": TaskState_Done, "t-2": TaskState_Done})
	for i := range g.Tasks {
		g.Tasks[i].Merged = true
	}
	runs := []*waveobj.Run{
		childRun("run-t-0", []waveobj.RunPhase{phase("quick", 1000, 2000)}),
		childRun("run-t-1", []waveobj.RunPhase{phase("quick", 2000, 3000)}),
		childRun("run-t-2", []waveobj.RunPhase{phase("quick", 3000, 4000)}),
	}
	runs[0].EndCommit, runs[1].EndCommit, runs[2].EndCommit = "reported-0", "reported-1", "sha-lane"
	r := BuildDigest(digestSnapshot(g, runs, nil, nil, digestNow)).Report
	if want := []wshrpc.DagLandedCommit{{TaskId: "t-2", Commit: "sha-lane"}}; !reflect.DeepEqual(r.Commits, want) {
		t.Fatalf("a lane lands one commit, got %+v", r.Commits)
	}
}

func TestDigestShapeCountsTasksLanesAndLongestChain(t *testing.T) {
	cases := []struct {
		name  string
		tasks []waveobj.TaskNode
		want  wshrpc.DagPlanShape
	}{
		{"one chain is one lane", chainTasks(), wshrpc.DagPlanShape{Tasks: 3, Lanes: 1, LongestChain: 3}},
		{"independent tasks are a lane each", plainTasks(), wshrpc.DagPlanShape{Tasks: 3, Lanes: 3, LongestChain: 1}},
	}
	for _, c := range cases {
		g := digestGroup(t, true, c.tasks)
		if got := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow)).Shape; got != c.want {
			t.Fatalf("%s: shape = %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestDigestListsLanesInPlanOrder(t *testing.T) {
	tasks := []waveobj.TaskNode{
		{ID: "t-1", Label: "a"},
		{ID: "t-2", Label: "b"},
		{ID: "t-3", Label: "c", Deps: []string{"t-2"}},
	}
	g := digestGroup(t, true, tasks)
	got := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow)).Lanes
	if want := [][]string{{"t-1"}, {"t-2", "t-3"}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("lanes = %v, want %v", got, want)
	}
}
