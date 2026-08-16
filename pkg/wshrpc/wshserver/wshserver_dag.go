package wshserver

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
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
	g, err := orchestrate.NewTaskGroup(data.RunId, data.ChannelId, data.Title, data.Parallelism, data.Tasks, time.Now().UnixMilli())
	if err != nil {
		return nil, err
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		return nil, fmt.Errorf("appending dag: %w", err)
	}
	if err := wstore.UpdateRun(ctx, data.ChannelId, data.RunId, func(r *waveobj.Run) error {
		r.DagORef = g.OID
		return nil
	}); err != nil {
		return nil, fmt.Errorf("linking dag to run: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, g.OID))
	// schedule the first step immediately (spawns the initially ready tasks); failures are
	// retried on the next trigger, so this is log-only.
	if serr := orchestrate.ScheduleOnce(ctx, &g); serr != nil {
		log.Printf("dag submit schedule error: %v", serr)
	}
	return &g, nil
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
	err = wstore.UpdateDag(ctx, run.DagORef, func(g *waveobj.TaskGroup) error {
		switch data.Action {
		case "approve":
			orchestrate.ApproveGate(g)
		case "sendback":
			orchestrate.SendBackGate(g)
		case "retry":
			if err := orchestrate.RetryTask(ctx, g, data.TaskId); err != nil {
				return err
			}
		case "skip":
			if err := orchestrate.SkipTask(g, data.TaskId); err != nil {
				return err
			}
		case "cancel":
			orchestrate.CancelGroup(g)
		default:
			return fmt.Errorf("unknown dag action %q", data.Action)
		}
		g.UpdatedTs = time.Now().UnixMilli()
		return nil
	})
	if err != nil {
		return err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, run.DagORef))
	// advance the DAG after the action (cancel is terminal: nothing left to schedule).
	if data.Action != "cancel" {
		if grp, gerr := wstore.GetDag(ctx, run.DagORef); gerr == nil {
			if serr := orchestrate.ScheduleOnce(ctx, grp); serr != nil {
				log.Printf("dag action schedule error: %v", serr)
			}
		}
	}
	return nil
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

func (ws *WshServer) DagMergeCommand(ctx context.Context, data wshrpc.CommandDagMergeData) error {
	if data.ChannelId == "" || data.RunId == "" {
		return fmt.Errorf("channelid and runid are required")
	}
	run, err := wstore.GetRun(ctx, data.ChannelId, data.RunId)
	if err != nil {
		return fmt.Errorf("loading run: %w", err)
	}
	sha, err := orchestrate.MergeRunWorktree(ctx, run.ProjectPath, data.RunId, run.Goal)
	if err != nil {
		if errors.Is(err, orchestrate.ErrMergeConflict) {
			// surface as blocked-merge on the task that owns this run
			if run.DagORef != "" {
				if derr := wstore.UpdateDag(ctx, run.DagORef, func(g *waveobj.TaskGroup) error {
					for i := range g.Tasks {
						if g.Tasks[i].RunID == data.RunId {
							g.Tasks[i].State = orchestrate.TaskState_BlockedMerge
						}
					}
					orchestrate.RecomputeDagStatus(g)
					return nil
				}); derr != nil {
					return derr
				}
			}
			return err
		}
		return err
	}
	if err := wstore.UpdateRun(ctx, data.ChannelId, data.RunId, func(r *waveobj.Run) error {
		r.EndCommit = sha
		return nil
	}); err != nil {
		return err
	}
	return jarvis.SealEvidence(ctx, run)
}
