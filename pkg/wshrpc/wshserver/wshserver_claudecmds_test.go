// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestClaudeLiveCommandsRoundTripPerBlock(t *testing.T) {
	ws := &WshServer{}
	ctx := context.Background()
	set := wshrpc.CommandSetClaudeLiveCommandsData{BlockId: "claudecmds-rt-a", Commands: []wshrpc.ClaudeCommandInfo{
		{Name: "clear", Description: "Clear", Source: "builtin"},
		{Name: "", Source: "user"},
		{Name: "skim", Source: "plugin", Plugin: "skim-mod"},
	}}
	if err := ws.SetClaudeLiveCommandsCommand(ctx, set); err != nil {
		t.Fatal(err)
	}
	got, err := ws.GetClaudeLiveCommandsCommand(ctx, wshrpc.CommandGetClaudeLiveCommandsData{BlockId: "claudecmds-rt-a"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Name != "clear" || got[1].Plugin != "skim-mod" {
		t.Fatalf("got %+v, want clear and skim", got)
	}
	other, err := ws.GetClaudeLiveCommandsCommand(ctx, wshrpc.CommandGetClaudeLiveCommandsData{BlockId: "claudecmds-rt-b"})
	if err != nil {
		t.Fatal(err)
	}
	// the frontend reads an empty list as "no live list", so the wire must carry [] and not null
	if raw, _ := json.Marshal(other); string(raw) != "[]" {
		t.Fatalf("a block with no list marshals as %s, want []", raw)
	}
}
