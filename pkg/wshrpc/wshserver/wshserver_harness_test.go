// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/harness"
	"github.com/wavetermdev/waveterm/pkg/runroute"
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
	if len(rtn.Harnesses) != 3 {
		t.Fatalf("len = %d, want 3", len(rtn.Harnesses))
	}
	for _, info := range rtn.Harnesses {
		if info.Runtime == "openrouter" {
			t.Fatal("OpenRouter must not be listed as a harness")
		}
		if info.Label == "" || !info.ConsultCapable {
			t.Errorf("info %+v missing label/capabilities", info)
		}
		if wantWorker := info.Runtime == "claude" || info.Runtime == "pi"; info.RunWorkerCapable != wantWorker {
			t.Errorf("%s RunWorkerCapable = %v, want %v", info.Runtime, info.RunWorkerCapable, wantWorker)
		}
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

// the picker reads refusals on every open, and the refresh an operator clicks after renewing forgets them
func TestListRefusedRoutesUntilRefresh(t *testing.T) {
	defer runroute.SetCatalogCommandForTest(func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte("not a model table\n"), nil
	})()
	defer runroute.RefreshRouteCatalog()
	const refusal = "403: An active OpenCode Go subscription is required"
	now := time.Now().UnixMilli()
	if err := runroute.RecordRefused(now,
		runroute.RefusedRoute{Runtime: "pi", Text: refusal, Ts: now},
		runroute.RefusedRoute{Runtime: "pi", Model: "opencode-go/deepseek-v4-flash", Text: refusal, Ts: now},
	); err != nil {
		t.Fatal(err)
	}
	ws := &WshServer{}
	rtn, err := ws.ListRefusedRoutesCommand(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := []wshrpc.RefusedRouteInfo{
		{Runtime: "pi", Text: refusal, Ts: now},
		{Runtime: "pi", Model: "opencode-go/deepseek-v4-flash", Text: refusal, Ts: now},
	}
	if !reflect.DeepEqual(rtn.Routes, want) {
		t.Fatalf("routes = %+v, want %+v", rtn.Routes, want)
	}
	if err := ws.RefreshRouteCatalogCommand(context.Background()); err != nil {
		t.Fatal(err)
	}
	if rtn, err = ws.ListRefusedRoutesCommand(context.Background()); err != nil || len(rtn.Routes) != 0 {
		t.Fatalf("refresh must forget refusals, got %+v, %v", rtn, err)
	}
}

// slowPiCatalog stands in for the harness CLIs: claude answers at once and pi waits for release, the way a cold
// `pi --list-models` spends seconds under load. Both fail on a done context, as exec.CommandContext does.
type slowPiCatalog struct {
	release    chan struct{}
	piCalls    atomic.Int32
	claudeCall atomic.Int32
}

func newSlowPiCatalog(t *testing.T) *slowPiCatalog {
	c := &slowPiCatalog{release: make(chan struct{})}
	restore := runroute.SetCatalogCommandForTest(func(ctx context.Context, bin string, _ ...string) ([]byte, error) {
		if bin == "pi" {
			c.piCalls.Add(1)
			select {
			case <-c.release:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			return []byte("provider model context\nopenai gpt-x 128K\n"), nil
		}
		c.claudeCall.Add(1)
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return []byte("  --model <model>  Model for the current session, an alias like 'sonnet' or 'opus'\n"), nil
	})
	runroute.RefreshRouteCatalog()
	old := probeHarnesses
	probeHarnesses = func(ctx context.Context) []harness.ProbeResult {
		return []harness.ProbeResult{
			{Spec: harness.Spec{Runtime: "pi", Label: "Pi", RunWorkerCapable: true}, Installed: true},
			{Spec: harness.Spec{Runtime: "claude", Label: "Claude Code", RunWorkerCapable: true}, Installed: true},
		}
	}
	t.Cleanup(func() {
		c.releasePi()
		// no enumeration may outlive the test into the next one's cache
		c.waitForModels(t, "pi")
		probeHarnesses = old
		restore()
		runroute.RefreshRouteCatalog()
	})
	return c
}

func (c *slowPiCatalog) releasePi() {
	select {
	case <-c.release:
	default:
		close(c.release)
	}
}

func listedModels(t *testing.T, ctx context.Context, runtime string) []string {
	t.Helper()
	rtn, err := (&WshServer{}).ListHarnessesCommand(ctx)
	if err != nil {
		t.Fatalf("ListHarnessesCommand: %v", err)
	}
	models := []string{}
	for _, h := range rtn.Harnesses {
		for _, c := range h.RouteCapabilities {
			if h.Runtime == runtime && c.Model != "" {
				models = append(models, c.Model)
			}
		}
	}
	return models
}

func (c *slowPiCatalog) waitForModels(t *testing.T, runtime string) []string {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if models := listedModels(t, context.Background(), runtime); len(models) > 0 {
			return models
		}
	}
	t.Fatalf("%s models never listed", runtime)
	return nil
}

// A slow pi spent the whole request's deadline, claude was then enumerated on an expired context, and the picker
// listed no model at all: the launcher's "Loading models…" with nothing under it.
func TestListHarnessesListsClaudeWhilePiIsSlow(t *testing.T) {
	newSlowPiCatalog(t)
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	claude := listedModels(t, ctx, "claude")

	if !slices.Contains(claude, "opus") {
		t.Fatalf("claude models = %v while pi was still listing, want opus among them", claude)
	}
}

// The request that started an enumeration giving up must not throw the enumeration away: it used to die with the
// request, nothing was cached, and the next picker open spawned the same CLI again from cold.
func TestListHarnessesFinishesTheCatalogPastTheCallersDeadline(t *testing.T) {
	c := newSlowPiCatalog(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if early := listedModels(t, ctx, "pi"); len(early) != 0 {
		t.Fatalf("pi models = %v before pi answered", early)
	}

	c.releasePi()
	models := c.waitForModels(t, "pi")

	if !slices.Contains(models, "openai/gpt-x") {
		t.Fatalf("pi models = %v, want openai/gpt-x", models)
	}
	if n := c.piCalls.Load(); n != 1 {
		t.Fatalf("pi --list-models ran %d times, want once: the first enumeration must fill the cache", n)
	}
}

// the frontend's boot request is not the only thing that fills the catalog: wavesrv lists it at startup itself
func TestWarmRouteCatalogListsModelsBeforeAnyPickerAsks(t *testing.T) {
	c := newSlowPiCatalog(t)
	c.releasePi()

	WarmRouteCatalog()
	piBefore, claudeBefore := c.piCalls.Load(), c.claudeCall.Load()
	claude := listedModels(t, context.Background(), "claude")
	pi := listedModels(t, context.Background(), "pi")

	if !slices.Contains(claude, "opus") || !slices.Contains(pi, "openai/gpt-x") {
		t.Fatalf("claude = %v, pi = %v after the warm-up, want both listed", claude, pi)
	}
	if c.piCalls.Load() != piBefore || c.claudeCall.Load() != claudeBefore {
		t.Fatal("a picker's listing re-ran a harness CLI the warm-up had already listed")
	}
}
