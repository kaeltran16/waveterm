// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package waveobj

import "encoding/json"

// RunEvent kinds (run visibility timeline). Written at the transitions that already persist run
// state; the FE timeline groups them under RUN (cross-cutting) or their phase (phaseidx set).
const (
	RunEventKindCreated        = "run-created"
	RunEventKindPhaseStarted   = "phase-started"
	RunEventKindPhaseComplete  = "phase-complete"
	RunEventKindPhaseHeld      = "phase-held"
	RunEventKindGateApproved   = "gate-approved"
	RunEventKindGateSentBack   = "gate-sent-back"
	RunEventKindTriage         = "triage"
	RunEventKindChildCreated   = "child-created"
	RunEventKindChildDone      = "child-done"
	RunEventKindChildCancelled = "child-cancelled"
	RunEventKindRunCancelled   = "run-cancelled"
	RunEventKindEvidenceSealed = "evidence-sealed"
	RunEventKindTaskSpawned    = "task-spawned"
	RunEventKindTaskStalled    = "task-stalled"
	RunEventKindDagBlocked     = "dag-blocked"
	RunEventKindDagDone        = "dag-done"
	RunEventKindTaskRetried    = "task-retried"
	// orchestration lifecycle transitions beyond run/phase/child coverage. Start/sent events append
	// after the request is accepted or its delivery write succeeds; outcome events append only after
	// the authoritative state mutation persists. Each writer attempts once at that boundary; a
	// successful append yields one row:
	//   task-done / task-failed       child ran to its end (task + child run id + failure detail)
	//   dag-cancelled / dag-gate-open orchestration boundaries the run status alone cannot explain
	//   child-ask / -answered / -cleared  one ask id survives across every answer path
	//   task-merge-*                  merge lifecycle at persisted content-integration boundaries
	//   task-cleanup-*                durable worktree cleanup at persisted transition boundaries
	//   lead-control-*                lead-control delivery + acknowledgement (stable event id)
	RunEventKindTaskDone                = "task-done"
	RunEventKindTaskFailed              = "task-failed"
	RunEventKindDagCancelled            = "dag-cancelled"
	RunEventKindDagGateOpen             = "dag-gate-open"
	RunEventKindChildAsk                = "child-ask"
	RunEventKindChildAnswered           = "child-answered"
	RunEventKindChildAskCleared         = "child-ask-cleared"
	RunEventKindTaskMergeStarted        = "task-merge-started"
	RunEventKindTaskMergeBlocked        = "task-merge-blocked"
	RunEventKindTaskMergeContinued      = "task-merge-continued"
	RunEventKindTaskMerged              = "task-merged"
	RunEventKindTaskCleanupPending      = "task-cleanup-pending"
	RunEventKindTaskCleanupCompleted    = "task-cleanup-completed"
	RunEventKindTaskCleanupFailed       = "task-cleanup-failed"
	RunEventKindLeadControlSent         = "lead-control-sent"
	RunEventKindLeadControlFailed       = "lead-control-failed"
	RunEventKindLeadControlAcknowledged = "lead-control-acknowledged"
)

// Detail payload keys per kind (values are built as map[string]any by writers):
//   phase events:     "artifacts" []string, "commit" string
//   triage:           "verdict" string, "note" string
//   child events:     "childrunid" string, "goal" string, "summary" string
//   evidence-sealed:  "files" int, "addtotal" int, "deltotal" int
//   task/dag events:  "taskid" string, "failures" int
//   task-retried:     "taskid" string, "kind" string, "attempt" int
//   created:          "runtime" string, "mode" string

// RunEvent is one row of a run's append-only lifecycle log (db_runevent).
type RunEvent struct {
	ID        string          `json:"id"`
	RunID     string          `json:"runid"`
	ChannelID string          `json:"channelid"`
	Ts        int64           `json:"ts"`
	Kind      string          `json:"kind"`
	PhaseIdx  *int            `json:"phaseidx,omitempty"`
	Detail    json.RawMessage `json:"detail,omitempty"`
}
