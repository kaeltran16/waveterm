// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestGetChannelRunsAndMessagesCommands(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	ch, err := wstore.CreateChannel(ctx, "rpc", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	if err := wstore.AppendRun(ctx, ch.OID, waveobj.Run{ID: "r1", Goal: "g", Status: "planning", CreatedTs: 1}); err != nil {
		t.Fatalf("append run: %v", err)
	}
	if _, err := wstore.PostChannelMessage(ctx, ch.OID, wstore.NewChannelMessage("human", "you", "hi", "", 5)); err != nil {
		t.Fatalf("post msg: %v", err)
	}
	runsRtn, err := ws.GetChannelRunsCommand(ctx, wshrpc.CommandGetChannelRunsData{ChannelId: ch.OID})
	if err != nil || len(runsRtn.Runs) != 1 || runsRtn.Runs[0].ID != "r1" {
		t.Fatalf("GetChannelRuns wrong: %+v err=%v", runsRtn, err)
	}
	msgRtn, err := ws.GetChannelMessagesCommand(ctx, wshrpc.CommandGetChannelMessagesData{ChannelId: ch.OID})
	if err != nil || len(msgRtn.Messages) != 1 || msgRtn.Messages[0].Text != "hi" {
		t.Fatalf("GetChannelMessages wrong: %+v err=%v", msgRtn, err)
	}
}
