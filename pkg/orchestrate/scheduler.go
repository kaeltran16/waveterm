package orchestrate

import (
	"fmt"
	"slices"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// ReadyTasks returns the pending tasks startBase lets start, ordered by id.
func ReadyTasks(g *waveobj.TaskGroup) []string {
	var out []string
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.State != TaskState_Pending {
			continue
		}
		if _, ok := startBase(g, t.ID); ok {
			out = append(out, t.ID)
		}
	}
	return out
}

// startBase reports whether taskID may start, and the predecessor lane tip it starts on when that lane has not
// merged yet (an early start, spec 2026-11-06-start-at-done-design). Without merges every dependency must be done
// or skipped. With them a same-lane dependency must be done or skipped, and the cross-lane ones are grouped by
// lane: all merged starts on the landing head (nil base); exactly one unmerged lane that is worker-done starts on
// its tip, because its work is finished and only its review and merge remain. Two unmerged lanes would need a
// merge into the new tree, so the task waits.
func startBase(g *waveobj.TaskGroup, taskID string) (*waveobj.TaskNode, bool) {
	t := taskByID(g, taskID)
	if t == nil {
		return nil, false
	}
	if !g.MergeRequired {
		for _, d := range t.Deps {
			if !depSatisfied(g, taskID, d) {
				return nil, false
			}
		}
		return nil, true
	}
	var unmerged []string
	for _, d := range t.Deps {
		if depSatisfied(g, taskID, d) {
			continue
		}
		lane := laneOf(g, d)
		if taskByID(g, d) == nil || slices.Contains(lane, taskID) {
			return nil, false
		}
		if len(unmerged) > 0 && !slices.Equal(unmerged, lane) {
			return nil, false
		}
		unmerged = lane
	}
	if unmerged == nil {
		return nil, true
	}
	tip := laneWorkerDone(g, unmerged)
	return tip, tip != nil
}

// depSatisfied reports whether dependency depID is met on the landing head. Without merges, finishing is enough.
// With them, a dependency in the same lane only has to be done, because its commits are already in the tree
// the lane shares; one in another lane is satisfied once its whole lane has merged onto the project branch,
// before its Verify passes. A task can start before an unmerged cross-lane dependency is met (startBase).
func depSatisfied(g *waveobj.TaskGroup, taskID, depID string) bool {
	dep := taskByID(g, depID)
	if dep == nil {
		return false
	}
	if !g.MergeRequired {
		return dep.State == TaskState_Done || dep.State == TaskState_Skipped
	}
	lane := laneOf(g, depID)
	if slices.Contains(lane, taskID) {
		return dep.State == TaskState_Skipped || dep.State == TaskState_Done
	}
	return laneMerged(g, lane)
}

// NextToSpawn returns ready tasks the engine should spawn now: ready minus busy,
// capped so busy+new <= Parallelism, the task with the longest chain of dependents first (ties by id):
// a slot spent on a leaf while a chain waits delays the whole run (8e755abf lost ~14 min that way).
// stalled workers still hold their slot — the
// stall flag does not stop the child process, so counting only Running would overshoot Parallelism.
// The circuit-break is enforced here rather than only derived into the status: "blocked" that still
// dispatches spends the whole DAG on the fault the human was supposed to be asked about. Already-
// running workers are untouched — this stops new work, it does not kill work in flight. A human dag
// action clears the streak (applyActionLocked), which is the only way back: with the guard in place
// no fresh success can arrive to clear it on its own. ReadyTasks stays unguarded so the digest can
// still report which tasks are being held back. A plan still under review holds dispatch the same way.
func NextToSpawn(g *waveobj.TaskGroup) []string {
	if g.Failures >= MaxConsecutiveFailures || planReviewHolds(g) {
		return nil
	}
	room := g.Parallelism - slotsInUse(g)
	if room <= 0 {
		return nil
	}
	// one worker per lane: its tasks share a tree, and an earlier task that was retried must not start
	// beside a later one still running in it
	lanes := map[string]bool{}
	for i := range g.Tasks {
		if taskInFlight(g.Tasks[i].State) {
			lanes[LaneWorktreeKey(g, g.Tasks[i].ID)] = true
		}
	}
	ready := ReadyTasks(g)
	behind := chainBehind(g)
	slices.SortStableFunc(ready, func(a, b string) int { return behind[b] - behind[a] })
	var out []string
	for _, id := range ready {
		key := LaneWorktreeKey(g, id)
		if lanes[key] {
			continue
		}
		lanes[key] = true
		out = append(out, id)
		if len(out) == room {
			break
		}
	}
	return out
}

// chainBehind maps each task to the number of tasks on the longest path of dependents below it.
// Tasks must be acyclic, as jarvis.LongestChain assumes.
func chainBehind(g *waveobj.TaskGroup) map[string]int {
	dependents := map[string][]string{}
	for _, t := range g.Tasks {
		for _, d := range t.Deps {
			dependents[d] = append(dependents[d], t.ID)
		}
	}
	behind := map[string]int{}
	var walk func(id string) int
	walk = func(id string) int {
		if n, ok := behind[id]; ok {
			return n
		}
		best := 0
		for _, d := range dependents[id] {
			best = max(best, walk(d)+1)
		}
		behind[id] = best
		return best
	}
	for _, t := range g.Tasks {
		walk(t.ID)
	}
	return behind
}

// MarkRunning assigns a spawned child run to a ready task.
func MarkRunning(g *waveobj.TaskGroup, taskID, runID string) error {
	for i := range g.Tasks {
		if g.Tasks[i].ID == taskID {
			g.Tasks[i].State = TaskState_Running
			g.Tasks[i].RunID = runID
			now := time.Now().UnixMilli()
			g.Tasks[i].SpawnedTs = now
			// an earlier attempt's readings must never describe the new worker
			g.Tasks[i].CPUSample, g.Tasks[i].CPUSampleTs, g.Tasks[i].BusyTs, g.Tasks[i].AskTs, g.Tasks[i].LatestTool = 0, 0, 0, 0, ""
			g.Tasks[i].ProgressHash, g.Tasks[i].ProgressCheckTs = "", 0
			g.Tasks[i].SuspectTs, g.Tasks[i].SuspectReason, g.Tasks[i].FlaggedFailures = 0, "", nil
			g.Tasks[i].ProgressTs = now
			return nil
		}
	}
	return fmt.Errorf("no task %q", taskID)
}

func RetryTask(g *waveobj.TaskGroup, taskID string) error {
	for i := range g.Tasks {
		if g.Tasks[i].ID == taskID {
			g.Tasks[i].State = TaskState_Pending
			g.Tasks[i].RunID = ""
			// failures is not reset here: the auto-retry path calls this too, and an auto-retry
			// clearing the dag-wide streak would starve the circuit-break — n failing tasks plus
			// one retry and it could never trip. Below the break a fresh success clears it via the
			// tick accounting; once the break has armed, only a human dag action does
			// (applyActionLocked), because the guard stops any success from arriving.
			RecomputeDagStatus(g)
			return nil
		}
	}
	return fmt.Errorf("no task %q", taskID)
}

// retryable is the states a retry may start a task over from: none has landed anything or holds a merge. A retry
// from done, blocked-merge, verifying or verify-failed would lose work the lane already merged or is merging.
func retryable(state string) bool {
	return taskActive(state) || state == TaskState_Failed || state == TaskState_ReviewFailed
}

func skippable(state string) bool {
	return state == TaskState_Failed || state == TaskState_Stalled || state == TaskState_Ready || state == TaskState_ReviewFailed
}

// SkipTask marks a failed/ready task skipped (no spawn).
func SkipTask(g *waveobj.TaskGroup, taskID string) error {
	for i := range g.Tasks {
		if g.Tasks[i].ID != taskID {
			continue
		}
		if !skippable(g.Tasks[i].State) {
			return fmt.Errorf("task %q cannot be skipped from state %q", taskID, g.Tasks[i].State)
		}
		g.Tasks[i].State = TaskState_Skipped
		g.Tasks[i].RunID = ""
		RecomputeDagStatus(g)
		return nil
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
		case TaskState_Running, TaskState_Stalled, TaskState_Reviewing, TaskState_ReviewFailed:
			t.State = TaskState_Cancelled
		}
	}
	g.Status = DagStatus_Cancelled
	return g
}
