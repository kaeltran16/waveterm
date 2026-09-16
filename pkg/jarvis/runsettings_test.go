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

// Only an orchestrator run has a scheduler to reconfigure.
func TestEngineSettingsBlockerRejectsNonOrchestratorRun(t *testing.T) {
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

// Pre-DAG the run is the pending carrier: DagSubmit reads exactly these fields, so writing them here is
// the same single source of truth the pre-rail runs already used.
func TestApplyPendingEngineSettingsWritesRun(t *testing.T) {
	r := engineRun()
	route := &waveobj.RoutePin{Runtime: "pi"}
	got := ApplyPendingEngineSettings(r, PendingEngineSettings{Parallelism: intPtr(3), WorkerRoute: route})
	if got.Parallelism != 3 {
		t.Errorf("parallelism = %d, want 3", got.Parallelism)
	}
	if got.WorkerRoute == nil || *got.WorkerRoute != *route {
		t.Errorf("worker route = %+v, want %+v", got.WorkerRoute, route)
	}
}

// An omitted width is not a request to clear one: the field is optional precisely so a sheet that only
// touched the route cannot silently forget the width the scheduler is running at.
func TestApplyPendingEngineSettingsLeavesOmittedWidth(t *testing.T) {
	r := engineRun()
	r.Parallelism = 5
	got := ApplyPendingEngineSettings(r, PendingEngineSettings{WorkerRoute: &waveobj.RoutePin{Runtime: "pi"}})
	if got.Parallelism != 5 {
		t.Errorf("parallelism = %d, want the run's existing 5", got.Parallelism)
	}
}

// A nil route clears the pending worker default rather than leaving the previous one in place.
func TestApplyPendingEngineSettingsClearsRoute(t *testing.T) {
	r := engineRun()
	r.WorkerRoute = &waveobj.RoutePin{Runtime: "pi"}
	got := ApplyPendingEngineSettings(r, PendingEngineSettings{Parallelism: intPtr(2)})
	if got.WorkerRoute != nil {
		t.Errorf("worker route = %+v, want nil", got.WorkerRoute)
	}
}

// Post-DAG the group is the scheduler's source of truth; the run keeps its launch snapshot.
func TestApplyLiveEngineSettingsWritesGroupOnly(t *testing.T) {
	g := waveobj.TaskGroup{OID: "d1", Parallelism: 2}
	route := &waveobj.RoutePin{Runtime: "pi"}
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
	route := &waveobj.RoutePin{Runtime: "claude"}
	r.WorkerRoute = route
	got := RunEngineSettings(r, nil)
	if got.Parallelism == nil || *got.Parallelism != 4 {
		t.Errorf("parallelism = %v, want the run's 4", got.Parallelism)
	}
	if got.WorkerRoute == nil || *got.WorkerRoute != *route {
		t.Errorf("worker route = %+v, want the run's", got.WorkerRoute)
	}
}

// Once the group exists it, not the run, is what the scheduler reads.
func TestRunEngineSettingsPrefersGroupAfterSubmit(t *testing.T) {
	r := engineRun()
	r.Parallelism = 4
	g := &waveobj.TaskGroup{Parallelism: 2}
	got := RunEngineSettings(r, g)
	if got.Parallelism == nil || *got.Parallelism != 2 {
		t.Errorf("parallelism = %v, want the group's 2", got.Parallelism)
	}
}
