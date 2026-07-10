// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestCollectRunsEmitsFailedPhases(t *testing.T) {
	ctx := context.Background()
	proj := "/repos/pay"
	ch, err := wstore.CreateChannel(ctx, "pay", proj)
	if err != nil {
		t.Fatalf("channel: %v", err)
	}
	run := waveobj.Run{
		ID: "run1", Goal: "Harden coupon validation", ProjectPath: proj, Status: "blocked",
		Phases: []waveobj.RunPhase{
			{Kind: "execute", State: "failed", Artifacts: []string{"src/coupons/validate.ts"}},
			{Kind: "plan", State: "done"},
		},
	}
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("append run: %v", err)
	}
	sigs, err := collectRuns(ctx, collectInput{projectPath: proj})
	if err != nil {
		t.Fatalf("collectRuns: %v", err)
	}
	if len(sigs) == 0 {
		t.Fatal("expected a signal for the failed phase")
	}
	// a run for a different project must not appear
	otherSigs, _ := collectRuns(ctx, collectInput{projectPath: "/repos/other"})
	if len(otherSigs) != 0 {
		t.Fatalf("project filter leaked: %d signals", len(otherSigs))
	}
}
