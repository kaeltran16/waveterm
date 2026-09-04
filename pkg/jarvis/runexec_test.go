// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
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
		{"pi", "pi", []string{"do work"}},
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
		{"pi capable", "pi", consult.TierCapable, []string{"do work"}},
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

func TestEnsureWorkersPassesKeepOnExitOnlyForOrchestrator(t *testing.T) {
	old := SpawnRunWorker
	defer func() { SpawnRunWorker = old }()

	var got []RunWorkerOptions
	SpawnRunWorker = func(_ context.Context, _ runroute.Capability, _, _, _, _ string, opts RunWorkerOptions) (string, error) {
		got = append(got, opts)
		return "tab:worker", nil
	}
	cap, err := runroute.Resolve(waveobj.RoutePin{Runtime: "pi", Tier: string(consult.TierCapable)})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}

	orch := NewRun("orchestrate", "ws", "/p", nil, RunMode_Orchestrator, DefaultOrchestratorPlaybook(false), 1)
	if _, err := EnsureWorkers(context.Background(), &orch, cap, "project"); err != nil {
		t.Fatal(err)
	}
	pipe := NewRun("pipeline", "ws", "/p", nil, RunMode_Pipeline, DefaultPlaybook(), 1)
	if _, err := EnsureWorkers(context.Background(), &pipe, cap, "project"); err != nil {
		t.Fatal(err)
	}

	if len(got) != 2 || !got[0].KeepOnExit || got[1].KeepOnExit {
		t.Fatalf("worker options = %+v", got)
	}
}

func TestConfigureWorkerPersistsMetaBeforeStart(t *testing.T) {
	oldPersist, oldStart := persistWorkerBlockMeta, startWorkerController
	defer func() { persistWorkerBlockMeta, startWorkerController = oldPersist, oldStart }()

	var calls []string
	persistWorkerBlockMeta = func(context.Context, string, waveobj.MetaMapType) error {
		calls = append(calls, "persist")
		return nil
	}
	startWorkerController = func(context.Context, string, string) error {
		calls = append(calls, "start")
		return nil
	}
	if err := configureAndStartWorker(context.Background(), "tab-1", "block-1", waveobj.MetaMapType{}); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(calls, []string{"persist", "start"}) {
		t.Fatalf("calls = %v", calls)
	}
}

func TestConfigureWorkerDoesNotStartAfterMetaFailure(t *testing.T) {
	oldPersist, oldStart := persistWorkerBlockMeta, startWorkerController
	defer func() { persistWorkerBlockMeta, startWorkerController = oldPersist, oldStart }()

	persistWorkerBlockMeta = func(context.Context, string, waveobj.MetaMapType) error { return errors.New("write failed") }
	started := false
	startWorkerController = func(context.Context, string, string) error { started = true; return nil }

	err := configureAndStartWorker(context.Background(), "tab-1", "block-1", waveobj.MetaMapType{})
	if err == nil || started {
		t.Fatalf("err=%v started=%v", err, started)
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

// A pi worker only ever carries a model when one was pinned, and a pinned pi model is always
// provider-qualified — that qualified id is what reaches the CLI, unmodified.
func TestRunWorkerSpecFor_piModelPinPassesQualifiedID(t *testing.T) {
	cap, err := runroute.Resolve(waveobj.RoutePin{Runtime: "pi", Model: "opencode/deepseek-v4-pro"})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	spec, ok := RunWorkerSpecFor(cap, "do work")
	if !ok {
		t.Fatal("pi model pin must produce a worker spec")
	}
	want := []string{"--model", "opencode/deepseek-v4-pro", "do work"}
	if !reflect.DeepEqual(spec.Args, want) {
		t.Errorf("args = %v, want %v", spec.Args, want)
	}
}
