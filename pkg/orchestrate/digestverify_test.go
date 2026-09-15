// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestDigestVerifyFailedNeedsTheLead(t *testing.T) {
	g := digestGroup(t, true, chainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_VerifyFailed})
	g.Tasks[0].Merged = true
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Health != "needs-you" {
		t.Fatalf("a failed Verify needs the lead, got %q", d.Health)
	}
	if d.Next.Kind != "human-action" || !reflect.DeepEqual(d.Next.TaskIds, []string{"t-0"}) || !reflect.DeepEqual(d.Next.Actions, []string{"resolve-merge"}) {
		t.Fatalf("next step must name the failed task and the fix-then-continue action, got %+v", d.Next)
	}
	if d.Tasks[0].WaitReason != "verify" || !reflect.DeepEqual(d.Tasks[0].HumanActions, []string{"resolve-merge"}) {
		t.Fatalf("task row must read verify / resolve-merge, got %+v", d.Tasks[0])
	}
}

func TestDigestRunningVerifyIsAWait(t *testing.T) {
	g := digestGroup(t, true, chainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Verifying})
	g.Tasks[0].Merged = true
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Health != "healthy" || d.Next.Kind != "verify-wait" || !reflect.DeepEqual(d.Next.TaskIds, []string{"t-0"}) {
		t.Fatalf("a running Verify is the engine's move, got health %q next %+v", d.Health, d.Next)
	}
	if d.Tasks[0].WaitReason != "verify" {
		t.Fatalf("task row must read verify, got %q", d.Tasks[0].WaitReason)
	}
}

func TestDigestReportNumbers(t *testing.T) {
	g := digestGroup(t, true, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done, "t-1": TaskState_Done, "t-2": TaskState_Running})
	g.Tasks[0].Merged = true
	g.Verify = "task test"
	runs := []*waveobj.Run{
		childRun("run-t-0", []waveobj.RunPhase{phase("quick", 1000, 61_000)}),
		childRun("run-t-1", []waveobj.RunPhase{phase("quick", 2000, 32_000)}),
	}
	runs[0].EndCommit = "sha-0"
	retained := []waveobj.RunEvent{
		retainedEvent(waveobj.RunEventKindChildAnswered, "t-2", 3000),
		retainedEvent(waveobj.RunEventKindChildAnswered, "t-2", 4000),
		retainedEvent(waveobj.RunEventKindTaskForwarded, "t-1", 5000),
	}
	r := BuildDigest(digestSnapshot(g, runs, nil, retained, digestNow)).Report
	if r.WorkerMs != 90_000 {
		t.Fatalf("worker time sums the tasks' run time, got %d", r.WorkerMs)
	}
	if !reflect.DeepEqual(r.Commits, []wshrpc.DagLandedCommit{{TaskId: "t-0", Commit: "sha-0"}}) {
		t.Fatalf("only merged tasks' commits are landed, got %+v", r.Commits)
	}
	if r.Unverified || r.Answered != 2 || r.Forwarded != 1 {
		t.Fatalf("want verified, 2 answered, 1 forwarded, got %+v", r)
	}
}

func TestDigestReportUnverified(t *testing.T) {
	cases := []struct {
		name   string
		merge  bool
		verify string
		want   bool
	}{
		{"a Verify line on a git project", true, "task test", false},
		{"no Verify line", true, "", true},
		{"no merge points to verify at", false, "task test", true},
	}
	for _, c := range cases {
		g := digestGroup(t, c.merge, plainTasks())
		g.Verify = c.verify
		if got := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow)).Report.Unverified; got != c.want {
			t.Fatalf("%s: unverified = %v, want %v", c.name, got, c.want)
		}
	}
}
