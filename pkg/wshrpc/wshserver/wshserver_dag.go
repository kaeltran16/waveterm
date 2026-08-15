package wshserver

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

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
			if err := orchestrate.RetryTask(g, data.TaskId); err != nil {
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
