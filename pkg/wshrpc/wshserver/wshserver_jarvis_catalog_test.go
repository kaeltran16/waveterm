// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestCatalogPresenceWarnings(t *testing.T) {
	defer runroute.SetCatalogCommandForTest(func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte("provider model\nopencode deepseek-v4-pro 1M\n"), nil
	})()
	runroute.RefreshRouteCatalog()
	defer runroute.RefreshRouteCatalog()
	draft := jarvis.DagPlanDraft{Tasks: []jarvis.DagPlanTask{
		{ID: "t-1"},
		{ID: "t-2", Route: &waveobj.RoutePin{Runtime: "pi", Model: "opencode/deepseek-v4-pro"}},
		{ID: "t-3", Route: &waveobj.RoutePin{Runtime: "pi", Model: "not/in/catalog"}},
	}}
	warnings := catalogPresenceWarnings(draft)
	if len(warnings) != 1 {
		t.Fatalf("want one presence warning, got %+v", warnings)
	}
	if !strings.Contains(warnings[0], "t-3") || !strings.Contains(warnings[0], "not/in/catalog") {
		t.Fatalf("warning must name the task and model: %q", warnings[0])
	}
}
