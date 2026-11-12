// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/boardstore"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func boardTestChannel(t *testing.T, name string) *waveobj.Channel {
	t.Helper()
	ch, err := wstore.CreateChannel(context.Background(), name, "")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	return ch
}

func TestBoardFilesCreateListReadSave(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	ch := boardTestChannel(t, "board-rt-"+uuid.NewString()[:8])

	info, err := ws.BoardCreateCommand(ctx, wshrpc.CommandBoardCreateData{ChannelId: ch.OID, Name: "Auth flow"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if info.Name != "Auth flow" || !boardstore.ValidID(info.ID) || info.ChannelId != ch.OID {
		t.Fatalf("create info: %+v", info)
	}

	list, err := ws.BoardListCommand(ctx, wshrpc.CommandBoardListData{ChannelId: ch.OID})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if list.Project != ch.Name || len(list.Boards) != 1 || list.Boards[0].ID != info.ID {
		t.Fatalf("list: %+v", list)
	}

	read, err := ws.BoardReadCommand(ctx, wshrpc.CommandBoardRefData{ChannelId: ch.OID, BoardId: info.ID})
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if read.Rev == "" || !strings.Contains(read.Data, `"elements":[]`) {
		t.Fatalf("read: %+v", read)
	}

	next := strings.Replace(read.Data, `"elements":[]`, `"elements":[{"id":"a","type":"rectangle"}]`, 1)
	saved, err := ws.BoardSaveCommand(ctx, wshrpc.CommandBoardSaveData{ChannelId: ch.OID, BoardId: info.ID, Data: next, BaseRev: read.Rev})
	if err != nil || saved.Conflict || saved.Rev == "" || saved.Rev == read.Rev {
		t.Fatalf("save: %+v %v", saved, err)
	}

	// the same base rev again is now stale: nothing is written
	stale, err := ws.BoardSaveCommand(ctx, wshrpc.CommandBoardSaveData{ChannelId: ch.OID, BoardId: info.ID, Data: read.Data, BaseRev: read.Rev})
	if err != nil || !stale.Conflict {
		t.Fatalf("stale save: %+v %v", stale, err)
	}
	again, err := ws.BoardReadCommand(ctx, wshrpc.CommandBoardRefData{ChannelId: ch.OID, BoardId: info.ID})
	if err != nil || again.Rev != saved.Rev || !strings.Contains(again.Data, `"rectangle"`) {
		t.Fatalf("a conflict wrote the file: %+v %v", again, err)
	}
}

func TestBoardFilesRejectBadIds(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	ch := boardTestChannel(t, "board-ids-"+uuid.NewString()[:8])
	for _, bad := range []string{"", "..", "../x", "ABCDEF12", "abc", "0123456789", `..\..\x`} {
		if _, err := ws.BoardReadCommand(ctx, wshrpc.CommandBoardRefData{ChannelId: ch.OID, BoardId: bad}); err == nil {
			t.Errorf("read accepted board id %q", bad)
		}
		if _, err := ws.BoardSaveCommand(ctx, wshrpc.CommandBoardSaveData{ChannelId: ch.OID, BoardId: bad, Data: "{}"}); err == nil {
			t.Errorf("save accepted board id %q", bad)
		}
		if bad != "" { // empty means every board on inbox
			if _, err := ws.BoardInboxCommand(ctx, wshrpc.CommandBoardInboxData{ChannelId: ch.OID, BoardId: bad}); err == nil {
				t.Errorf("inbox accepted board id %q", bad)
			}
		}
		if err := ws.BoardInboxAckCommand(ctx, wshrpc.CommandBoardInboxAckData{ChannelId: ch.OID, BoardId: bad, DrawId: uuid.NewString()}); err == nil {
			t.Errorf("ack accepted board id %q", bad)
		}
	}
	if err := ws.BoardInboxAckCommand(ctx, wshrpc.CommandBoardInboxAckData{ChannelId: ch.OID, BoardId: "0123abcd", DrawId: "../../x"}); err == nil {
		t.Error("ack accepted a path as a draw id")
	}
	if _, err := ws.BoardListCommand(ctx, wshrpc.CommandBoardListData{ChannelId: "no-such-channel"}); err == nil {
		t.Error("list accepted an unknown channel")
	}
	if _, err := ws.BoardCreateCommand(ctx, wshrpc.CommandBoardCreateData{ChannelId: ch.OID, Name: "  "}); err == nil {
		t.Error("create accepted a blank name")
	}
}

func TestBoardFilesInboxAllProjects(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	chA := boardTestChannel(t, "board-inbox-a-"+uuid.NewString()[:8])
	chB := boardTestChannel(t, "board-inbox-b-"+uuid.NewString()[:8])
	a, err := ws.BoardCreateCommand(ctx, wshrpc.CommandBoardCreateData{ChannelId: chA.OID, Name: "A"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := ws.BoardCreateCommand(ctx, wshrpc.CommandBoardCreateData{ChannelId: chB.OID, Name: "B"})
	if err != nil {
		t.Fatal(err)
	}
	drawA := wshrpc.BoardDraw{ID: uuid.NewString(), ChannelId: chA.OID, BoardId: a.ID, SourceKey: "agent:t1", Skeleton: "[]", Ts: 1}
	drawB := wshrpc.BoardDraw{ID: uuid.NewString(), ChannelId: chB.OID, BoardId: b.ID, SourceKey: "agent:t2", Skeleton: "[]", Ts: 2}
	if err := boardstore.PutDraw(boardstore.ProjectDir(chA.Name), drawA); err != nil {
		t.Fatal(err)
	}
	if err := boardstore.PutDraw(boardstore.ProjectDir(chB.Name), drawB); err != nil {
		t.Fatal(err)
	}

	all, err := ws.BoardInboxCommand(ctx, wshrpc.CommandBoardInboxData{})
	if err != nil {
		t.Fatalf("inbox all: %v", err)
	}
	got := map[string]wshrpc.BoardDraw{}
	for _, d := range all {
		got[d.ID] = d
	}
	// other tests in the package share the data dir, so look only for ours
	if got[drawA.ID].BoardId != a.ID || got[drawB.ID].BoardId != b.ID {
		t.Fatalf("inbox over every project missed a draw: %+v", all)
	}
	if got[drawA.ID].ChannelId != chA.OID || got[drawB.ID].ChannelId != chB.OID {
		t.Fatalf("a draw lost its channel: %+v", all)
	}

	one, err := ws.BoardInboxCommand(ctx, wshrpc.CommandBoardInboxData{ChannelId: chA.OID})
	if err != nil || len(one) != 1 || one[0].ID != drawA.ID {
		t.Fatalf("inbox for one channel: %+v %v", one, err)
	}

	if err := ws.BoardInboxAckCommand(ctx, wshrpc.CommandBoardInboxAckData{ChannelId: chA.OID, BoardId: a.ID, DrawId: drawA.ID}); err != nil {
		t.Fatalf("ack: %v", err)
	}
	if left, _ := ws.BoardInboxCommand(ctx, wshrpc.CommandBoardInboxData{ChannelId: chA.OID, BoardId: a.ID}); len(left) != 0 {
		t.Fatalf("ack left %+v", left)
	}
}

func TestBoardFilesDamagedBoardRefusesSave(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	ch := boardTestChannel(t, "board-bad-"+uuid.NewString()[:8])
	info, err := ws.BoardCreateCommand(ctx, wshrpc.CommandBoardCreateData{ChannelId: ch.OID, Name: "Broken"})
	if err != nil {
		t.Fatal(err)
	}
	read, err := ws.BoardReadCommand(ctx, wshrpc.CommandBoardRefData{ChannelId: ch.OID, BoardId: info.ID})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(info.Path, []byte(`{"arc":{"name":"Broken"},"elements":[`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ws.BoardSaveCommand(ctx, wshrpc.CommandBoardSaveData{ChannelId: ch.OID, BoardId: info.ID, Data: read.Data, BaseRev: read.Rev}); err == nil {
		t.Fatal("save overwrote a damaged file")
	}
	if raw, _ := os.ReadFile(info.Path); !strings.Contains(string(raw), `"elements":[`) || strings.Contains(string(raw), `"type"`) {
		t.Fatalf("damaged file was changed: %s", raw)
	}
	list, err := ws.BoardListCommand(ctx, wshrpc.CommandBoardListData{ChannelId: ch.OID})
	if err != nil || len(list.Boards) != 1 || list.Boards[0].LoadError == "" || list.Boards[0].Name != "Broken" {
		t.Fatalf("list of a damaged board: %+v %v", list, err)
	}
	_ = filepath.Base(info.Path)
}

func TestBoardFollowStopClearsMeta(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	other := waveobj.MetaMapType{waveobj.MetaKey_SessionAgent: "claude"}
	tab := &waveobj.Tab{OID: uuid.NewString(), Meta: waveobj.MetaMapType{
		waveobj.MetaKey_BoardFollowId:      "0123abcd",
		waveobj.MetaKey_BoardFollowChannel: "chan-1",
		waveobj.MetaKey_BoardFollowName:    "Auth flow",
		waveobj.MetaKey_BoardFollowAsk:     "the auth steps",
		waveobj.MetaKey_SessionAgent:       other[waveobj.MetaKey_SessionAgent],
	}}
	if err := wstore.DBInsert(ctx, tab); err != nil {
		t.Fatal(err)
	}
	if err := ws.BoardFollowStopCommand(ctx, wshrpc.CommandBoardFollowStopData{TabId: tab.OID}); err != nil {
		t.Fatalf("follow stop: %v", err)
	}
	got, err := wstore.DBMustGet[*waveobj.Tab](ctx, tab.OID)
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{waveobj.MetaKey_BoardFollowId, waveobj.MetaKey_BoardFollowChannel, waveobj.MetaKey_BoardFollowName, waveobj.MetaKey_BoardFollowAsk} {
		if _, ok := got.Meta[k]; ok {
			t.Errorf("%s survived follow stop: %v", k, got.Meta)
		}
	}
	if got.Meta[waveobj.MetaKey_SessionAgent] != "claude" {
		t.Errorf("follow stop cleared an unrelated key: %v", got.Meta)
	}
	// stopping a tab that follows nothing, or one that is gone, is not an error for the first and is for the second
	if err := ws.BoardFollowStopCommand(ctx, wshrpc.CommandBoardFollowStopData{TabId: tab.OID}); err != nil {
		t.Errorf("second follow stop: %v", err)
	}
	if err := ws.BoardFollowStopCommand(ctx, wshrpc.CommandBoardFollowStopData{TabId: ""}); err == nil {
		t.Error("follow stop accepted an empty tab id")
	}
}
