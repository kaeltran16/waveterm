// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package boarddrawer

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	drawAnswer  = `{"reply":"Two processes.","title":"wavesrv, opened up","add":[{"type":"rectangle","id":"a","x":0,"y":300,"width":10,"height":10},{"type":"text","id":"b","x":0,"y":340,"text":"x"}],"update":[{"id":"box","x":40}]}`
	wordsAnswer = `{"reply":"Nothing to draw."}`
	emptyBoard  = `{"type":"excalidraw","elements":[]}`
)

var board = Board{ChannelId: "c1", BoardId: "b1", Name: "Board talk", ProjectPath: "/repo"}

// fake is the store, the board files and the model behind a Drawer under test.
type fake struct {
	mu        sync.Mutex
	talks     map[string]wshrpc.BoardTalk
	files     map[string]string
	delivered []wshrpc.BoardAnswer
	published []wshrpc.BoardUpdateData
	calls     []Call
	reads     []int64
	active    int
	maxActive int
	ids       int
	run       func(ctx context.Context, c Call) (string, error)
}

func newFake(run func(ctx context.Context, c Call) (string, error)) *fake {
	return &fake{
		talks: map[string]wshrpc.BoardTalk{},
		files: map[string]string{"b1": sceneFile, "b0": emptyBoard},
		run:   run,
	}
}

func cloneTalk(t wshrpc.BoardTalk) wshrpc.BoardTalk {
	t.Turns = slices.Clone(t.Turns)
	if t.Handoff != nil {
		h := *t.Handoff
		t.Handoff = &h
	}
	return t
}

func (f *fake) deps() Deps {
	return Deps{
		LoadTalk: func(b Board) (wshrpc.BoardTalk, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			return cloneTalk(f.talks[b.BoardId]), nil
		},
		UpdateTalk: func(b Board, fn func(*wshrpc.BoardTalk) error) (wshrpc.BoardTalk, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			talk := cloneTalk(f.talks[b.BoardId])
			if err := fn(&talk); err != nil {
				return wshrpc.BoardTalk{}, err
			}
			f.talks[b.BoardId] = talk
			return cloneTalk(talk), nil
		},
		ReadBoard: func(b Board) ([]byte, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			file, ok := f.files[b.BoardId]
			if !ok {
				return nil, errors.New("no such file")
			}
			return []byte(file), nil
		},
		ReadThing: func(ctx context.Context, src wshrpc.BoardSource, sinceTs int64) (string, string, int64, error) {
			f.mu.Lock()
			f.reads = append(f.reads, sinceTs)
			f.mu.Unlock()
			return "the agent's turn text", "the whole session", 0, nil
		},
		Deliver: func(a wshrpc.BoardAnswer) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.delivered = append(f.delivered, a)
			return nil
		},
		Publish: func(u wshrpc.BoardUpdateData) {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.published = append(f.published, u)
		},
		Run: func(ctx context.Context, cwd string, c Call) (string, error) {
			f.mu.Lock()
			f.calls = append(f.calls, c)
			f.active++
			f.maxActive = max(f.maxActive, f.active)
			f.mu.Unlock()
			defer func() {
				f.mu.Lock()
				f.active--
				f.mu.Unlock()
			}()
			if cwd != board.ProjectPath {
				return "", fmt.Errorf("cwd %q", cwd)
			}
			return f.run(ctx, c)
		},
		Now: func() int64 { return 1000 },
		NewId: func() string {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.ids++
			return fmt.Sprintf("id-%d", f.ids)
		},
	}
}

func (f *fake) talk(boardId string) wshrpc.BoardTalk {
	f.mu.Lock()
	defer f.mu.Unlock()
	return cloneTalk(f.talks[boardId])
}

func (f *fake) callList() []Call {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

func (f *fake) deliveredCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.delivered)
}

func reply(s string) func(context.Context, Call) (string, error) {
	return func(context.Context, Call) (string, error) { return s, nil }
}

// gated blocks every run until release is closed, or its ctx ends.
func gated(release <-chan struct{}, s string) func(context.Context, Call) (string, error) {
	return func(ctx context.Context, c Call) (string, error) {
		select {
		case <-release:
			return s, nil
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// settled waits until the drawer is idle on board and returns the talk.
func settled(t *testing.T, f *fake, d *Drawer) wshrpc.BoardTalk {
	t.Helper()
	waitFor(t, "the drawer to finish", func() bool { return !d.Busy(board.ChannelId, board.BoardId) })
	return f.talk(board.BoardId)
}

func question(q string) wshrpc.BoardTurn { return wshrpc.BoardTurn{Question: q} }

func TestDrawerFirstTurnThenResume(t *testing.T) {
	f := newFake(reply(drawAnswer))
	f.talks["b1"] = wshrpc.BoardTalk{ChannelId: "c1", BoardId: "b1", About: wshrpc.BoardSource{Kind: "agent", Ref: "t1", Title: "claude · waveterm"}}
	d := New(f.deps())
	turn, err := d.Ask(board, wshrpc.BoardTurn{Question: "How does it work?", On: "wavesrv", SelectedIds: []string{"box"}})
	if err != nil || turn.ID == "" || turn.Ts != 1000 || turn.State != StateAnswering {
		t.Fatalf("ask: %+v %v", turn, err)
	}
	talk := settled(t, f, d)
	got := talk.Turns[0]
	if got.State != StateAnswered || got.Reply != "Two processes." || got.Title != "wavesrv, opened up" ||
		got.Added != 2 || got.Changed != 1 || got.Removed != 0 || got.AnsweredTs != 1000 {
		t.Errorf("first turn: %+v", got)
	}
	calls := f.callList()
	if len(calls) != 1 || calls[0].Resume || calls[0].SessionId == "" || calls[0].SessionId != talk.SessionId {
		t.Fatalf("first call: %+v, session %q", calls, talk.SessionId)
	}
	for _, want := range []string{"## Your reply", "the agent's turn text", "How does it work?", `"selected":true`} {
		if !strings.Contains(calls[0].Prompt, want) {
			t.Errorf("first prompt lacks %q", want)
		}
	}
	if len(f.reads) != 1 || f.reads[0] != 0 {
		t.Errorf("the thing must be read once from the start: %v", f.reads)
	}
	if len(f.delivered) != 1 || f.delivered[0].TurnId != turn.ID || f.delivered[0].Add == "" || f.delivered[0].Update == "" {
		t.Errorf("delivered: %+v", f.delivered)
	}

	if _, err := d.Ask(board, question("And the store?")); err != nil {
		t.Fatal(err)
	}
	talk = settled(t, f, d)
	calls = f.callList()
	if len(calls) != 2 || !calls[1].Resume || calls[1].Fork || calls[1].SessionId != calls[0].SessionId {
		t.Fatalf("follow-up call: %+v", calls)
	}
	if strings.Contains(calls[1].Prompt, "## Your reply") || !strings.Contains(calls[1].Prompt, "And the store?") {
		t.Errorf("follow-up prompt must be the turn alone:\n%s", calls[1].Prompt)
	}
	if len(f.reads) != 1 {
		t.Errorf("a follow-up must not read the thing again: %v", f.reads)
	}
	if talk.Turns[1].State != StateAnswered || talk.SessionId != calls[0].SessionId {
		t.Errorf("second turn: %+v", talk)
	}
	var whats []string
	for _, u := range f.published {
		whats = append(whats, u.What+":"+u.State)
	}
	want := []string{"talk:answering", "talk:answered", "answer:", "talk:answering", "talk:answered", "answer:"}
	if !slices.Equal(whats, want) {
		t.Errorf("published %v, want %v", whats, want)
	}
}

func TestDrawerRefusesAskWhileBusy(t *testing.T) {
	release := make(chan struct{})
	f := newFake(gated(release, drawAnswer))
	d := New(f.deps())
	if _, err := d.Ask(board, question("first")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the first run", func() bool { return len(f.callList()) == 1 })
	if _, err := d.Ask(board, question("second")); err == nil || err.Error() != BusyReason {
		t.Fatalf("want %q, got %v", BusyReason, err)
	}
	if n := len(f.talk("b1").Turns); n != 1 {
		t.Errorf("a refused ask must add no turn, got %d turns", n)
	}
	other := Board{ChannelId: "c1", BoardId: "b0", Name: "Other", ProjectPath: "/repo"}
	if _, err := d.Ask(other, question("elsewhere")); err != nil {
		t.Errorf("another board must not be busy: %v", err)
	}
	close(release)
	settled(t, f, d)
	waitFor(t, "the other board", func() bool { return !d.Busy("c1", "b0") })
}

func TestDrawerBriefingQueuesBehindTurn(t *testing.T) {
	release := make(chan struct{})
	f := newFake(gated(release, drawAnswer))
	d := New(f.deps())
	if _, err := d.Ask(board, question("first")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the first run", func() bool { return len(f.callList()) == 1 })
	brief := &wshrpc.BoardBriefing{From: "claude · waveterm", Text: "facts", Ask: "Draw the store."}
	queued, err := d.Ask(board, wshrpc.BoardTurn{Question: brief.Ask, Briefing: brief})
	if err != nil || queued.State != StateWaiting {
		t.Fatalf("a briefing must queue, got %+v %v", queued, err)
	}
	if got := f.talk("b1").Turns[1].State; got != StateWaiting {
		t.Errorf("queued turn saved as %q", got)
	}
	if n := len(f.callList()); n != 1 {
		t.Errorf("the briefing must not start a second session while a turn runs, %d calls", n)
	}
	close(release)
	talk := settled(t, f, d)
	if talk.Turns[0].State != StateAnswered || talk.Turns[1].State != StateAnswered {
		t.Errorf("turns: %+v", talk.Turns)
	}
	if f.maxActive != 1 {
		t.Errorf("never two sessions on one board at once, saw %d", f.maxActive)
	}
	calls := f.callList()
	if len(calls) != 2 || !calls[1].Resume || !strings.Contains(calls[1].Prompt, elsewhereMarker) {
		t.Errorf("the briefing runs next, resumed, and may answer elsewhere: %+v", calls)
	}
	var briefStates []string
	for _, u := range f.published {
		if u.TurnId == queued.ID && u.What == updateTalk {
			briefStates = append(briefStates, u.State)
			if u.From != brief.From {
				t.Errorf("a briefing turn's update must carry From, got %+v", u)
			}
		}
	}
	if !slices.Equal(briefStates, []string{StateWaiting, StateAnswering, StateAnswered}) {
		t.Errorf("briefing states published: %v", briefStates)
	}
}

func TestDrawerStopLeavesBoardUnchanged(t *testing.T) {
	f := newFake(gated(make(chan struct{}), drawAnswer))
	d := New(f.deps())
	if err := d.Stop(board); err == nil {
		t.Errorf("stop on an idle board must say so")
	}
	if _, err := d.Ask(board, question("q")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the run", func() bool { return len(f.callList()) == 1 })
	if err := d.Stop(board); err != nil {
		t.Fatal(err)
	}
	talk := settled(t, f, d)
	if talk.Turns[0].State != StateStopped || talk.Turns[0].Reason != "" {
		t.Errorf("turn: %+v", talk.Turns[0])
	}
	if f.deliveredCount() != 0 {
		t.Errorf("a stopped turn delivers nothing")
	}
	if talk.SessionId != "" {
		t.Errorf("a stopped first turn must leave no session to resume, got %q", talk.SessionId)
	}
}

func TestDrawerStopAfterDeliverStaysAnswered(t *testing.T) {
	f := newFake(reply(drawAnswer))
	deps := f.deps()
	var d *Drawer
	deliver := deps.Deliver
	deps.Deliver = func(a wshrpc.BoardAnswer) error {
		if err := deliver(a); err != nil {
			return err
		}
		// Stop lands once the answer is already in the inbox
		return d.Stop(board)
	}
	d = New(deps)
	turn, err := d.Ask(board, question("q"))
	if err != nil {
		t.Fatal(err)
	}
	talk := settled(t, f, d)
	if talk.Turns[0].State != StateAnswered || f.deliveredCount() != 1 {
		t.Fatalf("a delivered answer must end answered: %+v, delivered %d", talk.Turns[0], f.deliveredCount())
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if !slices.ContainsFunc(f.published, func(u wshrpc.BoardUpdateData) bool { return u.What == updateAnswer && u.TurnId == turn.ID }) {
		t.Errorf("the delivered answer must be published: %+v", f.published)
	}
}

func TestDrawerRetryReasks(t *testing.T) {
	fail := true
	f := newFake(nil)
	f.run = func(ctx context.Context, c Call) (string, error) {
		if fail {
			return "", errors.New("the drawer's session exited before it replied (exit status 1)")
		}
		return drawAnswer, nil
	}
	d := New(f.deps())
	turn, err := d.Ask(board, question("Why two?"))
	if err != nil {
		t.Fatal(err)
	}
	talk := settled(t, f, d)
	if talk.Turns[0].State != StateFailed || !strings.Contains(talk.Turns[0].Reason, "exited before it replied") {
		t.Fatalf("turn: %+v", talk.Turns[0])
	}
	if err := d.Retry(board, "nope"); err == nil {
		t.Errorf("retry of an unknown turn must fail")
	}
	fail = false
	if err := d.Retry(board, turn.ID); err != nil {
		t.Fatal(err)
	}
	talk = settled(t, f, d)
	if len(talk.Turns) != 1 || talk.Turns[0].State != StateAnswered || talk.Turns[0].Reason != "" {
		t.Errorf("retried turn: %+v", talk.Turns)
	}
	calls := f.callList()
	if len(calls) != 2 || calls[1].Resume || !strings.Contains(calls[1].Prompt, "Why two?") || !strings.Contains(calls[1].Prompt, "## Your reply") {
		t.Errorf("a first turn that never answered starts its session again on retry: %+v", calls)
	}
	if err := d.Retry(board, turn.ID); err == nil {
		t.Errorf("an answered turn cannot be retried")
	}
}

func TestDrawerResumeFailureFailsTurn(t *testing.T) {
	f := newFake(nil)
	f.run = func(ctx context.Context, c Call) (string, error) {
		if c.Resume {
			return "", errors.New("the drawer's session exited before it replied (API Error: 529 overloaded)")
		}
		return wordsAnswer, nil
	}
	d := New(f.deps())
	if _, err := d.Ask(board, question("first")); err != nil {
		t.Fatal(err)
	}
	session := settled(t, f, d).SessionId
	if _, err := d.Ask(board, question("second")); err != nil {
		t.Fatal(err)
	}
	talk := settled(t, f, d)
	if talk.Turns[1].State != StateFailed || !strings.Contains(talk.Turns[1].Reason, "529 overloaded") {
		t.Errorf("turn: %+v", talk.Turns[1])
	}
	if n := len(f.callList()); n != 2 {
		t.Errorf("a failed resume is never retried silently, %d calls", n)
	}
	if talk.SessionId != session {
		t.Errorf("a failed resume must keep the session, got %q want %q", talk.SessionId, session)
	}
}

// claude cleans up old session transcripts, and a session it no longer has can never be resumed
func TestDrawerLostSessionStartsNew(t *testing.T) {
	f := newFake(nil)
	f.talks["b1"] = wshrpc.BoardTalk{ChannelId: "c1", BoardId: "b1", About: wshrpc.BoardSource{Kind: "agent", Ref: "t1", Title: "claude · waveterm"}}
	lost := ""
	f.run = func(ctx context.Context, c Call) (string, error) {
		if c.Resume && c.SessionId == lost {
			return "", errors.New("the drawer's session exited before it replied (No conversation found with session ID: " + lost + ")")
		}
		return drawAnswer, nil
	}
	d := New(f.deps())
	if _, err := d.Ask(board, question("first")); err != nil {
		t.Fatal(err)
	}
	// the drawer is idle once settled, so the next run reads lost after this write
	lost = settled(t, f, d).SessionId
	if _, err := d.Ask(board, question("second")); err != nil {
		t.Fatal(err)
	}
	talk := settled(t, f, d)
	if talk.Turns[1].State != StateAnswered || talk.Turns[1].Reply != "Two processes." {
		t.Errorf("the turn must be answered by a new session: %+v", talk.Turns[1])
	}
	calls := f.callList()
	if len(calls) != 3 || !calls[1].Resume || calls[2].Resume || calls[2].SessionId == lost || calls[2].SessionId == "" {
		t.Fatalf("want a first call, the failed resume, then a new session: %+v", calls)
	}
	if talk.SessionId != calls[2].SessionId {
		t.Errorf("the talk must keep the new session, got %q want %q", talk.SessionId, calls[2].SessionId)
	}
	for _, want := range []string{"## Your reply", "the agent's turn text", "second"} {
		if !strings.Contains(calls[2].Prompt, want) {
			t.Errorf("the new session's prompt lacks %q", want)
		}
	}
	if f.deliveredCount() != 2 {
		t.Errorf("delivered %d answers, want 2", f.deliveredCount())
	}
}

func TestDrawerUnusableAnswerFails(t *testing.T) {
	f := newFake(reply(`{"reply":"ok","title":"t","update":[{"id":"nope","x":1}]}`))
	d := New(f.deps())
	if _, err := d.Ask(board, question("q")); err != nil {
		t.Fatal(err)
	}
	talk := settled(t, f, d)
	if talk.Turns[0].State != StateFailed || !strings.HasPrefix(talk.Turns[0].Reason, unusableHead) {
		t.Errorf("turn: %+v", talk.Turns[0])
	}
	if f.deliveredCount() != 0 {
		t.Errorf("an unusable answer delivers nothing")
	}
	f.files["b1"] = `{"elements":[`
	f.run = reply(drawAnswer)
	if err := d.Retry(board, talk.Turns[0].ID); err != nil {
		t.Fatal(err)
	}
	talk = settled(t, f, d)
	if !strings.HasPrefix(talk.Turns[0].Reason, wontOpenHead) {
		t.Errorf("a board file that won't open fails the turn: %+v", talk.Turns[0])
	}
}

func TestDrawerBrokenFileFirstTurnKeepsNoSession(t *testing.T) {
	f := newFake(reply(drawAnswer))
	f.files["b1"] = `{"elements":[`
	d := New(f.deps())
	if _, err := d.Ask(board, question("q")); err != nil {
		t.Fatal(err)
	}
	talk := settled(t, f, d)
	if talk.Turns[0].State != StateFailed || !strings.HasPrefix(talk.Turns[0].Reason, wontOpenHead) {
		t.Errorf("turn: %+v", talk.Turns[0])
	}
	if talk.SessionId != "" {
		t.Errorf("a first turn that never ran must leave no session, got %q", talk.SessionId)
	}
	f.files["b1"] = sceneFile
	if err := d.Retry(board, talk.Turns[0].ID); err != nil {
		t.Fatal(err)
	}
	settled(t, f, d)
	calls := f.callList()
	if len(calls) != 1 || calls[0].Resume || !strings.Contains(calls[0].Prompt, "## Your reply") {
		t.Errorf("once the file opens, Retry starts the session with the first prompt: %+v", calls)
	}
}

func TestDrawerElsewhereAsks(t *testing.T) {
	f := newFake(reply(wordsAnswer))
	d := New(f.deps())
	if _, err := d.Ask(board, question("first")); err != nil {
		t.Fatal(err)
	}
	settled(t, f, d)
	f.run = reply(`{"reply":"This is about the store. Start a new board for it?","elsewhere":true}`)
	brief := &wshrpc.BoardBriefing{From: "claude · waveterm", Text: "facts", Ask: "Draw the store."}
	if _, err := d.Ask(board, wshrpc.BoardTurn{Question: brief.Ask, Briefing: brief}); err != nil {
		t.Fatal(err)
	}
	talk := settled(t, f, d)
	if talk.Turns[1].State != StateAsks || !strings.Contains(talk.Turns[1].Reply, "new board") {
		t.Errorf("turn: %+v", talk.Turns[1])
	}
	if f.deliveredCount() != 0 {
		t.Errorf("an asking turn delivers nothing")
	}

	// a briefing on a fresh board may not answer elsewhere
	fresh := Board{ChannelId: "c1", BoardId: "b0", Name: "Store", ProjectPath: "/repo"}
	if _, err := d.Ask(fresh, wshrpc.BoardTurn{Question: brief.Ask, Briefing: brief}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the fresh board", func() bool { return !d.Busy("c1", "b0") })
	if got := f.talk("b0").Turns[0]; got.State != StateFailed || !strings.Contains(got.Reason, "says elsewhere") {
		t.Errorf("fresh board briefing: %+v", got)
	}
}

func TestDrawerKeepRunsKeptTurn(t *testing.T) {
	brief := &wshrpc.BoardBriefing{From: "claude · waveterm", Text: "facts", Ask: "Draw the store."}
	f := newFake(reply(drawAnswer))
	f.talks["b1"] = wshrpc.BoardTalk{ChannelId: "c1", BoardId: "b1", SessionId: "s1", Turns: []wshrpc.BoardTurn{
		{ID: "t0", Ts: 1, Question: "first", State: StateAnswered},
		{ID: "t1", Ts: 2, Question: brief.Ask, Briefing: brief, State: StateAsks, Reply: "New board?"},
		{ID: "t2", Ts: 3, Question: brief.Ask, Briefing: brief, State: StateAsks, Reply: "New board?"},
	}}
	d := New(f.deps())
	if err := d.Choose(board, "t1", "maybe"); err == nil {
		t.Errorf("an unknown choice must be refused")
	}
	if err := d.Choose(board, "t0", ChoiceKeep); err == nil {
		t.Errorf("a turn that does not ask cannot be chosen on")
	}
	if err := d.Choose(board, "t1", ChoiceKeep); err != nil {
		t.Fatal(err)
	}
	talk := settled(t, f, d)
	if talk.Turns[1].Choice != ChoiceKeep || len(talk.Turns) != 4 {
		t.Fatalf("turns: %+v", talk.Turns)
	}
	kept := talk.Turns[3]
	if !kept.Kept || kept.Question != brief.Ask || kept.Briefing != nil || kept.State != StateAnswered {
		t.Errorf("kept turn: %+v", kept)
	}
	calls := f.callList()
	if len(calls) != 1 || !calls[0].Resume || !strings.Contains(calls[0].Prompt, "chose to keep it here") || strings.Contains(calls[0].Prompt, elsewhereMarker) {
		t.Errorf("kept call: %+v", calls)
	}
	if err := d.Choose(board, "t1", ChoiceNew); err == nil {
		t.Errorf("a turn already chosen on cannot be chosen again")
	}
	if err := d.Choose(board, "t2", ChoiceNew); err != nil {
		t.Fatal(err)
	}
	talk = f.talk("b1")
	if talk.Turns[2].Choice != ChoiceNew || len(talk.Turns) != 4 || len(f.callList()) != 1 {
		t.Errorf("new only records the choice: %+v", talk.Turns)
	}
}

func TestDrawerHandoffSummaryForks(t *testing.T) {
	f := newFake(nil)
	f.run = func(ctx context.Context, c Call) (string, error) {
		if c.Fork {
			return "  They asked how wavesrv stores boards.  ", nil
		}
		return drawAnswer, nil
	}
	earlier := wshrpc.BoardTalk{ChannelId: "c1", BoardId: "b0", SessionId: "old", Turns: []wshrpc.BoardTurn{{ID: "x", Question: "q", State: StateAnswered}}}
	f.talks["b0"] = earlier
	f.talks["b1"] = wshrpc.BoardTalk{ChannelId: "c1", BoardId: "b1", Handoff: &wshrpc.BoardHandoff{FromBoardId: "b0", FromName: "Data model", Shapes: 14}}
	d := New(f.deps())
	if _, err := d.Ask(board, question("And the inbox?")); err != nil {
		t.Fatal(err)
	}
	talk := settled(t, f, d)
	calls := f.callList()
	if len(calls) != 2 {
		t.Fatalf("calls: %+v", calls)
	}
	if c := calls[0]; c.SessionId != "old" || !c.Resume || !c.Fork || c.Prompt != summaryPrompt {
		t.Errorf("summary call: %+v", c)
	}
	if c := calls[1]; c.Resume || c.SessionId == "old" || !strings.Contains(c.Prompt, "They asked how wavesrv stores boards.") || !strings.Contains(c.Prompt, `"Data model"`) {
		t.Errorf("first call: %+v", c)
	}
	if talk.Handoff.Summary != "They asked how wavesrv stores boards." || talk.Turns[0].State != StateAnswered {
		t.Errorf("talk: %+v", talk)
	}
	if got := f.talk("b0"); got.SessionId != "old" || len(got.Turns) != 1 {
		t.Errorf("the earlier board's talk must stay as it was: %+v", got)
	}

	// no earlier session: no summary run
	f.talks["b2"] = wshrpc.BoardTalk{ChannelId: "c1", BoardId: "b2", Handoff: &wshrpc.BoardHandoff{FromBoardId: "b3", FromName: "Empty"}}
	f.files["b2"] = emptyBoard
	b2 := Board{ChannelId: "c1", BoardId: "b2", Name: "B2", ProjectPath: "/repo"}
	if _, err := d.Ask(b2, question("q")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "b2", func() bool { return !d.Busy("c1", "b2") })
	if calls := f.callList(); len(calls) != 3 || calls[2].Fork {
		t.Errorf("an earlier board with no session gets no summary run: %+v", calls)
	}
}

func TestDrawerTalkFailsStaleTurns(t *testing.T) {
	f := newFake(reply(wordsAnswer))
	f.talks["b1"] = wshrpc.BoardTalk{ChannelId: "c1", BoardId: "b1", SessionId: "s1", Turns: []wshrpc.BoardTurn{
		{ID: "t0", Question: "a", State: StateAnswered},
		{ID: "t1", Question: "b", State: StateAnswering},
		{ID: "t2", Question: "c", State: StateWaiting, Briefing: &wshrpc.BoardBriefing{From: "x", Text: "y", Ask: "z"}},
	}}
	d := New(f.deps())
	talk, err := d.Talk(board)
	if err != nil {
		t.Fatal(err)
	}
	for _, i := range []int{1, 2} {
		if talk.Turns[i].State != StateFailed || talk.Turns[i].Reason != RestartedReason {
			t.Errorf("turn %d: %+v", i, talk.Turns[i])
		}
	}
	if talk.Turns[0].State != StateAnswered {
		t.Errorf("an answered turn stays answered")
	}
	if saved := f.talk("b1"); saved.Turns[1].State != StateFailed || saved.Turns[2].Reason != RestartedReason {
		t.Errorf("stale turns must be saved failed: %+v", saved.Turns)
	}
	f.mu.Lock()
	failedPubs := slices.Clone(f.published)
	f.mu.Unlock()
	if len(failedPubs) != 2 || failedPubs[0].TurnId != "t1" || failedPubs[1].TurnId != "t2" || failedPubs[1].From != "x" ||
		failedPubs[1].State != StateFailed || failedPubs[1].Reason != RestartedReason {
		t.Errorf("stale turns must be published failed: %+v", failedPubs)
	}
	if err := d.Retry(board, "t1"); err != nil {
		t.Fatal(err)
	}
	if got := settled(t, f, d).Turns[1]; got.State != StateAnswered {
		t.Errorf("retried: %+v", got)
	}

	// a turn the drawer is running is not stale
	release := make(chan struct{})
	f.run = gated(release, wordsAnswer)
	turn, err := d.Ask(board, question("live"))
	if err != nil {
		t.Fatal(err)
	}
	talk, err = d.Talk(board)
	if err != nil || findTurn(&talk, turn.ID).State != StateAnswering {
		t.Errorf("a running turn must stay answering: %+v %v", talk.Turns, err)
	}
	close(release)
	settled(t, f, d)
}

func TestDrawerAnsweredRecordsShapeIds(t *testing.T) {
	f := newFake(reply(drawAnswer))
	d := New(f.deps())
	turn, err := d.Ask(board, question("q"))
	if err != nil {
		t.Fatal(err)
	}
	settled(t, f, d)
	if err := d.Answered(board, turn.ID, []string{"n1", "n2", "box"}); err != nil {
		t.Fatal(err)
	}
	if got := f.talk("b1").Turns[0].ShapeIds; !slices.Equal(got, []string{"n1", "n2", "box"}) {
		t.Errorf("shape ids: %v", got)
	}
	if err := d.Answered(board, "nope", nil); err == nil {
		t.Errorf("an ack for an unknown turn must fail")
	}
}
