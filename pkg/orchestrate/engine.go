package orchestrate

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/harness"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// DagEvent kinds published on the wps broker. The names live in wps (the event hub's single source
// of truth — the FE event union is generated from wps.AllEvents); these aliases keep the engine's
// references unchanged.
const (
	DagEventChildDone   = wps.DagEventChildDone
	DagEventGateOpen    = wps.DagEventGateOpen
	DagEventBlocked     = wps.DagEventBlocked
	DagEventComplete    = wps.DagEventComplete
	DagEventTaskSpawned = wps.DagEventTaskSpawned
	DagEventChildAsk    = wps.DagEventChildAsk
	DagEventTaskStalled = wps.DagEventTaskStalled
)

// spawnWorker is the child-run launch seam. Package var so engine tests can stub it;
// defaults to jarvis.SpawnRunWorker, read at call time so external stubs (e.g. swapping
// jarvis.SpawnRunWorker in handler tests) take effect too.
var spawnWorker = func(ctx context.Context, cap runroute.Capability, workspaceId, projectName, cwd, prompt string) (string, error) {
	return jarvis.SpawnRunWorker(ctx, cap, workspaceId, projectName, cwd, prompt)
}

var validateWorkerHarness = func(runtime string) error {
	_, err := harness.ValidateInstalled(runtime, harness.OperationRunWorker)
	return err
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
	// liveness + stall detection: refresh each running task's last-activity from its child's pi
	// session writes; a running task silent past StallThreshold is flagged stalled and reported to the
	// lead (nothing else ever notices a headless child that stopped progressing). A stalled task whose
	// child later completes still derives done (DeriveTaskStates).
	now := time.Now().UnixMilli()
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.RunID == "" {
			continue
		}
		if activity := lastActivityForRun(runs[t.RunID]); activity > t.LastActivity {
			t.LastActivity = activity
		}
		if t.State == TaskState_Running && t.LastActivity > 0 && now-t.LastActivity > StallThreshold.Milliseconds() {
			t.State = TaskState_Stalled
		}
	}
	// child-done notification: a task whose child just reached done wakes the lead (publish + control file).
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.State == TaskState_Done && t.RunID != "" && prevStates[t.ID] == TaskState_Running {
			publishDagEvent(DagEventChildDone, g, t.ID)
			_ = NotifyLead(ctx, g, DagEventChildDone, t.ID)
		}
		if t.State == TaskState_Stalled && prevStates[t.ID] == TaskState_Running {
			PublishTaskStalled(ctx, g, t.ID)
			appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskStalled, nil, map[string]any{"taskid": t.ID})
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
		pin := effectiveTaskRoute(task, owner)
		capability, routeErr := runroute.Resolve(pin)
		if routeErr != nil {
			g.Tasks[taskIdx(g, taskID)].State = TaskState_Failed
			continue
		}
		if harnessErr := validateWorkerHarness(pin.Runtime); harnessErr != nil {
			g.Tasks[taskIdx(g, taskID)].State = TaskState_Failed
			continue
		}
		cwd := owner.ProjectPath
		if IsGitRepo(owner.ProjectPath) {
			wt := worktreeDir(owner.ProjectPath, owner.ID+"-"+taskID)
			if _, statErr := os.Stat(wt); statErr == nil {
				cwd = wt // retry of a dead child: reuse its worktree so partial work survives
			} else {
				wt, err := CreateRunWorktree(ctx, owner.ProjectPath, owner.ID+"-"+taskID, owner.BaseCommit)
				if err != nil {
					g.Tasks[taskIdx(g, taskID)].State = TaskState_Failed
					continue
				}
				cwd = wt
			}
		}
		prompt := taskPrompt(task, owner)
		oref, err := spawnWorker(ctx, capability, owner.WorkspaceId, "", cwd, prompt)
		if err != nil {
			g.Tasks[taskIdx(g, taskID)].State = TaskState_Failed
			continue
		}
		_ = oref // v1: no per-child steering surface; the child run row is the handle
		childRun := childRunFromSpec(g, task, owner, pin, cwd, prompt)
		if err := wstore.AppendRun(ctx, g.ChannelId, childRun); err != nil {
			return err
		}
		if err := MarkRunning(g, taskID, childRun.ID); err != nil {
			return err
		}
		g.Tasks[taskIdx(g, taskID)].LastActivity = now // the child is newborn: stall clock starts at spawn
		publishDagEvent(DagEventTaskSpawned, g, taskID)
		appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskSpawned, nil, map[string]any{"taskid": taskID})
	}
	RecomputeDagStatus(g)
	// status-transition notifications: gate-open / blocked / complete wake the lead.
	switch g.Status {
	case DagStatus_AwaitingReview:
		publishDagEvent(DagEventGateOpen, g, "")
		_ = NotifyLead(ctx, g, DagEventGateOpen, fmt.Sprintf("gate %s", gatedTaskID(g)))
	case DagStatus_Blocked:
		publishDagEvent(DagEventBlocked, g, "")
		appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindDagBlocked, nil, map[string]any{"failures": g.Failures})
		_ = NotifyLead(ctx, g, DagEventBlocked, fmt.Sprintf("%d failures", g.Failures))
	case DagStatus_Done:
		publishDagEvent(DagEventComplete, g, "")
		appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindDagDone, nil, map[string]any{})
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

// HeadlessContract is appended to every DAG child's goal. Children are unattended but not mute:
// a genuinely consequential decision the plan didn't pin must go UP — the child's ask is forwarded
// to the orchestrator lead (dag:child-ask event + parent-run card), who answers it or escalates to
// the human. The child waits for the answer rather than guessing. What children must NOT do is the
// lead's job: no design-approval gates, no plan rewriting — the plan was already approved.
const HeadlessContract = "You are a DAG child worker. The plan was already approved — do not pause for design approval, do not re-plan, and do not silently invent unpinned decisions when they are genuinely consequential. If a real decision is blocking you and the plan does not pin it, ask: your question is forwarded to the orchestrator lead, who answers it or escalates it to the human. Ask once with a concrete question and concrete options, then wait — the answer will be delivered to you. When the task is fully done: commit your changes in this working tree and run `wsh jarvis complete --commit $(git rev-parse HEAD)` from it, so the engine records the task complete."

// taskPrompt is the child's goal: per-task RunSpec goal, else the task label, with the plan
// description (decision pins) and the headless contract appended so the child never re-asks what the
// plan already decided.
func taskPrompt(task *waveobj.TaskNode, owner *waveobj.Run) string {
	var b strings.Builder
	if task.RunSpec.Goal != "" {
		b.WriteString(task.RunSpec.Goal)
	} else if task.Label != "" {
		b.WriteString(task.Label)
	} else {
		fmt.Fprintf(&b, "task %s of %q", task.ID, owner.Goal)
	}
	if task.Description != "" {
		b.WriteString("\n\n")
		b.WriteString(task.Description)
	}
	b.WriteString("\n\n")
	b.WriteString(HeadlessContract)
	return b.String()
}

func effectiveTaskRoute(task *waveobj.TaskNode, owner *waveobj.Run) waveobj.RoutePin {
	if task.RunSpec.Runtime != "" || task.RunSpec.Tier != "" {
		return runroute.NormalizeLegacy(task.RunSpec.Runtime, task.RunSpec.Tier)
	}
	return runroute.NormalizeLegacy(owner.Runtime, owner.Tier)
}

// childRunFromSpec builds the child run that owns the spawned worker. The child carries
// DagORef so GroupForRun resolves the group from any run in the DAG, and its ProjectPath is
// the worktree cwd so evidence/continuity machinery scopes to the isolated checkout.
func childRunFromSpec(g *waveobj.TaskGroup, task *waveobj.TaskNode, owner *waveobj.Run, route waveobj.RoutePin, cwd, goal string) waveobj.Run {
	mode := task.RunSpec.Mode
	if mode == "" {
		mode = jarvis.RunMode_Quick
	}
	run := jarvis.NewRun(goal, owner.WorkspaceId, cwd, nil, mode, jarvis.QuickPlaybook(), time.Now().UnixMilli())
	run.Runtime = route.Runtime
	run.Tier = route.Tier
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

// appendRunEvent records a lifecycle event on the dag's owning run's log and broadcasts it to the
// focused run card. Best-effort telemetry — a failure is logged, never returned: the engine's
// scheduling must not fail over a log write. Local copy of the wshserver helper (that package imports
// this one, so a shared implementation would be a cycle).
func appendRunEvent(ctx context.Context, channelId, runId, kind string, phaseIdx *int, detail any) {
	if ev, err := wstore.AppendRunEvent(ctx, channelId, runId, kind, phaseIdx, detail); err != nil {
		log.Printf("appendRunEvent(%s): %v", kind, err)
	} else {
		wps.Broker.Publish(wps.WaveEvent{
			Event:  wps.Event_RunEvent,
			Scopes: []string{waveobj.MakeORef(waveobj.OType_Run, runId).String()},
			Data:   wshrpc.RunEventData{ChannelId: channelId, RunId: runId, Event: ev},
		})
	}
}
