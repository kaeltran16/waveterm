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
	pool := []waveobj.RadarSignal{s1, s2, s3}
	wstore.UpdateRadarReport(ctx, rpt.OID, func(r *waveobj.RadarReport) { r.Candidates = pool })
	byID := map[string]waveobj.RadarSignal{s1.ID: s1, s2.ID: s2, s3.ID: s3}
	resp := &SynthResponse{Findings: []SynthFinding{{
		RiskKind: RiskTestCoverageGap, Risk: "coupon branches uncovered", Why: "w", Severity: "high",
		SignalIDs: []string{s1.ID, s2.ID}, Files: []string{"src/coupons/validate.ts"}, Mission: "add tests",
	}}}
	validated := validateFindings("/repos/pay", ModeCorrectness, resp, byID)
	runs := []waveobj.RadarModeRun{{Mode: ModeCorrectness, Status: ModeRunCompleted, ResolvedModel: "claude-sonnet-x"}}
	finalizeFindings(ctx, rpt.OID, validated, runs, pool, nil)

	got, _ := wstore.GetRadarReport(ctx, rpt.OID)
	if got.Status != StatusCompleted {
		t.Fatalf("want completed, got %q", got.Status)
	}
	if len(got.Findings) != 1 || got.Findings[0].Group != GroupNew {
		t.Fatalf("expected 1 new finding, got %+v", got.Findings)
	}
	if len(got.ModeRuns) != 1 || got.ModeRuns[0].Status != ModeRunCompleted {
		t.Fatalf("expected 1 completed mode run, got %+v", got.ModeRuns)
	}
	if len(got.Candidates) != 0 {
		t.Fatalf("candidates should be pruned after success, got %d", len(got.Candidates))
	}
	if len(got.Signals) != 2 {
		t.Fatalf("expected 2 referenced signals retained, got %d", len(got.Signals))
	}
}

func TestFinalizeRetainsCandidatesOnClusterFailure(t *testing.T) {
	ctx := context.Background()
	rpt, _ := wstore.CreateRadarReport(ctx, "pay", "/repos/pay")
	s1 := newSignal(CollectorGit, "commit:1", 100, []string{"src/coupons/validate.ts"}, "changed", nil, "")
	pool := []waveobj.RadarSignal{s1}
	wstore.UpdateRadarReport(ctx, rpt.OID, func(r *waveobj.RadarReport) { r.Candidates = pool })
	runs := []waveobj.RadarModeRun{{Mode: ModeCorrectness, Status: ModeRunClusterFailed, ClusterError: "boom"}}
	finalizeFindings(ctx, rpt.OID, nil, runs, pool, nil)

	got, _ := wstore.GetRadarReport(ctx, rpt.OID)
	if got.Status != StatusFailed {
		t.Fatalf("all-lenses-failed must be failed, got %q", got.Status)
	}
	if len(got.Candidates) != 1 {
		t.Fatalf("candidates must be retained for retry on failure, got %d", len(got.Candidates))
	}
	if got.ClusterError == "" {
		t.Fatalf("aggregate cluster error must be recorded")
	}
}
