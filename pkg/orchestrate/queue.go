// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// askDeadlineNote is why a question the lead sat on past LeadAskDeadline moved to the human.
const askDeadlineNote = "lead did not answer in time"

const runFinishedWake = "wake: run finished. wsh jarvis dag status"

// taskFailedWake names the failure kind so the lead can pick retry, escalate, skip or forward before
// reading the digest. A child run that reported itself blocked carries no kind.
func taskFailedWake(taskID, kind string) string {
	if kind == "" {
		kind = FailureKindUnknown
	}
	return fmt.Sprintf("wake: task %s failed (%s), retry spent. wsh jarvis dag status", taskID, kind)
}

// taskHungWake says how long the worker has been silent, so the lead can weigh a slow task against a
// stuck one before reading the digest.
func taskHungWake(taskID string, silentMin int64) string {
	return fmt.Sprintf("wake: task %s hung: silent %dm, process alive, no ask pending. wsh jarvis dag status", taskID, silentMin)
}

func mergeConflictWake(taskID string) string {
	return fmt.Sprintf("wake: merge conflict landing task %s. git status", taskID)
}

// verifyFailedWake names the exit code or the timeout, so the lead knows whether to read a failing test or
// look for a hang before it reads the digest.
func verifyFailedWake(taskID, reason string) string {
	return fmt.Sprintf("wake: Verify failed after merging task %s (%s). wsh jarvis dag status", taskID, reason)
}

// RaiseChildAsk puts a dag child's question in its lead's queue and wakes the lead. question is the
// first question's text, for the child-ask row.
func RaiseChildAsk(ctx context.Context, g *waveobj.TaskGroup, target AskTarget, blockOref, question string) {
	var raised agentask.PendingAsk
	ok := agentask.GlobalRegistry.Update(blockOref, target.AskId, func(p *agentask.PendingAsk) {
		p.Owner = agentask.AskOwner_Lead
		p.Deadline = wakeNow() + LeadAskDeadline.Milliseconds()
		p.ChannelId, p.RunId, p.TaskId, p.DagOID = g.ChannelId, g.RunID, target.TaskId, g.OID
		raised = *p
	})
	if !ok {
		return
	}
	publishChildAsk(raised)
	RecordAskLifecycle(ctx, target, waveobj.RunEventKindChildAsk, question)
	PokeWake(ctx, g.ChannelId, g.RunID)
}

// expireClearsFn puts typed answers no agent confirmed back in the queue and returns them. A var so
// tests can hand the sweep a restored ask without typing into a real block.
var expireClearsFn = func(now int64) map[string]agentask.PendingAsk {
	return agentask.GlobalRegistry.ExpireClears(now, agentask.AnswerClearTimeout)
}

// sweepAsks moves lead-owned questions past their deadline to the human, and puts answers that never
// landed back in front of their owner.
func sweepAsks(ctx context.Context) {
	now := wakeNow()
	for oref, p := range agentask.GlobalRegistry.List() {
		if p.Owner == agentask.AskOwner_Lead && p.Deadline > 0 && now >= p.Deadline {
			forwardAskToUser(ctx, oref, p, askDeadlineNote)
		}
	}
	for oref, p := range expireClearsFn(now) {
		if p.Owner != agentask.AskOwner_Lead {
			forwardAskToUser(ctx, oref, p, p.Note)
			continue
		}
		// the deadline restarts: the lead answered in time, and it was the delivery that failed.
		agentask.GlobalRegistry.Update(oref, p.AskId, func(cur *agentask.PendingAsk) {
			cur.Deadline = now + LeadAskDeadline.Milliseconds()
		})
		publishChildAsk(p)
		PokeWake(ctx, p.ChannelId, p.RunId)
	}
}

// ForwardTask hands a task's open judgment to the human with the lead's note (`dag forward`): its
// pending question when it has one, otherwise the failure, stall or merge conflict the lead was woken
// for, which then waits on the timeline for the human.
func ForwardTask(ctx context.Context, dagID, taskID, note string) error {
	note = strings.TrimSpace(note)
	if note == "" {
		return fmt.Errorf("forward needs a note saying what the human should decide")
	}
	g, err := wstore.GetDag(ctx, dagID)
	if err != nil {
		return fmt.Errorf("loading dag: %w", err)
	}
	task := taskByID(g, taskID)
	if task == nil {
		return fmt.Errorf("no task %q", taskID)
	}
	if oref, p, ok := taskPendingAsk(ctx, g, task); ok {
		p.ChannelId, p.RunId, p.TaskId, p.DagOID = g.ChannelId, g.RunID, task.ID, g.OID
		if !forwardAskToUser(ctx, oref, p, note) {
			return fmt.Errorf("task %s's question was answered before it could be forwarded", taskID)
		}
		return nil
	}
	switch task.State {
	case TaskState_Failed, TaskState_Stalled, TaskState_BlockedMerge, TaskState_VerifyFailed:
		appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskForwarded, nil, map[string]any{
			"taskid": task.ID,
			"note":   truncateText(note, MaxAskSummaryLen),
		})
		return nil
	}
	return fmt.Errorf("task %s has no question, failure, stall, merge conflict or failed Verify to forward (state %q)", taskID, task.State)
}

func taskPendingAsk(ctx context.Context, g *waveobj.TaskGroup, task *waveobj.TaskNode) (string, agentask.PendingAsk, bool) {
	if task.RunID == "" {
		return "", agentask.PendingAsk{}, false
	}
	child, err := wstore.GetRun(ctx, g.ChannelId, task.RunID)
	if err != nil {
		return "", agentask.PendingAsk{}, false
	}
	for _, oref := range RunBlockORefs(ctx, child) {
		if p, ok := agentask.GlobalRegistry.Get(oref); ok {
			return oref, p, true
		}
	}
	return "", agentask.PendingAsk{}, false
}

// RunBlockORefs lists the worker block orefs of a run's phases, the keys the ask registry holds the
// run's questions under.
func RunBlockORefs(ctx context.Context, run *waveobj.Run) []string {
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
