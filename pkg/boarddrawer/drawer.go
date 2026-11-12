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
	StateAsks      = "asks"
	StateFailed    = "failed"
	StateStopped   = "stopped"

	ChoiceKeep = "keep"
	ChoiceNew  = "new"

	updateTalk   = "talk"
	updateAnswer = "answer"

	wontOpenHead = "the board's file won't open: "
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
	Run        func(ctx context.Context, cwd string, c Call) (string, error) // nil: RunModel
	Now        func() int64
	NewId      func() string // nil: uuid.NewString
}

type boardKey struct{ channelId, boardId string }

// boardRun is a board the drawer is busy on: the turn it runs and the briefings waiting behind it.
type boardRun struct {
	turnId string
	cancel context.CancelFunc
	queue  []string // waiting turn ids, oldest first
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
		d.boards[keyOf(b)] = &boardRun{turnId: t.ID}
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
	if run == nil || run.cancel == nil {
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
	d.boards[keyOf(b)] = &boardRun{turnId: turn.ID}
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
// with RestartedReason, and that is saved.
func (d *Drawer) Talk(b Board) (wshrpc.BoardTalk, error) {
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
		return talk, err
	}
	return d.d.UpdateTalk(b, func(talk *wshrpc.BoardTalk) error {
		for i := range talk.Turns {
			if stale(talk.Turns[i]) {
				talk.Turns[i].State, talk.Turns[i].Reason = StateFailed, RestartedReason
			}
		}
		return nil
	})
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
		d.mu.Unlock()
	}
}

func (d *Drawer) runTurn(b Board, turnId string) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	d.mu.Lock()
	run := d.boards[keyOf(b)]
	run.turnId, run.cancel = turnId, cancel
	d.mu.Unlock()

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
	case ctx.Err() != nil:
		d.finish(b, turnId, func(t *wshrpc.BoardTurn) { t.State = StateStopped })
	case err != nil:
		d.finish(b, turnId, func(t *wshrpc.BoardTurn) { t.State, t.Reason = StateFailed, err.Error() })
	default:
		answeredTs := d.d.Now()
		d.finish(b, turnId, func(t *wshrpc.BoardTurn) {
			t.State = StateAnswered
			if answer.Elsewhere {
				t.State = StateAsks
			}
			t.Reply, t.Title, t.AnsweredTs = answer.Reply, answer.Title, answeredTs
			t.Added, t.Changed, t.Removed = answer.Added, answer.Changed, answer.Removed
		})
		if delivered {
			d.publish(wshrpc.BoardUpdateData{ChannelId: b.ChannelId, BoardId: b.BoardId, What: updateAnswer, TurnId: turnId})
		}
	}
}

// answer runs one turn's session and delivers its drawing; delivered says an answer went to the inbox.
func (d *Drawer) answer(ctx context.Context, b Board, talk wshrpc.BoardTalk, turn wshrpc.BoardTurn) (Answer, bool, error) {
	call := Call{SessionId: talk.SessionId, Resume: talk.SessionId != ""}
	var first *firstInput
	if !call.Resume {
		f, err := d.prepareFirst(ctx, b, talk)
		if err != nil {
			return Answer{}, false, err
		}
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
	ti := turnInput{
		Scene: scene, SelectedIds: turn.SelectedIds, On: turn.On, Question: turn.Question, Briefing: turn.Briefing,
		Kept: turn.Kept, Elsewhere: turn.Briefing != nil && hasEarlierTurns(talk, turn.ID),
	}
	call.Prompt = turnPrompt(ti)
	if first != nil {
		call.Prompt = firstPrompt(*first, ti)
		// saved only once the prompt is ready, so a turn that fails before the run leaves no session to resume, and
		// saved before the run, so a turn cut off by a restart still resumes
		call.SessionId = d.d.NewId()
		_, err := d.d.UpdateTalk(b, func(talk *wshrpc.BoardTalk) error {
			talk.SessionId = call.SessionId
			return nil
		})
		if err != nil {
			return Answer{}, false, err
		}
	}
	reply, err := d.d.Run(ctx, b.ProjectPath, call)
	if err != nil {
		if first != nil {
			// the session may never have started: the next turn starts it again rather than resume nothing
			d.dropSession(b, call.SessionId)
		}
		return Answer{}, false, err
	}
	if ctx.Err() != nil {
		return Answer{}, false, ctx.Err()
	}
	answer, err := CheckAnswer(reply, scene, ti.Elsewhere)
	if err != nil || !answer.HasDrawing() {
		return answer, false, err
	}
	err = d.d.Deliver(wshrpc.BoardAnswer{
		ID: d.d.NewId(), ChannelId: b.ChannelId, BoardId: b.BoardId, TurnId: turn.ID,
		Add: answer.Add, Update: answer.Update, Remove: answer.Remove, Ts: d.d.Now(),
	})
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
	return strings.TrimSpace(summary), nil
}

func (d *Drawer) dropSession(b Board, sessionId string) {
	_, err := d.d.UpdateTalk(b, func(talk *wshrpc.BoardTalk) error {
		if talk.SessionId == sessionId {
			talk.SessionId = ""
		}
		return nil
	})
	if err != nil {
		log.Printf("boarddrawer: dropping the unstarted session of board %s: %v", b.BoardId, err)
	}
}

// finish saves a turn's end state and publishes it.
func (d *Drawer) finish(b Board, turnId string, fn func(*wshrpc.BoardTurn)) {
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
		return
	}
	d.publishTurn(b, turn)
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
