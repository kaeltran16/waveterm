// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"encoding/json"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// DagDigestSnapshot is the explicit snapshot the RPC layer gathers for one status request: the group,
// the bounded child runs, pending asks, retained lifecycle rows, and now. BuildDigest is pure — it
// performs no storage or clock reads, so the RPC layer stays the only place deciding what inputs are
// fresh enough to report.
type DagDigestSnapshot struct {
	Group    *waveobj.TaskGroup
	Runs     []*waveobj.Run
	Asks     []wshrpc.DagAskItem
	Retained []waveobj.RunEvent
	Now      time.Time
}

// digest action sets, mirroring the digest contract's enum. Single derivation shared by CLI and UI —
// neither reconstructs alternatives from task state.
var (
	digestActionAnswer            = []string{"answer"}
	digestActionApproveSendback   = []string{"approve", "sendback"}
	digestActionResolveMerge      = []string{"resolve-merge"}
	digestActionRetryCleanup      = []string{"retry-cleanup"}
	digestActionRetrySkipEscalate = []string{"retry", "skip", "escalate"}
)

// BuildDigest projects the group (+ its child runs, asks, and retained lifecycle history) onto the
// shared typed digest. DagVersion pins the source group version so consumers can reject stale answers.
func BuildDigest(sn DagDigestSnapshot) wshrpc.DagStatusDigest {
	g := sn.Group
	if g == nil {
		return wshrpc.DagStatusDigest{}
	}
	askByTask := askIndex(sn.Asks)
	retried := retriedTaskSet(sn.Retained)
	d := wshrpc.DagStatusDigest{
		DagVersion: g.Version,
		Health:     buildHealth(g, askByTask),
		Counts:     buildCounts(g, askByTask, retried),
		Next:       buildNext(g, askByTask),
		Durations:  buildDurations(sn),
	}
	for i := range g.Tasks {
		d.Tasks = append(d.Tasks, buildTaskDigest(g, &g.Tasks[i], askByTask, retried))
	}
	d.Control = buildControl(sn.Retained)
	return d
}

// Control digest statuses (spec 7.1). Visibility only: none of them gate the engine, because the
// persisted DAG — not the lead's awareness of it — is what execution runs on.
const (
	controlStatusAcknowledged = "acknowledged"
	controlStatusUnconfirmed  = "unconfirmed"
	controlStatusFailed       = "failed"
	controlStatusUnavailable  = "unavailable"
)

// controlRow is one parsed lead-control-* detail payload.
type controlRow struct {
	EventId   string `json:"eventid"`
	SessionId string `json:"sessionid"`
	TaskId    string `json:"taskid"`
	Cmd       string `json:"cmd"`
	Failure   string `json:"failure"`
	Error     string `json:"error"`
}

// buildControl reports the LATEST control attempt only. Acknowledgements are matched by event id, so
// a superseded control file stays unconfirmed rather than inheriting the previous attempt's ack —
// exactly the case where a stale "acknowledged" would be a lie about what the lead has seen.
func buildControl(retained []waveobj.RunEvent) *wshrpc.ControlDigest {
	var latest *wshrpc.ControlDigest
	var latestTs int64
	acked := map[string]int64{}
	for _, ev := range retained {
		var row controlRow
		if err := json.Unmarshal(ev.Detail, &row); err != nil || row.EventId == "" {
			continue
		}
		if ev.Kind == waveobj.RunEventKindLeadControlAcknowledged {
			if ts, seen := acked[row.EventId]; !seen || ev.Ts > ts {
				acked[row.EventId] = ev.Ts
			}
			continue
		}
		sent := ev.Kind == waveobj.RunEventKindLeadControlSent
		if !sent && ev.Kind != waveobj.RunEventKindLeadControlFailed {
			continue
		}
		if latest != nil && ev.Ts <= latestTs {
			continue
		}
		latestTs = ev.Ts
		attempt := &wshrpc.ControlDigest{
			EventId:   row.EventId,
			Kind:      row.Cmd,
			TaskId:    row.TaskId,
			SessionId: row.SessionId,
			Error:     row.Error,
		}
		if sent {
			attempt.Status, attempt.SentTs = controlStatusUnconfirmed, ev.Ts
		} else if row.Failure == ControlFailureUnavailable {
			attempt.Status = controlStatusUnavailable
		} else {
			attempt.Status = controlStatusFailed
		}
		latest = attempt
	}
	if latest == nil {
		return nil
	}
	if ts, ok := acked[latest.EventId]; ok && latest.Status == controlStatusUnconfirmed {
		latest.Status, latest.AcknowledgedTs = controlStatusAcknowledged, ts
	}
	return latest
}

// askIndex maps task id -> its pending ask. A child may raise multiple asks (one block at a time); the
// newest ask wins because that is what the child is actually blocked on.
func askIndex(asks []wshrpc.DagAskItem) map[string]wshrpc.DagAskItem {
	out := map[string]wshrpc.DagAskItem{}
	for _, a := range asks {
		if a.TaskId == "" {
			continue
		}
		if cur, ok := out[a.TaskId]; !ok || a.Ts >= cur.Ts {
			out[a.TaskId] = a
		}
	}
	return out
}

// retriedTaskSet returns the task ids that carry a retained task-retried event (recovered-retry proof
// requires the current task be done; the per-task check does that part).
func retriedTaskSet(retained []waveobj.RunEvent) map[string]bool {
	out := map[string]bool{}
	for _, ev := range retained {
		if ev.Kind != waveobj.RunEventKindTaskRetried {
			continue
		}
		if taskID := eventTaskID(ev); taskID != "" {
			out[taskID] = true
		}
	}
	return out
}

// eventTaskID reads the taskid detail key an event carries ("taskid" for task/merge/cleanup kinds).
func eventTaskID(ev waveobj.RunEvent) string {
	if len(ev.Detail) == 0 {
		return ""
	}
	var detail map[string]any
	if err := json.Unmarshal(ev.Detail, &detail); err != nil {
		return ""
	}
	tid, _ := detail["taskid"].(string)
	return tid
}

func taskAttention(g *waveobj.TaskGroup, t *waveobj.TaskNode, askByTask map[string]wshrpc.DagAskItem) bool {
	if _, ok := askByTask[t.ID]; ok {
		return true
	}
	if t.Gate && t.State == TaskState_Done && !t.Released {
		return true
	}
	if t.State == TaskState_Failed || t.State == TaskState_BlockedMerge {
		return true
	}
	return t.CleanupError != ""
}

func buildCounts(g *waveobj.TaskGroup, askByTask map[string]wshrpc.DagAskItem, retried map[string]bool) wshrpc.DagStatusCounts {
	c := wshrpc.DagStatusCounts{Total: len(g.Tasks)}
	for i := range g.Tasks {
		t := &g.Tasks[i]
		switch t.State {
		case TaskState_Done:
			c.Done++
			if retried[t.ID] {
				c.RecoveredRetry++
			}
			if g.MergeRequired && !t.Merged && (!t.Gate || t.Released) {
				c.MergeReady++
			}
		case TaskState_Running:
			c.Running++
		case TaskState_Stalled:
			c.Stalled++
		}
		if t.State == TaskState_Pending && hasUnsatDep(g, t) {
			c.DependencyWaiting++
		}
		if taskAttention(g, t, askByTask) {
			c.Attention++
		}
	}
	return c
}

func hasUnsatDep(g *waveobj.TaskGroup, t *waveobj.TaskNode) bool {
	for _, d := range t.Deps {
		if !depSatisfied(g, d) {
			return true
		}
	}
	return false
}

// buildHealth derives aggregate health strictly per spec §5.2 precedence: needs-you (ask, unreleased
// gate, terminal failure, blocked merge, failed cleanup, blocked dag, terminal-with-debt) -> stalled ->
// healthy -> done/cancelled.
func buildHealth(g *waveobj.TaskGroup, askByTask map[string]wshrpc.DagAskItem) string {
	if g.Status == DagStatus_Blocked {
		return "needs-you"
	}
	for i := range g.Tasks {
		if taskAttention(g, &g.Tasks[i], askByTask) {
			return "needs-you"
		}
	}
	for i := range g.Tasks {
		if g.Tasks[i].State == TaskState_Stalled {
			return "stalled"
		}
	}
	if g.Status == DagStatus_Done || g.Status == DagStatus_Cancelled {
		if HasCleanupDebt(g) {
			return "needs-you"
		}
		if g.Status == DagStatus_Done {
			return "done"
		}
		return "cancelled"
	}
	return "healthy"
}

// mergeReadyBlocking returns the merge-ready tasks that block pending successors, in dag order
// (spec §5.3 step 2: "merge-ready work that blocks successors when MergeRequired is true").
func mergeReadyBlocking(g *waveobj.TaskGroup) []string {
	if !g.MergeRequired {
		return nil
	}
	mergeReady := map[string]bool{}
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.State == TaskState_Done && !t.Merged && (!t.Gate || t.Released) {
			mergeReady[t.ID] = true
		}
	}
	if len(mergeReady) == 0 {
		return nil
	}
	// a pending task is blocked-by-merge when its unsat dep chain reaches a merge-ready task
	var out []string
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.State == TaskState_Pending && depChainReachesMergeReady(g, t, mergeReady) {
			out = append(out, t.ID)
		}
	}
	return out
}

func depChainReachesMergeReady(g *waveobj.TaskGroup, t *waveobj.TaskNode, mergeReady map[string]bool) bool {
	for _, d := range t.Deps {
		if mergeReady[d] {
			return true
		}
		dn := taskByID(g, d)
		if dn != nil && !depSatisfied(g, d) && depChainReachesMergeReady(g, dn, mergeReady) {
			return true
		}
	}
	return false
}

// buildNext derives the highest-priority current condition per spec §5.3 ordering. TaskIds are always
// in dag order; Actions are the complete valid set for the selected condition (never reconstructed).
func buildNext(g *waveobj.TaskGroup, askByTask map[string]wshrpc.DagAskItem) wshrpc.DagNextStep {
	// 1. required human action, ordered: answer -> approve/sendback -> resolve-merge -> retry-cleanup -> retry/skip/escalate
	if ids := tasksWithAsk(g, askByTask); len(ids) > 0 {
		return humanActionStep("answer", ids, digestActionAnswer)
	}
	if ids := unreleasedGateIDs(g); len(ids) > 0 {
		return humanActionStep("approve/sendback", ids, digestActionApproveSendback)
	}
	if ids := tasksInState(g, TaskState_BlockedMerge); len(ids) > 0 {
		return humanActionStep("resolve-merge", ids, digestActionResolveMerge)
	}
	if ids := failedCleanupIDs(g); len(ids) > 0 {
		return humanActionStep("retry-cleanup", ids, digestActionRetryCleanup)
	}
	if ids := tasksInState(g, TaskState_Failed); len(ids) > 0 {
		return humanActionStep("retry/skip/escalate", ids, digestActionRetrySkipEscalate)
	}
	if ids := tasksInState(g, TaskState_Stalled); len(ids) > 0 {
		return humanActionStep("retry/skip/escalate", ids, digestActionRetrySkipEscalate)
	}
	// 2. merge-ready work that blocks successors (merge-required dags only)
	if blocked := mergeReadyBlocking(g); len(blocked) > 0 {
		ids := mergeReadyIDs(g)
		return wshrpc.DagNextStep{Kind: "merge-ready", TaskIds: ids, Actions: digestActionResolveMerge}
	}
	// 3. tasks the scheduler can dispatch now
	if next := NextToSpawn(g); len(next) > 0 {
		return wshrpc.DagNextStep{Kind: "dispatch", TaskIds: next}
	}
	// 4. parallelism wait: active tasks own the next engine move when nothing can dispatch now.
	if busy := busyTaskIDs(g); len(busy) > 0 {
		return wshrpc.DagNextStep{Kind: "parallelism-wait", BlockingTaskIds: busy}
	}
	// 5. dependency wait on pending tasks with unsatisfied deps
	if depWait, blocking := dependencyWait(g); len(depWait) > 0 {
		return wshrpc.DagNextStep{Kind: "dependency-wait", TaskIds: depWait, BlockingTaskIds: blocking}
	}
	// 6. terminal
	if g.Status == DagStatus_Done || g.Status == DagStatus_Cancelled {
		return wshrpc.DagNextStep{Kind: "terminal", TerminalStatus: g.Status}
	}
	return wshrpc.DagNextStep{Kind: "terminal"}
}

func humanActionStep(_ string, taskIDs, actions []string) wshrpc.DagNextStep {
	return wshrpc.DagNextStep{Kind: "human-action", TaskIds: taskIDs, Actions: actions}
}

func tasksWithAsk(g *waveobj.TaskGroup, askByTask map[string]wshrpc.DagAskItem) []string {
	var ids []string
	for i := range g.Tasks {
		if _, ok := askByTask[g.Tasks[i].ID]; ok {
			ids = append(ids, g.Tasks[i].ID)
		}
	}
	return ids
}

func unreleasedGateIDs(g *waveobj.TaskGroup) []string {
	var ids []string
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.Gate && t.State == TaskState_Done && !t.Released {
			ids = append(ids, t.ID)
		}
	}
	return ids
}

func tasksInState(g *waveobj.TaskGroup, state string) []string {
	var ids []string
	for i := range g.Tasks {
		if g.Tasks[i].State == state {
			ids = append(ids, g.Tasks[i].ID)
		}
	}
	return ids
}

func failedCleanupIDs(g *waveobj.TaskGroup) []string {
	var ids []string
	for i := range g.Tasks {
		if g.Tasks[i].CleanupError != "" {
			ids = append(ids, g.Tasks[i].ID)
		}
	}
	return ids
}

func mergeReadyIDs(g *waveobj.TaskGroup) []string {
	var ids []string
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if g.MergeRequired && t.State == TaskState_Done && !t.Merged && (!t.Gate || t.Released) {
			ids = append(ids, t.ID)
		}
	}
	return ids
}

func busyTaskIDs(g *waveobj.TaskGroup) []string {
	var ids []string
	for i := range g.Tasks {
		if g.Tasks[i].State == TaskState_Running || g.Tasks[i].State == TaskState_Stalled {
			ids = append(ids, g.Tasks[i].ID)
		}
	}
	return ids
}

// dependencyWait returns pending tasks with unsatisfied deps (dag order) and their blocking task ids
// (the unsat deps, dag order, deduped).
func dependencyWait(g *waveobj.TaskGroup) ([]string, []string) {
	var waiting []string
	blockingSet := map[string]bool{}
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.State != TaskState_Pending {
			continue
		}
		hasBlock := false
		for _, d := range t.Deps {
			if !depSatisfied(g, d) {
				hasBlock = true
				blockingSet[d] = true
			}
		}
		if hasBlock {
			waiting = append(waiting, t.ID)
		}
	}
	var blocking []string
	for i := range g.Tasks {
		if blockingSet[g.Tasks[i].ID] {
			blocking = append(blocking, g.Tasks[i].ID)
		}
	}
	return waiting, blocking
}

func buildTaskDigest(g *waveobj.TaskGroup, t *waveobj.TaskNode, askByTask map[string]wshrpc.DagAskItem, retried map[string]bool) wshrpc.DagTaskDigest {
	td := wshrpc.DagTaskDigest{
		TaskId:      t.ID,
		FreshnessTs: t.LastActivity,
	}
	if ask, ok := askByTask[t.ID]; ok {
		td.WaitReason = "ask"
		td.HumanActions = digestActionAnswer
		td.AskId = ask.AskId
		td.AskSummary = truncateText(ask.Question, MaxAskSummaryLen)
		td.AskTs = ask.Ts
	} else if t.Gate && t.State == TaskState_Done && !t.Released {
		td.WaitReason = "gate"
		td.HumanActions = digestActionApproveSendback
	} else {
		td.WaitReason = taskWaitReason(g, t)
		td.HumanActions = taskHumanActions(g, t)
		td.BlockingTaskIds = taskBlockingIds(g, t)
	}
	if t.State == TaskState_Done && retried[t.ID] {
		td.RecoveredRetry = true
	}
	td.MergeState = taskMergeState(g, t)
	td.CleanupState = taskCleanupState(g, t)
	return td
}

func taskWaitReason(g *waveobj.TaskGroup, t *waveobj.TaskNode) string {
	switch t.State {
	case TaskState_Running:
		return "none"
	case TaskState_Stalled:
		// stalled is its own state (health + counts carry it); the wait-reason enum has no stall value
		return "none"
	case TaskState_Failed:
		return "failure"
	case TaskState_BlockedMerge:
		return "merge"
	case TaskState_Done:
		return "terminal"
	case TaskState_Skipped, TaskState_Cancelled:
		return "terminal"
	case TaskState_Pending:
		if hasUnsatDep(g, t) {
			return "dependency"
		}
		if taskIsParallelismCapped(g, t) {
			return "parallelism"
		}
		return "none"
	default:
		return "none"
	}
}

// taskIsParallelismCapped reports a ready pending task that cannot spawn because every slot is busy.
func taskIsParallelismCapped(g *waveobj.TaskGroup, t *waveobj.TaskNode) bool {
	if len(NextToSpawn(g)) > 0 {
		return false
	}
	busy := 0
	for i := range g.Tasks {
		if g.Tasks[i].State == TaskState_Running || g.Tasks[i].State == TaskState_Stalled {
			busy++
		}
	}
	return busy > 0 && taskReady(g, t)
}

func taskReady(g *waveobj.TaskGroup, t *waveobj.TaskNode) bool {
	for _, d := range t.Deps {
		if !depSatisfied(g, d) {
			return false
		}
	}
	return true
}

func taskBlockingIds(g *waveobj.TaskGroup, t *waveobj.TaskNode) []string {
	if t.State != TaskState_Pending || !hasUnsatDep(g, t) {
		return nil
	}
	var out []string
	for _, d := range t.Deps {
		if !depSatisfied(g, d) {
			out = append(out, d)
		}
	}
	return out
}

func taskHumanActions(g *waveobj.TaskGroup, t *waveobj.TaskNode) []string {
	switch {
	case t.CleanupError != "":
		return digestActionRetryCleanup
	case t.State == TaskState_Failed || t.State == TaskState_Stalled:
		return digestActionRetrySkipEscalate
	case t.State == TaskState_BlockedMerge:
		return digestActionResolveMerge
	case t.State == TaskState_Done && g.MergeRequired && !t.Merged && (!t.Gate || t.Released):
		return digestActionResolveMerge
	}
	return nil
}

func taskMergeState(g *waveobj.TaskGroup, t *waveobj.TaskNode) string {
	if !g.MergeRequired {
		return "not-required"
	}
	if t.Merged {
		return "merged"
	}
	if t.State == TaskState_BlockedMerge {
		return "blocked"
	}
	if t.State == TaskState_Done && (!t.Gate || t.Released) {
		return "ready"
	}
	return "waiting"
}

func taskCleanupState(g *waveobj.TaskGroup, t *waveobj.TaskNode) string {
	if !g.MergeRequired {
		return "not-required"
	}
	if t.CleanupError != "" {
		return "failed"
	}
	if t.CleanupPending {
		return "pending"
	}
	return "clear"
}

// buildDurations derives durations strictly from persisted boundaries. A missing required boundary
// yields zero and marks the task (and the aggregate) partial — never a fabricated span.
func buildDurations(sn DagDigestSnapshot) wshrpc.DagDurationDigest {
	g := sn.Group
	d := wshrpc.DagDurationDigest{}
	// elapsed: now-created while active; terminal timestamp minus created after dag-done/cancelled
	terminalTs := terminalEventTs(sn.Retained)
	switch {
	case terminalTs > 0:
		d.ElapsedMs = terminalTs - g.CreatedTs
	case g.Status == DagStatus_Done || g.Status == DagStatus_Cancelled:
		// terminal transition happened but its required boundary was pruned
		d.Partial = true
	default:
		d.ElapsedMs = sn.Now.UnixMilli() - g.CreatedTs
	}
	runByID := map[string]*waveobj.Run{}
	for _, r := range sn.Runs {
		if r != nil {
			runByID[r.ID] = r
		}
	}
	for i := range g.Tasks {
		td := taskDuration(g, &g.Tasks[i], runByID, sn.Retained)
		if td == nil {
			continue
		}
		d.Tasks = append(d.Tasks, *td)
		if td.Partial {
			d.Partial = true
		}
	}
	return d
}

// taskDuration derives one task's duration row. Tasks without a child run and without merge/cleanup
// events have nothing to report (not dispatched yet) and get no row.
func taskDuration(g *waveobj.TaskGroup, t *waveobj.TaskNode, runByID map[string]*waveobj.Run, retained []waveobj.RunEvent) *wshrpc.DagTaskDuration {
	td := &wshrpc.DagTaskDuration{TaskId: t.ID}
	hasRow := false
	if t.RunID != "" {
		hasRow = true
		if run, ok := runByID[t.RunID]; ok {
			for _, p := range run.Phases {
				if p.StartedTs > 0 && p.DoneTs > 0 {
					td.RunMs += p.DoneTs - p.StartedTs
				} else if p.StartedTs > 0 || p.DoneTs > 0 {
					// a phase with only one bound: still executing or pruned
					td.Partial = true
				}
			}
		} else {
			// the child run exists in the group but did not load this request
			td.Partial = true
		}
	}
	// merge wait: task-done -> first task-merge-started
	if doneTs := firstTaskEventTs(retained, waveobj.RunEventKindTaskDone, t.ID, true); doneTs > 0 {
		hasRow = true
		if startedTs := firstTaskEventTs(retained, waveobj.RunEventKindTaskMergeStarted, t.ID, false); startedTs > 0 {
			td.MergeWaitMs = startedTs - doneTs
		} else {
			td.Partial = true
		}
	}
	// cleanup: task-cleanup-pending -> completed/failed
	if pendingTs := firstTaskEventTs(retained, waveobj.RunEventKindTaskCleanupPending, t.ID, true); pendingTs > 0 {
		hasRow = true
		if termTs := cleanupTerminalTs(retained, t.ID); termTs > 0 {
			td.CleanupMs = termTs - pendingTs
		} else {
			td.Partial = true
		}
	}
	if !hasRow {
		return nil
	}
	return td
}

// firstTaskEventTs returns the earliest (first=true) or latest (first=false) ts of a task-scoped kind,
// 0 when absent.
func firstTaskEventTs(retained []waveobj.RunEvent, kind, taskID string, earliest bool) int64 {
	var best int64
	for _, ev := range retained {
		if ev.Kind != kind || eventTaskID(ev) != taskID {
			continue
		}
		if best == 0 || (earliest && ev.Ts < best) || (!earliest && ev.Ts > best) {
			best = ev.Ts
		}
	}
	return best
}

// cleanupTerminalTs returns the completion/failure ts of a task's cleanup, 0 while still pending.
func cleanupTerminalTs(retained []waveobj.RunEvent, taskID string) int64 {
	completed := firstTaskEventTs(retained, waveobj.RunEventKindTaskCleanupCompleted, taskID, false)
	failed := firstTaskEventTs(retained, waveobj.RunEventKindTaskCleanupFailed, taskID, false)
	if completed > failed {
		return completed
	}
	return failed
}

// terminalEventTs returns the dag-done/dag-cancelled ts, 0 when neither is retained.
func terminalEventTs(retained []waveobj.RunEvent) int64 {
	var best int64
	for _, ev := range retained {
		if ev.Kind != waveobj.RunEventKindDagDone && ev.Kind != waveobj.RunEventKindDagCancelled {
			continue
		}
		if ev.Ts > best {
			best = ev.Ts
		}
	}
	return best
}

// MaxAskSummaryLen caps the ask summary the digest carries (and the ask lifecycle event writer uses).
const MaxAskSummaryLen = 256

func truncateText(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}
