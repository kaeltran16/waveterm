package orchestrate

import (
	"context"
	"fmt"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// DagEvent kinds published on the wps broker (mirrored in the cockpit events rail).
const (
	DagEventChildDone   = "dag:child-done"
	DagEventGateOpen    = "dag:gate-open"
	DagEventBlocked     = "dag:dag-blocked"
	DagEventComplete    = "dag:dag-complete"
	DagEventTaskSpawned = "dag:task-spawned"
)

// spawnWorker is the child-run launch seam. Package var so engine tests can stub it;
// defaults to jarvis.SpawnRunWorker, read at call time so external stubs (e.g. swapping
// jarvis.SpawnRunWorker in handler tests) take effect too.
var spawnWorker = func(ctx context.Context, runtime, workspaceId, projectName, cwd, prompt string) (string, error) {
	return jarvis.SpawnRunWorker(ctx, runtime, workspaceId, projectName, cwd, prompt)
}

// ScheduleOnce advances the DAG one step: derive task states from child runs, count
// consecutive failures, spawn ready tasks (managed worktrees when the project is git),
// persist, and publish waveobj + event updates. Idempotent — safe to call repeatedly.
func ScheduleOnce(ctx context.Context, g *waveobj.TaskGroup) error {
	owner, err := wstore.GetRun(ctx, g.ChannelId, g.RunID)
	if err != nil {
		return fmt.Errorf("loading owning run: %w", err)
	}
	runs := map[string]*waveobj.Run{}
	prevStates := map[string]string{}
	for i := range g.Tasks {
		t := &g.Tasks[i]
		prevStates[t.ID] = t.State
		if t.RunID == "" {
			continue
		}
		if run, rerr := wstore.GetRun(ctx, g.ChannelId, t.RunID); rerr == nil {
			runs[t.RunID] = run
		}
	}
	DeriveTaskStates(g, runs)
	// child-done notification: a task whose child just reached done wakes the lead (publish + control file).
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.State == TaskState_Done && t.RunID != "" && prevStates[t.ID] == TaskState_Running {
			publishDagEvent(DagEventChildDone, g, t.ID)
			_ = NotifyLead(ctx, g, DagEventChildDone, t.ID)
		}
	}
	// consecutive-failure accounting: a failure *streak* breaks only on a fresh success —
	// a task that completed in an earlier tick must not keep resetting the counter, or the
	// circuit-break at MaxConsecutiveFailures could never trip once any task had ever succeeded.
	if g.Failures > 0 {
		for i := range g.Tasks {
			if prevStates[g.Tasks[i].ID] == TaskState_Running && g.Tasks[i].State == TaskState_Done {
				g.Failures = 0
				break
			}
		}
	}
	for i := range g.Tasks {
		if g.Tasks[i].State == TaskState_Failed && g.Tasks[i].RunID != "" {
			g.Failures++
			g.Tasks[i].RunID = "" // allow retry re-spawn
		}
	}
	for _, taskID := range NextToSpawn(g) {
		task := taskByID(g, taskID)
		cwd := owner.ProjectPath
		if IsGitRepo(owner.ProjectPath) {
			wt, err := CreateRunWorktree(ctx, owner.ProjectPath, owner.ID+"-"+taskID, owner.BaseCommit)
			if err != nil {
				g.Tasks[taskIdx(g, taskID)].State = TaskState_Failed
				continue
			}
			cwd = wt
		}
		prompt := taskPrompt(task, owner)
		oref, err := spawnWorker(ctx, owner.Runtime, owner.WorkspaceId, "", cwd, prompt)
		if err != nil {
			g.Tasks[taskIdx(g, taskID)].State = TaskState_Failed
			continue
		}
		_ = oref // v1: no per-child steering surface; the child run row is the handle
		childRun := childRunFromSpec(g, task, owner, cwd, prompt)
		if err := wstore.AppendRun(ctx, g.ChannelId, childRun); err != nil {
			return err
		}
		if err := MarkRunning(g, taskID, childRun.ID); err != nil {
			return err
		}
		publishDagEvent(DagEventTaskSpawned, g, taskID)
	}
	RecomputeDagStatus(g)
	// status-transition notifications: gate-open / blocked / complete wake the lead.
	switch g.Status {
	case DagStatus_AwaitingReview:
		publishDagEvent(DagEventGateOpen, g, "")
		_ = NotifyLead(ctx, g, DagEventGateOpen, fmt.Sprintf("gate %s", gatedTaskID(g)))
	case DagStatus_Blocked:
		publishDagEvent(DagEventBlocked, g, "")
		_ = NotifyLead(ctx, g, DagEventBlocked, fmt.Sprintf("%d failures", g.Failures))
	case DagStatus_Done:
		publishDagEvent(DagEventComplete, g, "")
		_ = NotifyLead(ctx, g, DagEventComplete, "all tasks done")
	}
	g.UpdatedTs = time.Now().UnixMilli()
	if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
		*cur = *g
		return nil
	}); err != nil {
		return err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, g.OID))
	return nil
}

// GroupForRun resolves the dag owning a run (the run carries DagORef — set on the
// orchestrator run by DagSubmitCommand and copied onto children by childRunFromSpec).
func GroupForRun(ctx context.Context, channelId, runID string) (*waveobj.TaskGroup, error) {
	run, err := wstore.GetRun(ctx, channelId, runID)
	if err != nil {
		return nil, err
	}
	if run.DagORef == "" {
		return nil, fmt.Errorf("run %q has no dag", runID)
	}
	return wstore.GetDag(ctx, run.DagORef)
}

func taskByID(g *waveobj.TaskGroup, taskID string) *waveobj.TaskNode {
	for i := range g.Tasks {
		if g.Tasks[i].ID == taskID {
			return &g.Tasks[i]
		}
	}
	return nil
}

func taskIdx(g *waveobj.TaskGroup, taskID string) int {
	for i := range g.Tasks {
		if g.Tasks[i].ID == taskID {
			return i
		}
	}
	return -1
}

// taskPrompt is the child's goal: per-task RunSpec goal, else the task label.
func taskPrompt(task *waveobj.TaskNode, owner *waveobj.Run) string {
	if task.RunSpec.Goal != "" {
		return task.RunSpec.Goal
	}
	if task.Label != "" {
		return task.Label
	}
	return fmt.Sprintf("task %s of %q", task.ID, owner.Goal)
}

// childRunFromSpec builds the child run that owns the spawned worker. The child carries
// DagORef so GroupForRun resolves the group from any run in the DAG, and its ProjectPath is
// the worktree cwd so evidence/continuity machinery scopes to the isolated checkout.
func childRunFromSpec(g *waveobj.TaskGroup, task *waveobj.TaskNode, owner *waveobj.Run, cwd, goal string) waveobj.Run {
	mode := task.RunSpec.Mode
	if mode == "" {
		mode = jarvis.RunMode_Quick
	}
	runtime := task.RunSpec.Runtime
	if runtime == "" {
		runtime = owner.Runtime
	}
	run := jarvis.NewRun(goal, owner.WorkspaceId, cwd, nil, mode, jarvis.QuickPlaybook(), time.Now().UnixMilli())
	run.DagORef = g.OID
	run.BaseCommit = owner.BaseCommit
	return run
}

// publishDagEvent broadcasts an engine event scoped to the dag and its owning run.
func publishDagEvent(kind string, g *waveobj.TaskGroup, detail string) {
	wps.Broker.Publish(wps.WaveEvent{
		Event:  kind,
		Scopes: []string{waveobj.MakeORef(waveobj.OType_Dag, g.OID).String(), waveobj.MakeORef(waveobj.OType_Run, g.RunID).String()},
		Data:   detail,
	})
}
