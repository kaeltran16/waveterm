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

// boardProjectChannel makes a channel whose project path is a temp dir, so a drawer started on it runs there.
func boardProjectChannel(t *testing.T, ctx context.Context) (*waveobj.Channel, string) {
	t.Helper()
	project := t.TempDir()
	ch, err := wstore.CreateChannel(ctx, "board-"+uuid.NewString()[:8], project)
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	return ch, project
}

func TestBoardFilesCreateListReadSave(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	ch := boardTestChannel(t, "board-rt-"+uuid.NewString()[:8])

	info, err := ws.BoardStartCommand(ctx, wshrpc.CommandBoardStartData{ChannelId: ch.OID, Name: "Auth flow"})
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
			if _, err := ws.BoardAnswerInboxCommand(ctx, wshrpc.CommandBoardInboxData{ChannelId: ch.OID, BoardId: bad}); err == nil {
				t.Errorf("answer inbox accepted board id %q", bad)
			}
		}
		if err := ws.BoardAnswerAckCommand(ctx, wshrpc.CommandBoardAnswerAckData{ChannelId: ch.OID, BoardId: bad, TurnId: "t", AnswerId: uuid.NewString()}); err == nil {
			t.Errorf("answer ack accepted board id %q", bad)
		}
	}
	if _, err := ws.BoardListCommand(ctx, wshrpc.CommandBoardListData{ChannelId: "no-such-channel"}); err == nil {
		t.Error("list accepted an unknown channel")
	}
	if _, err := ws.BoardStartCommand(ctx, wshrpc.CommandBoardStartData{ChannelId: ch.OID, Name: "  "}); err == nil {
		t.Error("create accepted a blank name")
	}
}

func TestBoardFilesDamagedBoardRefusesSave(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	ch := boardTestChannel(t, "board-bad-"+uuid.NewString()[:8])
	info, err := ws.BoardStartCommand(ctx, wshrpc.CommandBoardStartData{ChannelId: ch.OID, Name: "Broken"})
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
