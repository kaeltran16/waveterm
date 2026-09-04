package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"log"
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
	DagEventTaskRetried = wps.DagEventTaskRetried
)

// spawnWorker is the child-run launch seam. Package var so engine tests can stub it;
// defaults to jarvis.SpawnRunWorker, read at call time so external stubs (e.g. swapping
// jarvis.SpawnRunWorker in handler tests) take effect too.
var spawnWorker = func(ctx context.Context, cap runroute.Capability, workspaceId, projectName, cwd, prompt string, opts jarvis.RunWorkerOptions) (string, error) {
	return jarvis.SpawnRunWorker(ctx, cap, workspaceId, projectName, cwd, prompt, opts)
}

var validateWorkerHarness = func(runtime string) error {
	_, err := harness.ValidateInstalled(runtime, harness.OperationRunWorker)
	return err
}

// SetValidateWorkerHarnessForTest stubs harness validation for tests.
func SetValidateWorkerHarnessForTest(fn func(string) error) func() {
	old := validateWorkerHarness
	validateWorkerHarness = fn
	return func() { validateWorkerHarness = old }
}

var appendChildRun = wstore.AppendRun
var stopSpawnedWorker = jarvis.StopRunWorker
var stampSpawnedWorker = wstore.StampWorkerOwner

const scheduleCleanupTimeout = 10 * time.Second

type spawnedWorkerInfo struct {
	childRun  waveobj.Run
	oref      string
	taskID    string
	persisted bool
}

func publishSpawnedRunUpdates(channelID string, spawned []spawnedWorkerInfo) {
	publishedChannel := false
	for _, sp := range spawned {
		if !sp.persisted {
			continue
		}
		wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Run, sp.childRun.ID))
		publishedChannel = true
	}
	if publishedChannel {
		wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, channelID))
	}
}

func cleanupScheduleFailure(ctx, workerCtx context.Context, g *waveobj.TaskGroup, spawned []spawnedWorkerInfo, cause error) error {
	cleanupCtx := ctx
	cancel := func() {}
	if cleanupCtx.Err() != nil {
		cleanupCtx, cancel = context.WithTimeout(context.WithoutCancel(ctx), scheduleCleanupTimeout)
	}
	defer cancel()
	if workerCtx.Err() != nil {
		workerCtx = cleanupCtx
	}

	errs := []error{cause}
	for _, sp := range spawned {
		if err := stopSpawnedWorker(workerCtx, sp.oref); err != nil {
			errs = append(errs, fmt.Errorf("stop worker %s for task %s: %w", sp.oref, sp.taskID, err))
		}
		if !sp.persisted {
			continue
		}
		if err := wstore.UpdateRun(cleanupCtx, g.ChannelId, sp.childRun.ID, func(r *waveobj.Run) error {
			*r = jarvis.CancelRun(*r)
			return nil
		}); err != nil {
			errs = append(errs, fmt.Errorf("cancel child run %s for task %s: %w", sp.childRun.ID, sp.taskID, err))
		}
	}

	publishSpawnedRunUpdates(g.ChannelId, spawned)
	fresh, err := wstore.GetDag(cleanupCtx, g.OID)
	if err != nil {
		return errors.Join(append(errs, fmt.Errorf("reload dag for task failure cleanup: %w", err))...)
	}
	for _, sp := range spawned {
		if idx := taskIdx(fresh, sp.taskID); idx >= 0 {
			fresh.Tasks[idx].State = TaskState_Failed
			fresh.Tasks[idx].RunID = ""
		}
	}
	fresh.UpdatedTs = time.Now().UnixMilli()
	RecomputeDagStatus(fresh)
	if err := wstore.UpdateDag(cleanupCtx, fresh.OID, func(cur *waveobj.TaskGroup) error {
		*cur = *fresh
		return nil
	}); err != nil {
		errs = append(errs, fmt.Errorf("recording task failure: %w", err))
	} else {
		wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, fresh.OID))
	}
	return errors.Join(errs...)
}

// failDispatch records a task that died before it ever started. A dispatch failure produces no child
// run and no transcript, so unless the reason is written here it exists nowhere: the classifier kind
// lands on the node (feeding the digest's blocking-kind), the message on the task-failed lifecycle
// event, and the raw error in the server log. RecomputeDagStatus already blocks the DAG on any failed
// task, so the streak counter is deliberately untouched — this is a dispatch fault, not a run of bad
// worker outcomes.
func failDispatch(ctx context.Context, g *waveobj.TaskGroup, taskID, kind string, cause error, afterCommit *[]func()) {
	idx := taskIdx(g, taskID)
	if idx < 0 {
		return
	}
	g.Tasks[idx].State = TaskState_Failed
	g.Tasks[idx].LastFailureKind = kind
	g.Tasks[idx].Attempts++
	log.Printf("schedule dag %s task %s: %s: %v", g.OID, taskID, kind, cause)
	detail := truncateText(cause.Error(), MaxFailureDetailLen)
	attempts := g.Tasks[idx].Attempts
	*afterCommit = append(*afterCommit, func() {
		appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskFailed, nil, map[string]any{
			"taskid": taskID, "lastfailurekind": kind, "attempts": attempts, "detail": detail,
		})
	})
}

// Schedule advances the DAG one step: derive task states from child runs, count
// consecutive failures, spawn ready tasks (managed worktrees when the project is git),
// persist, and publish waveobj + event updates. Idempotent — safe to call repeatedly.
// It is authoritative: it reloads the DAG after acquiring the per-DAG mutation lock.
func Schedule(ctx context.Context, dagID string) error {
	return withDagMutation(dagID, func() error {
		return scheduleLocked(ctx, dagID)
	})
}

// ScheduleOnce is a compatibility wrapper for callers that still hold a TaskGroup snapshot.
func ScheduleOnce(ctx context.Context, g *waveobj.TaskGroup) error {
	if g == nil {
		return fmt.Errorf("dag is required")
	}
	if err := Schedule(ctx, g.OID); err != nil {
		return err
	}
	// keep the caller's snapshot in sync for legacy callers
	if fresh, err := wstore.GetDag(ctx, g.OID); err == nil {
		*g = *fresh
	}
	return nil
}

func scheduleLocked(ctx context.Context, dagID string) error {
	g, err := wstore.GetDag(ctx, dagID)
	if err != nil {
		return fmt.Errorf("loading dag: %w", err)
	}
	if g.Status == DagStatus_Cancelled {
		return nil
	}
	// cleanup debt retry (ordinary merge retry / interrupted prior run): a merged task still
	// owning its worktree is retried through the same idempotent helper before any dispatch, and
	// the outcome persists with this tick's group write. A still-stuck tree never blocks
	// scheduling — it stays visible as task debt for the digest's attention.
	if HasCleanupDebt(g) {
		_ = RetryPendingCleanup(ctx, g)
		if err := PersistCleanupState(ctx, g); err != nil {
			return fmt.Errorf("persisting cleanup retry for dag %s: %w", g.ID, err)
		}
	}
	var afterCommit []func()
	spawnCtx := context.WithoutCancel(ctx)
	spawnCtx, cancel := context.WithTimeout(spawnCtx, jarvis.RunWorkerSpawnTimeout)
	defer cancel()
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
	// liveness + stall detection: refresh each running task's last-activity from its child's own
	// transcript writes; a running task silent past StallThreshold is flagged stalled and reported to
	// the lead (nothing else ever notices a headless child that stopped progressing). A stalled task
	// whose child later completes still derives done (DeriveTaskStates).
	now := time.Now().UnixMilli()
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.RunID == "" {
			continue
		}
		activity, tracked := lastActivityForRun(runs[t.RunID], dagSessionMarker(g.OID, t.ID))
		if activity > t.LastActivity {
			t.LastActivity = activity
		}
		// no readable activity source: the spawn-time seed would age into a stall on its own and hand
		// the lead a retry that kills a working child. Report freshness unknown (zero) instead — a
		// missed stall only costs a timeout.
		if !tracked {
			t.LastActivity = 0
			continue
		}
		if t.State == TaskState_Running && t.LastActivity > 0 && now-t.LastActivity > StallThreshold.Milliseconds() {
			t.State = TaskState_Stalled
		}
		// first-token deadline: a child that has written nothing has no mtime to age, so without this
		// it can never stall. The exit hook catches a child that DIED before its first token; this
		// catches one that hangs, which leaves no signal anywhere else.
		if spawned := spawnTs(runs[t.RunID]); t.State == TaskState_Running && t.LastActivity == 0 &&
			spawned > 0 && now-spawned > FirstTokenDeadline.Milliseconds() {
			t.State = TaskState_Stalled
		}
	}
	// child-done notification: a task whose child just reached done wakes the lead (publish + control file)
	// and records the task-done lifecycle boundary (task id + child run id).
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.State == TaskState_Done && t.RunID != "" && prevStates[t.ID] == TaskState_Running {
			taskID := t.ID
			childRunID := t.RunID
			afterCommit = append(afterCommit, func() {
				publishDagEvent(DagEventChildDone, g, taskID)
				notifyLeadBestEffort(ctx, g, DagEventChildDone, taskID, taskID)
				appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskDone, nil, map[string]any{"taskid": taskID, "runid": childRunID})
			})
		}
		if t.State == TaskState_Stalled && prevStates[t.ID] == TaskState_Running {
			taskID := t.ID
			afterCommit = append(afterCommit, func() {
				PublishTaskStalled(ctx, g, taskID)
				appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskStalled, nil, map[string]any{"taskid": taskID})
			})
		}
	}
	// consecutive-failure accounting: a failure *streak* breaks only on a fresh success —
	// a task that completed in an earlier tick must not keep resetting the counter, or the
	// circuit-break at MaxConsecutiveFailures could never trip once any task had ever succeeded.
	freshSuccess := false
	for i := range g.Tasks {
		if prevStates[g.Tasks[i].ID] != TaskState_Running || g.Tasks[i].State != TaskState_Done {
			continue
		}
		freshSuccess = true
		g.Tasks[i].Attempts = 0
		g.Tasks[i].LastFailureKind = ""
	}
	if freshSuccess && g.Failures > 0 {
		g.Failures = 0
	}
	for i := range g.Tasks {
		if g.Tasks[i].State == TaskState_Failed && prevStates[g.Tasks[i].ID] == TaskState_Running {
			g.Failures++
			// task-failed: record the terminal failure boundary (task id, child run id, failure
			// classifier, attempt count) — emitted only after the persist lands.
			taskID := g.Tasks[i].ID
			childRunID := g.Tasks[i].RunID
			kind := g.Tasks[i].LastFailureKind
			attempts := g.Tasks[i].Attempts
			afterCommit = append(afterCommit, func() {
				appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskFailed, nil, map[string]any{"taskid": taskID, "runid": childRunID, "lastfailurekind": kind, "attempts": attempts})
			})
		}
	}
	var spawned []spawnedWorkerInfo
	spawnBase := owner.BaseCommit
	if g.MergeRequired {
		spawnBase, err = ProjectHeadCommit(spawnCtx, owner.ProjectPath)
		if err != nil {
			return fmt.Errorf("resolving project head for dag %s: %w", g.ID, err)
		}
	}
	for _, taskID := range NextToSpawn(g) {
		task := taskByID(g, taskID)
		pin := effectiveTaskRoute(task, owner, g)
		capability, routeErr := runroute.Resolve(pin)
		if routeErr != nil {
			failDispatch(ctx, g, taskID, FailureKindRoute, routeErr, &afterCommit)
			continue
		}
		if harnessErr := validateWorkerHarness(pin.Runtime); harnessErr != nil {
			failDispatch(ctx, g, taskID, FailureKindHarness, harnessErr, &afterCommit)
			continue
		}
		cwd := owner.ProjectPath
		if IsGitRepo(owner.ProjectPath) {
			wt, werr := EnsureRunWorktree(spawnCtx, owner.ProjectPath, TaskWorktreeKey(owner.ID, taskID), spawnBase)
			if werr != nil {
				failDispatch(ctx, g, taskID, FailureKindWorktree, werr, &afterCommit)
				continue
			}
			cwd = wt
		}
		prompt := taskPrompt(task, owner) + "\n\n" + dagSessionMarker(g.OID, taskID)
		oref, err := spawnWorker(spawnCtx, capability, owner.WorkspaceId, "", cwd, prompt, jarvis.RunWorkerOptions{})
		if err != nil {
			failDispatch(ctx, g, taskID, FailureKindSpawn, err, &afterCommit)
			continue
		}
		// a fresh dispatch writes a new transcript; drop any cached path from a prior attempt so
		// liveness never reads the dead session's mtime as this one's heartbeat.
		sessionPathCache.Delete(dagSessionMarker(g.OID, taskID))
		childRun := childRunFromSpec(g, task, owner, pin, cwd, spawnBase, prompt)
		// attach worker to child run before persisting
		attached := false
		for i := range childRun.Phases {
			if childRun.Phases[i].State == jarvis.PhaseState_Running {
				childRun.Phases[i].WorkerOrefs = []string{oref}
				attached = true
				break
			}
		}
		spawned = append(spawned, spawnedWorkerInfo{childRun: childRun, oref: oref, taskID: taskID})
		if !attached {
			return cleanupScheduleFailure(ctx, spawnCtx, g, spawned, fmt.Errorf("child run for task %s has no running phase", taskID))
		}
		if err := appendChildRun(ctx, g.ChannelId, childRun); err != nil {
			return cleanupScheduleFailure(ctx, spawnCtx, g, spawned, fmt.Errorf("persisting child run for task %s: %w", taskID, err))
		}
		spawned[len(spawned)-1].persisted = true
		runORef := waveobj.MakeORef(waveobj.OType_Run, childRun.ID).String()
		channelORef := waveobj.MakeORef(waveobj.OType_Channel, g.ChannelId).String()
		if err := stampSpawnedWorker(spawnCtx, oref, runORef, channelORef); err != nil {
			log.Printf("schedule dag %s task %s: stamp worker %s: %v", g.OID, taskID, oref, err)
		}
		if err := MarkRunning(g, taskID, childRun.ID); err != nil {
			return cleanupScheduleFailure(ctx, spawnCtx, g, spawned, err)
		}
		g.Tasks[taskIdx(g, taskID)].LastActivity = now
		spawnedTaskID := taskID
		afterCommit = append(afterCommit, func() {
			publishDagEvent(DagEventTaskSpawned, g, spawnedTaskID)
			appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskSpawned, nil, map[string]any{"taskid": spawnedTaskID})
		})
	}
	RecomputeDagStatus(g)
	// status-transition notifications: gate-open / blocked / complete wake the lead.
	switch g.Status {
	case DagStatus_AwaitingReview:
		gateTask := gatedTaskID(g)
		detail := fmt.Sprintf("gate %s", gateTask)
		afterCommit = append(afterCommit, func() {
			publishDagEvent(DagEventGateOpen, g, "")
			notifyLeadBestEffort(ctx, g, DagEventGateOpen, detail, gateTask)
			appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindDagGateOpen, nil, map[string]any{"taskid": gateTask})
		})
	case DagStatus_Blocked:
		failures := g.Failures
		blockingKind := ""
		for i := range g.Tasks {
			kind := g.Tasks[i].LastFailureKind
			if g.Tasks[i].State != TaskState_Failed || kind == "" {
				continue
			}
			if blockingKind == "" {
				blockingKind = kind
				continue
			}
			if blockingKind != kind {
				blockingKind = "mixed"
				break
			}
		}
		afterCommit = append(afterCommit, func() {
			publishDagEvent(DagEventBlocked, g, "")
			appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindDagBlocked, nil, map[string]any{"failures": failures, "kind": blockingKind})
			notifyLeadBestEffort(ctx, g, DagEventBlocked, fmt.Sprintf("%d failures", failures), "")
		})
	case DagStatus_Done:
		afterCommit = append(afterCommit, func() {
			publishDagEvent(DagEventComplete, g, "")
			appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindDagDone, nil, map[string]any{})
			notifyLeadBestEffort(ctx, g, DagEventComplete, "all tasks done", "")
		})
	}
	g.UpdatedTs = time.Now().UnixMilli()
	// whole-object replace: the snapshot was loaded under the dag mutation lock, so it cannot have
	// gone stale. This is only sound while EVERY dag writer holds that lock — a write made outside it
	// (the merge stamp used to be one) is silently discarded here, because UpdateDag hands the mutator
	// the fresh row and this mutator throws it away. Field-scoped writers (PersistCleanupState) are the
	// pattern to follow if a writer ever genuinely cannot take the lock.
	if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
		*cur = *g
		return nil
	}); err != nil {
		return cleanupScheduleFailure(ctx, spawnCtx, g, spawned, err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, g.OID))
	publishSpawnedRunUpdates(g.ChannelId, spawned)
	for _, publish := range afterCommit {
		publish()
	}
	// auto-close the orchestrator lead tab once both the owning run and the DAG are
	// terminal — the lead's process may already be idle (keeponexit kept it), so the
	// shell layer will not delete it. best-effort: never fail Schedule over it.
	if owner != nil {
		if freshRun, err := wstore.GetRun(ctx, g.ChannelId, g.RunID); err == nil {
			if freshDag, err := wstore.GetDag(ctx, g.OID); err == nil {
				_, _ = MaybeCloseOrchestratorLead(ctx, freshRun, freshDag)
			}
		}
	}
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

func effectiveTaskRoute(task *waveobj.TaskNode, owner *waveobj.Run, group *waveobj.TaskGroup) waveobj.RoutePin {
	if task.RunSpec.Model != "" {
		runtime := task.RunSpec.Runtime
		if runtime == "" {
			runtime = owner.Runtime
		}
		return waveobj.RoutePin{Runtime: runtime, Model: task.RunSpec.Model}
	}
	if task.RunSpec.Runtime != "" || task.RunSpec.Tier != "" {
		return runroute.NormalizeLegacy(task.RunSpec.Runtime, task.RunSpec.Tier)
	}
	if group != nil && group.WorkerRoute != nil {
		if group.WorkerRoute.Model != "" {
			return waveobj.RoutePin{Runtime: group.WorkerRoute.Runtime, Model: group.WorkerRoute.Model}
		}
		if group.WorkerRoute.Runtime != "" || group.WorkerRoute.Tier != "" {
			return runroute.NormalizeLegacy(group.WorkerRoute.Runtime, group.WorkerRoute.Tier)
		}
	}
	if owner.Model != "" {
		return waveobj.RoutePin{Runtime: owner.Runtime, Model: owner.Model}
	}
	return runroute.NormalizeLegacy(owner.Runtime, owner.Tier)
}

// childRunFromSpec builds the child run that owns the spawned worker. The child carries
// DagORef so GroupForRun resolves the group from any run in the DAG, and its ProjectPath is
// the worktree cwd so evidence/continuity machinery scopes to the isolated checkout.
func childRunFromSpec(g *waveobj.TaskGroup, task *waveobj.TaskNode, owner *waveobj.Run, route waveobj.RoutePin, cwd, baseCommit, goal string) waveobj.Run {
	mode := task.RunSpec.Mode
	if mode == "" {
		mode = jarvis.RunMode_Quick
	}
	run := jarvis.NewRun(goal, owner.WorkspaceId, cwd, nil, mode, jarvis.QuickPlaybook(), time.Now().UnixMilli())
	run.Runtime = route.Runtime
	run.Tier = route.Tier
	run.Model = route.Model
	run.DagORef = g.OID
	run.BaseCommit = baseCommit
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
// this one, so a shared implementation would be a cycle). Var so tests can stub an append failure.
var appendRunEvent = func(ctx context.Context, channelId, runId, kind string, phaseIdx *int, detail any) {
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
