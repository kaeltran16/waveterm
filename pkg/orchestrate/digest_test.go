// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// no-merge fixtures: three independent tasks so tests control state precisely.
func plainTasks() []waveobj.TaskNode {
	return []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
		{ID: "t-1", Label: "b"},
		{ID: "t-2", Label: "c"},
	}
}

// chainTasks makes t-0 -> t-1 -> t-2 (used for dependency-wait and sequential next tests).
func chainTasks() []waveobj.TaskNode {
	return []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
		{ID: "t-1", Label: "b", Deps: []string{"t-0"}},
		{ID: "t-2", Label: "c", Deps: []string{"t-1"}},
	}
}

func TestHealthNeedsYouAsk(t *testing.T) {
	g := digestGroup(t, false, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Running})
	sn := digestSnapshot(g, nil, []wshrpc.DagAskItem{digestAsk("t-0", "ask-1", 2000)}, nil, digestNow)
	d := BuildDigest(sn)
	if d.Health != "needs-you" {
		t.Fatalf("pending ask must put the dag in needs-you, got %q", d.Health)
	}
}

func TestHealthNeedsYouUnreleasedGate(t *testing.T) {
	tasks := []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
		{ID: "t-1", Label: "gate", Gate: true},
	}
	g := digestGroup(t, false, tasks)
	setTaskStates(g, map[string]string{"t-1": TaskState_Done}) // done gate, never released
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Health != "needs-you" {
		t.Fatalf("done unreleased gate must put the dag in needs-you, got %q", d.Health)
	}
}

func TestHealthNeedsYouBlockedMerge(t *testing.T) {
	g := digestGroup(t, true, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_BlockedMerge})
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Health != "needs-you" {
		t.Fatalf("blocked merge must put the dag in needs-you, got %q", d.Health)
	}
}

func TestHealthNeedsYouTerminalFailure(t *testing.T) {
	g := digestGroup(t, false, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Failed})
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Health != "needs-you" {
		t.Fatalf("terminal failure must put the dag in needs-you, got %q", d.Health)
	}
}

func TestHealthNeedsYouFailedCleanupCancelled(t *testing.T) {
	g := digestGroup(t, true, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done})
	g.Tasks[0].Merged = true
	g.Tasks[0].CleanupError = "worktree locked"
	g.Status = DagStatus_Cancelled // terminal override, but failed cleanup debt remains
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Health != "needs-you" {
		t.Fatalf("cancelled dag with failed cleanup must stay needs-you, got %q", d.Health)
	}
}

func TestHealthStalled(t *testing.T) {
	g := digestGroup(t, false, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Stalled})
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Health != "stalled" {
		t.Fatalf("stalled task with no attention must report stalled, got %q", d.Health)
	}
}

func TestHealthHealthyDependencyWait(t *testing.T) {
	g := digestGroup(t, false, chainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Running}) // t-1/t-2 wait on deps
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Health != "healthy" {
		t.Fatalf("dependency wait only must be healthy, got %q", d.Health)
	}
}

func TestHealthHealthyRunning(t *testing.T) {
	g := digestGroup(t, false, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Running, "t-1": TaskState_Running})
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Health != "healthy" {
		t.Fatalf("active workers must be healthy, got %q", d.Health)
	}
}

func TestHealthDone(t *testing.T) {
	g := digestGroup(t, false, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done, "t-1": TaskState_Done, "t-2": TaskState_Done})
	if g.Status != DagStatus_Done {
		t.Fatalf("fixture should be done, got %s", g.Status)
	}
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Health != "done" {
		t.Fatalf("terminal dag without debt must be done, got %q", d.Health)
	}
}

func TestHealthCancelled(t *testing.T) {
	g := digestGroup(t, false, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Running})
	g.Status = DagStatus_Cancelled
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Health != "cancelled" {
		t.Fatalf("cancelled dag without debt must be cancelled, got %q", d.Health)
	}
}

// --- next-step derivation (spec §5.3 ordering) ---

func TestNextAnswer(t *testing.T) {
	g := digestGroup(t, false, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Running})
	sn := digestSnapshot(g, nil, []wshrpc.DagAskItem{digestAsk("t-0", "ask-1", 2000)}, nil, digestNow)
	d := BuildDigest(sn)
	if d.Next.Kind != "human-action" || len(d.Next.Actions) != 1 || d.Next.Actions[0] != "answer" {
		t.Fatalf("next must be answer human-action, got %+v", d.Next)
	}
	if len(d.Next.TaskIds) != 1 || d.Next.TaskIds[0] != "t-0" {
		t.Fatalf("answer next must name the ask task, got %+v", d.Next.TaskIds)
	}
}

func TestNextApproveSendback(t *testing.T) {
	tasks := []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
		{ID: "t-1", Label: "gate", Gate: true},
	}
	g := digestGroup(t, false, tasks)
	setTaskStates(g, map[string]string{"t-1": TaskState_Done})
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Next.Kind != "human-action" || len(d.Next.Actions) != 2 ||
		d.Next.Actions[0] != "approve" || d.Next.Actions[1] != "sendback" {
		t.Fatalf("next must be approve/sendback, got %+v", d.Next)
	}
	if len(d.Next.TaskIds) != 1 || d.Next.TaskIds[0] != "t-1" {
		t.Fatalf("gate next must name the gate, got %+v", d.Next.TaskIds)
	}
}

func TestNextResolveMerge(t *testing.T) {
	g := digestGroup(t, true, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_BlockedMerge})
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Next.Kind != "human-action" || len(d.Next.Actions) != 1 || d.Next.Actions[0] != "resolve-merge" {
		t.Fatalf("next must be resolve-merge, got %+v", d.Next)
	}
}

func TestNextRetryCleanup(t *testing.T) {
	g := digestGroup(t, true, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done})
	g.Tasks[0].Merged = true
	g.Tasks[0].CleanupError = "worktree locked"
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Next.Kind != "human-action" || len(d.Next.Actions) != 1 || d.Next.Actions[0] != "retry-cleanup" {
		t.Fatalf("next must be retry-cleanup, got %+v", d.Next)
	}
}

func TestNextRetrySkipEscalate(t *testing.T) {
	g := digestGroup(t, false, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Failed})
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	want := []string{"retry", "skip", "escalate"}
	if d.Next.Kind != "human-action" || !sameStrings(d.Next.Actions, want) {
		t.Fatalf("failed task next must be retry/skip/escalate, got %+v", d.Next)
	}
}

func TestNextStalled(t *testing.T) {
	g := digestGroup(t, false, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Stalled})
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Next.Kind != "human-action" {
		t.Fatalf("stalled task must still be a human action, got kind %q", d.Next.Kind)
	}
}

func TestNextMergeReady(t *testing.T) {
	g := digestGroup(t, true, chainTasks())
	// t-0 done, unmerged, merge-required -> blocks t-1 (depSatisfied needs Merged)
	setTaskStates(g, map[string]string{"t-0": TaskState_Done})
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Next.Kind != "merge-ready" {
		t.Fatalf("merge-required dag with unmerged blocking task must be merge-ready, got %q", d.Next.Kind)
	}
	if len(d.Next.TaskIds) != 1 || d.Next.TaskIds[0] != "t-0" {
		t.Fatalf("merge-ready must name the unmerged task, got %+v", d.Next.TaskIds)
	}
}

func TestNextMergeReadyNoBlocker(t *testing.T) {
	g := digestGroup(t, true, plainTasks()) // no deps: t-0 unmerged blocks nothing
	setTaskStates(g, map[string]string{"t-0": TaskState_Done})
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Next.Kind != "dispatch" {
		t.Fatalf("unmerged task that blocks nothing must not preempt dispatch, got %q", d.Next.Kind)
	}
}

func TestNextDispatch(t *testing.T) {
	g := digestGroup(t, false, plainTasks())
	setTaskStates(g, map[string]string{}) // all pending, nothing busy
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Next.Kind != "dispatch" {
		t.Fatalf("ready tasks must dispatch, got %q", d.Next.Kind)
	}
	if len(d.Next.TaskIds) != 2 || d.Next.TaskIds[0] != "t-0" || d.Next.TaskIds[1] != "t-1" {
		t.Fatalf("dispatch must name ready tasks in dag order (capped by parallelism), got %+v", d.Next.TaskIds)
	}
}

func TestNextParallelismWait(t *testing.T) {
	g := digestGroup(t, false, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Running, "t-1": TaskState_Running}) // both slots busy
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Next.Kind != "parallelism-wait" {
		t.Fatalf("full parallel slots with ready work must wait, got %q", d.Next.Kind)
	}
	if len(d.Next.BlockingTaskIds) != 2 {
		t.Fatalf("parallelism wait must name the slot-holding tasks, got %+v", d.Next.BlockingTaskIds)
	}
}

func TestNextDependencyWait(t *testing.T) {
	g := digestGroup(t, false, chainTasks())
	// exercise a dependency-only snapshot: the blocker cannot dispatch and no worker is active.
	setTaskStates(g, map[string]string{"t-0": TaskState_Cancelled, "t-1": TaskState_Pending})
	g.Status = DagStatus_Running
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Next.Kind != "dependency-wait" {
		t.Fatalf("dependency hold with no active tasks must be dependency-wait, got %q", d.Next.Kind)
	}
	if len(d.Next.TaskIds) != 2 || d.Next.TaskIds[0] != "t-1" || d.Next.TaskIds[1] != "t-2" {
		t.Fatalf("dependency wait must name the waiting tasks in dag order, got %+v", d.Next.TaskIds)
	}
	if len(d.Next.BlockingTaskIds) != 2 || d.Next.BlockingTaskIds[0] != "t-0" || d.Next.BlockingTaskIds[1] != "t-1" {
		t.Fatalf("dependency wait must name the unsat deps in dag order, got %+v", d.Next.BlockingTaskIds)
	}
}

func TestNextParallelismWaitBeatsDependency(t *testing.T) {
	g := digestGroup(t, false, chainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Running}) // active holds a slot; t-1/t-2 also dep-wait
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	// parallelism wait outranks dependency wait per spec §5.3 ordering
	if d.Next.Kind != "parallelism-wait" {
		t.Fatalf("active task with dependency holds: parallelism-wait wins, got %q", d.Next.Kind)
	}
	if len(d.Next.BlockingTaskIds) != 1 || d.Next.BlockingTaskIds[0] != "t-0" {
		t.Fatalf("parallelism wait must name the active task, got %+v", d.Next.BlockingTaskIds)
	}
}

func TestNextDependencyWaitBlocking(t *testing.T) {
	g := digestGroup(t, false, []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
		{ID: "t-1", Label: "b", Deps: []string{"t-0"}},
		{ID: "t-2", Label: "c", Deps: []string{"t-1"}},
	})
	setTaskStates(g, map[string]string{"t-0": TaskState_Cancelled, "t-1": TaskState_Pending})
	g.Status = DagStatus_Running
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Next.Kind != "dependency-wait" {
		t.Fatalf("no active tasks and dependency holds must be dependency-wait, got %q", d.Next.Kind)
	}
	if len(d.Next.BlockingTaskIds) != 2 || d.Next.BlockingTaskIds[0] != "t-0" || d.Next.BlockingTaskIds[1] != "t-1" {
		t.Fatalf("dependency wait must name the blocking tasks, got %+v", d.Next.BlockingTaskIds)
	}
}

func TestNextTerminal(t *testing.T) {
	g := digestGroup(t, false, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done, "t-1": TaskState_Done, "t-2": TaskState_Done})
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Next.Kind != "terminal" || d.Next.TerminalStatus != DagStatus_Done {
		t.Fatalf("done dag must be terminal next, got %+v", d.Next)
	}
}

// --- counts ---

func TestCountsOverlapSemantics(t *testing.T) {
	g := digestGroup(t, true, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done, "t-1": TaskState_Running})
	g.Tasks[0].Merged = true // done + merged: no longer merge-ready, no cleanup debt
	sn := digestSnapshot(g, nil, []wshrpc.DagAskItem{digestAsk("t-1", "ask-1", 2000)}, nil, digestNow)
	d := BuildDigest(sn)
	c := d.Counts
	if c.Total != 3 || c.Done != 1 || c.Running != 1 {
		t.Fatalf("basic counts wrong: %+v", c)
	}
	if c.Attention != 1 {
		t.Fatalf("attention must count the ask (merged done task carries none), got %d", c.Attention)
	}
	if c.MergeReady != 0 {
		t.Fatalf("merged task is not merge-ready, got %d", c.MergeReady)
	}
}

func TestCountsMergeReadyUnmerged(t *testing.T) {
	g := digestGroup(t, true, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done})
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Counts.MergeReady != 1 {
		t.Fatalf("done unmerged task in merge-required dag must count merge-ready, got %d", d.Counts.MergeReady)
	}
	if d.Counts.Done != 1 {
		t.Fatalf("done count includes unmerged done, got %d", d.Counts.Done)
	}
}

func TestCountsStallNotAttention(t *testing.T) {
	g := digestGroup(t, false, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Stalled})
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Counts.Stalled != 1 {
		t.Fatalf("stall count wrong: %d", d.Counts.Stalled)
	}
	if d.Counts.Attention != 0 {
		t.Fatalf("ordinary stall must not count attention, got %d", d.Counts.Attention)
	}
}

func TestCountsDependencyWaiting(t *testing.T) {
	g := digestGroup(t, false, chainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Running})
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	// t-1 waits on t-0 (running, unsat); t-2 waits on t-1 (pending, unsat)
	if d.Counts.DependencyWaiting != 2 {
		t.Fatalf("both t-1 and t-2 wait on unsatisfied deps, got %d", d.Counts.DependencyWaiting)
	}
}

func TestCountsRecoveredRetry(t *testing.T) {
	g := digestGroup(t, false, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done})
	retained := []waveobj.RunEvent{
		retainedEvent(waveobj.RunEventKindTaskRetried, "t-0", 5000),
		retainedEvent(waveobj.RunEventKindTaskRetried, "t-1", 6000),
	}
	d := BuildDigest(digestSnapshot(g, nil, nil, retained, digestNow))
	if d.Counts.RecoveredRetry != 1 {
		t.Fatalf("recovered retry counts done tasks with a retried event, got %d", d.Counts.RecoveredRetry)
	}
	if len(d.Tasks) != 3 || !d.Tasks[0].RecoveredRetry || d.Tasks[1].RecoveredRetry {
		t.Fatalf("recovered retry must mark the right tasks: %+v", d.Tasks)
	}
}

// --- task digests ---

func TestTaskWaitReasonDependencyAndBlocking(t *testing.T) {
	g := digestGroup(t, false, chainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Pending, "t-1": TaskState_Pending})
	sn := digestSnapshot(g, nil, nil, nil, digestNow)
	d := BuildDigest(sn)
	byId := map[string]wshrpc.DagTaskDigest{}
	for _, td := range d.Tasks {
		byId[td.TaskId] = td
	}
	if byId["t-1"].WaitReason != "dependency" {
		t.Fatalf("t-1 must wait on dependency, got %q", byId["t-1"].WaitReason)
	}
	if len(byId["t-1"].BlockingTaskIds) != 1 || byId["t-1"].BlockingTaskIds[0] != "t-0" {
		t.Fatalf("t-1 must name its unsat dep t-0, got %+v", byId["t-1"].BlockingTaskIds)
	}
}

func TestTaskWaitReasonAsk(t *testing.T) {
	g := digestGroup(t, false, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Running})
	sn := digestSnapshot(g, nil, []wshrpc.DagAskItem{digestAsk("t-0", "ask-1", 2000)}, nil, digestNow)
	d := BuildDigest(sn)
	td := d.Tasks[0]
	if td.WaitReason != "ask" || td.AskId != "ask-1" || td.AskTs != 2000 || td.AskSummary == "" {
		t.Fatalf("ask task digest wrong: %+v", td)
	}
}

func TestTaskMergeCleanupStates(t *testing.T) {
	g := digestGroup(t, true, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done})
	g.Tasks[0].Merged = false // unmerged: merge-ready, cleanup clear
	sn := digestSnapshot(g, nil, nil, nil, digestNow)
	d := BuildDigest(sn)
	td := d.Tasks[0]
	if td.MergeState != "ready" || td.CleanupState != "clear" {
		t.Fatalf("merge-ready task states wrong: %+v", td)
	}

	g2 := digestGroup(t, true, plainTasks())
	setTaskStates(g2, map[string]string{"t-0": TaskState_Done})
	g2.Tasks[0].Merged = true
	g2.Tasks[0].CleanupPending = true
	d2 := BuildDigest(digestSnapshot(g2, nil, nil, nil, digestNow))
	td2 := d2.Tasks[0]
	if td2.MergeState != "merged" || td2.CleanupState != "pending" {
		t.Fatalf("pending-cleanup states wrong: %+v", td2)
	}

	g3 := digestGroup(t, true, plainTasks())
	setTaskStates(g3, map[string]string{"t-0": TaskState_Done})
	g3.Tasks[0].Merged = true
	g3.Tasks[0].CleanupError = "locked"
	d3 := BuildDigest(digestSnapshot(g3, nil, nil, nil, digestNow))
	if d3.Tasks[0].CleanupState != "failed" {
		t.Fatalf("failed-cleanup state wrong: %+v", d3.Tasks[0])
	}
}

func TestTaskNotMergeRequiredStates(t *testing.T) {
	g := digestGroup(t, false, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done})
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	td := d.Tasks[0]
	if td.MergeState != "not-required" || td.CleanupState != "not-required" {
		t.Fatalf("non-merge dag task states must be not-required, got %+v", td)
	}
}

// --- durations ---

func TestDurationRunMsComplete(t *testing.T) {
	g := digestGroup(t, false, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done})
	run := childRun("run-t-0", []waveobj.RunPhase{
		phase("execute", 2000, 5000),
		phase("execute", 6000, 7000),
	})
	sn := digestSnapshot(g, []*waveobj.Run{run}, nil, nil, digestNow)
	d := BuildDigest(sn)
	td := d.Durations.Tasks[0]
	if td.RunMs != 4000 || td.Partial {
		t.Fatalf("complete run must sum phase spans exactly, got %+v", td)
	}
}

func TestDurationRunMsPartialRunningPhase(t *testing.T) {
	g := digestGroup(t, false, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Running})
	run := childRun("run-t-0", []waveobj.RunPhase{phase("execute", 2000, 0)}) // no done bound
	sn := digestSnapshot(g, []*waveobj.Run{run}, nil, nil, digestNow)
	d := BuildDigest(sn)
	td := d.Durations.Tasks[0]
	if td.RunMs != 0 || !td.Partial {
		t.Fatalf("running phase without done bound must be partial with zero duration, got %+v", td)
	}
}

func TestDurationMergeWait(t *testing.T) {
	g := digestGroup(t, true, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done})
	g.Tasks[0].Merged = true
	retained := []waveobj.RunEvent{
		retainedEvent("task-merge-started", "t-0", 6000),
		retainedEvent("task-done", "t-0", 5000),
	}
	sn := digestSnapshot(g, []*waveobj.Run{childRun("run-t-0", nil)}, nil, retained, digestNow)
	d := BuildDigest(sn)
	td := d.Durations.Tasks[0]
	if td.MergeWaitMs != 1000 || td.Partial {
		t.Fatalf("merge wait spans task-done to first task-merge-started, got %+v", td)
	}
}

func TestDurationMergeWaitMissingBoundary(t *testing.T) {
	g := digestGroup(t, true, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done})
	g.Tasks[0].Merged = true
	retained := []waveobj.RunEvent{
		retainedEvent("task-done", "t-0", 5000), // merged but merge-started pruned
	}
	sn := digestSnapshot(g, nil, nil, retained, digestNow)
	d := BuildDigest(sn)
	td := d.Durations.Tasks[0]
	if td.MergeWaitMs != 0 || !td.Partial {
		t.Fatalf("pruned merge boundary must be partial with zero duration, got %+v", td)
	}
}

func TestDurationCleanup(t *testing.T) {
	g := digestGroup(t, true, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done})
	g.Tasks[0].Merged = true
	retained := []waveobj.RunEvent{
		retainedEvent("task-cleanup-completed", "t-0", 7000),
		retainedEvent("task-cleanup-pending", "t-0", 6500),
	}
	sn := digestSnapshot(g, []*waveobj.Run{childRun("run-t-0", nil)}, nil, retained, digestNow)
	d := BuildDigest(sn)
	td := d.Durations.Tasks[0]
	if td.CleanupMs != 500 || td.Partial {
		t.Fatalf("cleanup spans pending to terminal, got %+v", td)
	}
}

func TestDurationAggregatePartial(t *testing.T) {
	g := digestGroup(t, true, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done})
	g.Tasks[0].Merged = true
	retained := []waveobj.RunEvent{
		retainedEvent("task-merge-started", "t-0", 6000),
		retainedEvent("task-done", "t-0", 5000),
		retainedEvent("task-cleanup-completed", "t-0", 7000),
	}
	sn := digestSnapshot(g, nil, nil, retained, digestNow)
	d := BuildDigest(sn)
	// cleanup-pending pruned -> task partial -> aggregate partial
	if !d.Durations.Partial {
		t.Fatalf("pruned cleanup-pending must mark the aggregate partial, got %+v", d.Durations)
	}
}

func TestDurationElapsedActive(t *testing.T) {
	g := digestGroup(t, false, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Running})
	sn := digestSnapshot(g, []*waveobj.Run{childRun("run-t-0", nil)}, nil, nil, digestNow) // created 1000, now 10000
	d := BuildDigest(sn)
	if d.Durations.ElapsedMs != 9000 || d.Durations.Partial {
		t.Fatalf("active elapsed is now-created, got %+v", d.Durations)
	}
}

func TestDurationElapsedTerminal(t *testing.T) {
	g := digestGroup(t, false, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done, "t-1": TaskState_Done, "t-2": TaskState_Done})
	retained := []waveobj.RunEvent{retainedDagEvent(waveobj.RunEventKindDagDone, 8000)}
	runs := []*waveobj.Run{
		childRun("run-t-0", nil),
		childRun("run-t-1", nil),
		childRun("run-t-2", nil),
	}
	sn := digestSnapshot(g, runs, nil, retained, digestNow)
	d := BuildDigest(sn)
	if d.Durations.ElapsedMs != 7000 || d.Durations.Partial {
		t.Fatalf("terminal elapsed is dag-done - created, got %+v", d.Durations)
	}
}

func TestDurationElapsedTerminalPruned(t *testing.T) {
	g := digestGroup(t, false, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done, "t-1": TaskState_Done, "t-2": TaskState_Done})
	sn := digestSnapshot(g, nil, nil, nil, digestNow) // terminal but dag-done pruned
	d := BuildDigest(sn)
	if !d.Durations.Partial {
		t.Fatalf("pruned terminal boundary must mark elapsed partial, got %+v", d.Durations)
	}
}

// --- version/stability ---

func TestDigestVersionMatchesGroup(t *testing.T) {
	g := digestGroup(t, false, plainTasks())
	g.Version = 42
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.DagVersion != 42 {
		t.Fatalf("digest version must equal group version, got %d", d.DagVersion)
	}
}

func TestChangedAskProducesNewDigest(t *testing.T) {
	g := digestGroup(t, false, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Running})
	noAsk := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	withAsk := BuildDigest(digestSnapshot(g, nil, []wshrpc.DagAskItem{digestAsk("t-0", "ask-2", 4000)}, nil, digestNow))
	if noAsk.DagVersion != withAsk.DagVersion {
		t.Fatalf("fixture must share the dag version")
	}
	if noAsk.Tasks[0].AskId == withAsk.Tasks[0].AskId || withAsk.Tasks[0].AskId != "ask-2" {
		t.Fatalf("same version with changed ask state must change the digest ask id")
	}
	if noAsk.Next.Kind == withAsk.Next.Kind {
		t.Fatalf("ask presence must change the next step (want dispatch vs human-action)")
	}
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func controlDigestFor(t *testing.T, retained []waveobj.RunEvent) *wshrpc.ControlDigest {
	t.Helper()
	g := digestGroup(t, false, []waveobj.TaskNode{{ID: "t-0", Label: "a"}})
	return BuildDigest(digestSnapshot(g, nil, nil, retained, digestNow)).Control
}

func TestControlDigestUnconfirmedWhenSentWithoutAck(t *testing.T) {
	c := controlDigestFor(t, []waveobj.RunEvent{
		controlEvent(waveobj.RunEventKindLeadControlSent, "ev-1", "sess-1", "t-0", "gate_open", "", 100),
	})
	if c == nil {
		t.Fatal("a sent control must produce a control digest")
	}
	if c.Status != "unconfirmed" || c.EventId != "ev-1" || c.SessionId != "sess-1" || c.Kind != "gate_open" {
		t.Fatalf("digest = %+v", c)
	}
	if c.SentTs != 100 || c.AcknowledgedTs != 0 || c.TaskId != "t-0" {
		t.Fatalf("digest = %+v", c)
	}
}

func TestControlDigestAcknowledged(t *testing.T) {
	c := controlDigestFor(t, []waveobj.RunEvent{
		controlEvent(waveobj.RunEventKindLeadControlSent, "ev-1", "sess-1", "t-0", "gate_open", "", 100),
		controlEvent(waveobj.RunEventKindLeadControlAcknowledged, "ev-1", "sess-1", "", "", "", 140),
	})
	if c == nil || c.Status != "acknowledged" || c.AcknowledgedTs != 140 {
		t.Fatalf("digest = %+v", c)
	}
}

func TestControlDigestFailedAndUnavailable(t *testing.T) {
	write := controlDigestFor(t, []waveobj.RunEvent{
		controlEvent(waveobj.RunEventKindLeadControlFailed, "ev-2", "sess-1", "t-0", "gate_open", ControlFailureWrite, 100),
	})
	if write == nil || write.Status != "failed" {
		t.Fatalf("a write failure is status failed: %+v", write)
	}
	gone := controlDigestFor(t, []waveobj.RunEvent{
		controlEvent(waveobj.RunEventKindLeadControlFailed, "ev-3", "", "", "dag_complete", ControlFailureUnavailable, 100),
	})
	if gone == nil || gone.Status != "unavailable" {
		t.Fatalf("an unreachable lead is status unavailable: %+v", gone)
	}
}

func TestControlDigestLatestAttemptWins(t *testing.T) {
	c := controlDigestFor(t, []waveobj.RunEvent{
		controlEvent(waveobj.RunEventKindLeadControlSent, "ev-1", "sess-1", "t-0", "gate_open", "", 100),
		controlEvent(waveobj.RunEventKindLeadControlAcknowledged, "ev-1", "sess-1", "", "", "", 110),
		controlEvent(waveobj.RunEventKindLeadControlSent, "ev-2", "sess-1", "t-1", "child_ask", "", 200),
	})
	if c == nil || c.EventId != "ev-2" {
		t.Fatalf("the newest attempt is the one reported: %+v", c)
	}
	if c.Status != "unconfirmed" {
		t.Fatalf("an ack for an older attempt must not confirm the newest one: %+v", c)
	}
}

func TestControlDigestAckNeverTransfersBetweenEvents(t *testing.T) {
	c := controlDigestFor(t, []waveobj.RunEvent{
		controlEvent(waveobj.RunEventKindLeadControlSent, "ev-5", "sess-1", "t-0", "gate_open", "", 100),
		controlEvent(waveobj.RunEventKindLeadControlAcknowledged, "ev-other", "sess-1", "", "", "", 150),
	})
	if c == nil || c.Status != "unconfirmed" {
		t.Fatalf("an ack naming a different event id must not confirm this one: %+v", c)
	}
}

func TestControlDigestAbsentWithoutControlRows(t *testing.T) {
	if c := controlDigestFor(t, nil); c != nil {
		t.Fatalf("no control attempt means no control digest, got %+v", c)
	}
}
