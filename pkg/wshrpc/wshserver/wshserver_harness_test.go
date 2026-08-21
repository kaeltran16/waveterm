// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/harness"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestListHarnessesReturnsCatalogWithoutOpenRouter(t *testing.T) {
	old := probeHarnesses
	t.Cleanup(func() { probeHarnesses = old })
	probeHarnesses = func(ctx context.Context) []harness.ProbeResult {
		results := []harness.ProbeResult{}
		for i, spec := range harness.List() {
			results = append(results, harness.ProbeResult{Spec: spec, Installed: i%2 == 0, Version: "1.2.3"})
		}
		return results
	}

	rtn, err := (&WshServer{}).ListHarnessesCommand(context.Background())
	if err != nil {
		t.Fatalf("ListHarnessesCommand: %v", err)
	}
	if len(rtn.Harnesses) != 4 {
		t.Fatalf("len = %d, want 4", len(rtn.Harnesses))
	}
	for _, info := range rtn.Harnesses {
		if info.Runtime == "openrouter" {
			t.Fatal("OpenRouter must not be listed as a harness")
		}
		if info.Label == "" || !info.ConsultCapable || !info.RunWorkerCapable {
			t.Errorf("info %+v missing label/capabilities", info)
		}
	}
}

func TestInstalledRunWorkerPinsUseOnlyInstalledWorkerCapabilities(t *testing.T) {
	pins := installedRunWorkerPins([]harness.ProbeResult{
		{Spec: harness.Spec{Runtime: "pi", RunWorkerCapable: true}, Installed: true},
		{Spec: harness.Spec{Runtime: "claude", RunWorkerCapable: true}, Installed: false},
		{Spec: harness.Spec{Runtime: "codex", RunWorkerCapable: false}, Installed: true},
	})
	want := []waveobj.RoutePin{
		{Runtime: "pi", Tier: "cheap"},
		{Runtime: "pi", Tier: "mid"},
		{Runtime: "pi", Tier: "capable"},
	}
	if !reflect.DeepEqual(pins, want) {
		t.Fatalf("pins=%+v want=%+v", pins, want)
	}
}

func TestListHarnessesAddsRouteCapabilitiesOnlyForAvailableWorkers(t *testing.T) {
	old := probeHarnesses
	t.Cleanup(func() { probeHarnesses = old })
	probeHarnesses = func(ctx context.Context) []harness.ProbeResult {
		return []harness.ProbeResult{
			{Spec: harness.Spec{Runtime: "pi", Label: "Pi", RunWorkerCapable: true}, Installed: true},
			{Spec: harness.Spec{Runtime: "claude", Label: "Claude Code", RunWorkerCapable: true}, Installed: false},
			{Spec: harness.Spec{Runtime: "codex", Label: "Codex", RunWorkerCapable: false}, Installed: true},
		}
	}

	rtn, err := (&WshServer{}).ListHarnessesCommand(context.Background())
	if err != nil {
		t.Fatalf("ListHarnessesCommand: %v", err)
	}
	if len(rtn.Harnesses) != 3 {
		t.Fatalf("len = %d, want 3 probe rows", len(rtn.Harnesses))
	}
	for _, info := range rtn.Harnesses {
		want := []wshrpc.RouteCapabilityInfo{}
		if info.Runtime == "pi" {
			for _, capability := range runroute.Capabilities("pi") {
				want = append(want, wshrpc.RouteCapabilityInfo{
					Runtime:       capability.Runtime,
					Tier:          string(capability.Tier),
					ResolvedModel: capability.ResolvedModel,
				})
			}
		}
		if !reflect.DeepEqual(info.RouteCapabilities, want) {
			t.Errorf("%s route capabilities = %+v, want %+v", info.Runtime, info.RouteCapabilities, want)
		}
		if info.Runtime == "openrouter" {
			t.Fatal("OpenRouter must not be listed as a harness")
		}
	}
}

func TestConsultRejectsUnknownRuntimeBeforeDispatch(t *testing.T) {
	old := validateHarness
	t.Cleanup(func() { validateHarness = old })
	validateHarness = func(runtime string, op harness.Operation) (harness.Spec, error) {
		return harness.Spec{}, errors.New("unknown harness \"mystery\"")
	}

	ch := (&WshServer{}).ConsultCommand(context.Background(), wshrpc.CommandConsultData{
		ChannelId: "ch:1",
		Runtime:   "mystery",
		Prompt:    "hi",
	})
	var gotErr error
	for resp := range ch {
		if resp.Error != nil {
			gotErr = resp.Error
		}
	}
	if gotErr == nil || !strings.Contains(gotErr.Error(), "mystery") {
		t.Fatalf("error = %v, want validator error naming the runtime", gotErr)
	}
}
