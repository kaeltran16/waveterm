// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestFinalizePersistsFindingsAndPrunes(t *testing.T) {
	ctx := context.Background()
	rpt, _ := wstore.CreateRadarReport(ctx, "pay", "/repos/pay")
	s1 := newSignal(CollectorGit, "commit:1", 100, []string{"src/coupons/validate.ts"}, "changed", nil, "")
	s2 := newSignal(CollectorRuns, "run:1:phase:0", 200, []string{"src/coupons/validate.ts"}, "failed", nil, "")
	s3 := newSignal(CollectorStructure, "struct:no-test:src/unrelated.ts", 50, []string{"src/unrelated.ts"}, "no test", nil, "")
	wstore.UpdateRadarReport(ctx, rpt.OID, func(r *waveobj.RadarReport) {
		r.Candidates = []waveobj.RadarSignal{s1, s2, s3}
	})
	resp := &SynthResponse{Findings: []SynthFinding{{
		RiskKind: RiskTestCoverageGap, Risk: "coupon branches uncovered", Why: "w", Severity: "high",
		SignalIDs: []string{s1.ID, s2.ID}, Files: []string{"src/coupons/validate.ts"}, Mission: "add tests",
	}}}
	finalizeFindings(ctx, rpt.OID, resp, []waveobj.RadarSignal{s1, s2, s3}, nil)

	got, _ := wstore.GetRadarReport(ctx, rpt.OID)
	if got.Status != StatusCompleted {
		t.Fatalf("want completed, got %q", got.Status)
	}
	if len(got.Findings) != 1 || got.Findings[0].Group != GroupNew {
		t.Fatalf("expected 1 new finding, got %+v", got.Findings)
	}
	// candidates pruned; only referenced signals retained (s1,s2 — not s3)
	if len(got.Candidates) != 0 {
		t.Fatalf("candidates should be pruned after success, got %d", len(got.Candidates))
	}
	if len(got.Signals) != 2 {
		t.Fatalf("expected 2 referenced signals retained, got %d", len(got.Signals))
	}
}
