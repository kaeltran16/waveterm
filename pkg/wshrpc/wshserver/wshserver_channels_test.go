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

func TestGetAttentionCommandSeesAGateInAnyChannel(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	ch, err := wstore.CreateChannel(ctx, "attn", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	run := waveobj.Run{
		ID: "r-gate", Goal: "refactor auth", Status: "awaiting-review", CreatedTs: 1,
		Phases: []waveobj.RunPhase{
			{Kind: "plan", State: "done", Gate: true, DoneTs: 700},
			{Kind: "execute", State: "pending"},
		},
	}
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("append run: %v", err)
	}

	rtn, err := ws.GetAttentionCommand(ctx)
	if err != nil {
		t.Fatalf("GetAttention: %v", err)
	}
	var found *wshrpc.AttentionItem
	for i := range rtn.Items {
		if rtn.Items[i].RunId == "r-gate" {
			found = &rtn.Items[i]
		}
	}
	if found == nil {
		t.Fatalf("gate not reported: %+v", rtn.Items)
	}
	if found.Kind != "gate" || found.ChannelId != ch.OID || found.WaitingSince != 700 {
		t.Fatalf("wrong gate item: %+v", *found)
	}
}

func TestCreateChannelCommandIsIdempotentPerProject(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	first, err := ws.CreateChannelCommand(ctx, wshrpc.CommandCreateChannelData{Name: "wave", ProjectPath: "/repo/wave"})
	if err != nil {
		t.Fatalf("first CreateChannelCommand: %v", err)
	}
	second, err := ws.CreateChannelCommand(ctx, wshrpc.CommandCreateChannelData{Name: "wave again", ProjectPath: "/repo/wave/"})
	if err != nil {
		t.Fatalf("second CreateChannelCommand: %v", err)
	}
	if second.OID != first.OID {
		t.Fatalf("second create made a new channel %s, want the existing %s", second.OID, first.OID)
	}
	// the existing channel is returned as it stands: a second create does not rename it
	if second.Name != "wave" {
		t.Fatalf("second create renamed the channel to %q, want %q", second.Name, "wave")
	}
}

func TestCreateChannelCommandStillCreatesWithoutAProject(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	a, err := ws.CreateChannelCommand(ctx, wshrpc.CommandCreateChannelData{Name: "scratch one"})
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	b, err := ws.CreateChannelCommand(ctx, wshrpc.CommandCreateChannelData{Name: "scratch two"})
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if a.OID == b.OID {
		t.Fatalf("two pathless channels collapsed onto %s; a pathless channel is not a project", a.OID)
	}
}
