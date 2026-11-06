// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import "testing"

// laneGroup's lane t-1 -> t-2 -> t-3 is the predecessor; t-4 heads a lane of its own that depends on it.

func TestLaneWorkerDoneTipReviewing(t *testing.T) {
	lane := []string{"t-1", "t-2", "t-3"}
	for _, tipState := range []string{TaskState_Reviewing, TaskState_Done, TaskState_BlockedMerge} {
		g := laneGroup(t, true, map[string]string{"t-1": TaskState_Done, "t-2": TaskState_Done, "t-3": tipState})
		taskByID(g, "t-3").RunID = "run-t-3"
		got := laneWorkerDone(g, lane)
		if got == nil || got.ID != "t-3" {
			t.Fatalf("tip %s: laneWorkerDone = %v, want t-3", tipState, got)
		}
	}

	g := laneGroup(t, true, map[string]string{"t-1": TaskState_Done, "t-2": TaskState_Done, "t-3": TaskState_Reviewing})
	if got := laneWorkerDone(g, lane); got != nil {
		t.Fatalf("a tip with no run is not worker-done, got %s", got.ID)
	}

	g = laneGroup(t, true, map[string]string{"t-1": TaskState_Skipped, "t-2": TaskState_Done, "t-3": TaskState_Reviewing})
	taskByID(g, "t-3").RunID = "run-t-3"
	if got := laneWorkerDone(g, lane); got == nil || got.ID != "t-3" {
		t.Fatalf("a skipped earlier task does not hold the lane back, got %v", got)
	}

	g = laneGroup(t, true, map[string]string{"t-1": TaskState_Done, "t-2": TaskState_Done, "t-3": TaskState_Skipped})
	taskByID(g, "t-2").RunID = "run-t-2"
	if got := laneWorkerDone(g, lane); got == nil || got.ID != "t-2" {
		t.Fatalf("a skipped tip moves the tip to the last task that was not skipped, got %v", got)
	}
}

func TestLaneWorkerDoneNotWhileEarlierTaskRunsOrTipReviewFailed(t *testing.T) {
	lane := []string{"t-1", "t-2", "t-3"}
	cases := []struct {
		name   string
		states map[string]string
	}{
		{"earlier task running", map[string]string{"t-1": TaskState_Running, "t-2": TaskState_Pending, "t-3": TaskState_Reviewing}},
		{"earlier task reviewing", map[string]string{"t-1": TaskState_Done, "t-2": TaskState_Reviewing, "t-3": TaskState_Reviewing}},
		{"earlier task pending", map[string]string{"t-1": TaskState_Done, "t-2": TaskState_Pending, "t-3": TaskState_Reviewing}},
		{"tip review-failed", map[string]string{"t-1": TaskState_Done, "t-2": TaskState_Done, "t-3": TaskState_ReviewFailed}},
		{"tip running", map[string]string{"t-1": TaskState_Done, "t-2": TaskState_Done, "t-3": TaskState_Running}},
		{"tip pending", map[string]string{"t-1": TaskState_Done, "t-2": TaskState_Done, "t-3": TaskState_Pending}},
		{"every task skipped", map[string]string{"t-1": TaskState_Skipped, "t-2": TaskState_Skipped, "t-3": TaskState_Skipped}},
	}
	for _, c := range cases {
		g := laneGroup(t, true, c.states)
		for _, id := range lane {
			taskByID(g, id).RunID = "run-" + id
		}
		if got := laneWorkerDone(g, lane); got != nil {
			t.Fatalf("%s: laneWorkerDone = %s, want nil", c.name, got.ID)
		}
	}
}

func TestEarlyBaseLiveStates(t *testing.T) {
	lane := map[string]string{"t-1": TaskState_Done, "t-2": TaskState_Done}
	cases := []struct {
		name      string
		baseState string
		merged    bool
		want      bool
	}{
		{"pending", TaskState_Pending, false, false},
		{"running", TaskState_Running, false, false},
		{"skipped", TaskState_Skipped, false, false},
		{"reviewing", TaskState_Reviewing, false, true},
		{"review-failed", TaskState_ReviewFailed, false, true},
		{"done", TaskState_Done, false, true},
		{"blocked-merge", TaskState_BlockedMerge, false, true},
		{"verifying", TaskState_Verifying, false, true},
		{"verify-failed", TaskState_VerifyFailed, false, true},
		{"merged lane with a verify-failed tip", TaskState_VerifyFailed, true, true},
		{"merged lane, tip done", TaskState_Done, true, true},
	}
	for _, c := range cases {
		states := map[string]string{"t-1": lane["t-1"], "t-2": lane["t-2"], "t-3": c.baseState, "t-4": TaskState_Pending}
		g := laneGroup(t, true, states)
		if c.merged {
			markMerged(g, "t-1", "t-2", "t-3")
		}
		taskByID(g, "t-4").EarlyBaseTask = "t-3"
		if got := earlyBaseLive(g, taskByID(g, "t-4")); got != c.want {
			t.Fatalf("%s: earlyBaseLive = %v, want %v", c.name, got, c.want)
		}
	}

	g := laneGroup(t, true, map[string]string{"t-4": TaskState_Pending})
	if !earlyBaseLive(g, taskByID(g, "t-4")) {
		t.Fatal("a task with no early base is live")
	}
	taskByID(g, "t-4").EarlyBaseTask = "t-99"
	if earlyBaseLive(g, taskByID(g, "t-4")) {
		t.Fatal("a base task that no longer exists is not live")
	}
}

func TestEarlyBaseUnmergedNilOnceBaseLaneMerged(t *testing.T) {
	g := laneGroup(t, true, map[string]string{"t-1": TaskState_Done, "t-2": TaskState_Done, "t-3": TaskState_Reviewing, "t-4": TaskState_Pending})
	lane := laneOf(g, "t-4")

	if got := earlyBaseUnmerged(g, lane); got != nil {
		t.Fatalf("a lane with no early base has none unmerged, got %s", got.ID)
	}

	taskByID(g, "t-4").EarlyBaseTask = "t-3"
	got := earlyBaseUnmerged(g, lane)
	if got == nil || got.ID != "t-3" {
		t.Fatalf("earlyBaseUnmerged = %v, want t-3", got)
	}

	markMerged(g, "t-1", "t-2", "t-3")
	if got := earlyBaseUnmerged(g, lane); got != nil {
		t.Fatalf("the base lane merged, want nil, got %s", got.ID)
	}
}
