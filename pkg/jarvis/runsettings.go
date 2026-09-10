// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Live reconfigure of a launched run's engine settings. Two rules keep this from becoming a second
// scheduler. Shape, machine and the active lead route are immutable after launch — changing them means a
// successor run, not an edit. And the pending/live split is explicit: before the DAG is submitted the Run
// carries the settings DagSubmit will consume, after submission the TaskGroup carries them because the
// TaskGroup is what the scheduler reads. Nothing writes both, so there is never a second live truth.
//
// A consequence worth stating rather than hiding: nothing here cancels a worker. Lowering parallelism
// below current occupancy is valid and means the scheduler waits before starting more children.

package jarvis

import (
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// dag statuses mirror orchestrate.DagStatus_* but are spelled here because pkg/orchestrate imports
// pkg/jarvis, never the reverse (the same reason MaxDagTasks lives in this package).
const (
	dagStatusDone      = "done"
	dagStatusCancelled = "cancelled"
)

// PendingEngineSettings is the prospective engine configuration the session sheet writes. Parallelism nil
// means the caller is not touching the width, which is how omission and inheritance are expressed — an
// explicit value is always a width and must be inside the engine's range. PlanGate nil likewise means the
// caller is not touching the gate, which is what lets a spent gate still accept a width change.
//
// WorkerRoute is deliberately not symmetric with those two: a nil route is itself a value (inherit the
// lead), so it is always applied. A caller that omits it is asking for inheritance, not asking for the
// stored route to be left alone — the sheet always sends the route it is showing, so the two readings
// only diverge for a hand-rolled client.
type PendingEngineSettings struct {
	Parallelism *int
	WorkerRoute *waveobj.RoutePin
	PlanGate    *bool
}

// EngineSettingsBlocker returns the reason a run's engine settings can no longer change, or "" when they
// can. Terminal is terminal, and only an engine orchestrator has a scheduler to reconfigure at all.
func EngineSettingsBlocker(r *waveobj.Run) string {
	if r == nil {
		return "the run is gone"
	}
	if r.Status == RunStatus_Done || r.Status == RunStatus_Cancelled {
		return fmt.Sprintf("the run is %s", r.Status)
	}
	if r.Mode != RunMode_Orchestrator {
		return fmt.Sprintf("only an orchestrator run has a scheduler to reconfigure (this run is %s)", r.Mode)
	}
	if ResolveOrchestration(r.Orchestration, r.Runtime) != Orchestration_Engine {
		return "only an engine orchestrator schedules children; an adaptive lead runs its own subagents"
	}
	return ""
}

// GateSettingsBlocker returns the reason the plan gate can no longer be flipped, or "" when it can. The
// test is "has anything crossed the gate", not "which direction": a nil group means nothing was submitted
// yet, which is the widest window; an approved or dispatched group has spent it.
func GateSettingsBlocker(r *waveobj.Run, g *waveobj.TaskGroup) string {
	if g == nil {
		return ""
	}
	if g.Status == dagStatusDone || g.Status == dagStatusCancelled {
		return fmt.Sprintf("the plan is %s", g.Status)
	}
	if g.PlanApprovedTs != 0 {
		return "the plan gate has already been approved"
	}
	for _, task := range g.Tasks {
		if task.RunID != "" {
			return "work has already been dispatched"
		}
	}
	return ""
}

// ApplyPendingEngineSettings writes the prospective settings onto the run. DagSubmit already reads these
// exact fields, so an edit here is the same pending carrier the Run rail writes before launch.
func ApplyPendingEngineSettings(r waveobj.Run, s PendingEngineSettings) waveobj.Run {
	if s.Parallelism != nil {
		r.Parallelism = *s.Parallelism
	}
	r.WorkerRoute = s.WorkerRoute
	if s.PlanGate != nil {
		gate := *s.PlanGate
		r.PlanGatePending = &gate
	}
	return r
}

// ApplyLiveEngineSettings writes them onto the group, which is the scheduler's source of truth once a DAG
// exists. The run is deliberately untouched: keeping its launch snapshot is what stops the sheet having to
// choose between two disagreeing values.
func ApplyLiveEngineSettings(g waveobj.TaskGroup, s PendingEngineSettings) waveobj.TaskGroup {
	if s.Parallelism != nil {
		g.Parallelism = *s.Parallelism
	}
	g.WorkerRoute = s.WorkerRoute
	if s.PlanGate != nil {
		g.PlanGate = *s.PlanGate
	}
	return g
}

// RunEngineSettings is what the sheet starts from: the effective configuration. Before submission that is
// the run's own launch form; after, it is the group's, because that is what the scheduler will honour. The
// pending gate defaults to DagSubmit's own rule — a top-level plan is gated, a child's never is.
func RunEngineSettings(r waveobj.Run, g *waveobj.TaskGroup) PendingEngineSettings {
	if g != nil {
		width := g.Parallelism
		gate := g.PlanGate
		return PendingEngineSettings{Parallelism: &width, WorkerRoute: g.WorkerRoute, PlanGate: &gate}
	}
	gate := r.ParentLeadORef == ""
	if r.PlanGatePending != nil {
		gate = *r.PlanGatePending
	}
	width := r.Parallelism
	return PendingEngineSettings{Parallelism: &width, WorkerRoute: r.WorkerRoute, PlanGate: &gate}
}
