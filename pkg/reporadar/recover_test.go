// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestRecoverInterruptedScans(t *testing.T) {
	ctx := context.Background()
	stuck, _ := wstore.CreateRadarReport(ctx, "pay", "/repos/pay") // status=collecting
	done, _ := wstore.CreateRadarReport(ctx, "pay2", "/repos/pay2")
	wstore.UpdateRadarReport(ctx, done.OID, func(r *waveobj.RadarReport) { r.Status = StatusCompleted })

	RecoverInterruptedScans(ctx)

	gs, _ := wstore.GetRadarReport(ctx, stuck.OID)
	if gs.Status != StatusFailed || gs.FatalError != "scan-interrupted" {
		t.Fatalf("stuck report should be failed/scan-interrupted, got %q/%q", gs.Status, gs.FatalError)
	}
	gd, _ := wstore.GetRadarReport(ctx, done.OID)
	if gd.Status != StatusCompleted {
		t.Fatalf("completed report must be untouched, got %q", gd.Status)
	}
}
