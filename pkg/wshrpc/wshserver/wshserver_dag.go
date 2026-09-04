package wshserver

// DAG execution is engine-owned: persisted TaskGroups and waveobj updates drive supervision.
// ScheduleOnce and the watchdog advance tasks from persisted state without the lead worker.
// The lead receives notifications for visibility, but its phase worker is not an execution dependency.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
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

func (ws *WshServer) DagSubmitCommand(ctx context.Context, data wshrpc.CommandDagSubmitData) (*waveobj.TaskGroup, error) {
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
	ownerPin := runroute.NormalizeLegacy(run.Runtime, run.Tier)
	for _, task := range data.Tasks {
		runtimePresent := task.RunSpec.Runtime != ""
		tierPresent := task.RunSpec.Tier != ""
		if runtimePresent != tierPresent {
			return nil, fmt.Errorf("task %q runtime and tier must be provided together", task.ID)
		}
		pin := ownerPin
		if runtimePresent {
			pin = waveobj.RoutePin{Runtime: task.RunSpec.Runtime, Tier: task.RunSpec.Tier}
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
	proposed, err := orchestrate.NewTaskGroup(data.RunId, data.ChannelId, data.Title, data.Parallelism, mergeRequired, data.Tasks, time.Now().UnixMilli(), workerRoute)
	if err != nil {
		return nil, err
	}
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
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, stored.OID))
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Run, data.RunId))
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	if serr := orchestrate.Schedule(ctx, stored.OID); serr != nil {
		log.Printf("dag submit schedule error: %v", serr)
	}
	if fresh, err := wstore.GetDag(ctx, stored.OID); err == nil {
		return fresh, nil
	}
	return stored, nil
}

// dagDigestChildRunLimit bounds the child runs a status snapshot loads; the digest never pages the
// whole fan-out, and missing runs just mark partial durations. Derived from the task ceiling so a
// raised cap cannot leave the tail of a full dag reporting partial durations.
const dagDigestChildRunLimit = jarvis.MaxDagTasks

// dagDigestRetainedKinds are the lifecycle boundaries the digest derives durations/retries/control
// from. The UI's 200-row window is not consulted.
var dagDigestRetainedKinds = []string{
	waveobj.RunEventKindTaskRetried,
	waveobj.RunEventKindTaskDone,
	waveobj.RunEventKindTaskMergeStarted,
	waveobj.RunEventKindTaskCleanupPending,
	waveobj.RunEventKindTaskCleanupCompleted,
	waveobj.RunEventKindTaskCleanupFailed,
	waveobj.RunEventKindDagDone,
	waveobj.RunEventKindDagCancelled,
	waveobj.RunEventKindLeadControlSent,
	waveobj.RunEventKindLeadControlFailed,
	waveobj.RunEventKindLeadControlAcknowledged,
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

// controlAckKinds are the rows an acknowledgement is checked against: the attempt it claims to
// confirm must appear as sent, must not have failed, and must not already be acknowledged.
var controlAckKinds = []string{
	waveobj.RunEventKindLeadControlSent,
	waveobj.RunEventKindLeadControlFailed,
	waveobj.RunEventKindLeadControlAcknowledged,
}

// PiControlAckCommand records that the lead's pi watcher accepted a control event. Acknowledgement is
// visibility only — the persisted DAG is authoritative either way — so the handler's job is to make
// sure the row it writes is TRUE: it appends only for an attempt that was really sent to really this
// session, and never twice for the same attempt.
func (ws *WshServer) PiControlAckCommand(ctx context.Context, data wshrpc.CommandPiControlAckData) error {
	if data.ChannelId == "" || data.RunId == "" || data.EventId == "" || data.SessionId == "" {
		return fmt.Errorf("channelid, runid, eventid and sessionid are required")
	}
	events, err := wstore.QueryRunEventsByKind(ctx, data.ChannelId, data.RunId, controlAckKinds, 0)
	if err != nil {
		return fmt.Errorf("loading control events: %w", err)
	}
	sentSession := ""
	sent, failed, acked := false, false, false
	for _, ev := range events {
		var detail struct {
			EventId   string `json:"eventid"`
			SessionId string `json:"sessionid"`
		}
		if jerr := json.Unmarshal(ev.Detail, &detail); jerr != nil || detail.EventId != data.EventId {
			continue
		}
		switch ev.Kind {
		case waveobj.RunEventKindLeadControlSent:
			sent, sentSession = true, detail.SessionId
		case waveobj.RunEventKindLeadControlFailed:
			failed = true
		case waveobj.RunEventKindLeadControlAcknowledged:
			acked = true
		}
	}
	if !sent {
		if failed {
			return fmt.Errorf("control event %s was never delivered", data.EventId)
		}
		return fmt.Errorf("unknown control event %s for run %s", data.EventId, data.RunId)
	}
	if sentSession != data.SessionId {
		return fmt.Errorf("control event %s was sent to session %s, not %s", data.EventId, sentSession, data.SessionId)
	}
	if acked {
		return nil // already confirmed; a watcher retry must not write a second row
	}
	appendRunEvent(ctx, data.ChannelId, data.RunId, waveobj.RunEventKindLeadControlAcknowledged, nil,
		map[string]any{"eventid": data.EventId, "sessionid": data.SessionId})
	return nil
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
	if data.Action == "cancel" {
		return orchestrate.Cancel(ctx, run.DagORef)
	}
	target := waveobj.RoutePin{Runtime: data.Runtime, Tier: data.Tier, Model: data.Model}
	return orchestrate.ApplyAction(ctx, run.DagORef, data.TaskId, data.Action, target)
}

// taskBlockOrefs lists the worker block orefs of a run's phases (the blocks the ask registry keys
// asks by).
// findTaskNode returns the task with id taskID inside g, or nil.
func findTaskNode(g *waveobj.TaskGroup, taskID string) *waveobj.TaskNode {
	for i := range g.Tasks {
		if g.Tasks[i].ID == taskID {
			return &g.Tasks[i]
		}
	}
	return nil
}

func cleanupMergedTask(ctx context.Context, channelID string, g *waveobj.TaskGroup, taskID string) error {
	task := findTaskNode(g, taskID)
	if task == nil {
		return fmt.Errorf("no task %q", taskID)
	}
	childRunID := task.RunID
	cleanupErr := orchestrate.CleanupTaskWorktree(ctx, g, taskID)
	if err := orchestrate.PersistCleanupState(ctx, g); err != nil {
		return err
	}
	if cleanupErr != nil {
		appendRunEvent(ctx, channelID, g.RunID, waveobj.RunEventKindTaskCleanupFailed, nil, map[string]any{"taskid": taskID, "error": cleanupErr.Error()})
		return cleanupErr
	}
	appendRunEvent(ctx, channelID, g.RunID, waveobj.RunEventKindTaskCleanupCompleted, nil, map[string]any{"taskid": taskID})
	child, err := wstore.GetRun(ctx, channelID, childRunID)
	if err != nil {
		return fmt.Errorf("loading child run: %w", err)
	}
	return jarvis.SealEvidence(ctx, child)
}

func persistMergedTask(ctx context.Context, channelID, dagID, childRunID, taskID, sha string) error {
	if err := wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		txCtx := tx.Context()
		if err := wstore.UpdateRun(txCtx, channelID, childRunID, func(r *waveobj.Run) error {
			r.EndCommit = sha
			return nil
		}); err != nil {
			return err
		}
		return wstore.UpdateDag(txCtx, dagID, func(cur *waveobj.TaskGroup) error {
			task := findTaskNode(cur, taskID)
			if task == nil {
				return fmt.Errorf("no task %q", taskID)
			}
			task.Merged = true
			task.CleanupPending = true
			task.CleanupError = ""
			orchestrate.RecomputeDagStatus(cur)
			return nil
		})
	}); err != nil {
		return err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, dagID))
	return nil
}

// finishMergedTask stamps a landed merge and then removes the worktree. It runs under the dag
// mutation lock: the engine persists its tick as a whole-object replace of a snapshot taken under
// that lock, so a merge stamp written outside it is silently reverted by any overlapping watchdog
// tick. Nothing inside re-enters the lock (the lock is not reentrant).
func finishMergedTask(ctx context.Context, channelID, dagID, childRunID, taskID, sha string) error {
	return orchestrate.WithDagMutation(dagID, func() error {
		if err := persistMergedTask(ctx, channelID, dagID, childRunID, taskID, sha); err != nil {
			return err
		}
		g, err := wstore.GetDag(ctx, dagID)
		if err != nil {
			return err
		}
		appendRunEvent(ctx, channelID, g.RunID, waveobj.RunEventKindTaskMerged, nil, map[string]any{"taskid": taskID, "commit": sha})
		appendRunEvent(ctx, channelID, g.RunID, waveobj.RunEventKindTaskCleanupPending, nil, map[string]any{"taskid": taskID})
		return cleanupMergedTask(ctx, channelID, g, taskID)
	})
}

func taskBlockOrefs(ctx context.Context, run *waveobj.Run) []string {
	var out []string
	seen := map[string]bool{}
	for _, p := range run.Phases {
		for _, oref := range p.WorkerOrefs {
			if !strings.HasPrefix(oref, "tab:") {
				continue
			}
			tab, terr := wstore.DBMustGet[*waveobj.Tab](ctx, strings.TrimPrefix(oref, "tab:"))
			if terr != nil || len(tab.BlockIds) == 0 {
				continue
			}
			bo := waveobj.MakeORef(waveobj.OType_Block, tab.BlockIds[0]).String()
			if !seen[bo] {
				seen[bo] = true
				out = append(out, bo)
			}
		}
	}
	return out
}

// gatherDagAsks lists the pending asks of the dag's running children — the lead's visibility into
// what its children are blocked on (children block on one ask at a time, and their cards are
// invisible on the child sessions). Shared by the asks RPC and the status digest.
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
		for _, bo := range taskBlockOrefs(ctx, child) {
			pending, ok := agentask.GlobalRegistry.Get(bo)
			if !ok || len(pending.Questions) == 0 {
				continue
			}
			q := pending.Questions[0]
			item := wshrpc.DagAskItem{
				TaskId:    task.ID,
				AskId:     pending.AskId,
				Question:  q.Question,
				BlockORef: bo,
				Ts:        pending.Ts,
			}
			for _, o := range q.Options {
				item.Options = append(item.Options, wshrpc.DagAskOption{Label: o.Label})
			}
			items = append(items, item)
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

// DagAnswerCommand delivers an answer to a child's pending ask (the lead's answer path for the
// `child_ask` control event). The child blocks until the answer resolves, so this is what unblocks
// a question-raised child.
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
		blocks := taskBlockOrefs(ctx, child)
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
func (ws *WshServer) DagMergeCommand(ctx context.Context, data wshrpc.CommandDagMergeData) error {
	if data.ChannelId == "" || data.RunId == "" || data.TaskId == "" {
		return fmt.Errorf("channelid, runid and taskid are required")
	}
	owner, err := wstore.GetRun(ctx, data.ChannelId, data.RunId)
	if err != nil {
		return fmt.Errorf("loading run: %w", err)
	}
	if owner.DagORef == "" {
		return fmt.Errorf("run has no dag")
	}
	g, err := wstore.GetDag(ctx, owner.DagORef)
	if err != nil {
		return err
	}
	taskIdx := -1
	for i := range g.Tasks {
		if g.Tasks[i].ID == data.TaskId {
			taskIdx = i
			break
		}
	}
	if taskIdx < 0 {
		return fmt.Errorf("no task %q", data.TaskId)
	}
	task := &g.Tasks[taskIdx]
	if task.Merged {
		if !task.CleanupPending && task.CleanupError == "" {
			return nil
		}
		return orchestrate.WithDagMutation(owner.DagORef, func() error {
			return cleanupMergedTask(ctx, data.ChannelId, g, data.TaskId)
		})
	}
	if task.State != orchestrate.TaskState_Done && task.State != orchestrate.TaskState_BlockedMerge {
		return fmt.Errorf("task %s is %s, want done", data.TaskId, task.State)
	}
	if task.RunID == "" {
		return fmt.Errorf("task %s has no child run", data.TaskId)
	}
	child, err := wstore.GetRun(ctx, data.ChannelId, task.RunID)
	if err != nil {
		return fmt.Errorf("loading child run: %w", err)
	}
	key := orchestrate.TaskWorktreeKey(owner.ID, data.TaskId)
	// commit message should be the task label, not the full child goal
	// (which embeds plan description + headless contract).
	mergeMsg := task.Label
	if mergeMsg == "" {
		mergeMsg = task.ID
	}
	// merge-started closes the digest's merge-wait window (task-done -> here): the interval a
	// finished task spent waiting on the lead to land it.
	appendRunEvent(ctx, data.ChannelId, owner.ID, waveobj.RunEventKindTaskMergeStarted, nil, map[string]any{"taskid": data.TaskId})
	sha, err := orchestrate.MergeRunWorktree(ctx, owner.ProjectPath, key, mergeMsg)
	if err != nil {
		if errors.Is(err, orchestrate.ErrMergeConflict) {
			appendRunEvent(ctx, data.ChannelId, owner.ID, waveobj.RunEventKindTaskMergeBlocked, nil, map[string]any{"taskid": data.TaskId})
			if derr := orchestrate.MarkBlockedMerge(ctx, owner.DagORef, child.ID); derr != nil {
				return derr
			}
			return err
		}
		return err
	}
	return finishMergedTask(ctx, data.ChannelId, owner.DagORef, child.ID, data.TaskId, sha)
}

// DagMergeContinueCommand finishes a squash merge the caller resolved manually after MergeContinue's
// conflict: it requires blocked-merge (resolved UU/AA/DD markers left behind) and commits the
// resolved project state, mirroring DagMergeCommand's run/task stamping + evidence sealing.
func (ws *WshServer) DagMergeContinueCommand(ctx context.Context, data wshrpc.CommandDagMergeData) error {
	if data.ChannelId == "" || data.RunId == "" || data.TaskId == "" {
		return fmt.Errorf("channelid, runid and taskid are required")
	}
	owner, err := wstore.GetRun(ctx, data.ChannelId, data.RunId)
	if err != nil {
		return fmt.Errorf("loading run: %w", err)
	}
	if owner.DagORef == "" {
		return fmt.Errorf("run has no dag")
	}
	g, err := wstore.GetDag(ctx, owner.DagORef)
	if err != nil {
		return err
	}
	taskIdx := -1
	for i := range g.Tasks {
		if g.Tasks[i].ID == data.TaskId {
			taskIdx = i
			break
		}
	}
	if taskIdx < 0 {
		return fmt.Errorf("no task %q", data.TaskId)
	}
	task := &g.Tasks[taskIdx]
	if task.Merged {
		if !task.CleanupPending && task.CleanupError == "" {
			return nil
		}
		return orchestrate.WithDagMutation(owner.DagORef, func() error {
			return cleanupMergedTask(ctx, data.ChannelId, g, data.TaskId)
		})
	}
	if task.State != orchestrate.TaskState_BlockedMerge {
		return fmt.Errorf("task %s is %s, want blocked-merge", data.TaskId, task.State)
	}
	if task.RunID == "" {
		return fmt.Errorf("task %s has no child run", data.TaskId)
	}
	child, err := wstore.GetRun(ctx, data.ChannelId, task.RunID)
	if err != nil {
		return fmt.Errorf("loading child run: %w", err)
	}
	key := orchestrate.TaskWorktreeKey(owner.ID, data.TaskId)
	mergeMsg := task.Label
	if mergeMsg == "" {
		mergeMsg = task.ID
	}
	appendRunEvent(ctx, data.ChannelId, owner.ID, waveobj.RunEventKindTaskMergeContinued, nil, map[string]any{"taskid": data.TaskId})
	sha, err := orchestrate.MergeContinue(ctx, owner.ProjectPath, key, mergeMsg)
	if err != nil {
		return err
	}
	return finishMergedTask(ctx, data.ChannelId, owner.DagORef, child.ID, data.TaskId, sha)
}
