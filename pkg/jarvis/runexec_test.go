// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestRunWorkerSpecFor(t *testing.T) {
	tests := []struct {
		runtime string
		bin     string
		args    []string
	}{
		{"claude", "claude", []string{"--dangerously-skip-permissions", "do work"}},
		{"codex", "codex", []string{"--dangerously-bypass-approvals-and-sandbox", "do work"}},
		{"opencode", "opencode", []string{"--auto", "--prompt", "do work"}},
		{"pi", "pi", []string{"--model", consult.PiMidModel, "do work"}},
	}
	for _, tt := range tests {
		cap, err := runroute.Resolve(waveobj.RoutePin{Runtime: tt.runtime, Tier: string(consult.TierCapable)})
		if err != nil {
			t.Fatalf("resolve %s: %v", tt.runtime, err)
		}
		spec, ok := RunWorkerSpecFor(cap, "do work")
		if !ok || spec.Bin != tt.bin || !reflect.DeepEqual(spec.Args, tt.args) {
			t.Errorf("%s spec = %+v, ok=%v", tt.runtime, spec, ok)
		}
	}
}

func TestRunWorkerSpecFor_CapabilityArgs(t *testing.T) {
	tests := []struct {
		name    string
		runtime string
		tier    consult.Tier
		args    []string
	}{
		{"pi cheap", "pi", consult.TierCheap, []string{"--model", consult.PiCheapModel, "do work"}},
		{"pi mid", "pi", consult.TierMid, []string{"--model", consult.PiMidModel, "do work"}},
		{"claude cheap", "claude", consult.TierCheap, []string{"--dangerously-skip-permissions", "--model", consult.CheapModel, "do work"}},
		{"claude mid", "claude", consult.TierMid, []string{"--dangerously-skip-permissions", "--model", consult.MidModel, "do work"}},
		{"claude capable", "claude", consult.TierCapable, []string{"--dangerously-skip-permissions", "do work"}},
		{"codex capable", "codex", consult.TierCapable, []string{"--dangerously-bypass-approvals-and-sandbox", "do work"}},
		{"opencode capable", "opencode", consult.TierCapable, []string{"--auto", "--prompt", "do work"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cap, err := runroute.Resolve(waveobj.RoutePin{Runtime: tt.runtime, Tier: string(tt.tier)})
			if err != nil {
				t.Fatal(err)
			}
			spec, ok := RunWorkerSpecFor(cap, "do work")
			if !ok || spec.Bin != tt.runtime || !reflect.DeepEqual(spec.Args, tt.args) {
				t.Fatalf("spec = %+v, ok=%v", spec, ok)
			}
		})
	}
	cap, _ := runroute.Resolve(waveobj.RoutePin{Runtime: "claude", Tier: string(consult.TierCheap)})
	cap.Tier = string(consult.TierCapable)
	for _, invalid := range []runroute.Capability{
		cap,
		{Runtime: "pi", Tier: string(consult.TierCapable)},
		{Runtime: "mystery", Tier: string(consult.TierCapable)},
	} {
		if _, ok := RunWorkerSpecFor(invalid, "do work"); ok {
			t.Errorf("mismatched/unsupported capability %+v produced a worker spec", cap)
		}
	}
}

func TestPhasePrompt_ModeAware(t *testing.T) {
	orch := NewRun("do X", "ws", "/p", waveobj.PrincipleList{{ID: "clean", Text: "be clean"}}, RunMode_Orchestrator, DefaultOrchestratorPlaybook(true), 1)
	if p := phasePrompt(&orch, 0); !strings.Contains(p, "wsh jarvis triage") || strings.Contains(p, "wsh jarvis hold") {
		t.Fatalf("orchestrator prompt should be adaptive and ungated:\n%s", p)
	}

	pipe := NewRun("do X", "ws", "/p", waveobj.PrincipleList{{ID: "clean", Text: "be clean"}}, RunMode_Pipeline, DefaultPlaybook(), 1)
	pp := phasePrompt(&pipe, 0)
	if !strings.Contains(pp, "wsh jarvis complete") {
		t.Fatalf("pipeline prompt should tell the worker to self-report completion:\n%s", pp)
	}
	if strings.Contains(pp, "wsh jarvis hold") {
		t.Fatalf("pipeline prompt must not hold-gate (gate is structural):\n%s", pp)
	}
}

func TestMakeWorkerBlockMeta_OrchestratorKeepsOnExit(t *testing.T) {
	// orchestrator leads must not auto-close on exit while DAG children are running
	orchMeta := makeWorkerBlockMeta(RunWorkerSpec{Bin: "pi", Args: []string{"do"}}, "/proj", true)
	if !orchMeta.GetBool(waveobj.MetaKey_CmdKeepOnExit, false) {
		t.Fatalf("orchestrator block meta should have cmd:keeponexit=true, got %#v", orchMeta)
	}
	pipeMeta := makeWorkerBlockMeta(RunWorkerSpec{Bin: "pi", Args: []string{"do"}}, "/proj", false)
	if pipeMeta.GetBool(waveobj.MetaKey_CmdKeepOnExit, false) {
		t.Fatalf("pipeline block meta should not have cmd:keeponexit, got %#v", pipeMeta)
	}
}

func TestEnsureWorkers_OrchestratorStampsKeepOnExit(t *testing.T) {
	ctx := context.Background()
	// create a fake tab/block that SpawnRunWorker will "return"
	tabId := "test-tab-orch"
	blockId := "test-block-orch"
	if err := wstore.DBInsert(ctx, &waveobj.Tab{OID: tabId, Name: "worker", BlockIds: []string{blockId}}); err != nil {
		t.Fatalf("insert tab: %v", err)
	}
	if err := wstore.DBInsert(ctx, &waveobj.Block{OID: blockId, Meta: waveobj.MetaMapType{}}); err != nil {
		t.Fatalf("insert block: %v", err)
	}
	t.Cleanup(func() {
		_ = wstore.DBDelete(ctx, waveobj.OType_Tab, tabId)
		_ = wstore.DBDelete(ctx, waveobj.OType_Block, blockId)
	})
	orig := SpawnRunWorker
	SpawnRunWorker = func(_ context.Context, _ runroute.Capability, _, _, _, _ string) (string, error) {
		return "tab:" + tabId, nil
	}
	defer func() { SpawnRunWorker = orig }()
	cap, _ := runroute.Resolve(waveobj.RoutePin{Runtime: "pi", Tier: string(consult.TierMid)})
	// orchestrator run should stamp keeponexit
	orchRun := NewRun("do orch", "ws", "/p", nil, RunMode_Orchestrator, DefaultOrchestratorPlaybook(false), 1)
	if _, err := EnsureWorkers(ctx, &orchRun, cap, "proj"); err != nil {
		t.Fatalf("EnsureWorkers orch: %v", err)
	}
	b, err := wstore.DBMustGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		t.Fatalf("get block: %v", err)
	}
	if !b.Meta.GetBool(waveobj.MetaKey_CmdKeepOnExit, false) {
		t.Fatalf("orchestrator lead should be stamped keeponexit, got %#v", b.Meta)
	}
	// reset
	_ = wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Block, blockId), waveobj.MetaMapType{waveobj.MetaKey_CmdKeepOnExit: nil}, false)
	// pipeline run must NOT stamp
	tabId2 := "test-tab-pipe"
	blockId2 := "test-block-pipe"
	if err := wstore.DBInsert(ctx, &waveobj.Tab{OID: tabId2, Name: "worker", BlockIds: []string{blockId2}}); err != nil {
		t.Fatalf("insert tab2: %v", err)
	}
	if err := wstore.DBInsert(ctx, &waveobj.Block{OID: blockId2, Meta: waveobj.MetaMapType{}}); err != nil {
		t.Fatalf("insert block2: %v", err)
	}
	t.Cleanup(func() {
		_ = wstore.DBDelete(ctx, waveobj.OType_Tab, tabId2)
		_ = wstore.DBDelete(ctx, waveobj.OType_Block, blockId2)
	})
	SpawnRunWorker = func(_ context.Context, _ runroute.Capability, _, _, _, _ string) (string, error) {
		return "tab:" + tabId2, nil
	}
	pipeRun := NewRun("do pipe", "ws", "/p", nil, RunMode_Pipeline, DefaultPlaybook(), 1)
	if _, err := EnsureWorkers(ctx, &pipeRun, cap, "proj"); err != nil {
		t.Fatalf("EnsureWorkers pipe: %v", err)
	}
	b2, err := wstore.DBMustGet[*waveobj.Block](ctx, blockId2)
	if err != nil {
		t.Fatalf("get block2: %v", err)
	}
	if b2.Meta.GetBool(waveobj.MetaKey_CmdKeepOnExit, false) {
		t.Fatalf("pipeline worker should not be stamped keeponexit, got %#v", b2.Meta)
	}
}

func TestInitialWorkerStatusEvent(t *testing.T) {
	ev := initialWorkerStatusEvent("abc", "claude", 1717000000000)
	if ev.Event != wps.Event_AgentStatus {
		t.Fatalf("event = %q, want %q", ev.Event, wps.Event_AgentStatus)
	}
	// Persist:1 so a late-subscribing frontend replays it and the worker still shows.
	if ev.Persist != 1 {
		t.Errorf("persist = %d, want 1", ev.Persist)
	}
	if len(ev.Scopes) != 1 || ev.Scopes[0] != "block:abc" {
		t.Errorf("scopes = %v, want [block:abc]", ev.Scopes)
	}
	data, ok := ev.Data.(baseds.AgentStatusData)
	if !ok {
		t.Fatalf("data type = %T, want baseds.AgentStatusData", ev.Data)
	}
	if data.State != baseds.AgentState_Working || data.ORef != "block:abc" || data.Agent != "claude" {
		t.Errorf("data = %#v, want working/block:abc/claude", data)
	}
}
