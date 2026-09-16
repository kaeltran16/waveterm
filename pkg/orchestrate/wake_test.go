// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

const (
	wakeChannel   = "ch-1"
	wakeRun       = "run-1"
	wakeLeadBlock = "5b1e0a52-2d5c-4c3b-9d8e-0f3b7c1a9e01"
	wakeLeadTab   = "7c2f1b63-3e6d-4d4c-8e9f-1a4c8d2b0f12"
	finishedLine  = "wake: run finished. wsh jarvis dag status"
)

// the engine and merge fixtures build store-backed runs with a dag and no lead worker; each of their
// judgment events would otherwise start a real launch goroutine that outlives its test
func init() {
	launchLeadFn = func(context.Context, string, string, string) {}
}

// stubLaunch records the wakes each started lead was launched with. The launch stays open until the test
// settles it with leadLaunched.
func stubLaunch(t *testing.T) *[]string {
	t.Helper()
	var launched []string
	old := launchLeadFn
	launchLeadFn = func(_ context.Context, _, _, wake string) { launched = append(launched, wake) }
	t.Cleanup(func() { launchLeadFn = old })
	return &launched
}

const failedLine = "wake: task t-1 failed (tests), retry spent. wsh jarvis dag status"

// fakeLead scripts the lead's block and records what the adapter typed and appended.
type fakeLead struct {
	state leadState
	sends []string // "" is Enter alone
	rows  []map[string]any
	now   int64
}

func newFakeLead(t *testing.T) *fakeLead {
	t.Helper()
	f := &fakeLead{
		state: leadState{BlockId: wakeLeadBlock, TabId: wakeLeadTab, Alive: true, State: baseds.AgentState_Idle},
		now:   1_000_000,
	}
	origWakes, origState, origSend, origNow, origAppend, origReg := wakes, leadStateFn, sendWakeFn, wakeNow, appendRunEvent, agentask.GlobalRegistry
	wakes = newWaker()
	agentask.GlobalRegistry = agentask.MakeRegistry()
	leadStateFn = func(context.Context, string, string) leadState { return f.state }
	sendWakeFn = func(_ string, text string) { f.sends = append(f.sends, text) }
	wakeNow = func() int64 { return f.now }
	appendRunEvent = func(_ context.Context, _, _, kind string, _ *int, detail any) {
		row := map[string]any{"eventkind": kind}
		if d, ok := detail.(map[string]any); ok {
			for k, v := range d {
				row[k] = v
			}
		}
		f.rows = append(f.rows, row)
	}
	t.Cleanup(func() {
		wakes, leadStateFn, sendWakeFn, wakeNow, appendRunEvent, agentask.GlobalRegistry = origWakes, origState, origSend, origNow, origAppend, origReg
	})
	return f
}

// status moves the scripted lead to state and returns the event its hook would publish.
func (f *fakeLead) status(state string) *wps.WaveEvent {
	f.state.State = state
	oref := waveobj.MakeORef(waveobj.OType_Block, wakeLeadBlock).String()
	return &wps.WaveEvent{Event: wps.Event_AgentStatus, Data: baseds.AgentStatusData{ORef: oref, State: state}}
}

func (f *fakeLead) countKind(kind string) int {
	n := 0
	for _, r := range f.rows {
		if r["eventkind"] == kind {
			n++
		}
	}
	return n
}

func seedLeadAsk(oref, askId string, questions int) {
	qs := make([]baseds.AgentAskQuestion, questions)
	for i := range qs {
		qs[i] = baseds.AgentAskQuestion{Question: "which way?", Options: []baseds.AgentAskOption{{Label: "A"}, {Label: "B"}}}
	}
	agentask.GlobalRegistry.Set(oref, agentask.PendingAsk{
		AskId: askId, BlockId: "child", Questions: qs,
		Owner: agentask.AskOwner_Lead, ChannelId: wakeChannel, RunId: wakeRun, TaskId: "t-0", DagOID: "dag-1",
	})
}

func TestWakeSendsToIdleLead(t *testing.T) {
	f := newFakeLead(t)
	PostWake(context.Background(), wakeChannel, wakeRun, finishedLine)
	if len(f.sends) != 1 || f.sends[0] != finishedLine {
		t.Fatalf("an idle lead gets the wake at once, got %q", f.sends)
	}
	if f.countKind(waveobj.RunEventKindLeadWoken) != 1 {
		t.Fatalf("a sent wake records one lead-woken row, got %+v", f.rows)
	}
}

func TestWakeTreatsWaitingAsAtPrompt(t *testing.T) {
	f := newFakeLead(t)
	f.state.State = baseds.AgentState_Waiting
	PostWake(context.Background(), wakeChannel, wakeRun, finishedLine)
	if len(f.sends) != 1 {
		t.Fatalf("a Claude lead idle past a minute reports waiting and must still be woken, got %q", f.sends)
	}
}

func TestWakeJoinsEventsHeldForBusyLead(t *testing.T) {
	f := newFakeLead(t)
	ctx := context.Background()
	for _, state := range []string{baseds.AgentState_Working, baseds.AgentState_Asking} {
		f.state.State = state
		PostWake(ctx, wakeChannel, wakeRun, "wake: task t-1 failed (tests), retry spent. wsh jarvis dag status")
		if len(f.sends) != 0 {
			t.Fatalf("a %s lead gets nothing yet, got %q", state, f.sends)
		}
	}
	PostWake(ctx, wakeChannel, wakeRun, "wake: merge conflict landing task t-2. git status")
	NoteLeadStatus(ctx, f.status(baseds.AgentState_Idle))
	want := "wake: task t-1 failed (tests), retry spent. wsh jarvis dag status\n" +
		"wake: task t-1 failed (tests), retry spent. wsh jarvis dag status\n" +
		"wake: merge conflict landing task t-2. git status"
	if len(f.sends) != 1 || f.sends[0] != want {
		t.Fatalf("held events go out as one message when the lead goes idle, got %q", f.sends)
	}
}

func TestWakeConfirmedByWorkingIsNotRetried(t *testing.T) {
	f := newFakeLead(t)
	ctx := context.Background()
	PostWake(ctx, wakeChannel, wakeRun, finishedLine)
	PostWake(ctx, wakeChannel, wakeRun, "wake: second")
	if len(f.sends) != 1 {
		t.Fatalf("no second wake while one is outstanding, got %q", f.sends)
	}
	NoteLeadStatus(ctx, f.status(baseds.AgentState_Working))
	f.now += 3 * WakeConfirmTimeout.Milliseconds()
	tickWakes(ctx)
	if len(f.sends) != 1 {
		t.Fatalf("a confirmed wake is never retried, got %q", f.sends)
	}
	NoteLeadStatus(ctx, f.status(baseds.AgentState_Idle))
	if len(f.sends) != 2 || f.sends[1] != "wake: second" {
		t.Fatalf("the held event goes out when the lead is idle again, got %q", f.sends)
	}
}

func TestWakeRetriesOnceThenLeadIsDead(t *testing.T) {
	f := newFakeLead(t)
	ctx := context.Background()
	PostWake(ctx, wakeChannel, wakeRun, finishedLine)

	f.now += WakeConfirmTimeout.Milliseconds()
	tickWakes(ctx)
	if len(f.sends) != 2 || f.sends[1] != "" {
		t.Fatalf("the single retry presses Enter alone, got %q", f.sends)
	}
	if LeadDead(wakeRun) {
		t.Fatal("one unconfirmed wake is not a dead lead")
	}

	f.now += WakeConfirmTimeout.Milliseconds()
	tickWakes(ctx)
	if !LeadDead(wakeRun) || len(f.sends) != 2 {
		t.Fatalf("an unconfirmed retry makes the lead dead with no further sends, dead=%v sends=%q", LeadDead(wakeRun), f.sends)
	}
	if f.countKind(waveobj.RunEventKindLeadWakeFailed) != 1 {
		t.Fatalf("want one lead-wake-failed row, got %+v", f.rows)
	}

	PostWake(ctx, wakeChannel, wakeRun, "wake: merge conflict landing task t-2. git status")
	if len(f.sends) != 2 || f.countKind(waveobj.RunEventKindLeadWakeFailed) != 2 {
		t.Fatalf("a dead lead's events go on the timeline, not into its terminal: sends=%q rows=%+v", f.sends, f.rows)
	}

	NoteLeadStatus(ctx, f.status(baseds.AgentState_Working))
	if LeadDead(wakeRun) {
		t.Fatal("a lead that reports working is taking wakes again")
	}
}

func TestWakeToExitedLeadMovesQuestionsToUser(t *testing.T) {
	f := newFakeLead(t)
	f.state.Alive = false
	seedLeadAsk("block:child-1", "a1", 1)

	PokeWake(context.Background(), wakeChannel, wakeRun)

	if len(f.sends) != 0 || !LeadDead(wakeRun) {
		t.Fatalf("an exited lead is dead and gets nothing typed, dead=%v sends=%q", LeadDead(wakeRun), f.sends)
	}
	p, _ := agentask.GlobalRegistry.Get("block:child-1")
	if p.Owner != agentask.AskOwner_User || p.Note != leadNotRunningNote {
		t.Fatalf("a dead lead's questions move to the user with the reason, got %+v", p)
	}
	if f.countKind(waveobj.RunEventKindTaskForwarded) != 1 {
		t.Fatalf("want one task-forwarded row, got %+v", f.rows)
	}
}

func TestWakeAnnouncesEachQuestionOnce(t *testing.T) {
	f := newFakeLead(t)
	ctx := context.Background()
	seedLeadAsk("block:child-1", "a1", 1)
	PokeWake(ctx, wakeChannel, wakeRun)
	if len(f.sends) != 1 || f.sends[0] != "wake: 1 question waiting. wsh jarvis dag asks" {
		t.Fatalf("want the one-question line, got %q", f.sends)
	}

	NoteLeadStatus(ctx, f.status(baseds.AgentState_Working))
	NoteLeadStatus(ctx, f.status(baseds.AgentState_Idle))
	if len(f.sends) != 1 {
		t.Fatalf("an announced question does not wake the lead again, got %q", f.sends)
	}

	seedLeadAsk("block:child-2", "a2", 2)
	PokeWake(ctx, wakeChannel, wakeRun)
	if len(f.sends) != 2 || f.sends[1] != "wake: 3 questions waiting. wsh jarvis dag asks" {
		t.Fatalf("a new ask wakes the lead with the queue's question count, got %q", f.sends)
	}
}

func TestWakeReannouncesRestoredQuestion(t *testing.T) {
	f := newFakeLead(t)
	ctx := context.Background()
	seedLeadAsk("block:child-1", "a1", 1)
	PokeWake(ctx, wakeChannel, wakeRun)
	NoteLeadStatus(ctx, f.status(baseds.AgentState_Working))
	agentask.GlobalRegistry.Update("block:child-1", "a1", func(p *agentask.PendingAsk) { p.Misses = 1 })

	NoteLeadStatus(ctx, f.status(baseds.AgentState_Idle))

	if len(f.sends) != 2 {
		t.Fatalf("a question back after a failed delivery is announced again, got %q", f.sends)
	}
}

func TestHandoffTypedAloneOnceTheLeadIsAtItsPrompt(t *testing.T) {
	f := newFakeLead(t)
	ctx := context.Background()
	// the lead is still in the turn that ran `dag submit`
	f.state.State = baseds.AgentState_Working
	PostHandoff(ctx, wakeChannel, wakeRun)
	PostWake(ctx, wakeChannel, wakeRun, finishedLine)
	if len(f.sends) != 0 {
		t.Fatalf("a working lead gets nothing yet, got %q", f.sends)
	}

	NoteLeadStatus(ctx, f.status(baseds.AgentState_Idle))
	if len(f.sends) != 1 || f.sends[0] != HandoffCompact {
		t.Fatalf("the handoff compaction goes out first and alone, got %q", f.sends)
	}
	if f.countKind(waveobj.RunEventKindLeadWoken) != 1 {
		t.Fatalf("the handoff records one lead-woken row, got %+v", f.rows)
	}

	// PreCompact reports working, and the SessionStart after the compaction reports idle
	NoteLeadStatus(ctx, f.status(baseds.AgentState_Working))
	NoteLeadStatus(ctx, f.status(baseds.AgentState_Idle))
	if len(f.sends) != 2 || f.sends[1] != finishedLine {
		t.Fatalf("the held wake follows once the compaction is over, got %q", f.sends)
	}
}

func TestHandoffUnconfirmedIsRetriedLikeAWake(t *testing.T) {
	f := newFakeLead(t)
	ctx := context.Background()
	PostHandoff(ctx, wakeChannel, wakeRun)
	if len(f.sends) != 1 || f.sends[0] != HandoffCompact {
		t.Fatalf("an idle lead gets the handoff at once, got %q", f.sends)
	}
	f.now += WakeConfirmTimeout.Milliseconds()
	tickWakes(ctx)
	if len(f.sends) != 2 || f.sends[1] != "" {
		t.Fatalf("an unconfirmed handoff is retried with Enter alone, got %q", f.sends)
	}
	NoteLeadStatus(ctx, f.status(baseds.AgentState_Working))
	f.now += 3 * WakeConfirmTimeout.Milliseconds()
	tickWakes(ctx)
	if len(f.sends) != 2 || LeadDead(wakeRun) {
		t.Fatalf("a confirmed handoff is done, sends=%q dead=%v", f.sends, LeadDead(wakeRun))
	}
}

func TestNoLeadRunLaunchesItsLeadAtTheFirstJudgmentEvent(t *testing.T) {
	f := newFakeLead(t)
	f.state = leadState{NoLead: true}
	launched := stubLaunch(t)

	PostWake(context.Background(), wakeChannel, wakeRun, failedLine)

	if len(*launched) != 1 || (*launched)[0] != failedLine {
		t.Fatalf("the first judgment event launches the lead with the wake as its first message, got %q", *launched)
	}
	if len(f.sends) != 0 || LeadDead(wakeRun) {
		t.Fatalf("a lead never launched is not dead and gets nothing typed, dead=%v sends=%q", LeadDead(wakeRun), f.sends)
	}
	if f.countKind(waveobj.RunEventKindLeadLaunched) != 1 || f.countKind(waveobj.RunEventKindLeadWakeFailed) != 0 {
		t.Fatalf("want one lead-launched row and no lead-wake-failed row, got %+v", f.rows)
	}
}

func TestNoLeadQuestionLaunchesTheLeadAndStaysItsQuestion(t *testing.T) {
	f := newFakeLead(t)
	f.state = leadState{NoLead: true}
	launched := stubLaunch(t)
	seedLeadAsk("block:child-1", "a1", 1)

	PokeWake(context.Background(), wakeChannel, wakeRun)

	if len(*launched) != 1 || (*launched)[0] != "wake: 1 question waiting. wsh jarvis dag asks" {
		t.Fatalf("a question launches the lead with the question line, got %q", *launched)
	}
	if p, _ := agentask.GlobalRegistry.Get("block:child-1"); p.Owner != agentask.AskOwner_Lead {
		t.Fatalf("a question raised before the lead exists is still the lead's, got %+v", p)
	}
}

// decision 1: nobody has a judgment to make about a clean finish, and the engine closes the run itself
func TestCleanFinishWithNoLeadLaunchesNothing(t *testing.T) {
	f := newFakeLead(t)
	f.state = leadState{NoLead: true}
	launched := stubLaunch(t)

	PostWake(context.Background(), wakeChannel, wakeRun, finishedLine)

	if len(*launched) != 0 || len(f.rows) != 0 || LeadDead(wakeRun) {
		t.Fatalf("a clean finish starts no lead and records nothing: launched=%q rows=%+v dead=%v", *launched, f.rows, LeadDead(wakeRun))
	}
}

func TestEventsDuringALaunchWaitForTheLead(t *testing.T) {
	f := newFakeLead(t)
	f.state = leadState{NoLead: true}
	launched := stubLaunch(t)
	ctx := context.Background()

	PostWake(ctx, wakeChannel, wakeRun, failedLine)
	PostWake(ctx, wakeChannel, wakeRun, finishedLine)
	tickWakes(ctx)
	if len(*launched) != 1 {
		t.Fatalf("one launch per lead while it starts, got %q", *launched)
	}

	f.state = leadState{BlockId: wakeLeadBlock, TabId: wakeLeadTab, Alive: true, State: baseds.AgentState_Idle}
	leadLaunched(ctx, wakeChannel, wakeRun, nil)
	tickWakes(ctx)

	if len(f.sends) != 1 || f.sends[0] != finishedLine {
		t.Fatalf("an event held while the lead started is typed once it is at its prompt, got %q", f.sends)
	}
}

func TestFailedLaunchHandsJudgmentToTheUser(t *testing.T) {
	f := newFakeLead(t)
	f.state = leadState{NoLead: true}
	stubLaunch(t)
	ctx := context.Background()
	seedLeadAsk("block:child-1", "a1", 1)
	PokeWake(ctx, wakeChannel, wakeRun)

	leadLaunched(ctx, wakeChannel, wakeRun, errors.New("no route for pi"))

	if !LeadDead(wakeRun) {
		t.Fatal("a lead that could not be started takes no wakes")
	}
	p, _ := agentask.GlobalRegistry.Get("block:child-1")
	if p.Owner != agentask.AskOwner_User || !strings.Contains(p.Note, leadLaunchFailedNote) || !strings.Contains(p.Note, "no route for pi") {
		t.Fatalf("its questions go to the user with why, got %+v", p)
	}
	if f.countKind(waveobj.RunEventKindLeadWakeFailed) != 1 {
		t.Fatalf("want one lead-wake-failed row, got %+v", f.rows)
	}
}
