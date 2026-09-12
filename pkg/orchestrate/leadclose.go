// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"log"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// deleteLeadTab is the tab-deletion seam. Var so tests can stub it without a live workspace.
var deleteLeadTab = func(ctx context.Context, workspaceId, tabId string) error {
	_, err := wcore.DeleteTab(ctx, workspaceId, tabId, true)
	return err
}

// leadTabID extracts the orchestrator lead's tab id from the run's first worker oref.
func leadTabID(run *waveobj.Run) string {
	for _, p := range run.Phases {
		for _, oref := range p.WorkerOrefs {
			if strings.HasPrefix(oref, "tab:") {
				return strings.TrimPrefix(oref, "tab:")
			}
		}
	}
	return ""
}

// MaybeCloseOrchestratorLead deletes the lead's tab when the orchestrator is terminal
// and the DAG has no active tasks. No-op otherwise. Returns true when it deleted.
func MaybeCloseOrchestratorLead(ctx context.Context, run *waveobj.Run, dag *waveobj.TaskGroup) (bool, error) {
	if !ShouldCloseOrchestratorLead(run, dag) {
		return false, nil
	}
	tabId := leadTabID(run)
	if tabId == "" || run.WorkspaceId == "" {
		return false, nil
	}
	if err := deleteLeadTab(ctx, run.WorkspaceId, tabId); err != nil {
		return false, err
	}
	return true, nil
}

// ShouldCloseOrchestratorLead reports whether an orchestrator lead's tab can be
// auto-closed. The lead's lifecycle is owned by Run/DAG, not by the shell exit:
// it must stay (even idle) while DAG children are still active, and only be
// closed after both the run and the DAG are terminal.
func ShouldCloseOrchestratorLead(run *waveobj.Run, dag *waveobj.TaskGroup) bool {
	if run == nil || dag == nil {
		return false
	}
	if run.Mode != jarvis.RunMode_Orchestrator {
		return false
	}
	if run.Status != jarvis.RunStatus_Done && run.Status != jarvis.RunStatus_Cancelled {
		return false
	}
	// dag must be terminal — no active tasks. done/cancelled are the only
	// terminal dag statuses; blocked/awaiting-review still need the lead to
	// triage the gate, so keep it.
	if dag.Status != DagStatus_Done && dag.Status != DagStatus_Cancelled {
		return false
	}
	return allTasksTerminal(dag)
}

// SealRunEvidenceHook seals a done run's evidence snapshot. Wired to wshserver at startup so a run the
// engine closes itself gets the same snapshot `wsh jarvis complete` produces; no-op by default, because
// wsh and the tests link this package without the server.
var SealRunEvidenceHook = func(channelId, runId string) {}

// MaybeCompleteLeadFreeRun closes an owner run whose DAG finished but which has no lead to report the
// completion. RunStatus_Done is only ever written by CompletePhase, reachable only through
// `wsh jarvis complete` — so a human-planned run (DeferStart never spawns a lead) finished its DAG and
// then sat in planning forever, its evidence never sealed. Returns true when it closed the run.
//
// Only a done DAG qualifies. Cancelling a dag already cascades CancelRun onto the owner, and closing a
// run whose tasks were cancelled would claim a success that did not happen.
func MaybeCompleteLeadFreeRun(ctx context.Context, run *waveobj.Run, dag *waveobj.TaskGroup) bool {
	if run == nil || dag == nil || run.Mode != jarvis.RunMode_Orchestrator {
		return false
	}
	if dag.Status != DagStatus_Done || !allTasksTerminal(dag) {
		return false
	}
	if run.Status == jarvis.RunStatus_Done || run.Status == jarvis.RunStatus_Cancelled {
		return false
	}
	// a run that has a lead has someone to report the completion, and that lead may still owe the human
	// a summary after the last task lands. this path is only for a run that has nobody.
	if leadTabID(run) != "" {
		return false
	}
	idx := jarvis.RunningPhaseIndex(*run)
	if idx < 0 || run.Phases[idx].Kind != jarvis.PhaseKind_Orchestrate || run.Phases[idx].Held {
		return false
	}
	// the commit the lead is told to report: `wsh jarvis complete --commit $(git rev-parse HEAD)`. It
	// scopes the sealed diff to BaseCommit..EndCommit; SealEvidence falls back to the working tree when
	// it is absent, so a non-repo project is not a reason to leave the run open.
	endCommit, cerr := ProjectHeadCommit(ctx, run.ProjectPath)
	if cerr != nil {
		log.Printf("complete lead-free run %s: no head commit, evidence falls back to the working tree: %v", run.ID, cerr)
	}
	ts := time.Now().UnixMilli()
	var completedIdx int
	// detached: two of the three Schedule callers are RPC handlers, and this is the write that closes
	// the run. A done dag is outside the watchdog's tick set, so nothing retries — a cancelled ctx here
	// would strand the run exactly as the missing lead did.
	if err := wstore.UpdateRun(context.WithoutCancel(ctx), dag.ChannelId, run.ID, func(r *waveobj.Run) error {
		completedIdx = jarvis.RunningPhaseIndex(*r)
		next, e := jarvis.CompletePhase(*r, completedIdx, nil, ts)
		if e != nil {
			return e
		}
		if endCommit != "" {
			next.EndCommit = endCommit
		}
		*r = next
		return nil
	}); err != nil {
		log.Printf("complete lead-free run %s: %v", run.ID, err)
		return false
	}
	if fresh, err := wstore.GetRun(ctx, dag.ChannelId, run.ID); err == nil {
		*run = *fresh
	}
	appendRunEvent(ctx, dag.ChannelId, run.ID, waveobj.RunEventKindPhaseComplete, &completedIdx, map[string]any{"commit": endCommit, "source": "engine"})
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Run, run.ID))
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, dag.ChannelId))
	SealRunEvidenceHook(dag.ChannelId, run.ID)
	return true
}

// allTasksTerminal reports whether no task is still active — a dag status claiming done can be a stale
// snapshot, so both close paths check the tasks themselves.
func allTasksTerminal(dag *waveobj.TaskGroup) bool {
	for _, t := range dag.Tasks {
		switch t.State {
		case TaskState_Done, TaskState_Skipped, TaskState_Failed, TaskState_Cancelled:
			continue
		default:
			return false
		}
	}
	return true
}
