// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestJarvisCtxResolvesOwnerRun(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "ctx-test", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner goal", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	owner.ID = "11111111-1111-4111-8111-111111111111"
	owner.Phases[0].WorkerOrefs = []string{"tab:22222222-2222-4222-8222-222222222222"}
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	block := &waveobj.Block{OID: "33333333-3333-4333-8333-333333333333", ParentORef: "tab:22222222-2222-4222-8222-222222222222"}
	if err := wstore.DBInsert(ctx, block); err != nil {
		t.Fatal(err)
	}

	ws := &WshServer{}
	rtn, err := ws.JarvisCtxCommand(ctx, wshrpc.CommandJarvisCtxData{BlockORef: "block:33333333-3333-4333-8333-333333333333"})
	if err != nil {
		t.Fatal(err)
	}
	if rtn.ChannelId != ch.OID || rtn.RunId != "11111111-1111-4111-8111-111111111111" || rtn.Goal != "owner goal" {
		t.Fatalf("ctx mismatch: %+v", rtn)
	}
}

func TestJarvisCtxEmptyForUnrelatedBlock(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "ctx-test2", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner goal", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	owner.Phases[0].WorkerOrefs = []string{"tab:55555555-5555-4555-8555-555555555555"}
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	block := &waveobj.Block{OID: "44444444-4444-4444-8444-444444444444", ParentORef: "tab:66666666-6666-4666-8666-666666666666"}
	if err := wstore.DBInsert(ctx, block); err != nil {
		t.Fatal(err)
	}

	ws := &WshServer{}
	rtn, err := ws.JarvisCtxCommand(ctx, wshrpc.CommandJarvisCtxData{BlockORef: "block:44444444-4444-4444-8444-444444444444"})
	if err != nil {
		t.Fatal(err)
	}
	if rtn.RunId != "" || rtn.ChannelId != "" {
		t.Fatalf("unrelated block must resolve to empty ctx, got %+v", rtn)
	}
	// empty + malformed orefs are safe no-ops, never errors
	if _, err := ws.JarvisCtxCommand(ctx, wshrpc.CommandJarvisCtxData{}); err != nil {
		t.Fatal(err)
	}
	if _, err := ws.JarvisCtxCommand(ctx, wshrpc.CommandJarvisCtxData{BlockORef: "not-an-oref"}); err != nil {
		t.Fatal(err)
	}
}
