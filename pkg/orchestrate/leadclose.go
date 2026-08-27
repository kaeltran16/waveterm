// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
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
	// defense-in-depth: if any task is still in a non-terminal state, keep the lead
	// even if the dag status claims done (stale snapshot).
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
