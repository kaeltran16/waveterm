package orchestrate

import (
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// gateBlocked reports whether a completed-but-unreleased gate is halting the DAG.
func gateBlocked(g *waveobj.TaskGroup) bool {
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.Gate && t.State == TaskState_Done && !t.Released {
			return true
		}
	}
	return false
}

// ReadyTasks returns pending tasks whose deps are all done/skipped, ordered by id.
// A done, unreleased gate halts everything (spec: "halts the DAG at its completion").
func ReadyTasks(g *waveobj.TaskGroup) []string {
	if gateBlocked(g) {
		return nil
	}
	var out []string
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.State != TaskState_Pending {
			continue
		}
		ok := true
		for _, d := range t.Deps {
			if !depTerminal(g, d) {
				ok = false
				break
			}
		}
		if ok {
			out = append(out, t.ID)
		}
	}
	return out
}

func depTerminal(g *waveobj.TaskGroup, id string) bool {
	for i := range g.Tasks {
		if g.Tasks[i].ID == id {
			s := g.Tasks[i].State
			return s == TaskState_Done || s == TaskState_Skipped
		}
	}
	return false
}

// NextToSpawn returns ready tasks the engine should spawn now: ready minus running,
// capped so running+new <= Parallelism, ordered by id.
func NextToSpawn(g *waveobj.TaskGroup) []string {
	running := 0
	for i := range g.Tasks {
		if g.Tasks[i].State == TaskState_Running {
			running++
		}
	}
	room := g.Parallelism - running
	if room <= 0 {
		return nil
	}
	ready := ReadyTasks(g)
	if len(ready) > room {
		ready = ready[:room]
	}
	return ready
}

// MarkRunning assigns a spawned child run to a ready task.
func MarkRunning(g *waveobj.TaskGroup, taskID, runID string) error {
	for i := range g.Tasks {
		if g.Tasks[i].ID == taskID {
			g.Tasks[i].State = TaskState_Running
			g.Tasks[i].RunID = runID
			return nil
		}
	}
	return fmt.Errorf("no task %q", taskID)
}

// ApproveGate releases a completed gate so successors may run.
func ApproveGate(g *waveobj.TaskGroup) *waveobj.TaskGroup {
	for i := range g.Tasks {
		if g.Tasks[i].Gate && g.Tasks[i].State == TaskState_Done {
			g.Tasks[i].Released = true
		}
	}
	RecomputeDagStatus(g)
	return g
}

// SendBackGate reopens a completed gate: it must re-spawn (RunID cleared) from a fresh worktree.
func SendBackGate(g *waveobj.TaskGroup) *waveobj.TaskGroup {
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.Gate && t.State == TaskState_Done {
			t.State = TaskState_Running
			t.Released = false
			t.RunID = ""
		}
	}
	RecomputeDagStatus(g)
	return g
}

// RetryTask re-spawns a failed task and resets the consecutive-failure counter.
func RetryTask(g *waveobj.TaskGroup, taskID string) error {
	for i := range g.Tasks {
		if g.Tasks[i].ID == taskID {
			g.Tasks[i].State = TaskState_Running
			g.Tasks[i].RunID = ""
			g.Failures = 0
			RecomputeDagStatus(g)
			return nil
		}
	}
	return fmt.Errorf("no task %q", taskID)
}

// SkipTask marks a failed/ready task skipped (no spawn).
func SkipTask(g *waveobj.TaskGroup, taskID string) error {
	for i := range g.Tasks {
		if g.Tasks[i].ID == taskID {
			g.Tasks[i].State = TaskState_Skipped
			g.Tasks[i].RunID = ""
			RecomputeDagStatus(g)
			return nil
		}
	}
	return fmt.Errorf("no task %q", taskID)
}

// CancelGroup terminally cancels: pending/ready -> skipped, running -> cancelled.
func CancelGroup(g *waveobj.TaskGroup) *waveobj.TaskGroup {
	for i := range g.Tasks {
		t := &g.Tasks[i]
		switch t.State {
		case TaskState_Pending, TaskState_Ready:
			t.State = TaskState_Skipped
		case TaskState_Running:
			t.State = TaskState_Cancelled
		}
	}
	g.Status = DagStatus_Cancelled
	return g
}
