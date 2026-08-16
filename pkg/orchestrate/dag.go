// Package orchestrate is the deterministic DAG engine for orchestrator runs.
package orchestrate

import (
	"fmt"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
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

// DefaultParallelism is applied when the submit data carries 0.
const DefaultParallelism = 2

// ValidateTasks rejects duplicate/empty ids, unknown or self deps, and dependency cycles.
func ValidateTasks(tasks []waveobj.TaskNode) error {
	if len(tasks) == 0 {
		return fmt.Errorf("dag has no tasks")
	}
	seen := map[string]bool{}
	for _, t := range tasks {
		if t.ID == "" {
			return fmt.Errorf("task with empty id")
		}
		if seen[t.ID] {
			return fmt.Errorf("duplicate task id %q", t.ID)
		}
		seen[t.ID] = true
		for _, d := range t.Deps {
			if d == t.ID {
				return fmt.Errorf("task %q depends on itself", t.ID)
			}
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

// NewTaskGroup validates and builds a group; parallelism 0 becomes DefaultParallelism.
func NewTaskGroup(runID, channelId, title string, parallelism int, tasks []waveobj.TaskNode, ts int64) (waveobj.TaskGroup, error) {
	if err := ValidateTasks(tasks); err != nil {
		return waveobj.TaskGroup{}, err
	}
	if parallelism < 1 {
		parallelism = DefaultParallelism
	}
	g := waveobj.TaskGroup{
		ID:          uuid.NewString(),
		RunID:       runID,
		ChannelId:   channelId,
		Title:       title,
		Parallelism: parallelism,
		Tasks:       tasks,
		Status:      DagStatus_Running,
		CreatedTs:   ts,
		UpdatedTs:   ts,
	}
	g.OID = g.ID
	for i := range g.Tasks {
		if g.Tasks[i].State == "" {
			g.Tasks[i].State = TaskState_Pending
		}
	}
	RecomputeDagStatus(&g)
	return g, nil
}

// RecomputeDagStatus derives g.Status from task states. Single source of truth.
// Order matters: cancelled (terminal override) -> done -> blocked -> awaiting-review -> running.
func RecomputeDagStatus(g *waveobj.TaskGroup) {
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
