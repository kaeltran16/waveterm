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
	// keep real CLIs out of the test; catalog contents are covered elsewhere
	defer runroute.SetCatalogCommandForTest(func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte("not a model table\n"), nil
	})()
	runroute.RefreshRouteCatalog()
	defer runroute.RefreshRouteCatalog()
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
	defer runroute.SetCatalogCommandForTest(func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte("provider model context\nopencode deepseek-v4-pro 1M\n"), nil
	})()
	runroute.RefreshRouteCatalog()
	defer runroute.RefreshRouteCatalog()

	pins := installedRunWorkerPins(context.Background(), []harness.ProbeResult{
		{Spec: harness.Spec{Runtime: "pi", RunWorkerCapable: true}, Installed: true},
		{Spec: harness.Spec{Runtime: "claude", RunWorkerCapable: true}, Installed: false},
		{Spec: harness.Spec{Runtime: "codex", RunWorkerCapable: false}, Installed: true},
	})
	want := []waveobj.RoutePin{
		{Runtime: "pi", Model: "opencode/deepseek-v4-pro"},
	}
	if !reflect.DeepEqual(pins, want) {
		t.Fatalf("pins=%+v want=%+v", pins, want)
	}
}

func TestListHarnessesAddsRouteCapabilitiesOnlyForAvailableWorkers(t *testing.T) {
	// garbage catalog output degrades every runtime to free-form-only, keeping the legacy-tier
	// assertions below deterministic regardless of which CLIs this machine has installed
	defer runroute.SetCatalogCommandForTest(func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte("not a model table\n"), nil
	})()
	runroute.RefreshRouteCatalog()
	defer runroute.RefreshRouteCatalog()
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

func TestListHarnessesAddsCatalogModelCapabilities(t *testing.T) {
	defer runroute.SetCatalogCommandForTest(func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte("provider model context\nopencode deepseek-v4-pro 1M\n"), nil
	})()
	runroute.RefreshRouteCatalog()
	defer runroute.RefreshRouteCatalog()
	old := probeHarnesses
	t.Cleanup(func() { probeHarnesses = old })
	probeHarnesses = func(ctx context.Context) []harness.ProbeResult {
		return []harness.ProbeResult{
			{Spec: harness.Spec{Runtime: "pi", Label: "Pi", RunWorkerCapable: true}, Installed: true},
			{Spec: harness.Spec{Runtime: "claude", Label: "Claude Code", RunWorkerCapable: true}, Installed: false},
			{Spec: harness.Spec{Runtime: "codex", Label: "Codex", RunWorkerCapable: false}, Installed: true},
		}
	}

	ws := &WshServer{}
	rtn, err := ws.ListHarnessesCommand(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var piCap *wshrpc.RouteCapabilityInfo
	for i := range rtn.Harnesses {
		h := &rtn.Harnesses[i]
		if h.Runtime != "pi" {
			continue
		}
		for j := range h.RouteCapabilities {
			if h.RouteCapabilities[j].Model == "opencode/deepseek-v4-pro" {
				piCap = &h.RouteCapabilities[j]
			}
		}
	}
	if piCap == nil {
		t.Fatalf("pi must expose a catalog model capability: %+v", rtn.Harnesses)
	}
	if piCap.ResolvedModel != "opencode/deepseek-v4-pro" {
		t.Fatalf("resolvedmodel must equal the model: %+v", piCap)
	}
	if piCap.ContextHint != "1M" {
		t.Fatalf("catalog metadata must ride through: %+v", piCap)
	}
	// non-installed / non-worker runtimes must not expose model capabilities
	for _, h := range rtn.Harnesses {
		if h.Runtime == "claude" || h.Runtime == "codex" {
			for _, c := range h.RouteCapabilities {
				if c.Model != "" {
					t.Errorf("%s must not expose model capabilities: %+v", h.Runtime, c)
				}
			}
		}
	}
}
