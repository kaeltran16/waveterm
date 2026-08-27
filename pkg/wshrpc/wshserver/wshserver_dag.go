package wshserver

// DAG execution is engine-owned: persisted TaskGroups and waveobj updates drive supervision.
// ScheduleOnce and the watchdog advance tasks from persisted state without the lead worker.
// The lead receives notifications for visibility, but its phase worker is not an execution dependency.

import (
	"context"
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
	proposed, err := orchestrate.NewTaskGroup(data.RunId, data.ChannelId, data.Title, data.Parallelism, data.Tasks, time.Now().UnixMilli())
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
			return nil, fmt.Errorf("dag conflict: run %s already linked to a different dag", data.RunId)
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

func (ws *WshServer) DagStatusCommand(ctx context.Context, data wshrpc.CommandDagStatusData) (*waveobj.TaskGroup, error) {
	run, err := wstore.GetRun(ctx, data.ChannelId, data.RunId)
	if err != nil {
		return nil, fmt.Errorf("loading run: %w", err)
	}
	if run.DagORef == "" {
		return nil, fmt.Errorf("run has no dag")
	}
	return wstore.GetDag(ctx, run.DagORef)
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

// DagAsksCommand lists the pending asks of the dag's running children — the lead's visibility into
// what its children are blocked on (children block on one ask at a time, and their cards are
// invisible on the child sessions).
func (ws *WshServer) DagAsksCommand(ctx context.Context, data wshrpc.CommandDagStatusData) (*wshrpc.CommandDagAsksRtnData, error) {
	rtn := &wshrpc.CommandDagAsksRtnData{}
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
	for i := range g.Tasks {
		task := &g.Tasks[i]
		if task.RunID == "" {
			continue
		}
		child, cerr := wstore.GetRun(ctx, data.ChannelId, task.RunID)
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
				Question:  q.Question,
				BlockORef: bo,
				Ts:        pending.Ts,
			}
			for _, o := range q.Options {
				item.Options = append(item.Options, wshrpc.DagAskOption{Label: o.Label})
			}
			rtn.Asks = append(rtn.Asks, item)
		}
	}
	return rtn, nil
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
		return nil
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
	sha, err := orchestrate.MergeRunWorktree(ctx, owner.ProjectPath, key, mergeMsg)
	if err != nil {
		if errors.Is(err, orchestrate.ErrMergeConflict) {
			if derr := orchestrate.MarkBlockedMerge(ctx, owner.DagORef, child.ID); derr != nil {
				return derr
			}
			return err
		}
		return err
	}
	if err := wstore.UpdateRun(ctx, data.ChannelId, child.ID, func(r *waveobj.Run) error {
		r.EndCommit = sha
		return nil
	}); err != nil {
		return err
	}
	if err := wstore.UpdateDag(ctx, owner.DagORef, func(cur *waveobj.TaskGroup) error {
		for i := range cur.Tasks {
			if cur.Tasks[i].ID == data.TaskId {
				cur.Tasks[i].Merged = true
				return nil
			}
		}
		return fmt.Errorf("no task %q", data.TaskId)
	}); err != nil {
		return err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, owner.DagORef))
	return jarvis.SealEvidence(ctx, child)
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
		return nil
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
	sha, err := orchestrate.MergeContinue(ctx, owner.ProjectPath, key, mergeMsg)
	if err != nil {
		return err
	}
	if err := wstore.UpdateRun(ctx, data.ChannelId, child.ID, func(r *waveobj.Run) error {
		r.EndCommit = sha
		return nil
	}); err != nil {
		return err
	}
	if err := wstore.UpdateDag(ctx, owner.DagORef, func(cur *waveobj.TaskGroup) error {
		for i := range cur.Tasks {
			if cur.Tasks[i].ID == data.TaskId {
				cur.Tasks[i].Merged = true
				return nil
			}
		}
		return fmt.Errorf("no task %q", data.TaskId)
	}); err != nil {
		return err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, owner.DagORef))
	return jarvis.SealEvidence(ctx, child)
}
