// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/boardscribe"
	"github.com/wavetermdev/waveterm/pkg/boardstore"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// fakeBoardScribe records wakes and reports a fixed state per board id.
type fakeBoardScribe struct {
	mu     sync.Mutex
	wakes  []boardscribe.Pass
	states map[string]string
}

func (f *fakeBoardScribe) Wake(p boardscribe.Pass) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.wakes = append(f.wakes, p)
}

func (f *fakeBoardScribe) Retry(channelId, boardId, key string) error { return nil }

func (f *fakeBoardScribe) Status(channelId, boardId string) []wshrpc.BoardSourceStatus {
	if st := f.states[boardId]; st != "" {
		return []wshrpc.BoardSourceStatus{{SourceKey: "agent:t", State: st}}
	}
	return nil
}

func (f *fakeBoardScribe) BoardState(channelId, boardId string) string { return f.states[boardId] }

func (f *fakeBoardScribe) woken() []boardscribe.Pass {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]boardscribe.Pass(nil), f.wakes...)
}

func stubBoardScribe(t *testing.T) *fakeBoardScribe {
	t.Helper()
	f := &fakeBoardScribe{states: map[string]string{}}
	old := boardScribe
	boardScribe = f
	t.Cleanup(func() { boardScribe = old })
	return f
}

func boardScribeChannel(t *testing.T, ctx context.Context) (*waveobj.Channel, string) {
	t.Helper()
	project := t.TempDir()
	ch, err := wstore.CreateChannel(ctx, "scribe-"+uuid.NewString()[:8], project)
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	return ch, project
}

func TestBoardScribeDrawFollowWritesTabMeta(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	fake := stubBoardScribe(t)
	ch, project := boardScribeChannel(t, ctx)
	info, err := ws.BoardCreateCommand(ctx, wshrpc.CommandBoardCreateData{ChannelId: ch.OID, Name: "Auth flow"})
	if err != nil {
		t.Fatal(err)
	}
	// an earlier follow onto another board is replaced
	tabId, _ := seedAgentTab(t, ctx, waveobj.MetaMapType{
		waveobj.MetaKey_BoardFollowId:      "ffffffff",
		waveobj.MetaKey_BoardFollowChannel: "other",
		waveobj.MetaKey_BoardFollowName:    "Old board",
		waveobj.MetaKey_BoardFollowAsk:     "old ask",
	})
	src := wshrpc.BoardSource{Kind: "agent", Ref: tabId, Title: "claude · waveterm"}
	err = ws.BoardDrawCommand(ctx, wshrpc.CommandBoardDrawData{ChannelId: ch.OID, BoardId: info.ID, Source: src, Ask: " the auth steps ", Follow: true})
	if err != nil {
		t.Fatalf("draw: %v", err)
	}
	meta := tabMeta(t, ctx, tabId)
	want := map[string]string{
		waveobj.MetaKey_BoardFollowId:      info.ID,
		waveobj.MetaKey_BoardFollowChannel: ch.OID,
		waveobj.MetaKey_BoardFollowName:    "Auth flow",
		waveobj.MetaKey_BoardFollowAsk:     "the auth steps",
	}
	for k, v := range want {
		if got := meta.GetString(k, ""); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	wakes := fake.woken()
	if len(wakes) != 1 {
		t.Fatalf("wakes = %d, want 1", len(wakes))
	}
	w := wakes[0]
	if w.BoardId != info.ID || w.ChannelId != ch.OID || w.BoardName != "Auth flow" || w.ProjectPath != project ||
		w.Source != src || w.Ask != "the auth steps" || !w.Follow {
		t.Errorf("wake = %+v", w)
	}
}

func TestBoardScribeDrawRefusesDamagedBoard(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	fake := stubBoardScribe(t)
	ch, _ := boardScribeChannel(t, ctx)
	info, err := ws.BoardCreateCommand(ctx, wshrpc.CommandBoardCreateData{ChannelId: ch.OID, Name: "Broken"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(info.Path, []byte(`{"arc":{"name":"Broken"},"elements":[{"id":`), 0o644); err != nil {
		t.Fatal(err)
	}
	src := wshrpc.BoardSource{Kind: "run", Ref: "run-1", ChannelId: ch.OID, Title: "run run-1"}
	if err := ws.BoardDrawCommand(ctx, wshrpc.CommandBoardDrawData{ChannelId: ch.OID, BoardId: info.ID, Source: src}); err == nil {
		t.Error("draw on a damaged board was accepted")
	}
	for _, bad := range []string{"", "../x", "ABCDEF12"} {
		if err := ws.BoardDrawCommand(ctx, wshrpc.CommandBoardDrawData{ChannelId: ch.OID, BoardId: bad, Source: src}); err == nil {
			t.Errorf("draw on board id %q was accepted", bad)
		}
	}
	if n := len(fake.woken()); n != 0 {
		t.Errorf("a refused draw woke the scribe %d times", n)
	}
}

func TestBoardScribeDrawRefusesFollowOnRun(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	fake := stubBoardScribe(t)
	ch, _ := boardScribeChannel(t, ctx)
	info, err := ws.BoardCreateCommand(ctx, wshrpc.CommandBoardCreateData{ChannelId: ch.OID, Name: "Runs"})
	if err != nil {
		t.Fatal(err)
	}
	run := wshrpc.BoardSource{Kind: "run", Ref: "run-1", ChannelId: ch.OID, Title: "run run-1"}
	if err := ws.BoardDrawCommand(ctx, wshrpc.CommandBoardDrawData{ChannelId: ch.OID, BoardId: info.ID, Source: run, Follow: true}); err == nil {
		t.Error("a follow on a run was accepted")
	}
	if err := ws.BoardDrawCommand(ctx, wshrpc.CommandBoardDrawData{ChannelId: ch.OID, BoardId: info.ID}); err == nil {
		t.Error("an empty source was accepted")
	}
	if n := len(fake.woken()); n != 0 {
		t.Fatalf("a refused draw woke the scribe %d times", n)
	}
	if err := ws.BoardDrawCommand(ctx, wshrpc.CommandBoardDrawData{ChannelId: ch.OID, BoardId: info.ID, Source: run}); err != nil {
		t.Fatalf("draw of a run: %v", err)
	}
	if wakes := fake.woken(); len(wakes) != 1 || wakes[0].Follow {
		t.Errorf("wakes = %+v, want one unfollowed", wakes)
	}
}

func agentStatusEvent(oref, state string) *wps.WaveEvent {
	return &wps.WaveEvent{Event: wps.Event_AgentStatus, Data: baseds.AgentStatusData{ORef: oref, State: state}}
}

func TestBoardScribeTurnEndWakesOnlyFollowedTabs(t *testing.T) {
	ctx := context.Background()
	fake := stubBoardScribe(t)
	ch, project := boardScribeChannel(t, ctx)
	followed, followedBlock := seedAgentTab(t, ctx, waveobj.MetaMapType{
		waveobj.MetaKey_SessionAgent:       "claude",
		waveobj.MetaKey_BoardFollowId:      "0123abcd",
		waveobj.MetaKey_BoardFollowChannel: ch.OID,
		waveobj.MetaKey_BoardFollowName:    "Auth flow",
		waveobj.MetaKey_BoardFollowAsk:     "the auth steps",
	})
	plain, plainBlock := seedAgentTab(t, ctx, nil)

	noteBoardFollowTurnEnded(ctx, agentStatusEvent("block:"+plainBlock, baseds.AgentState_Idle))
	noteBoardFollowTurnEnded(ctx, agentStatusEvent("tab:"+plain, baseds.AgentState_Waiting))
	noteBoardFollowTurnEnded(ctx, agentStatusEvent("block:"+followedBlock, "running"))
	noteBoardFollowTurnEnded(ctx, agentStatusEvent("tab:"+uuid.NewString(), baseds.AgentState_Idle))
	if n := len(fake.woken()); n != 0 {
		t.Fatalf("woke %d times for unfollowed tabs, a running turn or a closed tab", n)
	}

	noteBoardFollowTurnEnded(ctx, agentStatusEvent("block:"+followedBlock, baseds.AgentState_Idle))
	noteBoardFollowTurnEnded(ctx, agentStatusEvent("tab:"+followed, baseds.AgentState_Waiting))
	wakes := fake.woken()
	if len(wakes) != 2 {
		t.Fatalf("wakes = %d, want 2", len(wakes))
	}
	for _, w := range wakes {
		if w.BoardId != "0123abcd" || w.ChannelId != ch.OID || w.ProjectPath != project || w.Ask != "the auth steps" ||
			!w.Follow || w.Source.Kind != "agent" || w.Source.Ref != followed || w.Source.Title != "claude · "+ch.Name {
			t.Errorf("wake = %+v", w)
		}
	}
}

// writeDrawnBoard writes a board named name whose one source was drawn at drawnTs.
func writeDrawnBoard(t *testing.T, dir, id, name string, drawnTs int64) {
	t.Helper()
	arc, err := json.Marshal(wshrpc.BoardArcRecord{Name: name, CreatedTs: drawnTs, Sources: []wshrpc.BoardArcSource{{Key: "run:x", DrawnTs: drawnTs}}})
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

func TestBoardScribeAgentDrawCreatesByName(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	fake := stubBoardScribe(t)
	ch, project := boardScribeChannel(t, ctx)
	old := boardAgentCwd
	boardAgentCwd = func(context.Context, string, string) string { return project }
	t.Cleanup(func() { boardAgentCwd = old })
	tabId, blockId := seedAgentTab(t, ctx, waveobj.MetaMapType{waveobj.MetaKey_SessionAgent: "claude"})

	if _, err := ws.BoardAgentDrawCommand(ctx, wshrpc.CommandBoardAgentDrawData{BlockId: blockId}); err == nil {
		t.Error("an agent draw with no board name was accepted")
	}

	rtn, err := ws.BoardAgentDrawCommand(ctx, wshrpc.CommandBoardAgentDrawData{BlockId: blockId, Board: " Auth Flow ", Ask: "the steps"})
	if err != nil {
		t.Fatalf("agent draw: %v", err)
	}
	if !rtn.Created || rtn.BoardName != "Auth Flow" || rtn.Project != ch.Name || !boardstore.ValidID(rtn.BoardId) {
		t.Fatalf("agent draw of an unknown name: %+v", rtn)
	}
	wakes := fake.woken()
	if len(wakes) != 1 {
		t.Fatalf("wakes = %d, want 1", len(wakes))
	}
	w := wakes[0]
	if w.BoardId != rtn.BoardId || w.ChannelId != ch.OID || w.ProjectPath != project || w.Ask != "the steps" || w.Follow ||
		w.Source != (wshrpc.BoardSource{Kind: "agent", Ref: tabId, Title: "claude · " + ch.Name}) {
		t.Errorf("wake = %+v", w)
	}

	// two more boards whose names differ only in case: the most recently drawn wins
	dir := boardstore.ProjectDir(ch.Name)
	// List orders by activity (here the created time), so these stand later than the board made above
	const later = int64(1) << 60
	writeDrawnBoard(t, dir, "aaaa0001", "auth flow", later+200)
	writeDrawnBoard(t, dir, "aaaa0002", "AUTH FLOW", later+100)
	again, err := ws.BoardAgentDrawCommand(ctx, wshrpc.CommandBoardAgentDrawData{BlockId: blockId, Board: "auth FLOW"})
	if err != nil {
		t.Fatalf("second agent draw: %v", err)
	}
	if again.Created || again.BoardId != "aaaa0001" || again.BoardName != "auth flow" {
		t.Errorf("agent draw of an existing name: %+v", again)
	}
	list, err := ws.BoardListCommand(ctx, wshrpc.CommandBoardListData{ChannelId: ch.OID})
	if err != nil || len(list.Boards) != 3 {
		t.Errorf("an existing name created a board: %+v %v", list, err)
	}
}

func TestBoardScribeListShowsDrawingState(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	fake := stubBoardScribe(t)
	ch, _ := boardScribeChannel(t, ctx)
	drawing, err := ws.BoardCreateCommand(ctx, wshrpc.CommandBoardCreateData{ChannelId: ch.OID, Name: "Drawing"})
	if err != nil {
		t.Fatal(err)
	}
	idle, err := ws.BoardCreateCommand(ctx, wshrpc.CommandBoardCreateData{ChannelId: ch.OID, Name: "Idle"})
	if err != nil {
		t.Fatal(err)
	}
	fake.states[drawing.ID] = boardscribe.StateDrawing

	list, err := ws.BoardListCommand(ctx, wshrpc.CommandBoardListData{ChannelId: ch.OID})
	if err != nil {
		t.Fatal(err)
	}
	states := map[string]string{}
	for _, b := range list.Boards {
		states[b.ID] = b.State
	}
	if states[drawing.ID] != boardscribe.StateDrawing || states[idle.ID] != "" {
		t.Errorf("list states = %v", states)
	}
	status, err := ws.BoardStatusCommand(ctx, wshrpc.CommandBoardRefData{ChannelId: ch.OID, BoardId: drawing.ID})
	if err != nil || len(status.Sources) != 1 || status.Sources[0].State != boardscribe.StateDrawing {
		t.Errorf("status = %+v %v", status, err)
	}
	if _, err := ws.BoardStatusCommand(ctx, wshrpc.CommandBoardRefData{ChannelId: ch.OID, BoardId: ""}); err == nil {
		t.Error("status accepted an empty board id")
	}
}
