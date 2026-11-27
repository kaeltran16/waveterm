// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/boarddrawer"
	"github.com/wavetermdev/waveterm/pkg/boardforward"
	"github.com/wavetermdev/waveterm/pkg/boardstore"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// forwardFixture is a board in a project tied to one live claude agent, with what was typed into agents.
type forwardFixture struct {
	t          *testing.T
	ctx        context.Context
	ch         *waveobj.Channel
	board      boarddrawer.Board
	dir        string
	facts      *agentRosterFacts
	agent      *agentTabFacts
	transcript string
	drawer     *drawerCalls

	mu    sync.Mutex
	typed []agentsDelivery
}

// newForwardFixture: the agent's tab and block ids are its own, so pending forwards other tests leave never reach it.
func newForwardFixture(t *testing.T, state string) *forwardFixture {
	t.Helper()
	ctx := context.Background()
	f := &forwardFixture{t: t, ctx: ctx}
	f.drawer = stubBoardDrawer(t, drawReply, nil)
	ch, project := boardProjectChannel(t, ctx)
	info := startBoard(t, ctx, wshrpc.CommandBoardStartData{ChannelId: ch.OID, Name: "Auth flow"})
	f.ch, f.dir = ch, boardstore.ProjectDir(ch.Name)
	f.board = boarddrawer.Board{ChannelId: ch.OID, BoardId: info.ID, Name: info.Name, ProjectPath: project}
	f.transcript = filepath.Join(t.TempDir(), "session.jsonl")
	tf := agentFacts(uuid.NewString(), "lead", uuid.NewString(), "claude", state)
	tf.ProjectPath, tf.Status.Cwd, tf.Status.TranscriptPath = project, project, f.transcript
	f.facts = &agentRosterFacts{Tabs: []agentTabFacts{tf}, Channels: []*waveobj.Channel{ch}}
	f.agent = &f.facts.Tabs[0]
	scriptAgents(t, f.facts)
	oldType := typeAgentMessage
	typeAgentMessage = func(blockId, text string) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.typed = append(f.typed, agentsDelivery{blockId, text})
	}
	oldForwards := boardForwards
	boardForwards = &boardForwarder{}
	t.Cleanup(func() { typeAgentMessage, boardForwards = oldType, oldForwards })
	return f
}

func (f *forwardFixture) typedNow() []agentsDelivery {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]agentsDelivery(nil), f.typed...)
}

// addAgent adds another live agent in the same project.
func (f *forwardFixture) addAgent(runtime string) *agentTabFacts {
	tf := agentFacts(uuid.NewString(), "other", uuid.NewString(), runtime, baseds.AgentState_Idle)
	tf.ProjectPath, tf.Status.Cwd = f.board.ProjectPath, f.board.ProjectPath
	f.facts.Tabs = append(f.facts.Tabs, tf)
	f.agent = &f.facts.Tabs[0]
	return &f.facts.Tabs[len(f.facts.Tabs)-1]
}

func (f *forwardFixture) boardAgent(tf *agentTabFacts) *wshrpc.BoardAgent {
	return &wshrpc.BoardAgent{TabId: tf.Tab.OID, Title: "claude · " + f.ch.Name, Runtime: tf.Status.Agent}
}

// seed writes the talk's agent and appends turn, returning the turn as saved.
func (f *forwardFixture) seed(agent *wshrpc.BoardAgent, turn wshrpc.BoardTurn) wshrpc.BoardTurn {
	f.t.Helper()
	if turn.ID == "" {
		turn.ID = uuid.NewString()
	}
	if turn.Ts == 0 {
		turn.Ts = time.Now().Add(-time.Minute).UnixMilli()
	}
	_, err := boardstore.UpdateTalk(f.dir, f.board.BoardId, func(talk *wshrpc.BoardTalk) error {
		talk.Agent = agent
		talk.Turns = append(talk.Turns, turn)
		return nil
	})
	if err != nil {
		f.t.Fatal(err)
	}
	return turn
}

func (f *forwardFixture) forwardedTurn(agent *wshrpc.BoardAgent) wshrpc.BoardTurn {
	return f.seed(agent, wshrpc.BoardTurn{
		Question: "why two stores?", On: "Login box, Token store", State: boarddrawer.StateForwarded, Route: boarddrawer.RouteAgent,
	})
}

func (f *forwardFixture) talk() wshrpc.BoardTalk {
	f.t.Helper()
	talk, err := boardstore.ReadTalk(f.dir, f.board.BoardId)
	if err != nil {
		f.t.Fatal(err)
	}
	return talk
}

func (f *forwardFixture) turn(id string) wshrpc.BoardTurn {
	f.t.Helper()
	for _, t := range f.talk().Turns {
		if t.ID == id {
			return t
		}
	}
	f.t.Fatalf("no turn %s", id)
	return wshrpc.BoardTurn{}
}

func (f *forwardFixture) forwardState(id string) string {
	f.t.Helper()
	if fw := f.turn(id).Forward; fw != nil {
		return fw.State
	}
	return ""
}

// status reports the agent in state, as its hook would: the roster reads it as the latest status.
func (f *forwardFixture) status(state string) {
	f.agent.Status.State = state
	oref := waveobj.MakeORef(waveobj.OType_Block, f.agent.BlockId).String()
	publishEvent(f.ctx, wps.WaveEvent{
		Event:  wps.Event_AgentStatus,
		Scopes: []string{oref},
		Data:   baseds.AgentStatusData{ORef: oref, State: state, Agent: "claude", Ts: time.Now().UnixMilli()},
	})
}

// write appends the transcript's records: a typed prompt or an assistant text, stamped now plus offset.
func (f *forwardFixture) write(speaker, text string, offset time.Duration) {
	f.t.Helper()
	content, err := json.Marshal(text)
	if err != nil {
		f.t.Fatal(err)
	}
	ts := time.Now().Add(offset).UTC().Format("2006-01-02T15:04:05.000Z")
	line := `{"type":"user","timestamp":"` + ts + `","origin":{"kind":"human"},"message":{"role":"user","content":` + string(content) + `}}`
	if speaker == "agent" {
		line = `{"type":"assistant","timestamp":"` + ts + `","message":{"content":[{"type":"text","text":` + string(content) + `}]}}`
	}
	file, err := os.OpenFile(f.transcript, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		f.t.Fatal(err)
	}
	defer file.Close()
	if _, err := file.WriteString(line + "\n"); err != nil {
		f.t.Fatal(err)
	}
}

func TestBoardForwardToIdleAgentTypesTheMarker(t *testing.T) {
	f := newForwardFixture(t, baseds.AgentState_Idle)
	turn := f.forwardedTurn(f.boardAgent(f.agent))

	forwardBoardTurn(f.board, turn.ID)

	typed := f.typedNow()
	if len(typed) != 1 || typed[0].blockId != f.agent.BlockId {
		t.Fatalf("typed %+v, want one message into %s", typed, f.agent.BlockId)
	}
	if want := boardforward.Marker("Auth flow", turn.On, turn.ID, turn.Question); typed[0].text != want {
		t.Errorf("typed %q, want %q", typed[0].text, want)
	}
	fw := f.turn(turn.ID).Forward
	if fw == nil || fw.State != "sent" || fw.SentTs == 0 || fw.TabId != f.agent.Tab.OID || fw.Runtime != "claude" {
		t.Errorf("forward: %+v", fw)
	}
}

func TestBoardForwardHeldWhileTheAgentAsks(t *testing.T) {
	f := newForwardFixture(t, baseds.AgentState_Asking)
	turn := f.forwardedTurn(f.boardAgent(f.agent))

	forwardBoardTurn(f.board, turn.ID)
	if typed := f.typedNow(); len(typed) != 0 || f.forwardState(turn.ID) != "held" {
		t.Fatalf("typed %+v, forward %s; want nothing typed and held", typed, f.forwardState(turn.ID))
	}
	for _, state := range []string{baseds.AgentState_Asking, baseds.AgentState_Waiting} {
		f.status(state)
		if typed := f.typedNow(); len(typed) != 0 || f.forwardState(turn.ID) != "held" {
			t.Fatalf("after %s: typed %+v, forward %s", state, typed, f.forwardState(turn.ID))
		}
	}
	f.status(baseds.AgentState_Working)
	f.status(baseds.AgentState_Idle)
	typed := f.typedNow()
	if len(typed) != 1 || !strings.HasPrefix(typed[0].text, `[From board "Auth flow"`) {
		t.Fatalf("typed %+v, want exactly one marked message", typed)
	}
	if fw := f.turn(turn.ID).Forward; fw.State != "sent" || fw.SentTs == 0 {
		t.Errorf("forward: %+v", fw)
	}
}

func TestBoardForwardReleasedByAnIdleStatus(t *testing.T) {
	f := newForwardFixture(t, baseds.AgentState_Waiting)
	turn := f.forwardedTurn(f.boardAgent(f.agent))
	forwardBoardTurn(f.board, turn.ID)
	f.status(baseds.AgentState_Idle)
	if typed := f.typedNow(); len(typed) != 1 || f.forwardState(turn.ID) != "sent" {
		t.Fatalf("typed %+v, forward %s", typed, f.forwardState(turn.ID))
	}
}

func TestBoardForwardNeedsAnAgent(t *testing.T) {
	f := newForwardFixture(t, baseds.AgentState_Idle)
	untied := f.forwardedTurn(nil)
	forwardBoardTurn(f.board, untied.ID)
	noAgent := f.turn(untied.ID).Forward

	gone := f.forwardedTurn(&wshrpc.BoardAgent{TabId: uuid.NewString(), Title: "claude · gone", Runtime: "claude"})
	forwardBoardTurn(f.board, gone.ID)
	tabGone := f.turn(gone.ID).Forward

	if noAgent == nil || noAgent.State != "needsagent" || noAgent.Reason == "" {
		t.Errorf("no agent: %+v", noAgent)
	}
	if tabGone == nil || tabGone.State != "needsagent" || tabGone.Reason == "" {
		t.Errorf("a tab that is gone: %+v", tabGone)
	}
	if noAgent != nil && tabGone != nil && noAgent.Reason == tabGone.Reason {
		t.Errorf("both read %q", noAgent.Reason)
	}
	if typed := f.typedNow(); len(typed) != 0 {
		t.Errorf("typed %+v", typed)
	}
}

func TestBoardForwardCopiesTheReplyAtTurnEnd(t *testing.T) {
	f := newForwardFixture(t, baseds.AgentState_Idle)
	f.write("user", "an earlier question", -2*time.Hour)
	f.write("agent", "an earlier answer", -2*time.Hour)
	turn := f.forwardedTurn(f.boardAgent(f.agent))
	forwardBoardTurn(f.board, turn.ID)
	f.write("user", f.typedNow()[0].text, time.Second)

	f.status(baseds.AgentState_Working)
	f.status(baseds.AgentState_Idle)
	if got := f.forwardState(turn.ID); got != "sent" {
		t.Fatalf("with no answer in the transcript the forward is %s", got)
	}
	f.write("agent", "one store caches the other", 2*time.Second)
	f.status(baseds.AgentState_Working)
	if got := f.forwardState(turn.ID); got != "sent" {
		t.Fatalf("mid-turn the forward is %s", got)
	}
	f.status(baseds.AgentState_Idle)
	fw := f.turn(turn.ID).Forward
	if fw.State != "replied" || fw.Reply != "one store caches the other" || fw.ReplyTs == 0 {
		t.Errorf("forward: %+v", fw)
	}
}

func TestBoardForwardReplyAfterRestart(t *testing.T) {
	f := newForwardFixture(t, baseds.AgentState_Idle)
	turn := f.forwardedTurn(f.boardAgent(f.agent))
	forwardBoardTurn(f.board, turn.ID)
	f.write("user", f.typedNow()[0].text, time.Second)
	f.write("agent", "one store caches the other", 2*time.Second)

	boardForwards = &boardForwarder{} // wavesrv restarted: the pending index is gone
	f.status(baseds.AgentState_Idle)

	if fw := f.turn(turn.ID).Forward; fw.State != "replied" || fw.Reply != "one store caches the other" {
		t.Errorf("forward: %+v", fw)
	}
}

// 11-27: a pending forward made every agent's status event read the whole roster, every run with it, starving the store
func TestBoardForwardIgnoresAnUnrelatedAgentsStatus(t *testing.T) {
	f := newForwardFixture(t, baseds.AgentState_Idle)
	other := f.addAgent("claude")
	turn := f.forwardedTurn(f.boardAgent(f.agent))
	forwardBoardTurn(f.board, turn.ID)
	f.write("user", f.typedNow()[0].text, time.Second)
	f.write("agent", "one store caches the other", 2*time.Second)
	var reads []string
	loadAgentRosterFacts = func(context.Context) (*agentRosterFacts, error) {
		reads = append(reads, "roster")
		return f.facts, nil
	}
	loadAgentTabFacts = func(_ context.Context, tabId string) (*agentTabFacts, error) {
		reads = append(reads, tabId)
		return nil, nil
	}

	for _, oref := range []waveobj.ORef{waveobj.MakeORef(waveobj.OType_Block, other.BlockId), waveobj.MakeORef(waveobj.OType_Tab, other.Tab.OID)} {
		publishEvent(f.ctx, wps.WaveEvent{
			Event:  wps.Event_AgentStatus,
			Scopes: []string{oref.String()},
			Data:   baseds.AgentStatusData{ORef: oref.String(), State: baseds.AgentState_Working, Agent: "claude", Ts: time.Now().UnixMilli()},
		})
	}

	if len(reads) != 0 {
		t.Errorf("an unrelated agent's events read %v", reads)
	}
	if got := f.forwardState(turn.ID); got != "sent" {
		t.Errorf("the forward is %s", got)
	}
}

func TestBoardRerouteDrawnTurnForwardsIt(t *testing.T) {
	f := newForwardFixture(t, baseds.AgentState_Idle)
	drawn := f.seed(f.boardAgent(f.agent), wshrpc.BoardTurn{
		Question: "show the cache", On: "Cache", SelectedIds: []string{"a"}, DrawingId: "f1", State: boarddrawer.StateAnswered,
		Route: boarddrawer.RouteDraw, Title: "cache", Added: 2, ShapeIds: []string{"s1"},
	})

	err := (&WshServer{}).BoardRerouteCommand(f.ctx, wshrpc.CommandBoardTurnData{ChannelId: f.ch.OID, BoardId: f.board.BoardId, TurnId: drawn.ID})
	if err != nil {
		t.Fatal(err)
	}
	turns := f.talk().Turns
	if len(turns) != 2 {
		t.Fatalf("turns: %+v", turns)
	}
	if !reflect.DeepEqual(turns[0], drawn) {
		t.Errorf("the original changed:\n got %+v\nwant %+v", turns[0], drawn)
	}
	sent := turns[1]
	if sent.From != drawn.ID || sent.State != boarddrawer.StateForwarded || sent.Route != boarddrawer.RouteAgent ||
		sent.Question != drawn.Question || sent.On != drawn.On || sent.DrawingId != drawn.DrawingId || sent.ID == drawn.ID {
		t.Errorf("forwarded turn: %+v", sent)
	}
	if sent.Forward == nil || sent.Forward.State != "sent" {
		t.Errorf("forward: %+v", sent.Forward)
	}
	if typed := f.typedNow(); len(typed) != 1 || !strings.Contains(typed[0].text, "turn "+sent.ID+"]") {
		t.Errorf("typed %+v", typed)
	}
	if n := len(f.drawer.list()); n != 0 {
		t.Errorf("the drawer ran %d times", n)
	}
}

func TestBoardRerouteForwardedTurnDrawsIt(t *testing.T) {
	f := newForwardFixture(t, baseds.AgentState_Idle)
	asked := f.seed(f.boardAgent(f.agent), wshrpc.BoardTurn{
		Question: "show the cache", On: "Cache", DrawingId: "f1", State: boarddrawer.StateForwarded, Route: boarddrawer.RouteAgent,
		Forward: &wshrpc.BoardForward{State: "sent", TabId: f.agent.Tab.OID, SentTs: 1},
	})

	err := (&WshServer{}).BoardRerouteCommand(f.ctx, wshrpc.CommandBoardTurnData{ChannelId: f.ch.OID, BoardId: f.board.BoardId, TurnId: asked.ID})
	if err != nil {
		t.Fatal(err)
	}
	waitIdle(t, f.ch.OID, f.board.BoardId)
	turns := f.talk().Turns
	if len(turns) != 2 || !reflect.DeepEqual(turns[0], asked) {
		t.Fatalf("turns: %+v", turns)
	}
	if drawn := turns[1]; drawn.From != asked.ID || drawn.Route != boarddrawer.RouteDraw || drawn.Question != asked.Question || drawn.On != asked.On ||
		drawn.DrawingId != asked.DrawingId {
		t.Errorf("the drawer's turn: %+v", drawn)
	}
	if calls := f.drawer.list(); len(calls) != 1 || !strings.Contains(calls[0].Prompt, "show the cache") {
		t.Errorf("drawer calls: %+v", calls)
	}
	if typed := f.typedNow(); len(typed) != 0 {
		t.Errorf("typed %+v", typed)
	}
}

func TestBoardRerouteRefusesOtherTurns(t *testing.T) {
	f := newForwardFixture(t, baseds.AgentState_Idle)
	failed := f.seed(nil, wshrpc.BoardTurn{Question: "show it", State: boarddrawer.StateFailed, Reason: "boom"})
	briefing := f.seed(nil, wshrpc.BoardTurn{
		Question: "the steps", State: boarddrawer.StateAnswered, Briefing: &wshrpc.BoardBriefing{From: "claude · x", Ask: "the steps"},
	})
	kept := f.seed(nil, wshrpc.BoardTurn{Question: "the steps", Kept: true, State: boarddrawer.StateAnswered})
	before := f.talk()
	for _, id := range []string{failed.ID, briefing.ID, kept.ID, uuid.NewString()} {
		err := (&WshServer{}).BoardRerouteCommand(f.ctx, wshrpc.CommandBoardTurnData{ChannelId: f.ch.OID, BoardId: f.board.BoardId, TurnId: id})
		if err == nil {
			t.Errorf("turn %s: want a refusal", id)
		}
	}
	if after := f.talk(); !reflect.DeepEqual(after, before) {
		t.Errorf("a refused reroute changed the talk: %+v", after.Turns)
	}
	if typed := f.typedNow(); len(typed) != 0 || len(f.drawer.list()) != 0 {
		t.Errorf("typed %+v, drawer ran %d times", typed, len(f.drawer.list()))
	}
}

func TestBoardSetAgentRefusesWhatIsNotALiveAgentHere(t *testing.T) {
	f := newForwardFixture(t, baseds.AgentState_Idle)
	codex := f.addAgent("codex")
	elsewhere := f.addAgent("claude")
	elsewhere.ProjectPath, elsewhere.Status.Cwd = t.TempDir(), ""
	f.agent.ShellRunning = false // its terminal closed
	for _, tabId := range []string{f.agent.Tab.OID, codex.Tab.OID, elsewhere.Tab.OID, uuid.NewString()} {
		err := (&WshServer{}).BoardSetAgentCommand(f.ctx, wshrpc.CommandBoardSetAgentData{ChannelId: f.ch.OID, BoardId: f.board.BoardId, TabId: tabId})
		if err == nil {
			t.Errorf("tab %s: want a refusal", tabId)
		}
	}
	if talk := f.talk(); talk.Agent != nil {
		t.Errorf("a refused tab tied the board: %+v", talk.Agent)
	}
}

func TestBoardSetAgentTiesAndSendsWaitingQuestions(t *testing.T) {
	f := newForwardFixture(t, baseds.AgentState_Idle)
	earlier := f.addAgent("claude")
	sentBefore := f.seed(nil, wshrpc.BoardTurn{
		Question: "first", State: boarddrawer.StateForwarded, Route: boarddrawer.RouteAgent,
		Forward: &wshrpc.BoardForward{State: "replied", TabId: earlier.Tab.OID, Reply: "yes"},
	})
	waiting := f.forwardedTurn(nil)
	forwardBoardTurn(f.board, waiting.ID)
	if got := f.forwardState(waiting.ID); got != "needsagent" {
		t.Fatalf("an untied board's forward is %s", got)
	}
	client := &boardEventClient{}
	old := wps.Broker.GetClient()
	wps.Broker.SetClient(client)
	wps.Broker.Subscribe("board-setagent-test", wps.SubscriptionRequest{Event: wps.Event_BoardUpdate, AllScopes: true})
	t.Cleanup(func() {
		wps.Broker.UnsubscribeAll("board-setagent-test")
		wps.Broker.SetClient(old)
	})

	start := time.Now().UnixMilli()
	err := (&WshServer{}).BoardSetAgentCommand(f.ctx, wshrpc.CommandBoardSetAgentData{ChannelId: f.ch.OID, BoardId: f.board.BoardId, TabId: f.agent.Tab.OID})
	if err != nil {
		t.Fatal(err)
	}

	talk := f.talk()
	if a := talk.Agent; a == nil || a.TabId != f.agent.Tab.OID || a.Runtime != "claude" || a.Title != "claude · "+f.ch.Name || a.ReadTs < start {
		t.Errorf("agent: %+v", talk.Agent)
	}
	if fw := f.turn(waiting.ID).Forward; fw.State != "sent" || fw.TabId != f.agent.Tab.OID {
		t.Errorf("the waiting question: %+v", fw)
	}
	if fw := f.turn(sentBefore.ID).Forward; fw.TabId != earlier.Tab.OID || fw.State != "replied" {
		t.Errorf("an earlier forward moved: %+v", fw)
	}
	if typed := f.typedNow(); len(typed) != 1 || typed[0].blockId != f.agent.BlockId || !strings.Contains(typed[0].text, "turn "+waiting.ID+"]") {
		t.Errorf("typed %+v", typed)
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	var list, join bool
	for _, ev := range client.events {
		u, ok := ev.Data.(wshrpc.BoardUpdateData)
		if !ok || u.BoardId != f.board.BoardId {
			continue
		}
		list = list || u.What == "list"
		join = join || (u.What == "join" && u.AgentTabId == f.agent.Tab.OID && u.ChannelId == f.ch.OID)
	}
	if !list || !join {
		t.Errorf("list %v, join %v in %+v", list, join, client.events)
	}
}
