// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"
	"fmt"
	"log"
	"slices"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/agentsessions"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/boarddrawer"
	"github.com/wavetermdev/waveterm/pkg/boardforward"
	"github.com/wavetermdev/waveterm/pkg/boardstore"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	reasonNoAgent   = "this board has no agent to ask yet"
	reasonAgentGone = "%s is no longer a live agent"
)

var errNoSuchTurn = errors.New("this board has no such turn")

// errNotPending ends a talk update that finds the forward already moved on: nothing is written.
var errNotPending = errors.New("the forward is no longer waiting")

// forwardBoardTurn is what the drawer calls once a turn is saved as forwarded. A var so tests can swap it.
var forwardBoardTurn = func(b boarddrawer.Board, turnId string) {
	boardForwards.forward(context.Background(), b, turnId)
}

// pendingForward is a held or sent forward, waiting on its agent to be free or to reply.
type pendingForward struct{ channelId, boardId, turnId string }

// boardForwarder moves forwards along as their agents report. It indexes the pending ones by the agent tab they wait
// on, in memory, rebuilt from the talk files on first use, so a wavesrv restart loses none.
type boardForwarder struct {
	mu       sync.Mutex
	loaded   bool
	pending  map[string][]pendingForward
	kickMu   sync.Mutex // guards sweeping and again, apart from mu so an event never waits on a sweep
	sweeping bool       // a sweep is running
	again    bool       // an event came during it
}

// boardForwards is the one forwarder. A var so a test can drop its index, as a restart does.
var boardForwards = &boardForwarder{}

// forwardAsync runs a sweep off the status publisher's goroutine. A var so tests run it inline.
var forwardAsync = func(fn func()) { go fn() }

const forwardSweepTimeout = 30 * time.Second

func forwardPending(fw *wshrpc.BoardForward) bool {
	return fw != nil && (fw.State == boarddrawer.ForwardHeld || fw.State == boarddrawer.ForwardSent)
}

// load rebuilds the index from every project's talks, once.
func (f *boardForwarder) load(ctx context.Context) {
	if f.loaded {
		return
	}
	if f.pending == nil {
		f.pending = map[string][]pendingForward{}
	}
	chans, err := wstore.GetChannels(ctx)
	if err != nil {
		log.Printf("board forwards: loading channels: %v\n", err)
		return
	}
	// track skips what is indexed already, so a load that failed before leaves nothing twice
	for _, ch := range chans {
		dir := boardstore.ProjectDir(ch.Name)
		boards, err := boardstore.List(dir, ch.OID, nil)
		if err != nil {
			log.Printf("board forwards: listing %s's boards: %v\n", ch.Name, err)
			continue
		}
		for _, info := range boards {
			talk, err := boardstore.ReadTalk(dir, info.ID)
			if err != nil {
				continue
			}
			for _, t := range talk.Turns {
				if forwardPending(t.Forward) {
					f.track(t.Forward.TabId, pendingForward{ch.OID, info.ID, t.ID})
				}
			}
		}
	}
	f.loaded = true
}

func (f *boardForwarder) track(tabId string, p pendingForward) {
	if !slices.Contains(f.pending[tabId], p) {
		f.pending[tabId] = append(f.pending[tabId], p)
	}
}

func (f *boardForwarder) untrack(tabId string, p pendingForward) {
	f.pending[tabId] = slices.DeleteFunc(f.pending[tabId], func(q pendingForward) bool { return q == p })
	if len(f.pending[tabId]) == 0 {
		delete(f.pending, tabId)
	}
}

// liveAgents is the roster's live claude and pi agents.
func liveAgents(ctx context.Context) ([]agentRow, error) {
	facts, err := loadAgentRosterFacts(ctx)
	if err != nil {
		return nil, err
	}
	return buildAgentRoster(facts), nil
}

func findAgentRow(rows []agentRow, match func(agentRow) bool) *agentRow {
	if i := slices.IndexFunc(rows, match); i >= 0 {
		return &rows[i]
	}
	return nil
}

// forward sends a forwarded turn to the board's agent: typed when the agent is free, held while it asks, and
// needsagent when the board has no live agent. A turn already on its way is left alone.
func (f *boardForwarder) forward(ctx context.Context, b boarddrawer.Board, turnId string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.load(ctx)
	rows, err := liveAgents(ctx)
	if err != nil {
		log.Printf("board %s: forwarding turn %s: %v\n", b.BoardId, turnId, err)
		return
	}
	var row *agentRow
	turn, err := updateBoardTurn(ctx, b, turnId, func(talk *wshrpc.BoardTalk, t *wshrpc.BoardTurn) error {
		if t.State != boarddrawer.StateForwarded || (t.Forward != nil && t.Forward.State != boarddrawer.ForwardNeedsAgent) {
			return errNotPending
		}
		var fw wshrpc.BoardForward
		fw, row = forwardTo(talk.Agent, rows)
		t.Forward = &fw
		return nil
	})
	if err != nil {
		if !errors.Is(err, errNotPending) {
			log.Printf("board %s: forwarding turn %s: %v\n", b.BoardId, turnId, err)
		}
		return
	}
	f.after(b, turn, row)
}

// forwardTo is where a forward stands given the board's agent and the live roster. A sent one is stamped now.
func forwardTo(agent *wshrpc.BoardAgent, rows []agentRow) (wshrpc.BoardForward, *agentRow) {
	if agent == nil {
		return wshrpc.BoardForward{State: boarddrawer.ForwardNeedsAgent, Reason: reasonNoAgent}, nil
	}
	fw := wshrpc.BoardForward{TabId: agent.TabId, Title: agent.Title, Runtime: agent.Runtime}
	row := findAgentRow(rows, func(r agentRow) bool { return r.TabId == agent.TabId })
	switch {
	case row == nil:
		fw.State, fw.Reason = boarddrawer.ForwardNeedsAgent, fmt.Sprintf(reasonAgentGone, agent.Title)
	case row.State == wshrpc.AgentsState_Asking:
		// typed text would answer its open prompt
		fw.State = boarddrawer.ForwardHeld
	default:
		fw.State, fw.SentTs = boarddrawer.ForwardSent, time.Now().UnixMilli()
	}
	return fw, row
}

// after acts on a forward's saved state: types a sent one, indexes a pending one, and publishes the change.
func (f *boardForwarder) after(b boarddrawer.Board, t wshrpc.BoardTurn, row *agentRow) {
	p := pendingForward{b.ChannelId, b.BoardId, t.ID}
	if forwardPending(t.Forward) {
		f.track(t.Forward.TabId, p)
	} else if t.Forward != nil {
		f.untrack(t.Forward.TabId, p)
	}
	if t.Forward.State == boarddrawer.ForwardSent && row != nil {
		typeAgentMessage(row.blockId, boardforward.Marker(b.Name, t.On, t.ID, t.Question))
	}
	publishBoardTurn(b, t)
}

// kick asks for a sweep. Status events from every agent call it, so a burst coalesces into one running sweep and at
// most one more after it, off the publisher's RPC context: run on that context, each event's roster load queued
// behind the last and timed out, so the event of the agent's turn end was lost and its reply never copied (11-27).
func (f *boardForwarder) kick() {
	f.kickMu.Lock()
	if f.sweeping {
		f.again = true
		f.kickMu.Unlock()
		return
	}
	f.sweeping = true
	f.kickMu.Unlock()
	forwardAsync(f.sweepUntilQuiet)
}

func (f *boardForwarder) sweepUntilQuiet() {
	for {
		f.sweep()
		f.kickMu.Lock()
		if !f.again {
			f.sweeping = false
			f.kickMu.Unlock()
			return
		}
		f.again = false
		f.kickMu.Unlock()
	}
}

// sweep moves every pending forward its agent allows: a held one goes once the agent is not asking, and at its turn
// end a sent one takes the reply its transcript holds. Checking them all lets a forward whose own event was missed
// move on the next one.
func (f *boardForwarder) sweep() {
	ctx, cancel := context.WithTimeout(context.Background(), forwardSweepTimeout)
	defer cancel()
	f.mu.Lock()
	defer f.mu.Unlock()
	f.load(ctx)
	if len(f.pending) == 0 {
		return
	}
	rows, err := liveAgents(ctx)
	if err != nil {
		log.Printf("board forwards: reading the agents: %v\n", err)
		return
	}
	for tabId, waiting := range f.pending {
		row := findAgentRow(rows, func(r agentRow) bool { return r.TabId == tabId })
		if row == nil || row.State == wshrpc.AgentsState_Asking {
			continue
		}
		for _, p := range slices.Clone(waiting) {
			f.advance(ctx, row, p)
		}
	}
}

func (f *boardForwarder) advance(ctx context.Context, row *agentRow, p pendingForward) {
	b, _, err := drawerBoard(ctx, p.channelId, p.boardId)
	if err != nil {
		log.Printf("board %s: its forward of turn %s waits on a board that won't load: %v\n", p.boardId, p.turnId, err)
		f.untrack(row.TabId, p)
		return
	}
	t, ok := readBoardTurn(ctx, b, p.turnId)
	if !ok || !forwardPending(t.Forward) || t.Forward.TabId != row.TabId {
		f.untrack(row.TabId, p)
		return
	}
	held := t.Forward.State == boarddrawer.ForwardHeld
	var reply string
	var replyTs int64
	if !held {
		if row.State != wshrpc.AgentsState_Idle {
			return // not its turn end
		}
		if reply, replyTs, ok = agentReply(ctx, row, t); !ok {
			return
		}
	}
	turn, err := updateBoardTurn(ctx, b, p.turnId, func(_ *wshrpc.BoardTalk, saved *wshrpc.BoardTurn) error {
		fw := saved.Forward
		if fw == nil || fw.State != t.Forward.State || fw.TabId != row.TabId {
			return errNotPending
		}
		if held {
			fw.State, fw.SentTs = boarddrawer.ForwardSent, time.Now().UnixMilli()
		} else {
			fw.State, fw.Reply, fw.ReplyTs = boarddrawer.ForwardReplied, reply, replyTs
		}
		return nil
	})
	if err != nil {
		log.Printf("board %s: moving the forward of turn %s: %v\n", p.boardId, p.turnId, err)
		return
	}
	f.after(b, turn, row)
}

// agentReply is the agent's reply to t's forward, read from its transcript.
func agentReply(ctx context.Context, row *agentRow, t wshrpc.BoardTurn) (string, int64, bool) {
	path, err := agentTranscriptPath(ctx, row)
	if err != nil {
		log.Printf("board forwards: finding %s's transcript: %v\n", row.TabId, err)
	}
	if path == "" {
		return "", 0, false
	}
	// the forward is typed after its turn was made, so nothing before the turn can hold its reply
	return boardforward.ReplyAfter(agentsessions.TurnsSince(path, row.Harness, t.Ts), t.ID)
}

// noteBoardForwardStatus has the forwarder sweep on every agent status event. A usage-only report carries no state.
func noteBoardForwardStatus(ev *wps.WaveEvent) {
	var data baseds.AgentStatusData
	if utilfn.ReUnmarshal(&data, ev.Data) != nil || data.State == "" {
		return
	}
	boardForwards.kick()
}

// updateBoardTurn changes one turn of a board's talk under the store's lock and returns it as saved.
func updateBoardTurn(ctx context.Context, b boarddrawer.Board, turnId string, fn func(*wshrpc.BoardTalk, *wshrpc.BoardTurn) error) (wshrpc.BoardTurn, error) {
	_, dir, err := boardDir(ctx, b.ChannelId)
	if err != nil {
		return wshrpc.BoardTurn{}, err
	}
	var saved wshrpc.BoardTurn
	_, err = boardstore.UpdateTalk(dir, b.BoardId, func(talk *wshrpc.BoardTalk) error {
		i := slices.IndexFunc(talk.Turns, func(t wshrpc.BoardTurn) bool { return t.ID == turnId })
		if i < 0 {
			return errNoSuchTurn
		}
		if err := fn(talk, &talk.Turns[i]); err != nil {
			return err
		}
		saved = talk.Turns[i]
		return nil
	})
	return saved, err
}

func readBoardTurn(ctx context.Context, b boarddrawer.Board, turnId string) (wshrpc.BoardTurn, bool) {
	_, dir, err := boardDir(ctx, b.ChannelId)
	if err != nil {
		return wshrpc.BoardTurn{}, false
	}
	talk, err := boardstore.ReadTalk(dir, b.BoardId)
	if err != nil {
		return wshrpc.BoardTurn{}, false
	}
	i := slices.IndexFunc(talk.Turns, func(t wshrpc.BoardTurn) bool { return t.ID == turnId })
	if i < 0 {
		return wshrpc.BoardTurn{}, false
	}
	return talk.Turns[i], true
}

func publishBoardTurn(b boarddrawer.Board, t wshrpc.BoardTurn) {
	publishBoardUpdate(wshrpc.BoardUpdateData{ChannelId: b.ChannelId, BoardId: b.BoardId, What: boardUpdateTalk, TurnId: t.ID, State: t.State, Reason: t.Reason})
}

// BoardRerouteCommand sends a turn the other way as a new turn naming it, leaving it as it was: a drawn turn of
// yours goes to the agent, a forwarded one to the drawer.
func (ws *WshServer) BoardRerouteCommand(ctx context.Context, data wshrpc.CommandBoardTurnData) error {
	b, _, err := drawerBoard(ctx, data.ChannelId, data.BoardId)
	if err != nil {
		return err
	}
	t, ok := readBoardTurn(ctx, b, data.TurnId)
	switch {
	case !ok:
		return errNoSuchTurn
	case t.Briefing != nil || t.Kept:
		return errors.New("an agent's own request is not sent the other way")
	case t.State == boarddrawer.StateForwarded:
		_, err := boardDrawer.Ask(b, wshrpc.BoardTurn{
			Question: t.Question, On: t.On, SelectedIds: t.SelectedIds, DrawingId: t.DrawingId, Route: boarddrawer.RouteDraw,
			From: t.ID,
		})
		return err
	case t.State != boarddrawer.StateAnswered:
		return fmt.Errorf("only a drawn or forwarded turn can be sent the other way, and this one is %s", t.State)
	}
	_, dir, err := boardDir(ctx, b.ChannelId)
	if err != nil {
		return err
	}
	sent := wshrpc.BoardTurn{
		ID: uuid.NewString(), Ts: time.Now().UnixMilli(), Question: t.Question, On: t.On, SelectedIds: t.SelectedIds,
		DrawingId: t.DrawingId, State: boarddrawer.StateForwarded, Route: boarddrawer.RouteAgent, From: t.ID,
	}
	_, err = boardstore.UpdateTalk(dir, b.BoardId, func(talk *wshrpc.BoardTalk) error {
		talk.Turns = append(talk.Turns, sent)
		return nil
	})
	if err != nil {
		return err
	}
	publishBoardTurn(b, sent)
	forwardBoardTurn(b, sent.ID)
	return nil
}

// BoardSetAgentCommand ties the board to a live claude or pi agent in its project and sends it the questions waiting
// for an agent. Earlier forwards keep the agent they went to.
func (ws *WshServer) BoardSetAgentCommand(ctx context.Context, data wshrpc.CommandBoardSetAgentData) error {
	b, _, err := drawerBoard(ctx, data.ChannelId, data.BoardId)
	if err != nil {
		return err
	}
	ch, dir, err := boardDir(ctx, b.ChannelId)
	if err != nil {
		return err
	}
	facts, err := loadAgentRosterFacts(ctx)
	if err != nil {
		return err
	}
	i := slices.IndexFunc(facts.Tabs, func(tf agentTabFacts) bool { return tf.Tab.OID == data.TabId })
	if i < 0 {
		return fmt.Errorf("tab %s is not an agent", data.TabId)
	}
	if why := agentNotLive(facts.Tabs[i]); why != "" {
		return fmt.Errorf("tab %s is not a live agent: %s", data.TabId, why)
	}
	row := findAgentRow(buildAgentRoster(facts), func(r agentRow) bool { return r.TabId == data.TabId })
	if at := wstore.MatchChannelAtPath(facts.Channels, row.ProjectPath); at == nil || at.OID != ch.OID {
		return fmt.Errorf("agent %s works in another project than %s", data.TabId, ch.Name)
	}
	agent, ok := boardAgentOf(facts.Tabs[i].Tab, ch.Name)
	if !ok {
		return fmt.Errorf("only a claude or pi agent can be a board's agent")
	}
	var waiting []string
	_, err = boardstore.UpdateTalk(dir, b.BoardId, func(talk *wshrpc.BoardTalk) error {
		talk.Agent, waiting = &agent, nil
		for _, t := range talk.Turns {
			if t.State == boarddrawer.StateForwarded && t.Forward != nil && t.Forward.State == boarddrawer.ForwardNeedsAgent {
				waiting = append(waiting, t.ID)
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	publishBoardList(ch.OID, b.BoardId)
	publishBoardJoin(ch.OID, b.BoardId, agent.TabId)
	for _, id := range waiting {
		forwardBoardTurn(b, id)
	}
	return nil
}
