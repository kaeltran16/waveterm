package wshserver

// DAG execution is engine-owned: persisted TaskGroups and waveobj updates drive supervision.
// ScheduleOnce and the watchdog advance tasks from persisted state without the lead worker.
// The lead receives notifications for visibility, but its phase worker is not an execution dependency.

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/harness"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// readPlanFile reads and parses the plan at path. wavesrv does not share the caller's cwd, so only an
// absolute path names the file the caller meant.
func readPlanFile(path string) (jarvis.Plan, error) {
	if !filepath.IsAbs(path) {
		return jarvis.Plan{}, fmt.Errorf("planpath %q must be absolute", path)
	}
	src, err := os.ReadFile(path)
	if err != nil {
		return jarvis.Plan{}, fmt.Errorf("reading plan: %w", err)
	}
	plan, err := jarvis.ParsePlan(string(src))
	if err != nil {
		return jarvis.Plan{}, fmt.Errorf("plan %s: %w", path, err)
	}
	return plan, nil
}

// planTitle names a plan by its heading, else by its file.
func planTitle(plan jarvis.Plan, path string) string {
	if plan.Title != "" {
		return plan.Title
	}
	return strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
}

// loadDagPlan fills a submit's tasks, and its title and width when unset, from its plan file, and
// returns the plan for its Verify and Setup commands.
func loadDagPlan(data *wshrpc.CommandDagSubmitData) (jarvis.Plan, error) {
	if len(data.Tasks) > 0 {
		return jarvis.Plan{}, fmt.Errorf("pass tasks or planpath, not both")
	}
	if data.SpecPath != "" {
		if !filepath.IsAbs(data.SpecPath) {
			return jarvis.Plan{}, fmt.Errorf("specpath %q must be absolute", data.SpecPath)
		}
		// checked now: a mistyped path would otherwise surface only as a log line at the first merge
		if _, err := os.Stat(data.SpecPath); err != nil {
			return jarvis.Plan{}, fmt.Errorf("reading spec: %w", err)
		}
	}
	plan, err := readPlanFile(data.PlanPath)
	if err != nil {
		return jarvis.Plan{}, err
	}
	data.Tasks = plan.Tasks
	if data.Title == "" {
		data.Title = planTitle(plan, data.PlanPath)
	}
	if data.Parallelism == 0 {
		data.Parallelism = orchestrate.DefaultParallelism(plan.Tasks)
	}
	return plan, nil
}

// DagPlanPreviewCommand parses a plan for + Run before a run exists, so a plan that will not run is refused
// before start and the human sees the shape the engine will run.
func (ws *WshServer) DagPlanPreviewCommand(ctx context.Context, data wshrpc.CommandDagPlanPreviewData) (*wshrpc.CommandDagPlanPreviewRtnData, error) {
	plan, err := readPlanFile(data.PlanPath)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandDagPlanPreviewRtnData{
		Title:  planTitle(plan, data.PlanPath),
		Verify: plan.Verify,
		Setup:  plan.Setup,
		Shape:  orchestrate.PlanShapeOf(plan.Tasks),
	}, nil
}

// postHandoff is a var so tests can see which submits hand a lead its compaction.
var postHandoff = orchestrate.PostHandoff

func (ws *WshServer) DagSubmitCommand(ctx context.Context, data wshrpc.CommandDagSubmitData) (*waveobj.TaskGroup, error) {
	var plan jarvis.Plan
	if data.SpecPath != "" && data.PlanPath == "" {
		return nil, fmt.Errorf("specpath needs planpath: the spec is committed with the plan it produced")
	}
	if data.PlanPath != "" {
		loaded, err := loadDagPlan(&data)
		if err != nil {
			return nil, err
		}
		plan = loaded
	}
	if data.ChannelId == "" || data.RunId == "" || len(data.Tasks) == 0 {
		return nil, fmt.Errorf("channelid, runid and tasks are required")
	}
	run, err := wstore.GetRun(ctx, data.ChannelId, data.RunId)
	if err != nil {
		return nil, fmt.Errorf("loading run: %w", err)
	}
	if run.Mode != jarvis.RunMode_Orchestrator {
		return nil, fmt.Errorf("dag requires an orchestrator-mode run")
	}
	ownerPin := waveobj.RoutePin{Runtime: runroute.DefaultRuntime(run.Runtime), Model: run.Model}
	for _, task := range data.Tasks {
		// an absent runtime inherits the owner's, exactly as dispatch does; a runtime with no model is
		// that runtime's default
		pin := ownerPin
		if task.RunSpec.Runtime != "" || task.RunSpec.Model != "" {
			runtime := task.RunSpec.Runtime
			if runtime == "" {
				runtime = ownerPin.Runtime
			}
			pin = waveobj.RoutePin{Runtime: runtime, Model: task.RunSpec.Model}
		}
		if _, err := runroute.Resolve(pin); err != nil {
			return nil, fmt.Errorf("task %q: %w", task.ID, err)
		}
		if _, err := validateHarness(pin.Runtime, harness.OperationRunWorker); err != nil {
			return nil, fmt.Errorf("task %q: %w", task.ID, err)
		}
	}
	if data.WorkerRoute != nil {
		if _, err := runroute.Resolve(*data.WorkerRoute); err != nil {
			return nil, fmt.Errorf("workerRoute %w", err)
		}
		if _, err := validateHarness(data.WorkerRoute.Runtime, harness.OperationRunWorker); err != nil {
			return nil, fmt.Errorf("workerRoute %w", err)
		}
	}
	workerRoute := data.WorkerRoute
	if workerRoute == nil {
		workerRoute = run.WorkerRoute
	}
	mergeRequired := orchestrate.IsGitRepo(run.ProjectPath)
	// The width is the human's dial, not the lead's: N concurrent children are N live worktrees and N
	// token streams, a cost the human pays. Their choice (Run rail, stored on the run) therefore wins
	// over whatever the lead submits. The prompt already told the lead this number, so a lead that
	// followed it sees no change; one that ignored it does not get to overspend.
	parallelism := data.Parallelism
	if run.Parallelism > 0 {
		parallelism = run.Parallelism
	}
	proposed, err := orchestrate.NewTaskGroup(data.RunId, data.ChannelId, data.Title, parallelism, mergeRequired, data.Tasks, time.Now().UnixMilli(), workerRoute)
	if err != nil {
		return nil, err
	}
	proposed.Verify, proposed.Setup = plan.Verify, plan.Setup
	proposed.PlanPath, proposed.SpecPath = data.PlanPath, data.SpecPath
	stored, created, err := wstore.CreateDagForRun(ctx, data.ChannelId, data.RunId, &proposed, func(run *waveobj.Run) error {
		if run.Mode != jarvis.RunMode_Orchestrator {
			return fmt.Errorf("dag requires an orchestrator-mode run")
		}
		// accept both a deferred planning run and a live lead run that publishes its dag mid-run
		// (the adaptive orchestrator flow starts the orchestrate phase immediately). CreateDagForRun
		// rejects a run that already links a dag, so allowing executing cannot double-publish.
		if run.Status != jarvis.RunStatus_Planning && run.Status != jarvis.RunStatus_Executing {
			return fmt.Errorf("dag run %s is %s, want planning or executing", run.ID, run.Status)
		}
		run.Status = jarvis.RunStatus_Executing
		return nil
	})
	if err != nil {
		return nil, err
	}
	if !created {
		if !orchestrate.SameDagProposal(stored, &proposed) {
			return nil, fmt.Errorf("dag conflict: run %s already holds a different dag; a run holds exactly one dag for its whole lifetime, so remaining work needs a new run, not a second submission", data.RunId)
		}
	} else {
		zero := 0
		appendRunEvent(ctx, data.ChannelId, data.RunId, waveobj.RunEventKindPhaseStarted, &zero, map[string]any{})
		// a lead that just handed its plan over compacts at that boundary (spec §7); a run with no lead
		// worker, a human-planned one, has nobody to compact
		if leadORef(run) != "" {
			postHandoff(ctx, data.ChannelId, data.RunId)
		}
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, stored.OID))
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Run, data.RunId))
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	// the submitting tick: it derives the group's status, publishes it and dispatches the first layer.
	if serr := orchestrate.Schedule(ctx, stored.OID); serr != nil {
		log.Printf("dag submit schedule error: %v", serr)
	}
	if fresh, err := wstore.GetDag(ctx, stored.OID); err == nil {
		return fresh, nil
	}
	return stored, nil
}

// dagDigestChildRunLimit bounds the child runs a status snapshot loads; the digest never pages the
// list, so this is a cost bound on one snapshot, not a limit on how large a plan may be.
const dagDigestChildRunLimit = 64

// dagDigestRetainedKinds are the lifecycle rows the digest derives durations, retries and the report's counts from.
// The UI's 200-row window is not consulted.
var dagDigestRetainedKinds = []string{
	waveobj.RunEventKindTaskRetried,
	waveobj.RunEventKindTaskDone,
	waveobj.RunEventKindTaskMergeStarted,
	waveobj.RunEventKindTaskCleanupPending,
	waveobj.RunEventKindTaskCleanupCompleted,
	waveobj.RunEventKindTaskCleanupFailed,
	waveobj.RunEventKindDagDone,
	waveobj.RunEventKindDagCancelled,
	waveobj.RunEventKindChildAnswered,
	waveobj.RunEventKindTaskForwarded,
}

func (ws *WshServer) DagStatusCommand(ctx context.Context, data wshrpc.CommandDagStatusData) (*wshrpc.CommandDagStatusRtnData, error) {
	run, err := wstore.GetRun(ctx, data.ChannelId, data.RunId)
	if err != nil {
		return nil, fmt.Errorf("loading run: %w", err)
	}
	if run.DagORef == "" {
		return nil, fmt.Errorf("run has no dag")
	}
	g, err := wstore.GetDag(ctx, run.DagORef)
	if err != nil {
		return nil, err
	}
	sn := orchestrate.DagDigestSnapshot{
		Group:    g,
		Runs:     dagDigestChildRuns(ctx, data.ChannelId, g),
		Asks:     gatherDagAsks(ctx, run),
		Retained: dagDigestRetained(ctx, data.ChannelId, data.RunId),
		Now:      time.Now(),
	}
	return &wshrpc.CommandDagStatusRtnData{Group: g, Digest: orchestrate.BuildDigest(sn)}, nil
}

// dagDigestChildRuns loads at most dagDigestChildRunLimit unique child runs of the group's tasks;
// per-run load failures degrade to partial durations, never a status error.
func dagDigestChildRuns(ctx context.Context, channelId string, g *waveobj.TaskGroup) []*waveobj.Run {
	var out []*waveobj.Run
	seen := map[string]bool{}
	for i := range g.Tasks {
		runId := g.Tasks[i].RunID
		if runId == "" || seen[runId] || len(out) >= dagDigestChildRunLimit {
			continue
		}
		seen[runId] = true
		child, err := wstore.GetRun(ctx, channelId, runId)
		if err != nil {
			continue
		}
		out = append(out, child)
	}
	return out
}

// dagDigestRetained loads the bounded retained lifecycle rows the digest needs. A query failure
// degrades durations to partial rather than failing the status request.
func dagDigestRetained(ctx context.Context, channelId, runId string) []waveobj.RunEvent {
	ev, err := wstore.QueryRunEventsByKind(ctx, channelId, runId, dagDigestRetainedKinds, 0)
	if err != nil {
		log.Printf("dag digest retained events: %v", err)
		return nil
	}
	return ev
}

func (ws *WshServer) DagActionCommand(ctx context.Context, data wshrpc.CommandDagActionData) error {
	if data.ChannelId == "" || data.RunId == "" || data.Action == "" {
		return fmt.Errorf("channelid, runid and action are required")
	}
	run, err := wstore.GetRun(ctx, data.ChannelId, data.RunId)
	if err != nil {
		return fmt.Errorf("loading run: %w", err)
	}
	if run.DagORef == "" {
		return fmt.Errorf("run has no dag")
	}
	switch data.Action {
	case "cancel":
		return orchestrate.Cancel(ctx, run.DagORef)
	case "forward":
		return orchestrate.ForwardTask(ctx, run.DagORef, data.TaskId, data.Notes)
	}
	target := waveobj.RoutePin{Runtime: data.Runtime, Model: data.Model}
	return orchestrate.ApplyAction(ctx, run.DagORef, data.TaskId, data.Action, target)
}

// leadORef is the tab oref of the worker driving the run's running phase, or "" when there is none.
// An orchestrator run has exactly one phase, so this is the lead. Empty is a normal answer (the lead
// exited, or the run is deferred) and steerRunLead treats it as a no-op.
func leadORef(run *waveobj.Run) string {
	for i := range run.Phases {
		p := &run.Phases[i]
		if p.State == jarvis.PhaseState_Running && len(p.WorkerOrefs) > 0 {
			return p.WorkerOrefs[0]
		}
	}
	return ""
}

// gatherDagAsks lists the dag's question queue: every pending ask of its children, whoever holds it.
// Children block on one ask at a time and their own cards are invisible on the child sessions, so this
// is how the lead (`dag asks`) and the run cockpit see them. Shared by the asks RPC and the status
// digest.
func gatherDagAsks(ctx context.Context, run *waveobj.Run) []wshrpc.DagAskItem {
	g, err := wstore.GetDag(ctx, run.DagORef)
	if err != nil {
		return nil
	}
	var items []wshrpc.DagAskItem
	for i := range g.Tasks {
		task := &g.Tasks[i]
		if task.RunID == "" {
			continue
		}
		child, cerr := wstore.GetRun(ctx, run.ChannelOID, task.RunID)
		if cerr != nil {
			continue
		}
		for _, bo := range orchestrate.RunBlockORefs(ctx, child) {
			pending, ok := agentask.GlobalRegistry.Get(bo)
			if !ok || len(pending.Questions) == 0 {
				continue
			}
			items = append(items, wshrpc.DagAskItem{
				TaskId:    task.ID,
				AskId:     pending.AskId,
				Owner:     pending.Owner,
				Deadline:  pending.Deadline,
				Note:      pending.Note,
				Questions: pending.Questions,
				BlockORef: bo,
				Ts:        pending.Ts,
			})
		}
	}
	return items
}

// DagAsksCommand lists the pending asks of the dag's running children.
func (ws *WshServer) DagAsksCommand(ctx context.Context, data wshrpc.CommandDagStatusData) (*wshrpc.CommandDagAsksRtnData, error) {
	run, err := wstore.GetRun(ctx, data.ChannelId, data.RunId)
	if err != nil {
		return nil, fmt.Errorf("loading run: %w", err)
	}
	if run.DagORef == "" {
		return nil, fmt.Errorf("run has no dag")
	}
	return &wshrpc.CommandDagAsksRtnData{Asks: gatherDagAsks(ctx, run)}, nil
}

// DagAnswerCommand delivers an answer to a child's pending ask: the lead's, after a `wake: N questions
// waiting` line, or the human's, for a question the lead forwarded. The child blocks until the answer
// resolves, so this is what unblocks a question-raised child.
func (ws *WshServer) DagAnswerCommand(ctx context.Context, data wshrpc.CommandDagAnswerData) error {
	run, err := wstore.GetRun(ctx, data.ChannelId, data.RunId)
	if err != nil {
		return fmt.Errorf("loading run: %w", err)
	}
	if run.DagORef == "" {
		return fmt.Errorf("run has no dag")
	}
	g, err := wstore.GetDag(ctx, run.DagORef)
	if err != nil {
		return err
	}
	for i := range g.Tasks {
		if g.Tasks[i].ID != data.TaskId || g.Tasks[i].RunID == "" {
			continue
		}
		child, cerr := wstore.GetRun(ctx, data.ChannelId, g.Tasks[i].RunID)
		if cerr != nil {
			return fmt.Errorf("loading child run: %w", cerr)
		}
		blocks := orchestrate.RunBlockORefs(ctx, child)
		if len(blocks) == 0 {
			return fmt.Errorf("task %s has no worker blocks", data.TaskId)
		}
		for _, bo := range blocks {
			if _, pending := agentask.GlobalRegistry.Get(bo); pending {
				// child-answered is recorded by the shared answer hook inside DeliverAnswer, so
				// this path cannot diverge from a cockpit or Gatekeeper answer.
				return ws.AnswerAgentCommand(ctx, wshrpc.CommandAnswerAgentData{ORef: bo, Answers: data.Answers})
			}
		}
		return fmt.Errorf("task %s has no pending ask", data.TaskId)
	}
	return fmt.Errorf("no task %q", data.TaskId)
}

// DagMergeCommand squash-merges one finished task's worktree back into the project branch. RunId is
// the dag's owning run (which has no worktree of its own); TaskId selects the child — the branch is
// keyed by the composite worktree key the engine spawned, never by a run id.
// DagMergeCommand lands a task's merge on a human's instruction. The engine lands a clean merge on
// its own (orchestrate.AutoMergeReady); this stays the way to land one it declined to — a project
// tree with staged edits, or a conflict the caller has since made mergeable.
func (ws *WshServer) DagMergeCommand(ctx context.Context, data wshrpc.CommandDagMergeData) error {
	return orchestrate.MergeTask(ctx, data.ChannelId, data.RunId, data.TaskId)
}

// DagMergeContinueCommand is `dag merge <task> --continue`: it finishes a squash merge the caller
// resolved after a conflict, or re-runs Verify after the caller committed a fix.
func (ws *WshServer) DagMergeContinueCommand(ctx context.Context, data wshrpc.CommandDagMergeData) error {
	return orchestrate.ContinueMerge(ctx, data.ChannelId, data.RunId, data.TaskId)
}
