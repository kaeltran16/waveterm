// Package orchestrate is the deterministic DAG engine for orchestrator runs.
package orchestrate

import (
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// Task states (derived, never hand-set).
const (
	TaskState_Pending      = "pending"
	TaskState_Ready        = "ready"
	TaskState_Running      = "running"
	TaskState_Stalled      = "stalled" // no child activity past StallThreshold; lead decides (retry/skip/cancel)
	TaskState_Done         = "done"
	TaskState_Failed       = "failed"
	TaskState_Cancelled    = "cancelled"
	TaskState_Skipped      = "skipped"
	TaskState_BlockedMerge = "blocked-merge"
)

// Dag statuses (derived by RecomputeDagStatus; cancelled is a terminal override).
const (
	DagStatus_Running        = "running"
	DagStatus_AwaitingReview = "awaiting-review"
	DagStatus_Blocked        = "blocked"
	DagStatus_Done           = "done"
	DagStatus_Cancelled      = "cancelled"
)

// MaxConsecutiveFailures is the circuit-break: the DAG blocks with a "stop and ask" flag.
const MaxConsecutiveFailures = 3

// MaxTasks is the per-DAG node ceiling, declared in pkg/jarvis so the lead's prompt can state it.
// See jarvis.MaxDagTasks for what the cap is actually for. MaxParallelism is the limit that governs
// concurrent cost; this one only bounds how much one lead can fan out.
const MaxTasks = jarvis.MaxDagTasks
const MaxParallelism = 8

// DefaultParallelism is the width a dag can actually use on its first tick: the tasks with no
// dependencies, capped at MaxParallelism. It exists so a caller that does not pin a width gets the
// shape of the plan instead of a literal — a dag whose four independent tasks drained two at a time
// spent twice the wall clock it needed to.
func DefaultParallelism(tasks []waveobj.TaskNode) int {
	ready := 0
	for _, t := range tasks {
		if len(t.Deps) == 0 {
			ready++
		}
	}
	if ready < 1 {
		return 1
	}
	if ready > MaxParallelism {
		return MaxParallelism
	}
	return ready
}

// ValidateTasks rejects duplicate/empty ids, unknown or self deps, and dependency cycles.
func ValidateTasks(tasks []waveobj.TaskNode) error {
	if len(tasks) == 0 {
		return fmt.Errorf("dag has no tasks")
	}
	seen := map[string]bool{}
	for _, t := range tasks {
		if strings.TrimSpace(t.ID) == "" {
			return fmt.Errorf("task with empty id")
		}
		if strings.TrimSpace(t.Label) == "" {
			return fmt.Errorf("task %q label is required", t.ID)
		}
		if seen[t.ID] {
			return fmt.Errorf("duplicate task id %q", t.ID)
		}
		seen[t.ID] = true
		depSeen := map[string]bool{}
		for _, d := range t.Deps {
			if d == t.ID {
				return fmt.Errorf("task %q depends on itself", t.ID)
			}
			if depSeen[d] {
				return fmt.Errorf("task %q has duplicate dependency %q", t.ID, d)
			}
			depSeen[d] = true
			if !seen[d] && !taskExists(tasks, d) {
				return fmt.Errorf("task %q depends on unknown task %q", t.ID, d)
			}
		}
	}
	if cyc := findCycle(tasks); cyc != "" {
		return fmt.Errorf("dependency cycle involving %q", cyc)
	}
	return nil
}

func taskExists(tasks []waveobj.TaskNode, id string) bool {
	for _, t := range tasks {
		if t.ID == id {
			return true
		}
	}
	return false
}

// findCycle returns a task id participating in a dep cycle, or "" (Kahn's algorithm).
func findCycle(tasks []waveobj.TaskNode) string {
	indeg := map[string]int{}
	succ := map[string][]string{}
	for _, t := range tasks {
		indeg[t.ID] = 0
	}
	for _, t := range tasks {
		for _, d := range t.Deps {
			indeg[t.ID]++
			succ[d] = append(succ[d], t.ID)
		}
	}
	q := []string{}
	for id, n := range indeg {
		if n == 0 {
			q = append(q, id)
		}
	}
	visited := 0
	for len(q) > 0 {
		cur := q[0]
		q = q[1:]
		visited++
		for _, s := range succ[cur] {
			indeg[s]--
			if indeg[s] == 0 {
				q = append(q, s)
			}
		}
	}
	if visited == len(tasks) {
		return ""
	}
	for id, n := range indeg {
		if n > 0 {
			return id
		}
	}
	return ""
}

func NewTaskGroup(runID, channelId, title string, parallelism int, mergeRequired bool, tasks []waveobj.TaskNode, ts int64, workerRoute *waveobj.RoutePin) (waveobj.TaskGroup, error) {
	if strings.TrimSpace(title) == "" {
		return waveobj.TaskGroup{}, fmt.Errorf("title is required")
	}
	if len(tasks) == 0 {
		return waveobj.TaskGroup{}, fmt.Errorf("dag has no tasks")
	}
	if len(tasks) > MaxTasks {
		// the cap is discovered at submit time, after the planning cost is already spent, so the
		// message has to carry the constraint that decides what to do next: a second import is not
		// an option, because the run already owns this dag for good.
		return waveobj.TaskGroup{}, fmt.Errorf("%d tasks exceeds the limit of %d; a run holds exactly one dag for its whole lifetime, so a second import cannot carry the remainder — compress the plan to fit, or split the goal across two runs", len(tasks), MaxTasks)
	}
	if parallelism < 1 || parallelism > MaxParallelism {
		return waveobj.TaskGroup{}, fmt.Errorf("parallelism must be an integer from 1 through %d", MaxParallelism)
	}
	if err := ValidateTasks(tasks); err != nil {
		return waveobj.TaskGroup{}, err
	}
	if workerRoute != nil {
		if _, err := runroute.Resolve(*workerRoute); err != nil {
			return waveobj.TaskGroup{}, fmt.Errorf("workerRoute %w", err)
		}
	}
	// reject non-default engine fields
	for _, t := range tasks {
		if t.State != "" {
			return waveobj.TaskGroup{}, fmt.Errorf("task %q state must be empty", t.ID)
		}
		if t.RunID != "" {
			return waveobj.TaskGroup{}, fmt.Errorf("task %q runid must be empty", t.ID)
		}
		if t.Released {
			return waveobj.TaskGroup{}, fmt.Errorf("task %q released must be false", t.ID)
		}
		if t.Merged {
			return waveobj.TaskGroup{}, fmt.Errorf("task %q merged must be false", t.ID)
		}
		if t.CleanupPending || t.CleanupError != "" {
			return waveobj.TaskGroup{}, fmt.Errorf("task %q cleanup fields must be empty", t.ID)
		}
		if t.LastActivity != 0 {
			return waveobj.TaskGroup{}, fmt.Errorf("task %q lastactivity must be zero", t.ID)
		}
		if t.Attempts != 0 {
			return waveobj.TaskGroup{}, fmt.Errorf("task %q attempts must be zero", t.ID)
		}
		if t.LastFailureKind != "" {
			return waveobj.TaskGroup{}, fmt.Errorf("task %q lastfailurekind must be empty", t.ID)
		}
		if t.Escalations != 0 {
			return waveobj.TaskGroup{}, fmt.Errorf("task %q escalations must be zero", t.ID)
		}
	}
	tasksCopy := make([]waveobj.TaskNode, len(tasks))
	for i, t := range tasks {
		depsCopy := make([]string, len(t.Deps))
		copy(depsCopy, t.Deps)
		tasksCopy[i] = t
		tasksCopy[i].Deps = depsCopy
		tasksCopy[i].State = TaskState_Pending
	}
	g := waveobj.TaskGroup{
		ID:            uuid.NewString(),
		RunID:         runID,
		ChannelId:     channelId,
		Title:         title,
		Parallelism:   parallelism,
		WorkerRoute:   workerRoute,
		MergeRequired: mergeRequired,
		Tasks:         tasksCopy,
		Status:        DagStatus_Running,
		CreatedTs:     ts,
		UpdatedTs:     ts,
	}
	g.OID = g.ID
	RecomputeDagStatus(&g)
	return g, nil
}

func SameDagProposal(a, b *waveobj.TaskGroup) bool {
	if a == nil || b == nil {
		return a == b
	}
	if a.Title != b.Title || a.Parallelism != b.Parallelism || a.MergeRequired != b.MergeRequired || len(a.Tasks) != len(b.Tasks) {
		return false
	}
	if (a.WorkerRoute == nil) != (b.WorkerRoute == nil) {
		return false
	}
	if a.WorkerRoute != nil && *a.WorkerRoute != *b.WorkerRoute {
		return false
	}
	for i := range a.Tasks {
		ta := a.Tasks[i]
		tb := b.Tasks[i]
		if ta.ID != tb.ID || ta.Label != tb.Label || ta.Description != tb.Description || ta.Gate != tb.Gate {
			return false
		}
		if len(ta.Deps) != len(tb.Deps) {
			return false
		}
		for j := range ta.Deps {
			if ta.Deps[j] != tb.Deps[j] {
				return false
			}
		}
		if ta.RunSpec.Runtime != tb.RunSpec.Runtime || ta.RunSpec.Tier != tb.RunSpec.Tier || ta.RunSpec.Model != tb.RunSpec.Model || ta.RunSpec.Goal != tb.RunSpec.Goal || ta.RunSpec.Mode != tb.RunSpec.Mode {
			return false
		}
	}
	return true
}

// RecomputeDagStatus derives g.Status from task states. Single source of truth.
// Order matters: cancelled (terminal override) -> done -> blocked -> awaiting-review -> running.
func RecomputeDagStatus(g *waveobj.TaskGroup) {
	if g.Status == DagStatus_Cancelled {
		return
	}
	cancelled := false
	allTerminal := true
	blocked := false
	gateDone := false
	for i := range g.Tasks {
		t := &g.Tasks[i]
		switch t.State {
		case TaskState_Cancelled:
			cancelled = true
		case TaskState_Failed, TaskState_BlockedMerge:
			blocked = true
		case TaskState_Done:
			if t.Gate && !t.Released {
				gateDone = true
				allTerminal = false
				continue
			}
			if g.MergeRequired && (!t.Merged || t.CleanupPending || t.CleanupError != "") {
				allTerminal = false
				continue
			}
		}
		if t.State != TaskState_Done && t.State != TaskState_Skipped {
			allTerminal = false
		}
	}
	switch {
	case cancelled:
		g.Status = DagStatus_Cancelled
	case allTerminal:
		g.Status = DagStatus_Done
	case blocked || g.Failures >= MaxConsecutiveFailures:
		g.Status = DagStatus_Blocked
	case gateDone:
		g.Status = DagStatus_AwaitingReview
	default:
		g.Status = DagStatus_Running
	}
}

// DeriveTaskStates maps child run status onto tasks (only tasks with a RunID are touched).
func DeriveTaskStates(g *waveobj.TaskGroup, runs map[string]*waveobj.Run) {
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.RunID == "" {
			continue
		}
		r, ok := runs[t.RunID]
		if !ok {
			continue
		}
		switch r.Status {
		case jarvis.RunStatus_Done:
			t.State = TaskState_Done
		case jarvis.RunStatus_Cancelled:
			t.State = TaskState_Cancelled
		case jarvis.RunStatus_Blocked:
			t.State = TaskState_Failed
		}
	}
}
