// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func readPreferredRoute(t *testing.T) (string, string) {
	t.Helper()
	settings, errs := wconfig.ReadWaveHomeConfigFile(wconfig.SettingsFile)
	if len(errs) > 0 {
		t.Fatalf("reading settings: %v", errs)
	}
	runtime, _ := settings[wconfig.ConfigKey_HarnessPreferredRuntime].(string)
	tier, _ := settings[wconfig.ConfigKey_HarnessPreferredTier].(string)
	return runtime, tier
}

func TestSetConfigPreferredRouteGuardsAtomicPairs(t *testing.T) {
	withConfigHome(t, t.TempDir())
	ws := &WshServer{}
	ctx := context.Background()
	valid := waveobj.MetaMapType{
		wconfig.ConfigKey_HarnessPreferredRuntime: "pi",
		wconfig.ConfigKey_HarnessPreferredTier:    "capable",
	}
	if err := ws.SetConfigCommand(ctx, wshrpc.MetaSettingsType{MetaMapType: valid}); err != nil {
		t.Fatalf("seed valid route: %v", err)
	}

	for name, patch := range map[string]waveobj.MetaMapType{
		"unsupported pair": {
			wconfig.ConfigKey_HarnessPreferredRuntime: "openrouter",
			wconfig.ConfigKey_HarnessPreferredTier:    "capable",
		},
		"one-key patch": {
			wconfig.ConfigKey_HarnessPreferredRuntime: "claude",
		},
	} {
		t.Run(name, func(t *testing.T) {
			if err := ws.SetConfigCommand(ctx, wshrpc.MetaSettingsType{MetaMapType: patch}); err == nil {
				t.Fatal("expected route validation error")
			}
			gotRuntime, gotTier := readPreferredRoute(t)
			if gotRuntime != "pi" || gotTier != "capable" {
				t.Fatalf("invalid patch changed route: got %q/%q", gotRuntime, gotTier)
			}
		})
	}

	if err := ws.SetConfigCommand(ctx, wshrpc.MetaSettingsType{MetaMapType: waveobj.MetaMapType{"app:defaultnewblock": "route-test"}}); err != nil {
		t.Fatalf("unrelated config patch: %v", err)
	}
	settings, errs := wconfig.ReadWaveHomeConfigFile(wconfig.SettingsFile)
	if len(errs) > 0 {
		t.Fatalf("reading settings after unrelated patch: %v", errs)
	}
	if got, _ := settings["app:defaultnewblock"].(string); got != "route-test" {
		t.Fatalf("unrelated patch not persisted: %q", got)
	}
}

func TestSetConfigPreferredRouteRejectsNonStringValues(t *testing.T) {
	withConfigHome(t, t.TempDir())
	ws := &WshServer{}
	ctx := context.Background()
	if err := ws.SetConfigCommand(ctx, wshrpc.MetaSettingsType{MetaMapType: waveobj.MetaMapType{
		wconfig.ConfigKey_HarnessPreferredRuntime: "pi",
		wconfig.ConfigKey_HarnessPreferredTier:    "capable",
	}}); err != nil {
		t.Fatalf("seed valid route: %v", err)
	}
	if err := ws.SetConfigCommand(ctx, wshrpc.MetaSettingsType{MetaMapType: waveobj.MetaMapType{
		wconfig.ConfigKey_HarnessPreferredRuntime: "pi",
		wconfig.ConfigKey_HarnessPreferredTier:    1,
	}}); err == nil {
		t.Fatal("expected non-string route validation error")
	}
	gotRuntime, gotTier := readPreferredRoute(t)
	if gotRuntime != "pi" || gotTier != "capable" {
		t.Fatalf("non-string patch changed route: got %q/%q", gotRuntime, gotTier)
	}
}
