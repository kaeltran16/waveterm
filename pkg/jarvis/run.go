// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// Run statuses.
const (
	RunStatus_Planning       = "planning"
	RunStatus_AwaitingReview = "awaiting-review"
	RunStatus_Executing      = "executing"
	RunStatus_Blocked        = "blocked"
	RunStatus_Done           = "done"
	RunStatus_Cancelled      = "cancelled"
)

// Phase states.
const (
	PhaseState_Pending = "pending"
	PhaseState_Running = "running"
	PhaseState_Blocked = "blocked"
	PhaseState_Done    = "done"
	PhaseState_Failed  = "failed"
	PhaseState_Skipped = "skipped"
)

// Phase kinds.
const (
	PhaseKind_Brainstorm = "brainstorm"
	PhaseKind_Plan       = "plan"
	PhaseKind_Execute    = "execute"
	PhaseKind_Custom     = "custom"
)

// AdvanceRun actions (carried on CommandAdvanceRunData.Action).
const (
	RunAction_Complete = "complete"
	RunAction_Approve  = "approve"
	RunAction_SendBack = "sendback"
)

// DefaultPlaybook is the hardcoded superpowers pipeline (spec §"default playbook"): brainstorm -> plan
// (gate) -> execute (fresh context). Piece 3 replaces this with the resolved Jarvis profile.
func DefaultPlaybook() []waveobj.RunPhase {
	return []waveobj.RunPhase{
		{Kind: PhaseKind_Brainstorm, Skill: "superpowers:brainstorming", State: PhaseState_Pending},
		{Kind: PhaseKind_Plan, Skill: "superpowers:writing-plans", State: PhaseState_Pending, Gate: true},
		{Kind: PhaseKind_Execute, Skill: "superpowers:executing-plans", State: PhaseState_Pending, FreshCtx: true},
	}
}

// NewRun builds a run from a playbook: deep-copies the phases, marks the first phase running, derives
// status. ts is supplied by the caller (mirrors NewChannelMessage) for testability.
func NewRun(goal, workspaceId, projectPath string, playbook []waveobj.RunPhase, ts int64) waveobj.Run {
	phases := make([]waveobj.RunPhase, len(playbook))
	copy(phases, playbook)
	if len(phases) > 0 {
		phases[0].State = PhaseState_Running
	}
	r := waveobj.Run{
		ID:          uuid.NewString(),
		Goal:        goal,
		WorkspaceId: workspaceId,
		ProjectPath: projectPath,
		Status:      RunStatus_Planning,
		Phases:      phases,
		CreatedTs:   ts,
	}
	recomputeStatus(&r)
	return r
}

// recomputeStatus derives run.Status from phase states. Single source of truth: never set Status
// directly outside this function (except CancelRun, a terminal override).
func recomputeStatus(r *waveobj.Run) {
	firstOpen := -1
	for i, p := range r.Phases {
		if p.State != PhaseState_Done && p.State != PhaseState_Skipped {
			firstOpen = i
			break
		}
	}
	if firstOpen == -1 {
		r.Status = RunStatus_Done
		return
	}
	cur := r.Phases[firstOpen]
	if cur.State == PhaseState_Blocked || cur.State == PhaseState_Failed {
		r.Status = RunStatus_Blocked
		return
	}
	if cur.State == PhaseState_Pending && firstOpen > 0 &&
		r.Phases[firstOpen-1].Gate && r.Phases[firstOpen-1].State == PhaseState_Done {
		r.Status = RunStatus_AwaitingReview
		return
	}
	if cur.Kind == PhaseKind_Execute {
		r.Status = RunStatus_Executing
		return
	}
	r.Status = RunStatus_Planning
}

// CompletePhase marks phaseIdx done, records the reported artifacts, and advances: a non-gated phase
// auto-starts its successor; a gated phase halts (recomputeStatus derives awaiting-review). Completion
// is reported in by the caller (UI action or the ~/.claude hook) — the engine does not detect it.
func CompletePhase(run waveobj.Run, phaseIdx int, artifacts []string) (waveobj.Run, error) {
	if phaseIdx < 0 || phaseIdx >= len(run.Phases) {
		return run, fmt.Errorf("phase index %d out of range", phaseIdx)
	}
	if run.Phases[phaseIdx].State != PhaseState_Running {
		return run, fmt.Errorf("phase %d is %q, not running", phaseIdx, run.Phases[phaseIdx].State)
	}
	run.Phases[phaseIdx].State = PhaseState_Done
	run.Phases[phaseIdx].Artifacts = append(run.Phases[phaseIdx].Artifacts, artifacts...)
	if !run.Phases[phaseIdx].Gate && phaseIdx+1 < len(run.Phases) {
		run.Phases[phaseIdx+1].State = PhaseState_Running
	}
	recomputeStatus(&run)
	return run, nil
}

// gateIndex returns the index of the completed gate a halted run is waiting on, or -1. It is the phase
// immediately before the first still-open phase, when that phase is a Done gate.
func gateIndex(run waveobj.Run) int {
	for i, p := range run.Phases {
		if p.State != PhaseState_Done && p.State != PhaseState_Skipped {
			if i > 0 && run.Phases[i-1].Gate && run.Phases[i-1].State == PhaseState_Done {
				return i - 1
			}
			return -1
		}
	}
	return -1
}

// ApproveGate releases a halted run: starts the phase after the completed gate.
func ApproveGate(run waveobj.Run) (waveobj.Run, error) {
	if run.Status != RunStatus_AwaitingReview {
		return run, fmt.Errorf("run is %q, not awaiting-review", run.Status)
	}
	gi := gateIndex(run)
	if gi < 0 || gi+1 >= len(run.Phases) {
		return run, fmt.Errorf("no phase to release after the gate")
	}
	run.Phases[gi+1].State = PhaseState_Running
	recomputeStatus(&run)
	return run, nil
}

// SendBackGate re-opens the gate phase so its work is redone (the successor stays pending).
func SendBackGate(run waveobj.Run) (waveobj.Run, error) {
	if run.Status != RunStatus_AwaitingReview {
		return run, fmt.Errorf("run is %q, not awaiting-review", run.Status)
	}
	gi := gateIndex(run)
	if gi < 0 {
		return run, fmt.Errorf("no completed gate to send back")
	}
	run.Phases[gi].State = PhaseState_Running
	recomputeStatus(&run)
	return run, nil
}

// CancelRun terminally cancels a run: open phases become skipped, completed phases are preserved.
func CancelRun(run waveobj.Run) waveobj.Run {
	for i := range run.Phases {
		if run.Phases[i].State == PhaseState_Pending || run.Phases[i].State == PhaseState_Running {
			run.Phases[i].State = PhaseState_Skipped
		}
	}
	run.Status = RunStatus_Cancelled
	return run
}

// BuildPhasePrompt is the claude worker's initial prompt for a phase: run the phase's skill against the
// goal, using any artifacts prior phases produced. Piece 4 prepends the resolved Jarvis principles.
func BuildPhasePrompt(phase waveobj.RunPhase, goal string, priorArtifacts []string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Use the %s skill to work this goal, then stop when the phase's deliverable is written.\n", phase.Skill)
	fmt.Fprintf(&b, "Goal: %s\n", goal)
	if len(priorArtifacts) > 0 {
		fmt.Fprintf(&b, "Prior artifacts to build on: %s\n", strings.Join(priorArtifacts, ", "))
	}
	return strings.TrimRight(b.String(), "\n")
}
