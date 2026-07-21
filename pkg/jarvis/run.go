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

// Run modes.
const (
	RunMode_Quick        = "quick"
	RunMode_Pipeline     = "pipeline"
	RunMode_Orchestrator = "orchestrator"
)

// Phase kinds.
const (
	PhaseKind_Brainstorm  = "brainstorm"
	PhaseKind_Plan        = "plan"
	PhaseKind_Execute     = "execute"
	PhaseKind_Orchestrate = "orchestrate"
	PhaseKind_Custom      = "custom"
)

// AdvanceRun actions (carried on CommandAdvanceRunData.Action).
const (
	RunAction_Complete = "complete"
	RunAction_Approve  = "approve"
	RunAction_SendBack = "sendback"
	RunAction_Hold     = "hold"
	RunAction_Triage   = "triage"
)

// Triage verdicts (adaptive orchestrator).
const (
	TriageVerdict_Quick = "quick"
	TriageVerdict_Plan  = "plan"
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

// DefaultOrchestratorPlaybook is a single adaptive "orchestrate" phase. The lead plans and dispatches
// its own subagents; gate=true tells the lead (via BuildOrchestratePrompt) to hold for plan review.
func DefaultOrchestratorPlaybook(gate bool) []waveobj.RunPhase {
	return []waveobj.RunPhase{
		{Kind: PhaseKind_Orchestrate, Skill: "superpowers:subagent-driven-development", State: PhaseState_Pending, Gate: gate},
	}
}

// QuickPlaybook is a single bare execute phase: one worker, no plan gate, fresh context, no skill
// scaffolding. The worker is prompted (BuildQuickPrompt) to do the goal directly and self-report.
func QuickPlaybook() []waveobj.RunPhase {
	return []waveobj.RunPhase{
		{Kind: PhaseKind_Execute, State: PhaseState_Pending, FreshCtx: true},
	}
}

// StripPhaseGates returns a copy of a playbook with every phase's Gate cleared, so a child run never halts
// for human review — the decomposition was already gated once at the parent lead's plan gate. The input
// slice is not mutated.
func StripPhaseGates(phases []waveobj.RunPhase) []waveobj.RunPhase {
	out := make([]waveobj.RunPhase, len(phases))
	copy(out, phases)
	for i := range out {
		out[i].Gate = false
	}
	return out
}

// ParentNotifyLine builds the single line a child run steers back into its parent orchestrator lead when the
// child reaches a terminal state. ok is false unless the run has a parent (ParentLeadORef) AND a terminal
// status — done or cancelled, the only two the backend produces (there is no automatic blocked). The line
// ends in \r so it submits as one input line into the lead's PTY. The lead reads ONLY this line, never the
// child's transcript/diff/evidence — that is what keeps the driver's context small.
func ParentNotifyLine(run *waveobj.Run) (string, bool) {
	if run == nil || run.ParentLeadORef == "" {
		return "", false
	}
	short := run.Goal
	if r := []rune(short); len(r) > 60 {
		short = string(r[:57]) + "..."
	}
	switch run.Status {
	case RunStatus_Done:
		summary := ""
		if run.Evidence != nil {
			summary = fmt.Sprintf(" (%d files +%d/-%d)", len(run.Evidence.Files), run.Evidence.AddTotal, run.Evidence.DelTotal)
		}
		return fmt.Sprintf("[jarvis] child %s %q -> done%s\r", run.ID, short, summary), true
	case RunStatus_Cancelled:
		return fmt.Sprintf("[jarvis] child %s %q -> cancelled\r", run.ID, short), true
	default:
		return "", false
	}
}

// NewRun builds a run from a playbook: deep-copies the phases, marks the first phase running, derives
// status. ts is supplied by the caller (mirrors NewChannelMessage) for testability.
func NewRun(goal, workspaceId, projectPath string, principles waveobj.PrincipleList, mode string, playbook []waveobj.RunPhase, ts int64) waveobj.Run {
	phases := make([]waveobj.RunPhase, len(playbook))
	copy(phases, playbook)
	principlesSnapshot := append(waveobj.PrincipleList(nil), principles...)
	if len(phases) > 0 {
		phases[0].State = PhaseState_Running
		phases[0].StartedTs = ts
	}
	r := waveobj.Run{
		ID:          uuid.NewString(),
		Goal:        goal,
		Mode:        mode,
		WorkspaceId: workspaceId,
		ProjectPath: projectPath,
		Principles:  principlesSnapshot,
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
	if cur.State == PhaseState_Running && cur.Held {
		r.Status = RunStatus_AwaitingReview
		return
	}
	if cur.State == PhaseState_Blocked || cur.State == PhaseState_Failed {
		r.Status = RunStatus_Blocked
		return
	}
	if cur.State == PhaseState_Pending && firstOpen > 0 &&
		r.Phases[firstOpen-1].Gate && r.Phases[firstOpen-1].State == PhaseState_Done {
		r.Status = RunStatus_AwaitingReview
		return
	}
	// orchestrate is a single adaptive phase: a running (non-held) lead is actively working = executing.
	if cur.Kind == PhaseKind_Execute || cur.Kind == PhaseKind_Orchestrate {
		r.Status = RunStatus_Executing
		return
	}
	r.Status = RunStatus_Planning
}

// CompletePhase marks phaseIdx done, records the reported artifacts, and advances: a non-gated phase
// auto-starts its successor; a gated phase halts (recomputeStatus derives awaiting-review). Completion
// is reported in by the caller (UI action or the ~/.claude hook) — the engine does not detect it.
func CompletePhase(run waveobj.Run, phaseIdx int, artifacts []string, ts int64) (waveobj.Run, error) {
	if phaseIdx < 0 || phaseIdx >= len(run.Phases) {
		return run, fmt.Errorf("phase index %d out of range", phaseIdx)
	}
	if run.Phases[phaseIdx].State != PhaseState_Running {
		return run, fmt.Errorf("phase %d is %q, not running", phaseIdx, run.Phases[phaseIdx].State)
	}
	run.Phases[phaseIdx].State = PhaseState_Done
	run.Phases[phaseIdx].DoneTs = ts
	run.Phases[phaseIdx].Artifacts = append(run.Phases[phaseIdx].Artifacts, artifacts...)
	if !run.Phases[phaseIdx].Gate && phaseIdx+1 < len(run.Phases) {
		run.Phases[phaseIdx+1].State = PhaseState_Running
		run.Phases[phaseIdx+1].StartedTs = ts
	}
	recomputeStatus(&run)
	return run, nil
}

// HoldPhase marks a gated running phase as held (the lead paused itself for plan review) and records the
// plan artifact(s) it reported, so the review gate can preview the plan (the orchestrator lead writes the
// plan to a file and passes its path; unlike pipeline, there is no completion hook to record it).
// recomputeStatus derives awaiting-review. Errors (out of range / not running / not gated) fail safe.
func HoldPhase(run waveobj.Run, phaseIdx int, artifacts []string) (waveobj.Run, error) {
	if phaseIdx < 0 || phaseIdx >= len(run.Phases) {
		return run, fmt.Errorf("phase index %d out of range", phaseIdx)
	}
	if run.Phases[phaseIdx].State != PhaseState_Running {
		return run, fmt.Errorf("phase %d is %q, not running", phaseIdx, run.Phases[phaseIdx].State)
	}
	if !run.Phases[phaseIdx].Gate {
		return run, fmt.Errorf("phase %d is not gated; nothing to hold", phaseIdx)
	}
	run.Phases[phaseIdx].Held = true
	run.Phases[phaseIdx].Artifacts = append(run.Phases[phaseIdx].Artifacts, artifacts...)
	recomputeStatus(&run)
	return run, nil
}

// RecordTriage stores an adaptive lead's quick-vs-plan verdict on a running phase. Non-blocking: it
// touches only the Triage field, so the run stays executing (recomputeStatus is unaffected). Out of
// range / not-running fail safe so a stray report is a no-op at the caller.
func RecordTriage(run waveobj.Run, phaseIdx int, verdict, note string) (waveobj.Run, error) {
	if phaseIdx < 0 || phaseIdx >= len(run.Phases) {
		return run, fmt.Errorf("phase index %d out of range", phaseIdx)
	}
	if run.Phases[phaseIdx].State != PhaseState_Running {
		return run, fmt.Errorf("phase %d is %q, not running", phaseIdx, run.Phases[phaseIdx].State)
	}
	run.Phases[phaseIdx].Triage = &waveobj.PhaseTriage{Verdict: verdict, Note: note}
	return run, nil
}

// heldPhaseIndex returns the index of a held running phase (orchestrator plan gate), or -1.
func heldPhaseIndex(run waveobj.Run) int {
	for i := range run.Phases {
		if run.Phases[i].State == PhaseState_Running && run.Phases[i].Held {
			return i
		}
	}
	return -1
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
func ApproveGate(run waveobj.Run, ts int64) (waveobj.Run, error) {
	if run.Status != RunStatus_AwaitingReview {
		return run, fmt.Errorf("run is %q, not awaiting-review", run.Status)
	}
	// orchestrator: a held running phase resumes in place (no successor to start).
	if hi := heldPhaseIndex(run); hi >= 0 {
		run.Phases[hi].Held = false
		recomputeStatus(&run)
		return run, nil
	}
	gi := gateIndex(run)
	if gi < 0 || gi+1 >= len(run.Phases) {
		return run, fmt.Errorf("no phase to release after the gate")
	}
	run.Phases[gi+1].State = PhaseState_Running
	run.Phases[gi+1].StartedTs = ts
	recomputeStatus(&run)
	return run, nil
}

// SendBackGate re-opens the gate phase so its work is redone (the successor stays pending).
func SendBackGate(run waveobj.Run, ts int64) (waveobj.Run, error) {
	if run.Status != RunStatus_AwaitingReview {
		return run, fmt.Errorf("run is %q, not awaiting-review", run.Status)
	}
	gi := gateIndex(run)
	if gi < 0 {
		return run, fmt.Errorf("no completed gate to send back")
	}
	run.Phases[gi].State = PhaseState_Running
	run.Phases[gi].StartedTs = ts
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

// BuildPhasePrompt is the claude worker's initial prompt for a phase: work by the resolved principles,
// run the phase's skill against the goal, using any artifacts prior phases produced. Empty principles
// add nothing (identical to the pre-Piece-4 prompt). The autonomy line keeps a headless worker (no human
// at its terminal) from stalling on a skill's clarifying-question prompts: proceed on reasonable
// assumptions for low-stakes calls, and reserve AskUserQuestion — which surfaces in the cockpit — for
// decisions a wrong guess would actually derail.
func BuildPhasePrompt(phase waveobj.RunPhase, goal string, priorArtifacts []string, principles waveobj.PrincipleList) string {
	var b strings.Builder
	if rendered := RenderPrinciples(principles); rendered != "" {
		fmt.Fprintf(&b, "Work by these principles:\n%s\n\n", rendered)
	}
	fmt.Fprintf(&b, "Use the %s skill to work this goal until the phase's deliverable is written.\n", phase.Skill)
	b.WriteString("You are running headless with no human at your terminal. Make reasonable assumptions for low-stakes or easily-reversible choices and keep going — do not ask about them. Only when a decision is genuinely consequential and a wrong assumption would waste real work, pause and use the AskUserQuestion tool (it reaches the human in the cockpit); otherwise proceed to the deliverable.\n")
	fmt.Fprintf(&b, "Goal: %s\n", goal)
	if len(priorArtifacts) > 0 {
		fmt.Fprintf(&b, "Prior artifacts to build on: %s\n", strings.Join(priorArtifacts, ", "))
	}
	b.WriteString("When the deliverable is fully written, commit your work, then run `wsh jarvis complete <deliverable-path> --commit $(git rev-parse HEAD)` from your working tree (the deliverable path, and the SHA of your own final commit) to record it and hand the run off to the next phase. Run it only once the deliverable actually exists.\n")
	return strings.TrimRight(b.String(), "\n")
}

// BuildQuickPrompt is the worker prompt for a quick run: same headless guidance as a pipeline execute
// phase but no skill directive — just do the goal directly and report completion.
func BuildQuickPrompt(goal string, principles waveobj.PrincipleList) string {
	var b strings.Builder
	if rendered := RenderPrinciples(principles); rendered != "" {
		fmt.Fprintf(&b, "Work by these principles:\n%s\n\n", rendered)
	}
	b.WriteString("You are running headless with no human at your terminal. Make reasonable assumptions for low-stakes or easily-reversible choices and keep going — do not ask about them. Only when a decision is genuinely consequential and a wrong assumption would waste real work, pause and use the AskUserQuestion tool (it reaches the human in the cockpit); otherwise proceed to the deliverable.\n")
	fmt.Fprintf(&b, "Goal: %s\n", goal)
	b.WriteString("When the goal is fully accomplished, commit your work and run `wsh jarvis complete --commit $(git rev-parse HEAD)` from your working tree (the SHA of your own final commit), so the run's evidence reflects exactly your changes.\n")
	return strings.TrimRight(b.String(), "\n")
}

// BuildOrchestratePrompt is the lead's initial prompt for an orchestrator run: plan, then execute
// adaptively by dispatching subagents, carrying the principles down to each. A gated run tells the lead
// to hold after planning; every run tells it to report completion. Self-report verbs are wsh commands.
func BuildOrchestratePrompt(goal string, principles waveobj.PrincipleList, gate bool) string {
	var b strings.Builder
	if rendered := RenderPrinciples(principles); rendered != "" {
		fmt.Fprintf(&b, "Work by these principles, and propagate them into every subagent you dispatch:\n%s\n\n", rendered)
	}
	b.WriteString("You are the lead orchestrator for this goal.\n")
	if gate {
		b.WriteString("Plan the work using the superpowers:writing-plans approach, then execute it adaptively by dispatching your own subagents (superpowers:subagent-driven-development / superpowers:dispatching-parallel-agents).\n")
		b.WriteString("First write the plan to a file, then run `wsh jarvis hold <plan-file-path>` (pass the path so it can be reviewed) and wait — do not dispatch any subagents until you are told to proceed.\n")
		b.WriteString("If this goal is actually a backlog of INDEPENDENT, individually substantial units (a list of issues, several unrelated features), do not execute them all in one context. Make your plan file a decomposition checklist: each unit, the `wsh jarvis run --mode <quick|pipeline|orchestrator>` you will use for it (map small->quick, medium->pipeline, large->orchestrator), and its dependency order; then `wsh jarvis hold <plan-file-path>` as above. After you are told to proceed, create ONE child run per ready unit with `wsh jarvis run \"<unit description + how to verify it>\"` — keep at most 2-3 in flight, and only start a unit whose dependencies have already reported done. You will be woken with a one-line `[jarvis] child <id> ... -> done|cancelled` status per unit; never open a child's transcript, diff, or evidence — that line is all you need. If a unit reports cancelled, use AskUserQuestion to ask whether to retry it or continue without it. When every unit has reported done (or you were told to skip it), run `wsh jarvis complete --commit $(git rev-parse HEAD)` (its evidence is the aggregate of the children merged into your tree). If instead this goal is a single cohesive task, ignore this paragraph and execute it yourself with in-process subagents.\n")
	} else {
		// adaptive: size up the goal first and announce the call (non-blocking) before doing the work.
		b.WriteString("First size up the goal, then announce your call:\n")
		b.WriteString("- If it is a small, well-understood change, run `wsh jarvis triage quick \"<one-line reason>\"` and just make the fix directly — no plan document, and dispatch subagents only if the work genuinely needs them.\n")
		b.WriteString("- If it is larger or ambiguous, run `wsh jarvis triage plan \"<one-line reason>\"`, then plan it with the superpowers:writing-plans approach and execute adaptively by dispatching your own subagents (superpowers:subagent-driven-development / superpowers:dispatching-parallel-agents).\n")
		b.WriteString("Do not wait after triaging — proceed straight into the work you chose.\n")
	}
	// The intended ask channel is AskUserQuestion (it renders as an answerable card in the cockpit and
	// blocks); a question typed in prose does not render, so the run proceeds without an answer.
	b.WriteString("If a genuinely consequential or ambiguous decision comes up mid-run — one where a wrong assumption would waste real work — use the AskUserQuestion tool to ask the human; it renders as an answerable question in the cockpit and blocks until they reply. Never pose such a question in prose: a prose question does not render as a question, so the run just proceeds without an answer.\n")
	fmt.Fprintf(&b, "Goal: %s\n", goal)
	b.WriteString("When the goal is fully accomplished, commit your work and run `wsh jarvis complete --commit $(git rev-parse HEAD)` from your working tree (the SHA of your own final commit), so the run's evidence reflects exactly your changes.\n")
	return strings.TrimRight(b.String(), "\n")
}
