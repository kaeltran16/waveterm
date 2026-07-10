// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestRetryRejectsWhenNoRetainedCandidates(t *testing.T) {
	ctx := context.Background()
	rpt, _ := wstore.CreateRadarReport(ctx, "pay", "/repos/pay")
	wstore.UpdateRadarReport(ctx, rpt.OID, func(r *waveobj.RadarReport) {
		r.Status = StatusFailed
		r.Candidates = nil // pruned/none
	})
	if err := Retry(ctx, rpt.OID); err == nil {
		t.Fatal("retry without retained candidates must error")
	}
}

func TestRetryRejectsWhenNotFailed(t *testing.T) {
	ctx := context.Background()
	rpt, _ := wstore.CreateRadarReport(ctx, "pay", "/repos/pay")
	wstore.UpdateRadarReport(ctx, rpt.OID, func(r *waveobj.RadarReport) {
		r.Status = StatusCompleted
		r.Candidates = []waveobj.RadarSignal{newSignal(CollectorRuns, "run:1:phase:0", 1, []string{"src/a.ts"}, "s", nil, "")}
	})
	if err := Retry(ctx, rpt.OID); err == nil {
		t.Fatal("retry on a non-failed report must error")
	}
}
