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
		{"pi", "pi", []string{"do work"}},
	}
	for _, tt := range tests {
		cap, err := runroute.Resolve(waveobj.RoutePin{Runtime: tt.runtime})
		if err != nil {
			t.Fatalf("resolve %s: %v", tt.runtime, err)
		}
		spec, ok := RunWorkerSpecFor(cap, "", "do work")
		if !ok || spec.Bin != tt.bin || !reflect.DeepEqual(spec.Args, tt.args) {
			t.Errorf("%s spec = %+v, ok=%v", tt.runtime, spec, ok)
		}
	}
}

func TestRunWorkerSpecFor_CapabilityArgs(t *testing.T) {
	tests := []struct {
		name    string
		runtime string
		model   string
		args    []string
	}{
		{"pi default", "pi", "", []string{"do work"}},
		{"claude cheap model", "claude", consult.CheapModel, []string{"--dangerously-skip-permissions", "--model", consult.CheapModel, "do work"}},
		{"claude mid model", "claude", consult.MidModel, []string{"--dangerously-skip-permissions", "--model", consult.MidModel, "do work"}},
		{"claude default", "claude", "", []string{"--dangerously-skip-permissions", "do work"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cap, err := runroute.Resolve(waveobj.RoutePin{Runtime: tt.runtime, Model: tt.model})
			if err != nil {
				t.Fatal(err)
			}
			spec, ok := RunWorkerSpecFor(cap, "", "do work")
			if !ok || spec.Bin != tt.runtime || !reflect.DeepEqual(spec.Args, tt.args) {
				t.Fatalf("spec = %+v, ok=%v", spec, ok)
			}
		})
	}
	cap, _ := runroute.Resolve(waveobj.RoutePin{Runtime: "claude", Model: consult.CheapModel})
	cap.ModelArgs = nil
	for _, invalid := range []runroute.Capability{
		cap,
		{Runtime: "pi"},
		{Runtime: "mystery", ResolvedModel: "operator default"},
	} {
		if _, ok := RunWorkerSpecFor(invalid, "", "do work"); ok {
			t.Errorf("mismatched/unsupported capability %+v produced a worker spec", cap)
		}
	}
}

func TestRunWorkerSpecForRejectsUnsupportedRuntimes(t *testing.T) {
	for _, runtime := range []string{"codex", "opencode"} {
		cap := runroute.Capability{Runtime: runtime, ResolvedModel: "operator default"}
		if spec, ok := RunWorkerSpecFor(cap, "", "do work"); ok {
			t.Errorf("%s must have no run worker adapter, got %+v", runtime, spec)
		}
	}
}

// claude and pi both take --session-id, which names the transcript the worker writes; the engine picks
// the id so liveness and evidence can open that file instead of searching for it.
func TestRunWorkerSpecForSessionId(t *testing.T) {
	const id = "0b6f7c1e-4d2a-4f3b-9c8d-1a2b3c4d5e6f"
	tests := []struct {
		runtime string
		model   string
		args    []string
	}{
		{"claude", consult.CheapModel, []string{"--dangerously-skip-permissions", "--session-id", id, "--model", consult.CheapModel, "do work"}},
		{"pi", "", []string{"--session-id", id, "do work"}},
	}
	for _, tt := range tests {
		cap, err := runroute.Resolve(waveobj.RoutePin{Runtime: tt.runtime, Model: tt.model})
		if err != nil {
			t.Fatalf("resolve %s: %v", tt.runtime, err)
		}
		spec, ok := RunWorkerSpecFor(cap, id, "do work")
		if !ok || !reflect.DeepEqual(spec.Args, tt.args) {
			t.Errorf("%s args = %v, ok=%v, want %v", tt.runtime, spec.Args, ok, tt.args)
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
	cap, err := runroute.Resolve(waveobj.RoutePin{Runtime: "pi"})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}

	orch := NewRun("orchestrate", "ws", "/p", nil, RunMode_Orchestrator, DefaultOrchestratorPlaybook(false), 1)
	if _, err := EnsureWorkers(context.Background(), &orch, cap, "project", ""); err != nil {
		t.Fatal(err)
	}
	pipe := NewRun("pipeline", "ws", "/p", nil, RunMode_Pipeline, DefaultPlaybook(), 1)
	if _, err := EnsureWorkers(context.Background(), &pipe, cap, "project", ""); err != nil {
		t.Fatal(err)
	}

	if len(got) != 2 || !got[0].KeepOnExit || got[1].KeepOnExit {
		t.Fatalf("worker options = %+v", got)
	}
}

func TestEnsureWorkersUsesAGivenPrompt(t *testing.T) {
	old := SpawnRunWorker
	defer func() { SpawnRunWorker = old }()

	var prompts []string
	SpawnRunWorker = func(_ context.Context, _ runroute.Capability, _, _, _, prompt string, _ RunWorkerOptions) (string, error) {
		prompts = append(prompts, prompt)
		return "tab:worker", nil
	}
	cap, err := runroute.Resolve(waveobj.RoutePin{Runtime: "pi"})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}

	given := NewRun("orchestrate", "ws", "/p", nil, RunMode_Orchestrator, DefaultOrchestratorPlaybook(false), 1)
	if _, err := EnsureWorkers(context.Background(), &given, cap, "project", "the rules, then the wake"); err != nil {
		t.Fatal(err)
	}
	derived := NewRun("orchestrate", "ws", "/p", nil, RunMode_Orchestrator, DefaultOrchestratorPlaybook(false), 1)
	if _, err := EnsureWorkers(context.Background(), &derived, cap, "project", ""); err != nil {
		t.Fatal(err)
	}

	if len(prompts) != 2 || prompts[0] != "the rules, then the wake" || prompts[1] != phasePrompt(&derived, 0) {
		t.Fatalf("a given prompt replaces the phase's, an empty one derives it; got %q", prompts)
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
	spec, ok := RunWorkerSpecFor(cap, "", "do work")
	if !ok {
		t.Fatal("pi model pin must produce a worker spec")
	}
	want := []string{"--model", "opencode/deepseek-v4-pro", "do work"}
	if !reflect.DeepEqual(spec.Args, want) {
		t.Errorf("args = %v, want %v", spec.Args, want)
	}
}
