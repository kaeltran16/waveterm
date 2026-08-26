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