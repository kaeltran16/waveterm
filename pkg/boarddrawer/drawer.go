// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package boarddrawer

import (
	"context"
	"errors"
	"fmt"
	"log"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	RestartedReason = "Arc restarted before the drawer answered"
	BusyReason      = "the drawer is answering; ask once this answer lands"

	StateWaiting   = "waiting"
	StateAnswering = "answering"
	StateAnswered  = "answered"
	StateForwarded = "forwarded"
	StateAsks      = "asks"
	StateFailed    = "failed"
	StateStopped   = "stopped"

	RouteDraw  = "draw"
	RouteAgent = "agent"

	ForwardHeld       = "held"
	ForwardSent       = "sent"
	ForwardReplied    = "replied"
	ForwardNeedsAgent = "needsagent"

	// SummarizeAboveTokens: a talk whose session holds more context than this starts its next turn in a new session,
	// from a summary. The 11-13 talks reached 33k-57k, and one 143k by turn 13.
	SummarizeAboveTokens = 60_000

	ChoiceKeep = "keep"
	ChoiceNew  = "new"

	updateTalk   = "talk"
	updateAnswer = "answer"

	wontOpenHead = "the board's file won't open: "

	// claude's error for a --resume of a session it no longer has (its transcript was cleaned up or deleted)
	lostSessionText = "No conversation found with session ID"
)

// Board names one board and where its drawer runs.
type Board struct{ ChannelId, BoardId, Name, ProjectPath string }

// Deps is everything the drawer touches outside this package.
type Deps struct {
	LoadTalk func(b Board) (wshrpc.BoardTalk, error)
	// fn calls no other Dep: the store may hold its lock while fn runs
	UpdateTalk func(b Board, fn func(*wshrpc.BoardTalk) error) (wshrpc.BoardTalk, error)
	ReadBoard  func(b Board) ([]byte, error) // the board file
	ReadThing  func(ctx context.Context, src wshrpc.BoardSource, sinceTs int64) (text, reading string, cursorTs int64, err error)
	Deliver    func(a wshrpc.BoardAnswer) error
	Publish    func(u wshrpc.BoardUpdateData)
	// Forward is called, outside any talk update, once a turn is saved as forwarded
	Forward func(b Board, turnId string)
	Run     func(ctx context.Context, cwd string, c Call) (Reply, error) // nil: RunModel
	Now     func() int64
	NewId   func() string // nil: uuid.NewString
	// RemoveSession deletes a session's transcript; only ever given sessions the drawer made. nil: RemoveSession
	RemoveSession func(sessionId string) error
}

type boardKey struct{ channelId, boardId string }

// boardRun is a board the drawer is busy on: the turn it runs and the briefings waiting behind it.
type boardRun struct {
	turnId string
	ctx    context.Context
	cancel context.CancelFunc
	queue  []string // waiting turn ids, oldest first
}

// begin makes turnId the running turn, with the context Stop cancels. Called under d.mu as the turn is made current,
// not from the goroutine that runs it, so a Stop right after the ask finds something to cancel.
func (r *boardRun) begin(turnId string) {
	r.turnId = turnId
	r.ctx, r.cancel = context.WithCancel(context.Background())
}

func newRun(turnId string) *boardRun {
	r := &boardRun{}
	r.begin(turnId)
	return r
}

// Drawer runs boards' turns, one at a time per board. What it runs lives in memory only: after a restart, Talk
// fails the turns nothing runs any more.
type Drawer struct {
	d      Deps
	mu     sync.Mutex
	boards map[boardKey]*boardRun
}

func New(d Deps) *Drawer {
	if d.Run == nil {
		d.Run = RunModel
	}
	if d.Now == nil {
		d.Now = func() int64 { return time.Now().UnixMilli() }
	}
	if d.RemoveSession == nil {
		d.RemoveSession = RemoveSession
	}
	if d.NewId == nil {
		d.NewId = uuid.NewString
	}
	return &Drawer{d: d, boards: map[boardKey]*boardRun{}}
}

func keyOf(b Board) boardKey { return boardKey{b.ChannelId, b.BoardId} }

func (d *Drawer) Busy(channelId, boardId string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.boards[boardKey{channelId, boardId}] != nil
}

// Ask adds t to the board's talk and runs it. While a turn runs, your ask is refused with BusyReason, and an
// agent's briefing waits behind it instead.
func (d *Drawer) Ask(b Board, t wshrpc.BoardTurn) (wshrpc.BoardTurn, error) {
	t.ID, t.Ts, t.State = d.d.NewId(), d.d.Now(), StateAnswering
	d.mu.Lock()
	run := d.boards[keyOf(b)]
	if run != nil && t.Briefing == nil {
		d.mu.Unlock()
		return wshrpc.BoardTurn{}, errors.New(BusyReason)
	}
	if run != nil {
		t.State = StateWaiting
	}
	_, err := d.d.UpdateTalk(b, func(talk *wshrpc.BoardTalk) error {
		talk.Turns = append(talk.Turns, t)
		return nil
	})
	if err != nil {
		d.mu.Unlock()
		return wshrpc.BoardTurn{}, err
	}
	if run != nil {
		run.queue = append(run.queue, t.ID)
	} else {
		d.boards[keyOf(b)] = newRun(t.ID)
	}
	d.mu.Unlock()
	d.publishTurn(b, t)
	if run == nil {
		go d.loop(b, t.ID)
	}
	return t, nil
}

// Stop cancels the running turn only: it ends stopped, with nothing delivered; waiting briefings still run.
func (d *Drawer) Stop(b Board) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	run := d.boards[keyOf(b)]
	if run == nil {
		return errors.New("the drawer is not answering on this board")
	}
	run.cancel()
	return nil
}

// Retry asks a failed or stopped turn again.
func (d *Drawer) Retry(b Board, turnId string) error {
	now := d.d.Now()
	return d.startOwn(b, func(talk *wshrpc.BoardTalk) (*wshrpc.BoardTurn, error) {
		t := findTurn(talk, turnId)
		if t == nil {
			return nil, errors.New("this board has no such turn")
		}
		if t.State != StateFailed && t.State != StateStopped {
			return nil, fmt.Errorf("only a failed or stopped turn can be retried, and this one is %s", t.State)
		}
		t.State, t.Reason, t.Ts = StateAnswering, "", now
		return t, nil
	})
}

// Choose records your answer to a turn that asks whether a briefing belongs on a new board. Keep runs a kept turn
// that answers the briefing here; new only records it, as the new board is started elsewhere.
func (d *Drawer) Choose(b Board, turnId, choice string) error {
	if choice != ChoiceKeep && choice != ChoiceNew {
		return fmt.Errorf("the choice is keep or new, not %q", choice)
	}
	record := func(talk *wshrpc.BoardTalk) (*wshrpc.BoardTurn, error) {
		t := findTurn(talk, turnId)
		if t == nil {
			return nil, errors.New("this board has no such turn")
		}
		if t.State != StateAsks || t.Choice != "" {
			return nil, errors.New("this turn is not waiting for a choice")
		}
		t.Choice = choice
		return t, nil
	}
	if choice == ChoiceNew {
		var asked wshrpc.BoardTurn
		_, err := d.d.UpdateTalk(b, func(talk *wshrpc.BoardTalk) error {
			t, err := record(talk)
			if err == nil {
				asked = *t
			}
			return err
		})
		if err == nil {
			d.publishTurn(b, asked)
		}
		return err
	}
	// taken before the update: Deps are not called back from inside UpdateTalk
	keptId, now := d.d.NewId(), d.d.Now()
	return d.startOwn(b, func(talk *wshrpc.BoardTalk) (*wshrpc.BoardTurn, error) {
		t, err := record(talk)
		if err != nil {
			return nil, err
		}
		question := t.Question
		if t.Briefing != nil {
			question = t.Briefing.Ask
		}
		talk.Turns = append(talk.Turns, wshrpc.BoardTurn{
			ID: keptId, Ts: now, Question: question, Kept: true, State: StateAnswering,
		})
		return &talk.Turns[len(talk.Turns)-1], nil
	})
}

// startOwn runs the turn fn readies in the talk, refusing while the board is busy: Retry and Keep are your asks.
func (d *Drawer) startOwn(b Board, fn func(*wshrpc.BoardTalk) (*wshrpc.BoardTurn, error)) error {
	d.mu.Lock()
	if d.boards[keyOf(b)] != nil {
		d.mu.Unlock()
		return errors.New(BusyReason)
	}
	var turn wshrpc.BoardTurn
	_, err := d.d.UpdateTalk(b, func(talk *wshrpc.BoardTalk) error {
		t, err := fn(talk)
		if err == nil {
			turn = *t
		}
		return err
	})
	if err != nil {
		d.mu.Unlock()
		return err
	}
	d.boards[keyOf(b)] = newRun(turn.ID)
	d.mu.Unlock()
	d.publishTurn(b, turn)
	go d.loop(b, turn.ID)
	return nil
}

// Answered records the ack: the shapes the frontend added or changed when it applied the turn's answer.
func (d *Drawer) Answered(b Board, turnId string, shapeIds []string) error {
	_, err := d.d.UpdateTalk(b, func(talk *wshrpc.BoardTalk) error {
		t := findTurn(talk, turnId)
		if t == nil {
			return errors.New("this board has no such turn")
		}
		t.ShapeIds = shapeIds
		return nil
	})
	return err
}

// Talk reads the board's talk. A turn left answering or waiting that nothing runs (wavesrv restarted) is failed
// with RestartedReason, and that is saved and published.
func (d *Drawer) Talk(b Board) (wshrpc.BoardTalk, error) {
	talk, failed, err := d.failStale(b)
	for _, t := range failed {
		d.publishTurn(b, t)
	}
	return talk, err
}

func (d *Drawer) failStale(b Board) (wshrpc.BoardTalk, []wshrpc.BoardTurn, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	var live []string
	if run := d.boards[keyOf(b)]; run != nil {
		live = append([]string{run.turnId}, run.queue...)
	}
	stale := func(t wshrpc.BoardTurn) bool {
		return (t.State == StateAnswering || t.State == StateWaiting) && !slices.Contains(live, t.ID)
	}
	talk, err := d.d.LoadTalk(b)
	if err != nil || !slices.ContainsFunc(talk.Turns, stale) {
		return talk, nil, err
	}
	var failed []wshrpc.BoardTurn
	talk, err = d.d.UpdateTalk(b, func(talk *wshrpc.BoardTalk) error {
		failed = nil
		for i := range talk.Turns {
			if stale(talk.Turns[i]) {
				talk.Turns[i].State, talk.Turns[i].Reason = StateFailed, RestartedReason
				failed = append(failed, talk.Turns[i])
			}
		}
		return nil
	})
	if err != nil {
		return talk, nil, err
	}
	return talk, failed, nil
}

// loop runs turnId, then each briefing that queued behind it.
func (d *Drawer) loop(b Board, turnId string) {
	k := keyOf(b)
	for {
		d.runTurn(b, turnId)
		d.mu.Lock()
		run := d.boards[k]
		if len(run.queue) == 0 {
			delete(d.boards, k)
			d.mu.Unlock()
			return
		}
		turnId, run.queue = run.queue[0], run.queue[1:]
		run.begin(turnId)
		d.mu.Unlock()
	}
}

func (d *Drawer) runTurn(b Board, turnId string) {
	d.mu.Lock()
	run := d.boards[keyOf(b)]
	ctx, cancel := run.ctx, run.cancel
	d.mu.Unlock()
	defer cancel()

	waited := false
	talk, err := d.d.UpdateTalk(b, func(talk *wshrpc.BoardTalk) error {
		t := findTurn(talk, turnId)
		if t == nil {
			return errors.New("the turn is gone from the board's talk")
		}
		waited, t.State = t.State == StateWaiting, StateAnswering
		return nil
	})
	if err != nil {
		d.finish(b, turnId, func(t *wshrpc.BoardTurn) { t.State, t.Reason = StateFailed, err.Error() })
		return
	}
	turn := *findTurn(&talk, turnId)
	if waited {
		d.publishTurn(b, turn)
	}

	answer, delivered, err := d.answer(ctx, b, talk, turn)
	switch {
	// a nil err means the answer is in the inbox: a Stop that lands after that is too late to keep it off the board
	case err != nil && ctx.Err() != nil:
		d.finish(b, turnId, func(t *wshrpc.BoardTurn) { t.State = StateStopped })
	case err != nil:
		d.finish(b, turnId, func(t *wshrpc.BoardTurn) { t.State, t.Reason = StateFailed, err.Error() })
	default:
		answeredTs := d.d.Now()
		saved := d.finish(b, turnId, func(t *wshrpc.BoardTurn) {
			switch {
			case answer.Elsewhere:
				t.State = StateAsks
			case answer.Question:
				t.State, t.Route = StateForwarded, RouteAgent
			default:
				t.State, t.Route = StateAnswered, RouteDraw
			}
			t.Title, t.AnsweredTs = answer.Title, answeredTs
			t.Added, t.Changed, t.Removed = answer.Added, answer.Changed, answer.Removed
		})
		if delivered {
			d.publish(wshrpc.BoardUpdateData{ChannelId: b.ChannelId, BoardId: b.BoardId, What: updateAnswer, TurnId: turnId})
		}
		if saved && answer.Question && d.d.Forward != nil {
			d.d.Forward(b, turnId)
		}
	}
}

// mustDraw is why a turn may only be drawn, or "" for your own ask, which the drawer may flag as a question.
func mustDraw(t wshrpc.BoardTurn) string {
	switch {
	case t.Briefing != nil, t.Kept:
		return "the agent's own request must be drawn"
	case t.Route == RouteDraw:
		return "the line was sent to be drawn"
	}
	return ""
}

// agentRead is what a turn read of the board's agent: handed to the drawer, and saved as the cursor once it ran.
type agentRead struct {
	tabId, title, text string
	cursorTs           int64
}

// readAgent reads what the board's agent said since the drawer last read it. An agent that can't be read (its tab
// is gone) costs the turn nothing: it is drawn without it, and the cursor stays.
func (d *Drawer) readAgent(ctx context.Context, b Board, agent *wshrpc.BoardAgent) agentRead {
	if agent == nil {
		return agentRead{}
	}
	read := agentRead{tabId: agent.TabId, title: agent.Title}
	src := wshrpc.BoardSource{Kind: KindAgent, Ref: agent.TabId, Title: agent.Title}
	text, _, cursorTs, err := d.d.ReadThing(ctx, src, agent.ReadTs)
	if err != nil {
		log.Printf("boarddrawer: reading agent %s for board %s: %v", agent.TabId, b.BoardId, err)
		return read
	}
	read.text, read.cursorTs = text, cursorTs
	return read
}

// answer runs one turn's session and delivers its drawing; delivered says an answer went to the inbox.
func (d *Drawer) answer(ctx context.Context, b Board, talk wshrpc.BoardTalk, turn wshrpc.BoardTurn) (Answer, bool, error) {
	call := Call{SessionId: talk.SessionId, Resume: talk.SessionId != ""}
	earlier, retired := "", "" // retired: the large session a summary replaces, removed once the new one answers
	if call.Resume && talk.ContextTokens > SummarizeAboveTokens {
		s, err := d.summarize(ctx, b, talk.SessionId)
		if ctx.Err() != nil {
			return Answer{}, false, ctx.Err()
		}
		if err != nil {
			// the large session still works: this turn resumes it, and the next tries the summary again
			log.Printf("boarddrawer: summing up session %s of board %s: %v", talk.SessionId, b.BoardId, err)
		} else {
			earlier, retired, call = s, talk.SessionId, Call{}
		}
	}
	var first *firstInput
	if !call.Resume {
		f, err := d.prepareFirst(ctx, b, talk)
		if err != nil {
			return Answer{}, false, err
		}
		f.Earlier = earlier
		first = &f
	}
	file, err := d.d.ReadBoard(b)
	if err != nil {
		return Answer{}, false, errors.New(wontOpenHead + err.Error())
	}
	scene, err := SceneSummary(file, turn.SelectedIds)
	if err != nil {
		return Answer{}, false, errors.New(wontOpenHead + err.Error())
	}
	agent := d.readAgent(ctx, b, talk.Agent)
	ti := turnInput{
		Scene: scene, SelectedIds: turn.SelectedIds, DrawingId: turn.DrawingId, On: turn.On, Question: turn.Question,
		Briefing: turn.Briefing, Kept: turn.Kept, Elsewhere: turn.Briefing != nil && hasEarlierTurns(talk, turn.ID), Draw: turn.Route == RouteDraw,
		AgentTitle: agent.title, AgentTurns: agent.text,
	}
	call.Prompt = turnPrompt(ti)
	if first != nil {
		call.Prompt = firstPrompt(*first, ti)
		// saved only once the prompt is ready, so a turn that fails before the run leaves no session to resume, and
		// saved before the run, so a turn cut off by a restart still resumes
		call.SessionId = d.d.NewId()
		_, err := d.d.UpdateTalk(b, func(talk *wshrpc.BoardTalk) error {
			talk.SessionId, talk.ContextTokens = call.SessionId, 0
			return nil
		})
		if err != nil {
			return Answer{}, false, err
		}
	}
	out, err := d.d.Run(ctx, b.ProjectPath, call)
	reply := out.Text
	if err == nil {
		d.recordRun(b, call.SessionId, out.ContextTokens, agent)
		if retired != "" {
			d.removeSession(b, retired)
		}
	}
	if err != nil && first == nil && strings.Contains(err.Error(), lostSessionText) {
		// nothing can ever resume it, so keeping it would fail every later turn: this one starts a new session
		d.dropSession(b, call.SessionId)
		talk.SessionId = ""
		return d.answer(ctx, b, talk, turn)
	}
	if err != nil {
		switch {
		case retired != "":
			// the summed-up session is still whole: the talk goes back to it, and the next turn sums it up again
			d.restoreSession(b, call.SessionId, retired, talk.ContextTokens)
		case first != nil:
			// the session may never have started: the next turn starts it again rather than resume nothing
			d.dropSession(b, call.SessionId)
		}
		return Answer{}, false, err
	}
	if ctx.Err() != nil {
		return Answer{}, false, ctx.Err()
	}
	answer, err := CheckAnswer(reply, scene, ti.Elsewhere, turn.DrawingId)
	if err == nil {
		answer, err = routeAnswer(answer, mustDraw(turn))
	}
	if err != nil || !answer.HasDrawing() {
		return answer, false, err
	}
	delivered := wshrpc.BoardAnswer{
		ID: d.d.NewId(), ChannelId: b.ChannelId, BoardId: b.BoardId, TurnId: turn.ID,
		Add: answer.Add, Update: answer.Update, Remove: answer.Remove, Title: answer.Title, Ts: d.d.Now(),
	}
	if answer.Edit {
		delivered.DrawingId = turn.DrawingId
	}
	err = d.d.Deliver(delivered)
	if err != nil {
		return Answer{}, false, fmt.Errorf("the drawer's answer could not be delivered: %w", err)
	}
	return answer, true, nil
}

// prepareFirst readies a session's first prompt: the handoff summary from the earlier board's drawer and the thing
// the talk is about.
func (d *Drawer) prepareFirst(ctx context.Context, b Board, talk wshrpc.BoardTalk) (firstInput, error) {
	f := firstInput{BoardName: b.Name, About: talk.About, Handoff: talk.Handoff}
	if h := talk.Handoff; h != nil && h.FromBoardId != "" && strings.TrimSpace(h.Summary) == "" {
		summary, err := d.handoffSummary(ctx, b, h.FromBoardId)
		if err != nil {
			return f, err
		}
		if summary != "" {
			saved, err := d.d.UpdateTalk(b, func(talk *wshrpc.BoardTalk) error {
				if talk.Handoff != nil {
					talk.Handoff.Summary = summary
				}
				return nil
			})
			if err != nil {
				return f, err
			}
			f.Handoff = saved.Handoff
		}
	}
	if readsThing(talk.About) {
		text, _, _, err := d.d.ReadThing(ctx, talk.About, 0)
		if err != nil {
			return f, fmt.Errorf("the drawer couldn't read %s: %w", talk.About.Title, err)
		}
		f.ThingText = text
	}
	return f, nil
}

// handoffSummary asks a fork of the earlier board's session to sum up its talk; no session (nothing asked) is no summary.
func (d *Drawer) handoffSummary(ctx context.Context, b Board, fromBoardId string) (string, error) {
	earlier := Board{ChannelId: b.ChannelId, BoardId: fromBoardId, ProjectPath: b.ProjectPath}
	from, err := d.d.LoadTalk(earlier)
	if err != nil {
		return "", fmt.Errorf("the earlier board's talk won't open: %w", err)
	}
	if from.SessionId == "" {
		return "", nil
	}
	summary, err := d.d.Run(ctx, b.ProjectPath, Call{SessionId: from.SessionId, Resume: true, Fork: true, Prompt: summaryPrompt})
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(summary.Text), nil
}

// summarize asks a fork of sessionId to sum up its talk for the session that takes over, so a failed summary
// leaves the session as it was.
func (d *Drawer) summarize(ctx context.Context, b Board, sessionId string) (string, error) {
	fork := d.d.NewId()
	// the fork only carries the summary out
	defer d.removeSession(b, fork)
	out, err := d.d.Run(ctx, b.ProjectPath, Call{SessionId: sessionId, Resume: true, Fork: true, ForkId: fork, Prompt: compactPrompt})
	if err != nil {
		return "", err
	}
	s := strings.TrimSpace(out.Text)
	if s == "" {
		return "", errors.New("the summary came back empty")
	}
	return s, nil
}

// recordRun keeps what a session that ran has seen: its context size, unless the talk moved to another session
// meanwhile, and the agent's cursor, unless the board's agent changed or its cursor was reset past it.
func (d *Drawer) recordRun(b Board, sessionId string, tokens int, agent agentRead) {
	_, err := d.d.UpdateTalk(b, func(talk *wshrpc.BoardTalk) error {
		if talk.SessionId == sessionId {
			talk.ContextTokens = tokens
		}
		if a := talk.Agent; a != nil && a.TabId == agent.tabId && agent.cursorTs > a.ReadTs {
			a.ReadTs = agent.cursorTs
		}
		return nil
	})
	if err != nil {
		log.Printf("boarddrawer: recording the context of board %s: %v", b.BoardId, err)
	}
}

// restoreSession puts the talk back on old, unless it moved past failed meanwhile, and removes failed.
func (d *Drawer) restoreSession(b Board, failed, old string, tokens int) {
	_, err := d.d.UpdateTalk(b, func(talk *wshrpc.BoardTalk) error {
		if talk.SessionId == failed {
			talk.SessionId, talk.ContextTokens = old, tokens
		}
		return nil
	})
	if err != nil {
		log.Printf("boarddrawer: restoring session %s of board %s: %v", old, b.BoardId, err)
		return
	}
	d.removeSession(b, failed)
}

func (d *Drawer) removeSession(b Board, sessionId string) {
	if err := d.d.RemoveSession(sessionId); err != nil {
		log.Printf("boarddrawer: removing session %s of board %s: %v", sessionId, b.BoardId, err)
	}
}

func (d *Drawer) dropSession(b Board, sessionId string) {
	_, err := d.d.UpdateTalk(b, func(talk *wshrpc.BoardTalk) error {
		if talk.SessionId == sessionId {
			talk.SessionId, talk.ContextTokens = "", 0
		}
		return nil
	})
	if err != nil {
		log.Printf("boarddrawer: dropping session %s of board %s: %v", sessionId, b.BoardId, err)
	}
}

// finish saves a turn's end state and publishes it; false when it could not be saved.
func (d *Drawer) finish(b Board, turnId string, fn func(*wshrpc.BoardTurn)) bool {
	var turn wshrpc.BoardTurn
	_, err := d.d.UpdateTalk(b, func(talk *wshrpc.BoardTalk) error {
		t := findTurn(talk, turnId)
		if t == nil {
			return errors.New("the turn is gone from the board's talk")
		}
		fn(t)
		turn = *t
		return nil
	})
	if err != nil {
		log.Printf("boarddrawer: saving turn %s of board %s: %v", turnId, b.BoardId, err)
		return false
	}
	d.publishTurn(b, turn)
	return true
}

func (d *Drawer) publishTurn(b Board, t wshrpc.BoardTurn) {
	u := wshrpc.BoardUpdateData{ChannelId: b.ChannelId, BoardId: b.BoardId, What: updateTalk, TurnId: t.ID, State: t.State, Reason: t.Reason}
	if t.Briefing != nil {
		u.From = t.Briefing.From
	}
	d.publish(u)
}

func (d *Drawer) publish(u wshrpc.BoardUpdateData) {
	if d.d.Publish != nil {
		d.d.Publish(u)
	}
}

func findTurn(talk *wshrpc.BoardTalk, turnId string) *wshrpc.BoardTurn {
	for i := range talk.Turns {
		if talk.Turns[i].ID == turnId {
			return &talk.Turns[i]
		}
	}
	return nil
}

func hasEarlierTurns(talk wshrpc.BoardTalk, turnId string) bool {
	return len(talk.Turns) > 0 && talk.Turns[0].ID != turnId
}
