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
	RunEventKindChildCreated   = "child-created"
	RunEventKindChildDone      = "child-done"
	RunEventKindChildCancelled = "child-cancelled"
	RunEventKindRunCancelled   = "run-cancelled"
	RunEventKindEvidenceSealed = "evidence-sealed"
	RunEventKindTaskSpawned    = "task-spawned"
	// task-first-activity marks the first transcript write observed from a child. Paired with
	// task-spawned it decomposes a child's wall clock into environment setup and cold orientation —
	// the two candidates with different fixes, indistinguishable from the done timestamp alone.
	RunEventKindTaskFirstActivity = "task-first-activity"
	RunEventKindTaskStalled       = "task-stalled"
	RunEventKindDagBlocked        = "dag-blocked"
	RunEventKindDagDone           = "dag-done"
	RunEventKindTaskRetried       = "task-retried"
	// orchestration lifecycle transitions beyond run/phase/child coverage. Start/sent events append
	// after the request is accepted or its delivery write succeeds; outcome events append only after
	// the authoritative state mutation persists. Each writer attempts once at that boundary; a
	// successful append yields one row:
	//   task-done / task-failed       child ran to its end (task + child run id + failure detail)
	//   dag-cancelled / dag-gate-open orchestration boundaries the run status alone cannot explain
	//   child-ask / -answered / -cleared  one ask id survives across every answer path
	//   task-merge-*                  merge lifecycle at persisted content-integration boundaries.
	//                                 -blocked is a conflict, which is the human's; -failed is git
	//                                 refusing the squash outright, which is retried a bounded number
	//                                 of times and then blocks rather than looping unseen
	//   task-cleanup-*                durable worktree cleanup at persisted transition boundaries
	RunEventKindTaskDone             = "task-done"
	RunEventKindTaskFailed           = "task-failed"
	RunEventKindDagCancelled         = "dag-cancelled"
	RunEventKindDagGateOpen          = "dag-gate-open"
	RunEventKindChildAsk             = "child-ask"
	RunEventKindChildAnswered        = "child-answered"
	RunEventKindChildAskCleared      = "child-ask-cleared"
	RunEventKindTaskMergeStarted     = "task-merge-started"
	RunEventKindTaskMergeBlocked     = "task-merge-blocked"
	RunEventKindTaskMergeFailed      = "task-merge-failed"
	RunEventKindTaskMergeContinued   = "task-merge-continued"
	RunEventKindTaskMerged           = "task-merged"
	RunEventKindTaskCleanupPending   = "task-cleanup-pending"
	RunEventKindTaskCleanupCompleted = "task-cleanup-completed"
	RunEventKindTaskCleanupFailed    = "task-cleanup-failed"

	// the question queue and the lead wake (orchestrator redesign §5, §6):
	//   task-forwarded    a task's open judgment handed to the human, with why ("taskid", "askid", "note")
	//   lead-woken        a wake typed into the lead's terminal ("text")
	//   lead-launched     a plan-input run's first lead started, with the wake that needed it ("text")
	//   lead-wake-failed  the lead cannot take wakes; its judgment goes to the human ("reason", "lines")
	//   lead-exited       the lead exited before submitting a plan, which fails the run ("reason")
	//   worker-exited     a quick/pipeline run's only worker exited without completing its phase ("reason")
	RunEventKindTaskForwarded  = "task-forwarded"
	RunEventKindLeadWoken      = "lead-woken"
	RunEventKindLeadLaunched   = "lead-launched"
	RunEventKindLeadWakeFailed = "lead-wake-failed"
	RunEventKindLeadExited     = "lead-exited"
	RunEventKindWorkerExited   = "worker-exited"

	// task-told: a message the human typed into a dag child's own terminal ("taskid", "text"), recorded on the
	// owning run so the lead reads it in its status. It wakes nobody.
	RunEventKindTaskTold = "task-told"

	// merge-point Verify (orchestrator redesign §4): the plan's Verify command, run in the project
	// checkout after a task's squash merge.
	//   task-verify-started  "taskid"
	//   task-verify-passed   "taskid", "ms"
	//   task-verify-failed   "taskid", "reason" ("exit 1" or "timed out after 20m"), "detail"
	RunEventKindTaskVerifyStarted = "task-verify-started"
	RunEventKindTaskVerifyPassed  = "task-verify-passed"
	RunEventKindTaskVerifyFailed  = "task-verify-failed"

	// merge-held: the engine is holding every ready merge because the project index is not clean, which
	// is the human mid-edit in the checkout ("held" int, "reason"). Recorded once per transition, not per
	// tick. Without it the halt reaches nobody: the tasks stay merge-ready and the digest keeps offering
	// resolve-merge, while the automatic path refuses every tick for a reason only the server log holds.
	RunEventKindMergeHeld = "merge-held"

	// the review loop and the lead's steering (spec 2026-09-23-orchestrator-review-and-lead-link):
	//   task-review-started  a reviewer was spawned for a finished task ("taskid", "runid")
	//   task-review-passed   "taskid", "note", "downstream"
	//   task-review-failed   "taskid", "note", "round", "final" (true when it went to the lead)
	//   review-overruled     the lead approved a task whose review failed ("taskid")
	//   task-amended         the lead added a note to a task not started yet ("taskid", "text")
	//   task-lead-told       the lead typed into a running worker or reviewer ("taskid", "text")
	RunEventKindTaskReviewStarted = "task-review-started"
	RunEventKindTaskReviewPassed  = "task-review-passed"
	RunEventKindTaskReviewFailed  = "task-review-failed"
	RunEventKindReviewOverruled   = "review-overruled"
	RunEventKindTaskAmended       = "task-amended"
	RunEventKindTaskLeadTold      = "task-lead-told"

	// dag-level judging sessions (spec 2026-09-25-orchestrator-findings-fixes):
	//   stage-session-started  a plan reviewer or final verifier was spawned ("role", "runid")
	//   plan-reviewed          the plan review reached a verdict ("state", "round", "findings")
	RunEventKindStageSessionStarted = "stage-session-started"
	RunEventKindPlanReviewed        = "plan-reviewed"
)

// Detail payload keys per kind (values are built as map[string]any by writers):
//   phase events:     "artifacts" []string, "commit" string
//   child events:     "childrunid" string, "goal" string, "summary" string
//   evidence-sealed:  "files" int, "addtotal" int, "deltotal" int
//   task/dag events:  "taskid" string, "failures" int
//   task-retried:     "taskid" string, "kind" string, "attempt" int
//   task-merge-failed: "taskid" string, "error" string (the git refusal), "attempt" int, "blocked" bool
//   task-spawned:     "taskid" string, "worktreems" int64, "setupms" int64, "spawnms" int64
//   task-first-activity: "taskid" string, "sincespawnms" int64
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
