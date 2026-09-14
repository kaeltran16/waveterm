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

func TestRetryRejectsPartialWithoutFailedLens(t *testing.T) {
	ctx := context.Background()
	rpt, _ := wstore.CreateRadarReport(ctx, "retry-partial", "/repos/retry-partial")
	wstore.UpdateRadarReport(ctx, rpt.OID, func(r *waveobj.RadarReport) {
		r.Status = StatusPartial
		r.Candidates = []waveobj.RadarSignal{newSignal(CollectorRuns, "run:1:phase:0", 1, []string{"src/a.ts"}, "s", nil, "")}
		r.ModeRuns = []waveobj.RadarModeRun{{Mode: ModeCorrectness, Status: ModeRunCompleted}, {Mode: ModeSecurity, Status: ModeRunCompleted}}
	})
	if err := Retry(ctx, rpt.OID); err == nil {
		t.Fatal("a partial report whose lenses all clustered has nothing to retry")
	}
}

func TestRetryModesPicksFailedLenses(t *testing.T) {
	rpt := &waveobj.RadarReport{ModeRuns: []waveobj.RadarModeRun{
		{Mode: ModeCorrectness, Status: ModeRunCompleted},
		{Mode: ModeSecurity, Status: ModeRunClusterFailed},
	}}
	if got := retryModes(rpt); len(got) != 1 || got[0] != ModeSecurity {
		t.Fatalf("want only the failed security lens, got %v", got)
	}
	if got := retryModes(&waveobj.RadarReport{}); len(got) != len(V1Modes) {
		t.Fatalf("a report that never clustered reruns every lens, got %v", got)
	}
}

// A retry reruns only the failed lens: the lens that clustered keeps its findings and run, and the rerun
// lens reconciles against the report's own findings, so a dismissal made on the partial report holds.
func TestRetryFinalizeKeepsClusteredLens(t *testing.T) {
	ctx := context.Background()
	rpt, _ := wstore.CreateRadarReport(ctx, "retry-merge", "/repos/retry-merge")
	sig := newSignal(CollectorGit, "commit:a", 100, []string{"src/auth/login.ts"}, "c", nil, "")
	corr := waveobj.RadarFinding{Fingerprint: "RAD-corr", Group: GroupRecurring, Mode: ModeCorrectness, Subsystem: "src/a", SignalIDs: []string{sig.ID}}
	sec := waveobj.RadarFinding{Fingerprint: "RAD-sec", Group: GroupDismissed, Mode: ModeSecurity, Subsystem: "src/auth", SignalIDs: []string{sig.ID},
		Disposition: &waveobj.RadarDisposition{Action: "dismiss", Ts: 500}}
	wstore.UpdateRadarReport(ctx, rpt.OID, func(r *waveobj.RadarReport) {
		r.Status = StatusPartial
		r.WindowEndTs = 1
		r.Candidates = []waveobj.RadarSignal{sig}
		r.Signals = []waveobj.RadarSignal{sig}
		r.Findings = []waveobj.RadarFinding{corr, sec}
		r.ModeRuns = []waveobj.RadarModeRun{
			{Mode: ModeCorrectness, Status: ModeRunCompleted, FindingCount: 1},
			{Mode: ModeSecurity, Status: ModeRunClusterFailed, ClusterError: "boom"},
		}
	})
	rpt, _ = wstore.GetRadarReport(ctx, rpt.OID)

	// the security lens now clusters and re-detects the dismissed finding on evidence older than the dismissal
	redetected := sec
	redetected.Group, redetected.Disposition = GroupNew, nil
	runs := []waveobj.RadarModeRun{{Mode: ModeSecurity, Status: ModeRunCompleted, FindingCount: 1}}
	finalizeFindings(ctx, rpt.OID, retryPass(ctx, rpt, retryModes(rpt), []waveobj.RadarFinding{redetected}, runs))

	got, _ := wstore.GetRadarReport(ctx, rpt.OID)
	if got.Status != StatusCompleted {
		t.Fatalf("every lens clustered, want completed, got %q", got.Status)
	}
	if len(got.ModeRuns) != 2 || got.ModeRuns[0].Mode != ModeCorrectness || got.ModeRuns[0].FindingCount != 1 || got.ModeRuns[1].Status != ModeRunCompleted {
		t.Fatalf("mode runs must merge in lens order, keeping the clustered lens's run, got %+v", got.ModeRuns)
	}
	groups := map[string]string{}
	for _, f := range got.Findings {
		groups[f.Fingerprint] = f.Group
	}
	if len(got.Findings) != 2 || groups["RAD-corr"] != GroupRecurring || groups["RAD-sec"] != GroupDismissed {
		t.Fatalf("want corr recurring and sec still dismissed, got %v", groups)
	}
	if len(got.Candidates) != 0 {
		t.Fatalf("candidates are pruned once every lens clustered, got %d", len(got.Candidates))
	}
	if got.WindowEndTs != 1 {
		t.Fatalf("a retry must keep the first pass's repository boundary, got windowendts=%d", got.WindowEndTs)
	}
}
