// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const oneQuestionWake = "wake: 1 question waiting. wsh jarvis dag asks"

// settle has the scripted lead take the outstanding wake, so the next event is typed instead of held.
func (f *fakeLead) settle(ctx context.Context) {
	NoteLeadStatus(ctx, f.status(baseds.AgentState_Working))
	NoteLeadStatus(ctx, f.status(baseds.AgentState_Idle))
}

func raiseOn(t *testing.T, oref, askId string) {
	t.Helper()
	agentask.GlobalRegistry.Set(oref, agentask.PendingAsk{
		AskId: askId, BlockId: "child", Questions: []baseds.AgentAskQuestion{{Question: "which way?"}},
	})
	g := &waveobj.TaskGroup{OID: "dag-1", ChannelId: wakeChannel, RunID: wakeRun}
	target := AskTarget{ChannelId: wakeChannel, RunID: wakeRun, TaskId: "t-2", AskId: askId}
	RaiseChildAsk(context.Background(), g, target, oref, "which way?")
}

// stubExpiredClears hands the sweep answers that never landed, putting them back in the registry the
// way ExpireClears does, once.
func stubExpiredClears(t *testing.T, restored map[string]agentask.PendingAsk) {
	t.Helper()
	orig := expireClearsFn
	expireClearsFn = func(int64) map[string]agentask.PendingAsk {
		for oref, p := range restored {
			agentask.GlobalRegistry.Set(oref, p)
		}
		out := restored
		restored = nil
		return out
	}
	t.Cleanup(func() { expireClearsFn = orig })
}

func unconfirmedAsk(owner string, misses int) agentask.PendingAsk {
	return agentask.PendingAsk{
		AskId: "a1", BlockId: "child", Questions: []baseds.AgentAskQuestion{{Question: "which way?"}},
		Owner: owner, Deadline: 1, Note: agentask.AnswerUnconfirmedNote, Misses: misses,
		ChannelId: wakeChannel, RunId: wakeRun, TaskId: "t-2", DagOID: "dag-1",
	}
}

func TestRaisedAskIsLeadOwnedAndWakesLead(t *testing.T) {
	f := newFakeLead(t)
	raiseOn(t, "block:child-1", "a1")

	p, _ := agentask.GlobalRegistry.Get("block:child-1")
	if p.Owner != agentask.AskOwner_Lead || p.Deadline != f.now+LeadAskDeadline.Milliseconds() ||
		p.RunId != wakeRun || p.TaskId != "t-2" || p.DagOID != "dag-1" {
		t.Fatalf("a raised ask belongs to the lead, with a deadline and its task, got %+v", p)
	}
	if len(f.sends) != 1 || f.sends[0] != oneQuestionWake {
		t.Fatalf("an idle lead is woken for the question, got %q", f.sends)
	}
	if f.countKind(waveobj.RunEventKindChildAsk) != 1 {
		t.Fatalf("want one child-ask row, got %+v", f.rows)
	}
}

func TestRaisedAskGoesToUserWhenLeadIsDead(t *testing.T) {
	f := newFakeLead(t)
	f.state.Alive = false
	PostWake(context.Background(), wakeChannel, wakeRun, finishedLine)

	raiseOn(t, "block:child-1", "a1")

	p, _ := agentask.GlobalRegistry.Get("block:child-1")
	if p.Owner != agentask.AskOwner_User || p.Note != leadDeadNote {
		t.Fatalf("a dead lead cannot own a new question, got %+v", p)
	}
	if len(f.sends) != 0 || f.countKind(waveobj.RunEventKindTaskForwarded) != 1 {
		t.Fatalf("want no typing and one task-forwarded row, sends=%q rows=%+v", f.sends, f.rows)
	}
}

func TestLeadAskPastDeadlineMovesToUser(t *testing.T) {
	f := newFakeLead(t)
	f.state.State = baseds.AgentState_Working
	raiseOn(t, "block:child-1", "a1")
	ctx := context.Background()

	f.now += LeadAskDeadline.Milliseconds() - 1
	sweepAsks(ctx)
	if p, _ := agentask.GlobalRegistry.Get("block:child-1"); p.Owner != agentask.AskOwner_Lead {
		t.Fatalf("the lead keeps its question until the deadline, got %+v", p)
	}

	f.now++
	sweepAsks(ctx)
	p, _ := agentask.GlobalRegistry.Get("block:child-1")
	if p.Owner != agentask.AskOwner_User || p.Note != askDeadlineNote {
		t.Fatalf("a question past its deadline moves to the user with why, got %+v", p)
	}
	if f.countKind(waveobj.RunEventKindTaskForwarded) != 1 {
		t.Fatalf("want one task-forwarded row, got %+v", f.rows)
	}
}

func TestUnconfirmedAnswerComesBackToLead(t *testing.T) {
	f := newFakeLead(t)
	stubExpiredClears(t, map[string]agentask.PendingAsk{"block:child-1": unconfirmedAsk(agentask.AskOwner_Lead, 1)})

	sweepAsks(context.Background())

	p, _ := agentask.GlobalRegistry.Get("block:child-1")
	if p.Owner != agentask.AskOwner_Lead || p.Deadline != f.now+LeadAskDeadline.Milliseconds() {
		t.Fatalf("an answer that never landed returns to the lead with a fresh deadline, got %+v", p)
	}
	if len(f.sends) != 1 || f.sends[0] != oneQuestionWake {
		t.Fatalf("the lead is told the question is back, got %q", f.sends)
	}
}

func TestSecondUnconfirmedAnswerIsForwardedToUser(t *testing.T) {
	f := newFakeLead(t)
	stubExpiredClears(t, map[string]agentask.PendingAsk{"block:child-1": unconfirmedAsk(agentask.AskOwner_User, 2)})

	sweepAsks(context.Background())

	p, _ := agentask.GlobalRegistry.Get("block:child-1")
	if p.Owner != agentask.AskOwner_User || p.Note != agentask.AnswerUnconfirmedNote {
		t.Fatalf("the second miss stays with the user, noted, got %+v", p)
	}
	if len(f.sends) != 0 || f.countKind(waveobj.RunEventKindTaskForwarded) != 1 {
		t.Fatalf("want no typing and one task-forwarded row, sends=%q rows=%+v", f.sends, f.rows)
	}
}

func TestDispatchFailureWakesLeadAfterCommit(t *testing.T) {
	f := newFakeLead(t)
	g := &waveobj.TaskGroup{OID: "dag-1", ChannelId: wakeChannel, RunID: wakeRun, Tasks: []waveobj.TaskNode{{ID: "t-3", State: TaskState_Ready}}}
	var afterCommit []func()

	failDispatch(context.Background(), g, "t-3", FailureKindSpawn, errors.New("pty refused"), &afterCommit)
	if len(f.sends) != 0 {
		t.Fatalf("nothing is typed before the failure persists, got %q", f.sends)
	}
	for _, fn := range afterCommit {
		fn()
	}

	want := "wake: task t-3 failed (spawn-failed), retry spent. wsh jarvis dag status"
	if len(f.sends) != 1 || f.sends[0] != want {
		t.Fatalf("want %q, got %q", want, f.sends)
	}
}

func TestBlockedChildRunWakesLead(t *testing.T) {
	f := newFakeLead(t)
	h := newNotifyHarness(t, 1, []waveobj.TaskNode{{ID: "t-0", Label: "a"}})
	h.finishTask(t, "t-0", jarvis.RunStatus_Blocked)

	h.scheduleTimes(t, 1)

	want := "wake: task t-0 failed (unknown), retry spent. wsh jarvis dag status"
	if len(f.sends) != 1 || f.sends[0] != want {
		t.Fatalf("want %q, got %q", want, f.sends)
	}
}

func TestChildFailureWakesLeadOnlyWhenRetryIsSpent(t *testing.T) {
	f := newFakeLead(t)
	h := newChildOutcomeHarness(t, 1)

	if err := HandleChildOutcome(h.ctx, h.workers[0], toolFlakeOutcome()); err != nil {
		t.Fatal(err)
	}
	if len(f.sends) != 0 {
		t.Fatalf("an automatically retried flake is not judgment, got %q", f.sends)
	}
	if err := HandleChildOutcome(h.ctx, h.workers[len(h.workers)-1], toolFlakeOutcome()); err != nil {
		t.Fatal(err)
	}

	want := "wake: task t-0 failed (tool_call_error), retry spent. wsh jarvis dag status"
	if len(f.sends) != 1 || f.sends[0] != want {
		t.Fatalf("want %q, got %q", want, f.sends)
	}
}

func TestMergeConflictWakesLead(t *testing.T) {
	f := newFakeLead(t)
	h := newNotifyHarness(t, 1, []waveobj.TaskNode{{ID: "t-0", Label: "a"}})

	if err := MarkBlockedMerge(h.ctx, h.dagID, h.loadDag(t).Tasks[0].RunID); err != nil {
		t.Fatal(err)
	}

	want := "wake: merge conflict landing lane ending at task t-0. git status"
	if len(f.sends) != 1 || f.sends[0] != want {
		t.Fatalf("want %q, got %q", want, f.sends)
	}
}

func TestRunFinishedWakesLeadOnce(t *testing.T) {
	f := newFakeLead(t)
	h := newNotifyHarness(t, 1, []waveobj.TaskNode{{ID: "t-0", Label: "a"}})
	h.finishTask(t, "t-0", jarvis.RunStatus_Done)

	for i := 0; i < 3; i++ {
		h.scheduleTimes(t, 1)
		f.settle(h.ctx)
	}

	if len(f.sends) != 1 || f.sends[0] != runFinishedWake {
		t.Fatalf("the finished run wakes the lead once, got %q", f.sends)
	}
}

func TestDoneChildAndOpenGateDoNotWakeLead(t *testing.T) {
	f := newFakeLead(t)
	h := newNotifyHarness(t, 1, []waveobj.TaskNode{{ID: "t-0", Label: "a", Gate: true}})
	h.finishTask(t, "t-0", jarvis.RunStatus_Done)

	h.scheduleTimes(t, 2)

	if got := h.loadDag(t).Status; got != DagStatus_AwaitingReview {
		t.Fatalf("setup: dag status = %q, want %q", got, DagStatus_AwaitingReview)
	}
	if len(f.sends) != 0 {
		t.Fatalf("a finished child and an open gate are not the lead's judgment, got %q", f.sends)
	}
}

func TestForwardTaskMovesPendingQuestionToUser(t *testing.T) {
	f := newFakeLead(t)
	h := newChildOutcomeHarness(t, 1)
	child, err := wstore.GetRun(h.ctx, h.channel, h.loadDag(t).Tasks[0].RunID)
	if err != nil {
		t.Fatal(err)
	}
	blocks := RunBlockORefs(h.ctx, child)
	if len(blocks) != 1 {
		t.Fatalf("setup: want the child's one worker block, got %q", blocks)
	}
	agentask.GlobalRegistry.Set(blocks[0], agentask.PendingAsk{
		AskId: "a1", Questions: []baseds.AgentAskQuestion{{Question: "which schema?"}}, Owner: agentask.AskOwner_Lead,
	})

	if err := ForwardTask(h.ctx, h.dagID, "t-0", "picking a schema is a product call"); err != nil {
		t.Fatal(err)
	}

	p, _ := agentask.GlobalRegistry.Get(blocks[0])
	if p.Owner != agentask.AskOwner_User || p.Note != "picking a schema is a product call" || p.RunId != h.runID || p.TaskId != "t-0" {
		t.Fatalf("the forwarded question belongs to the user, with the lead's note and its task, got %+v", p)
	}
	if f.countKind(waveobj.RunEventKindTaskForwarded) != 1 {
		t.Fatalf("want one task-forwarded row, got %+v", f.rows)
	}
}

func TestForwardTaskRecordsFailedTask(t *testing.T) {
	f := newFakeLead(t)
	h := newNotifyHarness(t, 1, []waveobj.TaskNode{{ID: "t-0", Label: "a"}})
	h.finishTask(t, "t-0", jarvis.RunStatus_Blocked)
	h.scheduleTimes(t, 1)

	if err := ForwardTask(h.ctx, h.dagID, "t-0", "the test needs a staging key only the human has"); err != nil {
		t.Fatal(err)
	}

	if f.countKind(waveobj.RunEventKindTaskForwarded) != 1 {
		t.Fatalf("a forwarded failure lands on the timeline, got %+v", f.rows)
	}
}

func TestForwardTaskRejectsNothingToForward(t *testing.T) {
	newFakeLead(t)
	h := newNotifyHarness(t, 1, []waveobj.TaskNode{{ID: "t-0", Label: "a"}})

	if err := ForwardTask(h.ctx, h.dagID, "t-0", "over to you"); err == nil {
		t.Fatal("a running task with no question has nothing to forward")
	}
	h.finishTask(t, "t-0", jarvis.RunStatus_Blocked)
	h.scheduleTimes(t, 1)
	if err := ForwardTask(h.ctx, h.dagID, "t-0", "  "); err == nil {
		t.Fatal("a forward without a note tells the human nothing")
	}
}
