package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/agentask"
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

// scheduleTickTimeout bounds one detached tick. A tick dispatches up to MaxParallelism workers in
// sequence, each bounded by jarvis.RunWorkerSpawnTimeout, so the bound is that worst case with room to
// spare — it exists to stop a wedged tick living forever, not to pace a healthy one.
const scheduleTickTimeout = 10 * time.Minute

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
	var failed []int
	for _, sp := range spawned {
		if idx := taskIdx(fresh, sp.taskID); idx >= 0 {
			fresh.Tasks[idx].State = TaskState_Failed
			fresh.Tasks[idx].RunID = ""
			fresh.Tasks[idx].LastFailureKind = FailureKindUnrecorded
			fresh.Tasks[idx].Attempts++
			failed = append(failed, idx)
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
		// the child run was cancelled or never persisted, so as with failDispatch the event is the only
		// place the reason survives
		detail := truncateText(cause.Error(), MaxFailureDetailLen)
		for _, idx := range failed {
			appendRunEvent(cleanupCtx, fresh.ChannelId, fresh.RunID, waveobj.RunEventKindTaskFailed, nil, map[string]any{
				"taskid": fresh.Tasks[idx].ID, "lastfailurekind": FailureKindUnrecorded, "attempts": fresh.Tasks[idx].Attempts, "detail": detail,
			})
			PostWake(cleanupCtx, fresh.ChannelId, fresh.RunID, taskFailedWake(fresh.Tasks[idx].ID, FailureKindUnrecorded))
		}
	}
	return errors.Join(errs...)
}

// MaxAutoStallRetries is how many times the engine retries a stalled task itself. A stall is otherwise
// only ever retried by a lead or a human, so a run whose lead is gone stays parked forever; one retry
// clears the transient hang, and a task that stalls again waits for a human.
const MaxAutoStallRetries = 1

// autoRetryStalled returns a freshly stalled task to pending when the run has no live lead to judge it,
// stopping its child first. A run with a live lead is left alone: the lead is woken and decides. The
// dag-wide failure streak is untouched (RetryTask). Reports whether it retried; a failure to stop the
// child leaves the task stalled for a human.
func autoRetryStalled(ctx context.Context, g *waveobj.TaskGroup, taskID string) bool {
	task := taskByID(g, taskID)
	if task == nil || task.StallRetries >= MaxAutoStallRetries {
		return false
	}
	if leadStateFn(ctx, g.ChannelId, g.RunID).Alive {
		return false
	}
	if err := cancelAndStopTaskRun(ctx, g, taskID); err != nil {
		log.Printf("schedule dag %s task %s: auto-retry of stalled task: %v", g.OID, taskID, err)
		return false
	}
	if err := RetryTask(g, taskID); err != nil {
		log.Printf("schedule dag %s task %s: auto-retry of stalled task: %v", g.OID, taskID, err)
		return false
	}
	task.StallRetries++
	task.CPUSample, task.CPUSampleTs = 0, 0
	return true
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
	detail := failureDetail(cause)
	attempts := g.Tasks[idx].Attempts
	*afterCommit = append(*afterCommit, func() {
		appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskFailed, nil, map[string]any{
			"taskid": taskID, "lastfailurekind": kind, "attempts": attempts, "detail": detail,
		})
		PostWake(ctx, g.ChannelId, g.RunID, taskFailedWake(taskID, kind))
	})
}

// Schedule advances the DAG one step: derive task states from child runs, count
// consecutive failures, spawn ready tasks (managed worktrees when the project is git),
// persist, and publish waveobj + event updates. Idempotent — safe to call repeatedly.
// It is authoritative: it reloads the DAG after acquiring the per-DAG mutation lock.
func Schedule(ctx context.Context, dagID string) error {
	// the whole tick owns its lifetime, not just the merge half. Two of the three callers are RPC
	// handlers, and every write a tick makes - the squash commit, the child run rows, the lifecycle
	// events - has to finish whether or not the client that poked it is still waiting. A cancelled tick
	// kills git mid-commit and leaves an index.lock no later tick gets past, spawns workers it cannot
	// record, and drops the task-spawned rows that are the only account of what it did.
	ctx = context.WithoutCancel(ctx)
	ctx, cancel := context.WithTimeout(ctx, scheduleTickTimeout)
	defer cancel()
	// before the tick, not inside it: the merge takes the same lock and it is not reentrant. A
	// landed merge is what makes a dependent's dep satisfied, so merging first lets one tick both
	// land the predecessor and dispatch what it unblocked.
	AutoMergeReady(ctx, dagID)
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
	// transcript writes; a running task silent past StallThreshold is flagged stalled (nothing else ever
	// notices a headless child that stopped progressing). A stalled task whose child later completes
	// still derives done (DeriveTaskStates).
	now := time.Now().UnixMilli()
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.RunID == "" {
			continue
		}
		// a reboot leaves the child run running and its transcript frozen, with nothing to relaunch the worker:
		// waiting out StallThreshold only delays the retry
		if t.State == TaskState_Running && workerControllerGone(ctx, runs[t.RunID]) {
			t.State = TaskState_Stalled
		}
		activity, tracked := lastActivityForRun(runs[t.RunID])
		if activity > t.LastActivity {
			t.LastActivity = activity
		}
		// first-activity boundary: stamped once, from the first tick that can read the child's
		// transcript at all. Spawn stamps LastActivity, so the transition to "has written something"
		// is not visible in that field — this is why FirstActivity is its own stamp rather than a
		// zero check. Without it a child's wall clock is one opaque span and every claim about task
		// size is a guess about which part of it is setup.
		if tracked && activity > 0 && t.FirstActivity == 0 {
			t.FirstActivity = activity
			taskID := t.ID
			sinceSpawn := int64(0)
			if spawned := spawnTs(runs[t.RunID]); spawned > 0 {
				sinceSpawn = activity - spawned
			}
			afterCommit = append(afterCommit, func() {
				appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskFirstActivity, nil, map[string]any{"taskid": taskID, "sincespawnms": sinceSpawn})
			})
		}
		// what the human typed into the worker's own terminal goes on the lead's record once, and wakes nobody: the
		// lead reads it in the status it checks when something else wakes it
		if tracked && (t.State == TaskState_Running || t.State == TaskState_Stalled) {
			for _, p := range toldSince(runs[t.RunID], t.ToldTs) {
				t.ToldTs = p.Ts
				// the lead's own `dag tell`, which the transcript shows as typed input
				if takeLeadTold(t, p.Text) {
					continue
				}
				// an answer to the worker's prose question was typed for whoever answered it, and its ask rows say who
				if agentask.GlobalRegistry.TakeTypedAnswer(g.OID, t.ID, p.Text, p.Ts) {
					continue
				}
				detail := map[string]any{"taskid": t.ID, "text": toldText(p.Text)}
				afterCommit = append(afterCommit, func() {
					appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskTold, nil, detail)
				})
			}
		}
		// no readable activity source: the spawn-time seed would age into a stall on its own and hand
		// the lead a retry that kills a working child. Report freshness unknown (zero) instead — a
		// missed stall only costs a timeout. It skips the first-token deadline too: an unreadable child
		// has written nothing as far as the probe can tell, however hard it is working.
		if !tracked {
			t.LastActivity = 0
			continue
		}
		// readable but nothing written yet: the spawn seed is not activity either. Kept, it ages into a
		// stall on a child that simply writes no transcript (claude routinely), and it hides the child
		// from the first-token deadline, which only judges a zero.
		if activity == 0 {
			t.LastActivity = 0
		}
		// a worker whose turn ended with its run still open has nothing left to write, so its transcript can sit
		// fresh for all of StallThreshold while nobody hears of it (run 28caa81f's t-4). Its CPU still decides,
		// because a turn can end on a background test run.
		quiet := t.LastActivity > 0 && now-t.LastActivity > StallThreshold.Milliseconds()
		if t.State == TaskState_Running && (quiet || turnEndedPast(ctx, runs[t.RunID], now)) &&
			!childStillWorking(ctx, t, runs[t.RunID], now) {
			t.State = TaskState_Stalled
		}
		// first-token deadline: a child that has written nothing has no mtime to age, so without this
		// it can never stall. The exit hook catches a child that DIED before its first token; this
		// catches one that hangs, which leaves no signal anywhere else. A runtime the deadline is off for still
		// stalls when its worker's process never started.
		if spawned := spawnTs(runs[t.RunID]); t.State == TaskState_Running && t.LastActivity == 0 && spawned > 0 &&
			now-spawned > FirstTokenDeadline.Milliseconds() &&
			(firstTokenArmed(runs[t.RunID]) || workerStuckStarting(ctx, runs[t.RunID])) {
			t.State = TaskState_Stalled
		}
	}
	// review: apply verdicts, replace a reviewer that ended without one, spawn the missing ones. Before the
	// task-done accounting below, so a pass is counted done in the tick that applied it.
	advanceReviews(ctx, spawnCtx, g, owner, runs, now, &afterCommit)
	// child-done: record the task-done lifecycle boundary (task id + child run id). A done child is not
	// judgment, so the lead is not woken; the merge that follows wakes it only on a conflict.
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.State == TaskState_Done && t.RunID != "" && taskInFlight(prevStates[t.ID]) {
			taskID := t.ID
			childRunID := t.RunID
			// a worker goes straight to done only when it reported no commit to review (DeriveTaskStates)
			unreviewed := ""
			if taskActive(prevStates[t.ID]) {
				unreviewed = noCommitLine(taskID, runs[t.RunID])
			}
			afterCommit = append(afterCommit, func() {
				publishDagEvent(DagEventChildDone, g, taskID)
				appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskDone, nil, map[string]any{"taskid": taskID, "runid": childRunID})
				if unreviewed != "" {
					PostQuiet(ctx, g.ChannelId, g.RunID, unreviewed)
				}
			})
		}
		if t.State == TaskState_Stalled && prevStates[t.ID] == TaskState_Running {
			taskID := t.ID
			// silence runs from the last write, or from spawn for a child that never wrote (the first-token stall)
			since := t.LastActivity
			if since == 0 {
				since = spawnTs(runs[t.RunID])
			}
			hung := hungWake(ctx, taskID, runs[t.RunID], now-since)
			// a worker that ended its turn may have finished (its complete lost to an EC-TIME): a retry would throw
			// its work away, so the lead judges it
			retried := workerTurnEndedAt(ctx, runs[t.RunID]) == 0 && autoRetryStalled(ctx, g, taskID)
			afterCommit = append(afterCommit, func() {
				publishDagEvent(DagEventTaskStalled, g, taskID)
				appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskStalled, nil, map[string]any{"taskid": taskID})
				if retried {
					publishDagEvent(DagEventTaskRetried, g, taskID)
					appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskRetried, nil, map[string]any{"taskid": taskID, "kind": TaskState_Stalled, "auto": true})
					return
				}
				if hung != "" {
					PostWake(ctx, g.ChannelId, g.RunID, hung)
				}
			})
		}
	}
	// consecutive-failure accounting: a failure *streak* breaks only on a fresh success —
	// a task that completed in an earlier tick must not keep resetting the counter, or the
	// circuit-break at MaxConsecutiveFailures could never trip once any task had ever succeeded.
	freshSuccess := false
	for i := range g.Tasks {
		if !taskInFlight(prevStates[g.Tasks[i].ID]) || g.Tasks[i].State != TaskState_Done {
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
		if g.Tasks[i].State == TaskState_Failed && taskActive(prevStates[g.Tasks[i].ID]) {
			g.Failures++
			// task-failed: record the terminal failure boundary (task id, child run id, failure
			// classifier, attempt count) — emitted only after the persist lands.
			taskID := g.Tasks[i].ID
			childRunID := g.Tasks[i].RunID
			kind := g.Tasks[i].LastFailureKind
			attempts := g.Tasks[i].Attempts
			afterCommit = append(afterCommit, func() {
				appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskFailed, nil, map[string]any{"taskid": taskID, "runid": childRunID, "lastfailurekind": kind, "attempts": attempts})
				PostWake(ctx, g.ChannelId, g.RunID, taskFailedWake(taskID, kind))
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
		// dispatch timing: worktree creation and the spawn call are in-process and separately
		// fixable (a warm tree vs. a warm worker), so they are measured separately rather than
		// folded into the child's wall clock where neither can be told apart.
		cwd := owner.ProjectPath
		taskBase := spawnBase
		var branch string
		var worktreeMs, setupMs int64
		if IsGitRepo(owner.ProjectPath) {
			// a lane's tasks share one tree, so each starts from the commits of the task before it
			key := LaneWorktreeKey(g, taskID)
			wtStart := time.Now()
			wt, head, created, werr := EnsureRunWorktree(spawnCtx, owner.ProjectPath, key, spawnBase)
			worktreeMs = time.Since(wtStart).Milliseconds()
			if werr != nil {
				failDispatch(ctx, g, taskID, FailureKindWorktree, werr, &afterCommit)
				continue
			}
			if created && g.Setup != "" {
				setupStart := time.Now()
				// no progress sink: Setup runs under the dag mutation lock, so nothing can read a
				// partial tail while it holds the lock anyway
				_, serr := runPlanCommand(context.WithoutCancel(ctx), wt, g.Setup, SetupTimeout, nil)
				setupMs = time.Since(setupStart).Milliseconds()
				if serr != nil {
					// only a new tree is set up, so a retry must not reuse this half-prepared one. The branch
					// stays: it holds the lane's earlier commits, and the retry checks it out again.
					if rerr := removeWorktreeDir(context.WithoutCancel(ctx), owner.ProjectPath, wt); rerr != nil {
						log.Printf("schedule dag %s task %s: removing worktree after setup failure: %v", g.OID, taskID, rerr)
					}
					failDispatch(ctx, g, taskID, FailureKindSetup, serr, &afterCommit)
					continue
				}
			}
			cwd = wt
			taskBase = head
			branch = "wave/" + key
		}
		prompt := taskPrompt(g, task, owner, pin.Runtime, predecessorHandoff(task, g, runs))
		// a new session per dispatch: its transcript is named by the id, so liveness and evidence never
		// read a previous attempt's file as this one's.
		sessionId := uuid.NewString()
		spawnStart := time.Now()
		// the worker block is stamped with its run before the run row exists, so the id is minted here
		runID := uuid.NewString()
		// named after its task: a prompt too long for a command line moves to a file, and the ai-title of the
		// pointer to it names every such worker the same
		oref, err := spawnWorker(spawnCtx, capability, owner.WorkspaceId, "", cwd, prompt,
			jarvis.RunWorkerOptions{SessionId: sessionId, RunId: runID, TaskId: taskID, Label: task.Label})
		spawnMs := time.Since(spawnStart).Milliseconds()
		if err != nil {
			failDispatch(ctx, g, taskID, FailureKindSpawn, err, &afterCommit)
			continue
		}
		childRun := childRunFromSpec(g, task, owner, pin, cwd, taskBase, prompt)
		childRun.ID = runID
		childRun.SessionId = sessionId
		childRun.Branch = branch
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
		// spawnCtx, not ctx: the row that records a spawned worker must outlive exactly as long as the
		// spawn it records. Persisting on the caller's budget is what leaves a live process with no run
		// row, and the task's RunID is cleared on this failure, so nothing can ever reap it.
		if err := appendChildRun(spawnCtx, g.ChannelId, childRun); err != nil {
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
			appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskSpawned, nil, map[string]any{"taskid": spawnedTaskID, "worktreems": worktreeMs, "setupms": setupMs, "spawnms": spawnMs})
		})
	}
	RecomputeDagStatus(g)
	// status notifications: gate-open / blocked / complete, once per condition. The watchdog and every
	// dag mutation re-enter Schedule, so emitting the standing status would refill the lifecycle log with
	// identical rows and re-wake the lead about what it was already told. The gate cannot be compared
	// against the status this tick started from: the mutation paths recompute and PERSIST the new status
	// before calling Schedule, so the row already reads the new condition. What was last announced is its
	// own fact, so the dag records it. Only the finished run wakes the lead here: a gate is the human's,
	// and each failure behind a blocked dag woke the lead when it happened.
	condition := dagCondition(g)
	notify := condition != g.NotifiedCondition
	g.NotifiedCondition = condition
	switch {
	case notify && g.Status == DagStatus_AwaitingReview:
		gateTask := gatedTaskID(g)
		afterCommit = append(afterCommit, func() {
			publishDagEvent(DagEventGateOpen, g, "")
			appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindDagGateOpen, nil, map[string]any{"taskid": gateTask})
		})
	case notify && g.Status == DagStatus_Blocked:
		failures := g.Failures
		blockingKind := BlockingKind(g)
		afterCommit = append(afterCommit, func() {
			publishDagEvent(DagEventBlocked, g, "")
			appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindDagBlocked, nil, map[string]any{"failures": failures, "kind": blockingKind})
		})
	case notify && g.Status == DagStatus_Done:
		afterCommit = append(afterCommit, func() {
			publishDagEvent(DagEventComplete, g, "")
			appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindDagDone, nil, map[string]any{})
			PostWake(ctx, g.ChannelId, g.RunID, runFinishedWake)
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
	// the one place a dag goes terminal regardless of what triggered the tick, so both closures hang
	// here: complete a run that has no lead to report its own completion, then close a lead tab whose
	// process may already be idle (keeponexit kept it), which the shell layer will not delete. The first
	// completes a run only when no lead process is alive, and the second closes a tab only once the run is
	// done, so a live lead's tab is never touched. best-effort: never fail Schedule over either.
	if owner != nil {
		if freshRun, err := wstore.GetRun(ctx, g.ChannelId, g.RunID); err == nil {
			if freshDag, err := wstore.GetDag(ctx, g.OID); err == nil {
				MaybeCompleteLeadFreeRun(ctx, freshRun, freshDag)
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

// workerContract opens every dag worker's prompt (spec §4). The plan is approved, so the worker neither
// re-plans nor guesses a consequential decision: it asks, and the lead or the human answers. It owns its
// task's tests, and it names the plan so a compacted worker can re-read its task.
func workerContract(g *waveobj.TaskGroup, task *waveobj.TaskNode, runtime string) string {
	var b strings.Builder
	if g.PlanPath != "" {
		fmt.Fprintf(&b, "You are the worker for task %s of the plan at %s", strings.TrimPrefix(task.ID, "t-"), g.PlanPath)
		if g.SpecPath != "" {
			fmt.Fprintf(&b, " (spec: %s)", g.SpecPath)
		}
		b.WriteString(".\n")
	} else {
		fmt.Fprintf(&b, "You are the worker for task %s of this run's dag.\n", task.ID)
	}
	fmt.Fprintf(&b, "The plan is approved: don't re-plan or pause for design approval. If a consequential decision isn't pinned, or the plan and the code disagree, ask once with %s and concrete options, then wait; the lead or the human answers.\n", jarvis.AskTool(runtime))
	b.WriteString("A reviewer checks your commit against this task and the spec before it lands, and the lead reads your final message: end with what you did, anything you did differently from the task and why, and anything a later task must know.\n")
	b.WriteString("Run the tests your task names")
	if g.Check != "" {
		fmt.Fprintf(&b, ", and `%s`,", g.Check)
	}
	b.WriteString(" and get them passing before you complete; if you can't, ask.")
	if g.Verify != "" {
		fmt.Fprintf(&b, " Don't run the plan's full Verify (`%s`): the engine runs it after your task merges.", g.Verify)
	}
	b.WriteString(" Commit, then `wsh jarvis complete --commit $(git rev-parse HEAD)`. " + jarvis.NoAttributionRule)
	if g.PlanPath != "" {
		b.WriteString("\nIf your context was compacted, re-read your task from the plan.")
	}
	return b.String()
}

// predecessor handoff bounds: a brief, not a transcript. The child can read the whole change with
// `git show`; what it needs inline is enough to know a decision was made and where to look.
const (
	handoffMaxFiles      = 12
	handoffMaxSummaryLen = 600
)

// predecessorHandoff describes what each of a task's satisfied dependencies actually did: the squash
// commit its work landed as, the files it touched, and its closing note. Without this a dependent
// learns only its own label and description, so it re-derives (or contradicts) decisions a sibling
// already made and committed. Everything here is already loaded at dispatch time — runs is the map
// scheduleLocked built for DeriveTaskStates, keyed by child run id.
//
// The commit is citable from the dependent's own tree: a dependency in the same lane committed it in the
// tree the dependent now works in, and one in another lane is satisfied only once its lane merged onto the
// project branch the dependent's tree branches from (depSatisfied).
// Evidence can still be nil — cleanup or the seal may have failed and the backfill retries — so the
// files and the note degrade to the commit line alone.
func predecessorHandoff(task *waveobj.TaskNode, g *waveobj.TaskGroup, runs map[string]*waveobj.Run) string {
	var b strings.Builder
	for _, depID := range task.Deps {
		dep := taskByID(g, depID)
		if dep == nil || dep.RunID == "" {
			continue
		}
		depRun := runs[dep.RunID]
		if depRun == nil || depRun.EndCommit == "" {
			continue
		}
		if b.Len() == 0 {
			b.WriteString("Work already landed by the tasks this one depends on. It is in your starting tree — read it before you touch any file it changed, and do not redo or revert its decisions.\n")
		}
		label := dep.Label
		if label == "" {
			label = dep.ID
		}
		fmt.Fprintf(&b, "\n- %s (task %s) landed as commit %s — inspect it with `git show --stat %s`.\n", label, dep.ID, depRun.EndCommit, depRun.EndCommit)
		if depRun.Evidence == nil {
			continue
		}
		if files := depRun.Evidence.Files; len(files) > 0 {
			b.WriteString("  Files: ")
			for i, f := range files {
				if i == handoffMaxFiles {
					fmt.Fprintf(&b, ", and %d more", len(files)-handoffMaxFiles)
					break
				}
				if i > 0 {
					b.WriteString(", ")
				}
				fmt.Fprintf(&b, "%s (+%d/-%d)", f.Path, f.Add, f.Del)
			}
			b.WriteString("\n")
		}
		if note := truncateNote(depRun.Evidence.Summary, handoffMaxSummaryLen); note != "" {
			fmt.Fprintf(&b, "  It reported: %s\n", note)
		}
	}
	return strings.TrimSpace(b.String())
}

// truncateNote collapses a child's closing note to one bounded run of text. A worker's final message
// can be arbitrarily long and a dependent's prompt is not the place to replay it.
func truncateNote(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= max {
		return s
	}
	cut := s[:max]
	if i := strings.LastIndex(cut, " "); i > max/2 {
		cut = cut[:i]
	}
	return cut + "..."
}

// taskPrompt is the child's goal: the worker contract, then the task's text (its RunSpec goal, else its
// label, with the plan description and its decision pins), then the handoff from landed dependencies.
func taskPrompt(g *waveobj.TaskGroup, task *waveobj.TaskNode, owner *waveobj.Run, runtime, handoff string) string {
	var b strings.Builder
	b.WriteString(workerContract(g, task, runtime))
	b.WriteString("\n\n")
	if g.Preamble != "" {
		b.WriteString("The plan's header applies to every task:\n")
		b.WriteString(g.Preamble)
		b.WriteString("\n\n")
	}
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
	if len(task.LeadNotes) > 0 {
		b.WriteString("\n\nThe lead added after earlier tasks landed:")
		for _, n := range task.LeadNotes {
			fmt.Fprintf(&b, "\n- %s", n)
		}
	}
	if feedback := reviewFeedback(task); feedback != "" {
		b.WriteString("\n\n")
		b.WriteString(feedback)
	}
	if handoff != "" {
		b.WriteString("\n\n")
		b.WriteString(handoff)
	}
	return b.String()
}

func effectiveTaskRoute(task *waveobj.TaskNode, owner *waveobj.Run, group *waveobj.TaskGroup) waveobj.RoutePin {
	if task.RunSpec.Runtime != "" || task.RunSpec.Model != "" {
		runtime := task.RunSpec.Runtime
		if runtime == "" {
			runtime = owner.Runtime
		}
		return waveobj.RoutePin{Runtime: runroute.DefaultRuntime(runtime), Model: task.RunSpec.Model}
	}
	if group != nil && group.WorkerRoute != nil && (group.WorkerRoute.Runtime != "" || group.WorkerRoute.Model != "") {
		return waveobj.RoutePin{Runtime: runroute.DefaultRuntime(group.WorkerRoute.Runtime), Model: group.WorkerRoute.Model}
	}
	return waveobj.RoutePin{Runtime: runroute.DefaultRuntime(owner.Runtime), Model: owner.Model}
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
