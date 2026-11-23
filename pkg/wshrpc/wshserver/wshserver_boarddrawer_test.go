// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/boarddrawer"
	"github.com/wavetermdev/waveterm/pkg/boardstore"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	// wordsReply is the 11-12 words answer: it draws nothing, so on your own ask it goes to the agent
	wordsReply    = `{"reply":"Two processes."}`
	drawReply     = `{"title":"wavesrv","add":[{"type":"rectangle","id":"a","x":0,"y":0,"width":10,"height":10}]}`
	questionReply = `{"question":true}`
)

// drawerCalls is the stubbed drawer model: the calls it got, and a gate that holds every run until it is opened.
type drawerCalls struct {
	mu     sync.Mutex
	calls  []boarddrawer.Call
	cwds   []string
	active int
	most   int
	gate   chan struct{}
	reply  string
}

func (r *drawerCalls) run(ctx context.Context, cwd string, c boarddrawer.Call) (boarddrawer.Reply, error) {
	r.mu.Lock()
	r.calls = append(r.calls, c)
	r.cwds = append(r.cwds, cwd)
	r.active++
	r.most = max(r.most, r.active)
	gate, reply := r.gate, r.reply
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		r.active--
		r.mu.Unlock()
	}()
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return boarddrawer.Reply{}, ctx.Err()
		}
	}
	return boarddrawer.Reply{Text: reply}, nil
}

func (r *drawerCalls) mostAtOnce() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.most
}

func (r *drawerCalls) list() []boarddrawer.Call {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.calls)
}

// stubBoardDrawer swaps in a drawer whose model replies reply, held by gate when gate is not nil.
func stubBoardDrawer(t *testing.T, reply string, gate chan struct{}) *drawerCalls {
	t.Helper()
	r := &drawerCalls{reply: reply, gate: gate}
	old := boardDrawer
	boardDrawer = newBoardDrawer(r.run)
	t.Cleanup(func() { boardDrawer = old })
	return r
}

func waitIdle(t *testing.T, channelId, boardId string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for boardDrawer.Busy(channelId, boardId) {
		if time.Now().After(deadline) {
			t.Fatalf("the drawer is still busy on %s", boardId)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func readTalk(t *testing.T, ctx context.Context, channelId, boardId string) wshrpc.BoardTalk {
	t.Helper()
	talk, err := (&WshServer{}).BoardTalkCommand(ctx, wshrpc.CommandBoardRefData{ChannelId: channelId, BoardId: boardId})
	if err != nil {
		t.Fatalf("talk: %v", err)
	}
	return *talk
}

func startBoard(t *testing.T, ctx context.Context, data wshrpc.CommandBoardStartData) wshrpc.BoardInfo {
	t.Helper()
	info, err := (&WshServer{}).BoardStartCommand(ctx, data)
	if err != nil {
		t.Fatalf("start %q: %v", data.Name, err)
	}
	return *info
}

func TestBoardStartEmptyMakesNoTurn(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	r := stubBoardDrawer(t, wordsReply, nil)
	ch, _ := boardProjectChannel(t, ctx)
	if _, err := ws.BoardStartCommand(ctx, wshrpc.CommandBoardStartData{ChannelId: ch.OID, Name: "  "}); err == nil || err.Error() != "Type a name first" {
		t.Errorf("an empty name: %v", err)
	}
	if _, err := ws.BoardStartCommand(ctx, wshrpc.CommandBoardStartData{ChannelId: ch.OID, Name: "x", About: wshrpc.BoardSource{Kind: "planet"}}); err == nil {
		t.Error("an unknown about kind was accepted")
	}
	if _, err := ws.BoardStartCommand(ctx, wshrpc.CommandBoardStartData{ChannelId: ch.OID, Name: "x", About: wshrpc.BoardSource{Kind: "run"}}); err == nil {
		t.Error("a run about with no ref was accepted")
	}
	about := wshrpc.BoardSource{Kind: "project", Title: ch.Name}
	info := startBoard(t, ctx, wshrpc.CommandBoardStartData{ChannelId: ch.OID, Name: " Auth flow ", About: about})
	if info.Name != "Auth flow" || !boardstore.ValidID(info.ID) {
		t.Fatalf("info: %+v", info)
	}
	talk := readTalk(t, ctx, ch.OID, info.ID)
	if len(talk.Turns) != 0 || talk.ChannelId != ch.OID || talk.About != about || talk.Handoff != nil {
		t.Errorf("talk: %+v", talk)
	}
	list, err := ws.BoardListCommand(ctx, wshrpc.CommandBoardListData{ChannelId: ch.OID})
	if err != nil || len(list.Boards) != 1 {
		t.Fatalf("only the named board is made: %+v %v", list, err)
	}
	if n := len(r.list()); n != 0 {
		t.Errorf("an empty board ran the drawer %d times", n)
	}
}

func TestBoardStartWithQuestionStartsTurn(t *testing.T) {
	ctx := context.Background()
	r := stubBoardDrawer(t, drawReply, nil)
	ch, project := boardProjectChannel(t, ctx)
	info := startBoard(t, ctx, wshrpc.CommandBoardStartData{ChannelId: ch.OID, Name: "Auth flow", Question: " How does it start? "})
	waitIdle(t, ch.OID, info.ID)
	talk := readTalk(t, ctx, ch.OID, info.ID)
	if len(talk.Turns) != 1 || talk.Turns[0].Question != "How does it start?" || talk.Turns[0].State != boarddrawer.StateAnswered ||
		talk.Turns[0].Route != boarddrawer.RouteDraw || talk.Turns[0].Reply != "" || talk.Turns[0].Title != "wavesrv" {
		t.Fatalf("turns: %+v", talk.Turns)
	}
	calls := r.list()
	r.mu.Lock()
	cwds := slices.Clone(r.cwds)
	r.mu.Unlock()
	if len(calls) != 1 || calls[0].Resume || calls[0].SessionId != talk.SessionId || cwds[0] != project ||
		!strings.Contains(calls[0].Prompt, "How does it start?") {
		t.Errorf("calls: %+v, cwds %v", calls, cwds)
	}
}

func TestBoardStartCopiesElementsAndHandoff(t *testing.T) {
	ctx := context.Background()
	stubBoardDrawer(t, wordsReply, nil)
	ch, _ := boardProjectChannel(t, ctx)
	from := startBoard(t, ctx, wshrpc.CommandBoardStartData{ChannelId: ch.OID, Name: "Auth flow"})
	// a labelled box and an arrow: the bound text is part of its box
	elements := `[{"id":"n1","type":"rectangle","x":0,"y":0,"width":10,"height":10},` +
		`{"id":"n2","type":"text","x":1,"y":1,"text":"wavesrv","containerId":"n1"},` +
		`{"id":"n3","type":"arrow","x":20,"y":0,"width":10,"height":0}]`
	about := wshrpc.BoardSource{Kind: "project"}
	info := startBoard(t, ctx, wshrpc.CommandBoardStartData{ChannelId: ch.OID, Name: "Auth, part two", About: about, FromBoardId: from.ID, Elements: elements})
	read, err := (&WshServer{}).BoardReadCommand(ctx, wshrpc.CommandBoardRefData{ChannelId: ch.OID, BoardId: info.ID})
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Elements []struct {
			Id string `json:"id"`
		} `json:"elements"`
	}
	if err := json.Unmarshal([]byte(read.Data), &file); err != nil || len(file.Elements) != 3 || file.Elements[1].Id != "n2" {
		t.Fatalf("copied elements: %+v %v", file.Elements, err)
	}
	talk := readTalk(t, ctx, ch.OID, info.ID)
	want := wshrpc.BoardHandoff{FromBoardId: from.ID, FromName: "Auth flow", Shapes: 2}
	if talk.Handoff == nil || *talk.Handoff != want || talk.About != about || len(talk.Turns) != 0 {
		t.Errorf("talk: %+v, handoff %+v", talk, talk.Handoff)
	}
}

func TestBoardStartRefusesBadFromBoard(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	r := stubBoardDrawer(t, wordsReply, nil)
	ch, _ := boardProjectChannel(t, ctx)
	other, _ := boardProjectChannel(t, ctx)
	elsewhere := startBoard(t, ctx, wshrpc.CommandBoardStartData{ChannelId: other.OID, Name: "Theirs"})
	for _, from := range []string{"../x", "ABCDEF12", "0000aaaa", elsewhere.ID} {
		_, err := ws.BoardStartCommand(ctx, wshrpc.CommandBoardStartData{ChannelId: ch.OID, Name: "Next", FromBoardId: from, Question: "q"})
		if err == nil {
			t.Errorf("from board %q was accepted", from)
		}
	}
	list, err := ws.BoardListCommand(ctx, wshrpc.CommandBoardListData{ChannelId: ch.OID})
	if err != nil || len(list.Boards) != 0 {
		t.Errorf("a refused start made a board: %+v %v", list, err)
	}
	if n := len(r.list()); n != 0 {
		t.Errorf("a refused start ran the drawer %d times", n)
	}
}

func TestBoardAskRefusesWontOpen(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	r := stubBoardDrawer(t, wordsReply, nil)
	ch, _ := boardProjectChannel(t, ctx)
	info := startBoard(t, ctx, wshrpc.CommandBoardStartData{ChannelId: ch.OID, Name: "Broken"})
	if err := os.WriteFile(info.Path, []byte(`{"arc":{"name":"Broken"},"elements":[{"id":`), 0o644); err != nil {
		t.Fatal(err)
	}
	err := ws.BoardAskCommand(ctx, wshrpc.CommandBoardAskData{ChannelId: ch.OID, BoardId: info.ID, Question: "why?"})
	if err == nil || !strings.Contains(err.Error(), "won't open") {
		t.Errorf("ask on a damaged board: %v", err)
	}
	// its talk still shows
	if talk := readTalk(t, ctx, ch.OID, info.ID); len(talk.Turns) != 0 {
		t.Errorf("a refused ask left a turn: %+v", talk.Turns)
	}
	if err := ws.BoardAskCommand(ctx, wshrpc.CommandBoardAskData{ChannelId: ch.OID, BoardId: "0000aaaa", Question: "why?"}); err == nil {
		t.Error("ask on a missing board was accepted")
	}
	if n := len(r.list()); n != 0 {
		t.Errorf("a refused ask ran the drawer %d times", n)
	}
}

func TestBoardAskRefusesWhileBusy(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	gate := make(chan struct{})
	r := stubBoardDrawer(t, drawReply, gate)
	ch, _ := boardProjectChannel(t, ctx)
	info := startBoard(t, ctx, wshrpc.CommandBoardStartData{ChannelId: ch.OID, Name: "Auth flow"})
	ask := wshrpc.CommandBoardAskData{ChannelId: ch.OID, BoardId: info.ID, Question: "How?", On: "wavesrv", SelectedIds: []string{"n1"}, DrawingId: "f1"}
	if err := ws.BoardAskCommand(ctx, ask); err != nil {
		t.Fatal(err)
	}
	err := ws.BoardAskCommand(ctx, ask)
	if err == nil || err.Error() != boarddrawer.BusyReason {
		t.Errorf("a second ask while busy: %v", err)
	}
	if err := ws.BoardAskStopCommand(ctx, wshrpc.CommandBoardRefData{ChannelId: ch.OID, BoardId: info.ID}); err != nil {
		t.Fatal(err)
	}
	waitIdle(t, ch.OID, info.ID)
	talk := readTalk(t, ctx, ch.OID, info.ID)
	if len(talk.Turns) != 1 || talk.Turns[0].State != boarddrawer.StateStopped || talk.Turns[0].On != "wavesrv" ||
		!slices.Equal(talk.Turns[0].SelectedIds, []string{"n1"}) || talk.Turns[0].DrawingId != "f1" {
		t.Fatalf("turns: %+v", talk.Turns)
	}
	close(gate)
	if err := ws.BoardAskRetryCommand(ctx, wshrpc.CommandBoardTurnData{ChannelId: ch.OID, BoardId: info.ID, TurnId: talk.Turns[0].ID}); err != nil {
		t.Fatal(err)
	}
	waitIdle(t, ch.OID, info.ID)
	if got := readTalk(t, ctx, ch.OID, info.ID).Turns[0]; got.State != boarddrawer.StateAnswered {
		t.Errorf("retried: %+v", got)
	}
	if n := r.mostAtOnce(); n != 1 {
		t.Errorf("%d sessions ran at once on one board", n)
	}
}

func TestBoardAnswerAckRecordsShapeIds(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	stubBoardDrawer(t, drawReply, nil)
	ch, _ := boardProjectChannel(t, ctx)
	info := startBoard(t, ctx, wshrpc.CommandBoardStartData{ChannelId: ch.OID, Name: "Auth flow", Question: "How?"})
	waitIdle(t, ch.OID, info.ID)
	inbox := wshrpc.CommandBoardInboxData{ChannelId: ch.OID, BoardId: info.ID}
	answers, err := ws.BoardAnswerInboxCommand(ctx, inbox)
	if err != nil || len(answers) != 1 {
		t.Fatalf("inbox: %+v %v", answers, err)
	}
	a := answers[0]
	turn := readTalk(t, ctx, ch.OID, info.ID).Turns[0]
	if a.ChannelId != ch.OID || a.BoardId != info.ID || a.TurnId != turn.ID || !strings.Contains(a.Add, `"rectangle"`) {
		t.Errorf("answer: %+v", a)
	}
	ack := wshrpc.CommandBoardAnswerAckData{ChannelId: ch.OID, BoardId: info.ID, AnswerId: a.ID, TurnId: a.TurnId, ShapeIds: []string{"x1", "x2"}}
	if err := ws.BoardAnswerAckCommand(ctx, ack); err != nil {
		t.Fatal(err)
	}
	if left, err := ws.BoardAnswerInboxCommand(ctx, inbox); err != nil || len(left) != 0 {
		t.Errorf("an acked answer is still waiting: %+v %v", left, err)
	}
	if got := readTalk(t, ctx, ch.OID, info.ID).Turns[0]; !slices.Equal(got.ShapeIds, []string{"x1", "x2"}) {
		t.Errorf("shape ids: %+v", got)
	}
	ack.TurnId = ""
	if err := ws.BoardAnswerAckCommand(ctx, ack); err == nil {
		t.Error("an ack with no turn was accepted")
	}
}

func TestBoardAnswerInboxAllProjects(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	stubBoardDrawer(t, drawReply, nil)
	one, _ := boardProjectChannel(t, ctx)
	two, _ := boardProjectChannel(t, ctx)
	b1 := startBoard(t, ctx, wshrpc.CommandBoardStartData{ChannelId: one.OID, Name: "One", Question: "q"})
	waitIdle(t, one.OID, b1.ID)
	b2 := startBoard(t, ctx, wshrpc.CommandBoardStartData{ChannelId: two.OID, Name: "Two", Question: "q"})
	waitIdle(t, two.OID, b2.ID)
	all, err := ws.BoardAnswerInboxCommand(ctx, wshrpc.CommandBoardInboxData{})
	if err != nil {
		t.Fatal(err)
	}
	// other tests' boards share the root: look only at these two
	got := map[string]string{}
	for _, a := range all {
		if a.BoardId == b1.ID || a.BoardId == b2.ID {
			got[a.BoardId] = a.ChannelId
		}
	}
	if got[b1.ID] != one.OID || got[b2.ID] != two.OID || len(got) != 2 {
		t.Errorf("every project's answers, each naming its channel: %v", got)
	}
	if _, err := ws.BoardAnswerInboxCommand(ctx, wshrpc.CommandBoardInboxData{BoardId: b1.ID}); err == nil {
		t.Error("a board id with no channel was accepted")
	}
}

func stubAgentCwd(t *testing.T, cwd string) {
	t.Helper()
	old := boardAgentCwd
	boardAgentCwd = func(context.Context, string, string) string { return cwd }
	t.Cleanup(func() { boardAgentCwd = old })
}

func TestBoardAgentDrawNewBoardFromBriefing(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	r := stubBoardDrawer(t, drawReply, nil)
	ch, project := boardProjectChannel(t, ctx)
	stubAgentCwd(t, project)
	tabId, blockId := seedAgentTab(t, ctx, waveobj.MetaMapType{waveobj.MetaKey_SessionAgent: "claude"})

	rtn, err := ws.BoardAgentDrawCommand(ctx, wshrpc.CommandBoardAgentDrawData{
		BlockId: blockId, Board: " Auth Flow ", Context: " The login goes through wavesrv. ", Ask: " the steps ",
	})
	if err != nil {
		t.Fatalf("agent draw: %v", err)
	}
	if !rtn.Created || rtn.BoardName != "Auth Flow" || rtn.Project != ch.Name || !boardstore.ValidID(rtn.BoardId) {
		t.Fatalf("rtn: %+v", rtn)
	}
	waitIdle(t, ch.OID, rtn.BoardId)
	talk := readTalk(t, ctx, ch.OID, rtn.BoardId)
	from := "claude · " + ch.Name
	wantAbout := wshrpc.BoardSource{Kind: "briefing", Ref: tabId, Title: from, Text: "The login goes through wavesrv."}
	if talk.About != wantAbout || talk.ChannelId != ch.OID {
		t.Errorf("about: %+v", talk.About)
	}
	if len(talk.Turns) != 1 {
		t.Fatalf("turns: %+v", talk.Turns)
	}
	turn := talk.Turns[0]
	wantBrief := wshrpc.BoardBriefing{From: from, Text: "The login goes through wavesrv.", Ask: "the steps"}
	if turn.Briefing == nil || *turn.Briefing != wantBrief || turn.Question != "the steps" || turn.State != boarddrawer.StateAnswered {
		t.Errorf("turn: %+v, briefing %+v", turn, turn.Briefing)
	}
	if calls := r.list(); len(calls) != 1 || !strings.Contains(calls[0].Prompt, "The login goes through wavesrv.") {
		t.Errorf("calls: %+v", calls)
	}
}

// writeActiveBoard writes a board named name created (so last active) at ts.
func writeActiveBoard(t *testing.T, dir, id, name string, ts int64) {
	t.Helper()
	arc, err := json.Marshal(wshrpc.BoardArcRecord{Name: name, CreatedTs: ts})
	if err != nil {
		t.Fatal(err)
	}
	body := `{"arc":` + string(arc) + `,"type":"excalidraw","version":2,"source":"arc","elements":[],"appState":{},"files":{}}`
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, id+".excalidraw"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestBoardAgentDrawQueuesOnExistingBoard(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	gate := make(chan struct{})
	r := stubBoardDrawer(t, drawReply, gate)
	ch, project := boardProjectChannel(t, ctx)
	stubAgentCwd(t, project)
	_, blockId := seedAgentTab(t, ctx, waveobj.MetaMapType{waveobj.MetaKey_SessionLabel: "auth agent"})
	// two boards whose names differ only in case: the most recently active one wins
	dir := boardstore.ProjectDir(ch.Name)
	const later = int64(1) << 60
	writeActiveBoard(t, dir, "aaaa0001", "auth flow", later+200)
	writeActiveBoard(t, dir, "aaaa0002", "AUTH FLOW", later+100)

	if err := ws.BoardAskCommand(ctx, wshrpc.CommandBoardAskData{ChannelId: ch.OID, BoardId: "aaaa0001", Question: "mine"}); err != nil {
		t.Fatal(err)
	}
	rtn, err := ws.BoardAgentDrawCommand(ctx, wshrpc.CommandBoardAgentDrawData{BlockId: blockId, Board: "Auth FLOW", Context: "the briefing", Ask: "theirs"})
	if err != nil {
		t.Fatalf("a briefing on a busy board: %v", err)
	}
	if rtn.Created || rtn.BoardId != "aaaa0001" || rtn.BoardName != "auth flow" {
		t.Errorf("rtn: %+v", rtn)
	}
	talk := readTalk(t, ctx, ch.OID, "aaaa0001")
	if len(talk.Turns) != 2 || talk.Turns[1].State != boarddrawer.StateWaiting || talk.Turns[1].Briefing.From != "auth agent" {
		t.Fatalf("turns: %+v", talk.Turns)
	}
	if talk.About.Kind != "" {
		t.Errorf("a briefing on an existing board changed its about: %+v", talk.About)
	}
	close(gate)
	waitIdle(t, ch.OID, "aaaa0001")
	for _, turn := range readTalk(t, ctx, ch.OID, "aaaa0001").Turns {
		if turn.State != boarddrawer.StateAnswered {
			t.Errorf("turn: %+v", turn)
		}
	}
	if r.mostAtOnce() != 1 || len(r.list()) != 2 {
		t.Errorf("runs %d, at most %d at once", len(r.list()), r.mostAtOnce())
	}
	list, err := ws.BoardListCommand(ctx, wshrpc.CommandBoardListData{ChannelId: ch.OID})
	if err != nil || len(list.Boards) != 2 {
		t.Errorf("an existing name made a board: %+v %v", list, err)
	}
}

func TestBoardAgentDrawNeedsContextOnlyToCreate(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	r := stubBoardDrawer(t, drawReply, nil)
	ch, project := boardProjectChannel(t, ctx)
	stubAgentCwd(t, project)
	_, blockId := seedAgentTab(t, ctx, nil)
	for _, brief := range []string{"", "   "} {
		_, err := ws.BoardAgentDrawCommand(ctx, wshrpc.CommandBoardAgentDrawData{BlockId: blockId, Board: "Auth flow", Ask: "the steps", Context: brief})
		if err == nil || !strings.Contains(err.Error(), "--context") {
			t.Errorf("briefing %q on a board that does not exist: %v", brief, err)
		}
	}
	if _, err := ws.BoardAgentDrawCommand(ctx, wshrpc.CommandBoardAgentDrawData{BlockId: blockId, Context: "x"}); err == nil {
		t.Error("an agent draw with no board name was accepted")
	}
	list, err := ws.BoardListCommand(ctx, wshrpc.CommandBoardListData{ChannelId: ch.OID})
	if err != nil || len(list.Boards) != 0 {
		t.Errorf("a refused draw made a board: %+v %v", list, err)
	}
	if n := len(r.list()); n != 0 {
		t.Errorf("a refused draw ran the drawer %d times", n)
	}

	first, err := ws.BoardAgentDrawCommand(ctx, wshrpc.CommandBoardAgentDrawData{BlockId: blockId, Board: "Auth flow", Context: "The login goes through wavesrv.", Ask: "the steps"})
	if err != nil {
		t.Fatalf("the first request: %v", err)
	}
	waitIdle(t, ch.OID, first.BoardId)
	later, err := ws.BoardAgentDrawCommand(ctx, wshrpc.CommandBoardAgentDrawData{BlockId: blockId, Board: "auth flow", Ask: " add the retry path "})
	if err != nil {
		t.Fatalf("a later request with --ask alone: %v", err)
	}
	if later.Created || later.BoardId != first.BoardId {
		t.Errorf("later: %+v", later)
	}
	waitIdle(t, ch.OID, first.BoardId)
	turns := readTalk(t, ctx, ch.OID, first.BoardId).Turns
	if len(turns) != 2 {
		t.Fatalf("turns: %+v", turns)
	}
	if b := turns[1].Briefing; b == nil || b.Text != "" || b.Ask != "add the retry path" || turns[1].Question != "add the retry path" {
		t.Errorf("a later request is one line: %+v", turns[1])
	}
	if _, err := ws.BoardAgentDrawCommand(ctx, wshrpc.CommandBoardAgentDrawData{BlockId: blockId, Board: "Auth flow"}); err == nil {
		t.Error("a request with neither --context nor --ask was accepted")
	}
}

// collectBoardJoins records the join announcements published until the test ends.
func collectBoardJoins(t *testing.T) func() []wshrpc.BoardUpdateData {
	t.Helper()
	client := &boardEventClient{}
	old := wps.Broker.GetClient()
	wps.Broker.SetClient(client)
	subscriber := "board-joins-" + t.Name()
	wps.Broker.Subscribe(subscriber, wps.SubscriptionRequest{Event: wps.Event_BoardUpdate, AllScopes: true})
	t.Cleanup(func() {
		wps.Broker.UnsubscribeAll(subscriber)
		wps.Broker.SetClient(old)
	})
	return func() []wshrpc.BoardUpdateData {
		client.mu.Lock()
		defer client.mu.Unlock()
		joins := []wshrpc.BoardUpdateData{}
		for _, e := range client.events {
			if u, ok := e.Data.(wshrpc.BoardUpdateData); ok && u.What == boardUpdateJoin {
				joins = append(joins, u)
			}
		}
		return joins
	}
}

func TestBoardAgentDrawTiesANewBoardAndAnnouncesTheJoin(t *testing.T) {
	ctx := context.Background()
	gate := make(chan struct{})
	stubBoardDrawer(t, drawReply, gate)
	joins := collectBoardJoins(t)
	ch, project := boardProjectChannel(t, ctx)
	stubAgentCwd(t, project)
	tabId, blockId := seedAgentTab(t, ctx, waveobj.MetaMapType{waveobj.MetaKey_SessionAgent: "pi", waveobj.MetaKey_SessionLabel: "auth agent"})
	ws := &WshServer{}

	rtn, err := ws.BoardAgentDrawCommand(ctx, wshrpc.CommandBoardAgentDrawData{BlockId: blockId, Board: "Auth flow", Context: "the briefing", Ask: "the steps"})
	if err != nil {
		t.Fatal(err)
	}
	// the drawer is still held: the board joins the workspace before its first turn ends
	want := wshrpc.BoardUpdateData{ChannelId: ch.OID, BoardId: rtn.BoardId, What: "join", AgentTabId: tabId}
	if got := joins(); len(got) != 1 || got[0] != want {
		t.Errorf("joins while the turn runs: %+v, want [%+v]", got, want)
	}
	close(gate)
	waitIdle(t, ch.OID, rtn.BoardId)
	got := readTalk(t, ctx, ch.OID, rtn.BoardId).Agent
	if got == nil || got.TabId != tabId || got.Title != "auth agent" || got.Runtime != "pi" {
		t.Errorf("tie: %+v", got)
	}

	// each later draw by the tied agent announces again, so a closed tab comes back
	if _, err := ws.BoardAgentDrawCommand(ctx, wshrpc.CommandBoardAgentDrawData{BlockId: blockId, Board: "Auth flow", Ask: "more"}); err != nil {
		t.Fatal(err)
	}
	waitIdle(t, ch.OID, rtn.BoardId)
	if got := joins(); len(got) != 2 || got[1] != want {
		t.Errorf("joins after a second draw: %+v", got)
	}
}

func TestBoardAgentDrawByCodexLeavesTheBoardUntied(t *testing.T) {
	ctx := context.Background()
	stubBoardDrawer(t, drawReply, nil)
	joins := collectBoardJoins(t)
	ch, project := boardProjectChannel(t, ctx)
	stubAgentCwd(t, project)
	_, blockId := seedAgentTab(t, ctx, waveobj.MetaMapType{waveobj.MetaKey_SessionAgent: "codex"})

	rtn, err := (&WshServer{}).BoardAgentDrawCommand(ctx, wshrpc.CommandBoardAgentDrawData{BlockId: blockId, Board: "Auth flow", Context: "the briefing", Ask: "the steps"})
	if err != nil {
		t.Fatal(err)
	}
	waitIdle(t, ch.OID, rtn.BoardId)
	if talk := readTalk(t, ctx, ch.OID, rtn.BoardId); talk.Agent != nil || len(talk.Turns) != 1 {
		t.Errorf("a codex agent's board: agent %+v, turns %d", talk.Agent, len(talk.Turns))
	}
	if got := joins(); len(got) != 0 {
		t.Errorf("joins: %+v", got)
	}
}

func TestBoardAgentDrawKeepsAnotherAgentsTie(t *testing.T) {
	ctx := context.Background()
	stubBoardDrawer(t, drawReply, nil)
	joins := collectBoardJoins(t)
	ch, project := boardProjectChannel(t, ctx)
	stubAgentCwd(t, project)
	firstTab, firstBlock := seedAgentTab(t, ctx, waveobj.MetaMapType{waveobj.MetaKey_SessionAgent: "claude"})
	_, secondBlock := seedAgentTab(t, ctx, waveobj.MetaMapType{waveobj.MetaKey_SessionAgent: "claude"})
	ws := &WshServer{}

	rtn, err := ws.BoardAgentDrawCommand(ctx, wshrpc.CommandBoardAgentDrawData{BlockId: firstBlock, Board: "Auth flow", Context: "first", Ask: "a"})
	if err != nil {
		t.Fatal(err)
	}
	waitIdle(t, ch.OID, rtn.BoardId)
	if _, err := ws.BoardAgentDrawCommand(ctx, wshrpc.CommandBoardAgentDrawData{BlockId: secondBlock, Board: "Auth flow", Context: "second", Ask: "b"}); err != nil {
		t.Fatal(err)
	}
	waitIdle(t, ch.OID, rtn.BoardId)
	talk := readTalk(t, ctx, ch.OID, rtn.BoardId)
	if talk.Agent == nil || talk.Agent.TabId != firstTab {
		t.Errorf("the second agent took the tie: %+v", talk.Agent)
	}
	if len(talk.Turns) != 2 || talk.Turns[1].Briefing == nil {
		t.Errorf("the second agent's draw is still drawn as its request: %+v", talk.Turns)
	}
	if got := joins(); len(got) != 1 || got[0].AgentTabId != firstTab {
		t.Errorf("joins: %+v, want only the first agent's", got)
	}
}

func TestBoardAgentDrawTiesAnUntiedBoard(t *testing.T) {
	ctx := context.Background()
	stubBoardDrawer(t, drawReply, nil)
	joins := collectBoardJoins(t)
	ch, project := boardProjectChannel(t, ctx)
	stubAgentCwd(t, project)
	tabId, blockId := seedAgentTab(t, ctx, waveobj.MetaMapType{waveobj.MetaKey_SessionAgent: "claude"})
	// a board the user made, with no agent
	info := startBoard(t, ctx, wshrpc.CommandBoardStartData{ChannelId: ch.OID, Name: "Auth flow"})

	if _, err := (&WshServer{}).BoardAgentDrawCommand(ctx, wshrpc.CommandBoardAgentDrawData{BlockId: blockId, Board: "auth flow", Context: "the briefing", Ask: "the steps"}); err != nil {
		t.Fatal(err)
	}
	waitIdle(t, ch.OID, info.ID)
	talk := readTalk(t, ctx, ch.OID, info.ID)
	if talk.Agent == nil || talk.Agent.TabId != tabId {
		t.Errorf("tie: %+v", talk.Agent)
	}
	if talk.About.Kind != "" {
		t.Errorf("tying an existing board changed its about: %+v", talk.About)
	}
	if got := joins(); len(got) != 1 || got[0].BoardId != info.ID || got[0].AgentTabId != tabId {
		t.Errorf("joins: %+v", got)
	}
}

func TestBoardStartAboutAnAgentTiesIt(t *testing.T) {
	ctx := context.Background()
	stubBoardDrawer(t, drawReply, nil)
	ch, _ := boardProjectChannel(t, ctx)
	claudeTab, _ := seedAgentTab(t, ctx, waveobj.MetaMapType{waveobj.MetaKey_SessionAgent: "claude", waveobj.MetaKey_SessionLabel: "auth agent"})
	codexTab, _ := seedAgentTab(t, ctx, waveobj.MetaMapType{waveobj.MetaKey_SessionAgent: "codex"})
	cases := []struct {
		name  string
		about wshrpc.BoardSource
		want  *wshrpc.BoardAgent
	}{
		{"claude agent", wshrpc.BoardSource{Kind: "agent", Ref: claudeTab, Title: "auth agent"}, &wshrpc.BoardAgent{TabId: claudeTab, Title: "auth agent", Runtime: "claude"}},
		{"codex agent", wshrpc.BoardSource{Kind: "agent", Ref: codexTab, Title: "codex"}, nil},
		{"run", wshrpc.BoardSource{Kind: "run", Ref: "run-1", Title: "a run"}, nil},
	}
	for _, c := range cases {
		info := startBoard(t, ctx, wshrpc.CommandBoardStartData{ChannelId: ch.OID, Name: c.name, About: c.about})
		got := readTalk(t, ctx, ch.OID, info.ID).Agent
		if got != nil {
			got.ReadTs = 0
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: agent %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestBoardListReportsTheAgentAndDrawings(t *testing.T) {
	ctx := context.Background()
	stubBoardDrawer(t, drawReply, nil)
	ch, project := boardProjectChannel(t, ctx)
	stubAgentCwd(t, project)
	tabId, blockId := seedAgentTab(t, ctx, waveobj.MetaMapType{waveobj.MetaKey_SessionAgent: "claude"})
	rtn, err := (&WshServer{}).BoardAgentDrawCommand(ctx, wshrpc.CommandBoardAgentDrawData{BlockId: blockId, Board: "Auth flow", Context: "the briefing", Ask: "the steps"})
	if err != nil {
		t.Fatal(err)
	}
	waitIdle(t, ch.OID, rtn.BoardId)
	list, err := (&WshServer{}).BoardListCommand(ctx, wshrpc.CommandBoardListData{ChannelId: ch.OID})
	if err != nil || len(list.Boards) != 1 {
		t.Fatalf("list: %+v %v", list, err)
	}
	if b := list.Boards[0]; b.AgentTabId != tabId || b.Drawings != 1 || b.DrawnTs == 0 {
		t.Errorf("board: %+v", b)
	}
}

func TestBoardListShowsAnswering(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	gate := make(chan struct{})
	stubBoardDrawer(t, drawReply, gate)
	ch, _ := boardProjectChannel(t, ctx)
	busy := startBoard(t, ctx, wshrpc.CommandBoardStartData{ChannelId: ch.OID, Name: "Busy", Question: "q"})
	idle := startBoard(t, ctx, wshrpc.CommandBoardStartData{ChannelId: ch.OID, Name: "Idle"})
	states := func() map[string]string {
		t.Helper()
		list, err := ws.BoardListCommand(ctx, wshrpc.CommandBoardListData{ChannelId: ch.OID})
		if err != nil {
			t.Fatal(err)
		}
		m := map[string]string{}
		for _, b := range list.Boards {
			m[b.ID] = b.State
		}
		return m
	}
	if got := states(); got[busy.ID] != "answering" || got[idle.ID] != "" {
		t.Errorf("while answering: %v", got)
	}
	close(gate)
	waitIdle(t, ch.OID, busy.ID)
	if got := states(); got[busy.ID] != "" {
		t.Errorf("once answered: %v", got)
	}
}

// stubForward records the turns the drawer forwards, instead of typing them into an agent.
func stubForward(t *testing.T) func() []string {
	t.Helper()
	var mu sync.Mutex
	var got []string
	old := forwardBoardTurn
	forwardBoardTurn = func(b boarddrawer.Board, turnId string) {
		mu.Lock()
		defer mu.Unlock()
		got = append(got, b.BoardId+"/"+turnId)
	}
	t.Cleanup(func() { forwardBoardTurn = old })
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(got)
	}
}

func TestBoardAskForwardsAQuestion(t *testing.T) {
	ctx := context.Background()
	stubBoardDrawer(t, questionReply, nil)
	forwarded := stubForward(t)
	ch, _ := boardProjectChannel(t, ctx)
	info := startBoard(t, ctx, wshrpc.CommandBoardStartData{ChannelId: ch.OID, Name: "Auth flow"})
	if err := (&WshServer{}).BoardAskCommand(ctx, wshrpc.CommandBoardAskData{ChannelId: ch.OID, BoardId: info.ID, Question: "Why twice?"}); err != nil {
		t.Fatal(err)
	}
	waitIdle(t, ch.OID, info.ID)
	talk := readTalk(t, ctx, ch.OID, info.ID)
	if len(talk.Turns) != 1 || talk.Turns[0].State != boarddrawer.StateForwarded || talk.Turns[0].Route != boarddrawer.RouteAgent {
		t.Fatalf("turns: %+v", talk.Turns)
	}
	if got := forwarded(); !slices.Equal(got, []string{info.ID + "/" + talk.Turns[0].ID}) {
		t.Errorf("forwarded %v", got)
	}
	answers, err := (&WshServer{}).BoardAnswerInboxCommand(ctx, wshrpc.CommandBoardInboxData{ChannelId: ch.OID, BoardId: info.ID})
	if err != nil || len(answers) != 0 {
		t.Errorf("a forwarded turn delivers nothing: %+v %v", answers, err)
	}
}

// a talk file written before routing has words replies and no route key
func TestBoardTalkReadsTurnsFromBeforeRouting(t *testing.T) {
	ctx := context.Background()
	stubBoardDrawer(t, drawReply, nil)
	ch, _ := boardProjectChannel(t, ctx)
	info := startBoard(t, ctx, wshrpc.CommandBoardStartData{ChannelId: ch.OID, Name: "Auth flow"})
	files, err := filepath.Glob(filepath.Join(boardstore.ProjectDir(ch.Name), info.ID+"*"))
	if err != nil {
		t.Fatal(err)
	}
	talkFile := ""
	for _, f := range files {
		if filepath.Base(f) != filepath.Base(info.Path) {
			talkFile = f
		}
	}
	if talkFile == "" {
		t.Fatalf("no talk file beside %s: %v", info.Path, files)
	}
	old := `{"channelid":"` + ch.OID + `","boardid":"` + info.ID + `","about":{"kind":"","ref":"","title":""},"sessionid":"s1","turns":[` +
		`{"id":"t0","ts":1,"question":"How does it start?","state":"answered","reply":"Two processes.","title":"wavesrv","added":1,"answeredts":2}]}`
	if err := os.WriteFile(talkFile, []byte(old), 0o644); err != nil {
		t.Fatal(err)
	}
	talk := readTalk(t, ctx, ch.OID, info.ID)
	want := wshrpc.BoardTurn{ID: "t0", Ts: 1, Question: "How does it start?", State: boarddrawer.StateAnswered, Reply: "Two processes.",
		Title: "wavesrv", Added: 1, AnsweredTs: 2}
	if len(talk.Turns) != 1 || !reflect.DeepEqual(talk.Turns[0], want) {
		t.Errorf("an old turn must read as it was: %+v", talk.Turns)
	}
}
