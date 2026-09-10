// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func engineRun() waveobj.Run {
	return waveobj.Run{
		OID: "r1", ID: "r1", Mode: RunMode_Orchestrator,
		Orchestration: Orchestration_Engine, Runtime: "pi",
		Status: RunStatus_Executing,
	}
}

// A launched engine run's scheduler settings stay mutable while it is live — the session sheet's one
// genuinely changeable surface.
func TestEngineSettingsBlockerAllowsLiveEngineRun(t *testing.T) {
	for _, status := range []string{RunStatus_Planning, RunStatus_Executing, RunStatus_Blocked, RunStatus_AwaitingReview} {
		r := engineRun()
		r.Status = status
		if got := EngineSettingsBlocker(&r); got != "" {
			t.Errorf("status %q: blocker = %q, want none", status, got)
		}
	}
}

// Terminal is terminal: nothing is scheduled any more, so offering a dial that changes nothing is a lie.
func TestEngineSettingsBlockerRejectsTerminalRun(t *testing.T) {
	for _, status := range []string{RunStatus_Done, RunStatus_Cancelled} {
		r := engineRun()
		r.Status = status
		if got := EngineSettingsBlocker(&r); got == "" {
			t.Errorf("status %q: want a blocker", status)
		}
	}
}

// Only an engine orchestrator has a scheduler to reconfigure.
func TestEngineSettingsBlockerRejectsNonEngineRun(t *testing.T) {
	adaptive := engineRun()
	adaptive.Orchestration = Orchestration_Adaptive
	if got := EngineSettingsBlocker(&adaptive); got == "" {
		t.Error("adaptive orchestration: want a blocker")
	}
	pipeline := engineRun()
	pipeline.Mode = RunMode_Pipeline
	pipeline.Orchestration = ""
	if got := EngineSettingsBlocker(&pipeline); got == "" {
		t.Error("pipeline mode: want a blocker")
	}
	quick := engineRun()
	quick.Mode = RunMode_Quick
	quick.Orchestration = ""
	if got := EngineSettingsBlocker(&quick); got == "" {
		t.Error("quick mode: want a blocker")
	}
}

// A legacy engine run stores no orchestration string; the runtime-decided resolution must still make it
// mutable rather than silently read as adaptive.
func TestEngineSettingsBlockerResolvesLegacyOrchestration(t *testing.T) {
	r := engineRun()
	r.Orchestration = ""
	if got := EngineSettingsBlocker(&r); got != "" {
		t.Fatalf("legacy pi engine run: blocker = %q, want none", got)
	}
	r.Runtime = "claude"
	if got := EngineSettingsBlocker(&r); got == "" {
		t.Fatal("legacy non-pi run resolves adaptive; want a blocker")
	}
}

// Before the DAG exists nothing has crossed the gate, so the gate is whatever the human last chose.
func TestGateSettingsBlockerAllowsBeforeSubmission(t *testing.T) {
	r := engineRun()
	if got := GateSettingsBlocker(&r, nil); got != "" {
		t.Fatalf("no group: blocker = %q, want none", got)
	}
}

// An unreleased, undispatched plan still has its whole plan gate ahead of it.
func TestGateSettingsBlockerAllowsUnreleasedUndispatchedPlan(t *testing.T) {
	r := engineRun()
	g := &waveobj.TaskGroup{PlanGate: true, Tasks: []waveobj.TaskNode{{ID: "t-1", State: "pending"}}}
	if got := GateSettingsBlocker(&r, g); got != "" {
		t.Fatalf("blocker = %q, want none", got)
	}
}

// Once the human approved the plan the gate is spent — the workers it was holding may already be live.
func TestGateSettingsBlockerRejectsReleasedGate(t *testing.T) {
	r := engineRun()
	g := &waveobj.TaskGroup{PlanGate: true, PlanApprovedTs: 1, Tasks: []waveobj.TaskNode{{ID: "t-1", State: "pending"}}}
	if got := GateSettingsBlocker(&r, g); got == "" {
		t.Fatal("released gate: want a blocker")
	}
}

// A dispatched child is the other half of "work has crossed the gate".
func TestGateSettingsBlockerRejectsDispatchedWork(t *testing.T) {
	r := engineRun()
	g := &waveobj.TaskGroup{Tasks: []waveobj.TaskNode{{ID: "t-1", State: "running", RunID: "child-1"}}}
	if got := GateSettingsBlocker(&r, g); got == "" {
		t.Fatal("dispatched task: want a blocker")
	}
}

// A terminal group schedules nothing, so a gate flipped onto it would hold nothing.
func TestGateSettingsBlockerRejectsTerminalGroup(t *testing.T) {
	r := engineRun()
	for _, status := range []string{"done", "cancelled"} {
		g := &waveobj.TaskGroup{Status: status, Tasks: []waveobj.TaskNode{{ID: "t-1", State: "pending"}}}
		if got := GateSettingsBlocker(&r, g); got == "" {
			t.Errorf("status %q: want a blocker", status)
		}
	}
}

// Pre-DAG the run is the pending carrier: DagSubmit reads exactly these fields, so writing them here is
// the same single source of truth the pre-rail runs already used.
func TestApplyPendingEngineSettingsWritesRun(t *testing.T) {
	r := engineRun()
	route := &waveobj.RoutePin{Runtime: "pi", Tier: "capable"}
	gate := false
	got := ApplyPendingEngineSettings(r, PendingEngineSettings{Parallelism: intPtr(3), WorkerRoute: route, PlanGate: &gate})
	if got.Parallelism != 3 {
		t.Errorf("parallelism = %d, want 3", got.Parallelism)
	}
	if got.WorkerRoute == nil || *got.WorkerRoute != *route {
		t.Errorf("worker route = %+v, want %+v", got.WorkerRoute, route)
	}
	if got.PlanGatePending == nil || *got.PlanGatePending {
		t.Errorf("plan gate pending = %v, want an explicit false", got.PlanGatePending)
	}
}

// An omitted width is not a request to clear one: the field is optional precisely so a sheet that only
// touched the route cannot silently forget the width the scheduler is running at.
func TestApplyPendingEngineSettingsLeavesOmittedWidth(t *testing.T) {
	r := engineRun()
	r.Parallelism = 5
	got := ApplyPendingEngineSettings(r, PendingEngineSettings{PlanGate: boolPtr(false)})
	if got.Parallelism != 5 {
		t.Errorf("parallelism = %d, want the run's existing 5", got.Parallelism)
	}
}

// A nil route clears the pending worker default rather than leaving the previous one in place.
func TestApplyPendingEngineSettingsClearsRoute(t *testing.T) {
	r := engineRun()
	r.WorkerRoute = &waveobj.RoutePin{Runtime: "pi", Tier: "capable"}
	got := ApplyPendingEngineSettings(r, PendingEngineSettings{Parallelism: intPtr(2)})
	if got.WorkerRoute != nil {
		t.Errorf("worker route = %+v, want nil", got.WorkerRoute)
	}
}

// Post-DAG the group is the scheduler's source of truth; the run keeps its launch snapshot.
func TestApplyLiveEngineSettingsWritesGroupOnly(t *testing.T) {
	g := waveobj.TaskGroup{OID: "d1", Parallelism: 2}
	route := &waveobj.RoutePin{Runtime: "pi", Tier: "capable"}
	got := ApplyLiveEngineSettings(g, PendingEngineSettings{Parallelism: intPtr(5), WorkerRoute: route})
	if got.Parallelism != 5 {
		t.Errorf("parallelism = %d, want 5", got.Parallelism)
	}
	if got.WorkerRoute == nil || *got.WorkerRoute != *route {
		t.Errorf("worker route = %+v, want %+v", got.WorkerRoute, route)
	}
}

// The same omission rule holds on the live side.
func TestApplyLiveEngineSettingsLeavesOmittedWidth(t *testing.T) {
	g := waveobj.TaskGroup{OID: "d1", Parallelism: 6}
	got := ApplyLiveEngineSettings(g, PendingEngineSettings{})
	if got.Parallelism != 6 {
		t.Errorf("parallelism = %d, want the group's existing 6", got.Parallelism)
	}
}

// The sheet's starting point: what the run will actually dispatch with, before a DAG exists.
func TestRunEngineSettingsReadsLaunchForm(t *testing.T) {
	r := engineRun()
	r.Parallelism = 4
	route := &waveobj.RoutePin{Runtime: "claude", Tier: "capable"}
	r.WorkerRoute = route
	got := RunEngineSettings(r, nil)
	if got.Parallelism == nil || *got.Parallelism != 4 {
		t.Errorf("parallelism = %v, want the run's 4", got.Parallelism)
	}
	if got.WorkerRoute == nil || *got.WorkerRoute != *route {
		t.Errorf("worker route = %+v, want the run's", got.WorkerRoute)
	}
	if got.PlanGate == nil || !*got.PlanGate {
		t.Errorf("plan gate = %v, want the default true for a top-level plan", got.PlanGate)
	}
}

// Once the group exists it, not the run, is what the scheduler reads.
func TestRunEngineSettingsPrefersGroupAfterSubmit(t *testing.T) {
	r := engineRun()
	r.Parallelism = 4
	g := &waveobj.TaskGroup{Parallelism: 2, PlanGate: false}
	got := RunEngineSettings(r, g)
	if got.Parallelism == nil || *got.Parallelism != 2 {
		t.Errorf("parallelism = %v, want the group's 2", got.Parallelism)
	}
	if got.PlanGate == nil || *got.PlanGate {
		t.Errorf("plan gate = %v, want the group's false", got.PlanGate)
	}
}

// A sidecar run's plan is never gated (DagSubmit's own rule), so the sheet must not claim otherwise by
// defaulting to true.
func TestRunEngineSettingsDefaultsGateOffForChildPlan(t *testing.T) {
	r := engineRun()
	r.ParentLeadORef = "tab:lead"
	got := RunEngineSettings(r, nil)
	if got.PlanGate == nil || *got.PlanGate {
		t.Errorf("plan gate = %v, want false for a child plan", got.PlanGate)
	}
}
