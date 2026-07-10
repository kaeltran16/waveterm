// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestRadarReportRoundTrip(t *testing.T) {
	ctx := context.Background()
	rpt, err := CreateRadarReport(ctx, "payments-api", "/repos/payments-api")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if rpt.OID == "" || rpt.Status != "collecting" {
		t.Fatalf("bad new report: %+v", rpt)
	}
	if err := UpdateRadarReport(ctx, rpt.OID, func(r *waveobj.RadarReport) {
		r.Status = "completed"
	}); err != nil {
		t.Fatalf("update: %v", err)
	}
	got, err := GetRadarReport(ctx, rpt.OID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Status != "completed" {
		t.Fatalf("update not persisted: %q", got.Status)
	}
	all, err := GetRadarReports(ctx, "/repos/payments-api")
	if err != nil || len(all) != 1 {
		t.Fatalf("list: %v n=%d", err, len(all))
	}
	if err := DeleteRadarReport(ctx, rpt.OID); err != nil {
		t.Fatalf("delete: %v", err)
	}
}
