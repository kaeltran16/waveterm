// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestCreateRunPrototype(t *testing.T) {
	ctx := context.Background()
	const prototype = "C:/canvas/Main.dc.html"
	create := func(t *testing.T, mode string) (string, *wshrpc.CommandCreateRunRtnData, error) {
		t.Helper()
		stubRunServer(t, "pi", nil)
		// not a git project, so an orchestrator launch cuts no landing tree
		ch, err := wstore.CreateChannel(ctx, "createrun-prototype", t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		rtn, err := (&WshServer{}).CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
			ChannelId: ch.OID, WorkspaceId: "ws", Goal: "g", Runtime: "pi", Mode: mode, DeferStart: true, Prototype: prototype,
		})
		return ch.OID, rtn, err
	}

	t.Run("a quick run with a prototype is refused before anything persists", func(t *testing.T) {
		channelId, _, err := create(t, jarvis.RunMode_Quick)
		if err == nil || !strings.Contains(err.Error(), "prototype needs an orchestrator run") {
			t.Fatalf("error %v should refuse the prototype", err)
		}
		if runs, _ := wstore.GetChannelRuns(ctx, channelId); len(runs) != 0 {
			t.Fatalf("a refused prototype left runs behind: %+v", runs)
		}
	})

	t.Run("an orchestrator run stores its prototype", func(t *testing.T) {
		channelId, rtn, err := create(t, jarvis.RunMode_Orchestrator)
		if err != nil {
			t.Fatal(err)
		}
		if rtn.Run.Prototype != prototype {
			t.Fatalf("returned prototype = %q, want %q", rtn.Run.Prototype, prototype)
		}
		runs, err := wstore.GetChannelRuns(ctx, channelId)
		if err != nil || len(runs) != 1 || runs[0].Prototype != prototype {
			t.Fatalf("stored runs = %+v, %v; want one run with the prototype", runs, err)
		}
	})
}
