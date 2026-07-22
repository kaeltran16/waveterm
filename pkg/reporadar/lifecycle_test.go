// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func fp(sub string) string { return fingerprint("/repos/pay", RiskTestCoverageGap, sub) }

func find(sub string) waveobj.RadarFinding {
	return waveobj.RadarFinding{
		ID: "f", Fingerprint: fp(sub), Group: GroupNew, RiskKind: RiskTestCoverageGap,
		Subsystem: sub, Severity: SeverityHigh, Strength: StrengthStrong,
	}
}

func TestReconcileClassifies(t *testing.T) {
	// previous report had coupons (open) and checkout (open)
	prev := &waveobj.RadarReport{Findings: []waveobj.RadarFinding{
		{Fingerprint: fp("src/coupons"), Group: GroupNew, RiskKind: RiskTestCoverageGap, Subsystem: "src/coupons"},
		{Fingerprint: fp("src/checkout"), Group: GroupNew, RiskKind: RiskTestCoverageGap, Subsystem: "src/checkout"},
	}}
	// current scan still finds coupons, plus a brand-new auth finding; checkout disappeared
	current := []waveobj.RadarFinding{find("src/coupons"), find("src/auth")}
	out := reconcile("/repos/pay", current, prev, map[string]int64{})

	groups := map[string]string{}
	for _, f := range out {
		groups[f.Subsystem] = f.Group
	}
	if groups["src/coupons"] != GroupRecurring {
		t.Fatalf("coupons should recur, got %q", groups["src/coupons"])
	}
	if groups["src/auth"] != GroupNew {
		t.Fatalf("auth should be new, got %q", groups["src/auth"])
	}
	if groups["src/checkout"] != GroupNoLonger {
		t.Fatalf("checkout should be no-longer-detected, got %q", groups["src/checkout"])
	}
}

func TestReconcileCarriesSuppression(t *testing.T) {
	prev := &waveobj.RadarReport{Findings: []waveobj.RadarFinding{
		{Fingerprint: fp("src/legacy"), Group: GroupSuppressed, RiskKind: RiskTestCoverageGap, Subsystem: "src/legacy",
			Disposition: &waveobj.RadarDisposition{Action: "suppress", Ts: 50}},
	}}
	current := []waveobj.RadarFinding{find("src/legacy")}
	out := reconcile("/repos/pay", current, prev, map[string]int64{})
	if len(out) != 1 || out[0].Group != GroupSuppressed {
		t.Fatalf("suppressed fingerprint must stay suppressed, got %+v", out)
	}
	if out[0].Disposition == nil {
		t.Fatalf("carried suppression must retain its disposition")
	}
}

func TestReconcileReopensDismissedOnNewerEvidence(t *testing.T) {
	prev := &waveobj.RadarReport{Findings: []waveobj.RadarFinding{
		{Fingerprint: fp("src/coupons"), Group: GroupDismissed, RiskKind: RiskTestCoverageGap, Subsystem: "src/coupons",
			Disposition: &waveobj.RadarDisposition{Action: "dismiss", Ts: 50}},
	}}
	current := []waveobj.RadarFinding{find("src/coupons")}

	// newer evidence than the dismissal -> reopened as recurring
	reopened := reconcile("/repos/pay", current, prev, map[string]int64{fp("src/coupons"): 100})
	if reopened[0].Group != GroupRecurring || reopened[0].Disposition != nil {
		t.Fatalf("newer evidence must reopen dismissal, got %+v", reopened[0])
	}

	// no newer evidence -> stays dismissed with its disposition carried forward
	stale := reconcile("/repos/pay", current, prev, map[string]int64{fp("src/coupons"): 10})
	if stale[0].Group != GroupDismissed || stale[0].Disposition == nil {
		t.Fatalf("stale evidence must stay dismissed, got %+v", stale[0])
	}
}

func TestReconcileCarriesInvestigationForward(t *testing.T) {
	inv := &waveobj.RadarInvestigation{RunID: "r1", Status: "done", CompletedTs: 40, FilesTouched: 3}
	prev := &waveobj.RadarReport{Findings: []waveobj.RadarFinding{
		{Fingerprint: fp("src/coupons"), Group: GroupNew, RiskKind: RiskTestCoverageGap, Subsystem: "src/coupons", Investigation: inv},
	}}
	// still detected -> Recurring, but the investigation record rides along (the "still detected" signal)
	out := reconcile("/repos/pay", []waveobj.RadarFinding{find("src/coupons")}, prev, map[string]int64{})
	if len(out) != 1 || out[0].Group != GroupRecurring {
		t.Fatalf("expected recurring, got %+v", out)
	}
	if out[0].Investigation == nil || out[0].Investigation.RunID != "r1" {
		t.Fatalf("investigation must carry forward, got %+v", out[0].Investigation)
	}
}

func TestReconcileDoesNotInventInvestigationForNewFinding(t *testing.T) {
	out := reconcile("/repos/pay", []waveobj.RadarFinding{find("src/auth")}, nil, map[string]int64{})
	if out[0].Investigation != nil {
		t.Fatalf("a brand-new finding must have no investigation, got %+v", out[0].Investigation)
	}
}

func TestAssignFindingIDsUniqueAndDeterministic(t *testing.T) {
	// Two lenses each number their findings f1.. independently, so the merged set collides on "f1"; a
	// carried-forward finding brings yet another old id. All must come out uniquely renumbered in order.
	in := []waveobj.RadarFinding{
		{ID: "f1", Fingerprint: "RAD-corr"},
		{ID: "f1", Fingerprint: "RAD-sec"},
		{ID: "f7", Fingerprint: "RAD-carried"},
	}
	out := assignFindingIDs(in)
	if len(out) != 3 || out[0].ID != "f1" || out[1].ID != "f2" || out[2].ID != "f3" {
		t.Fatalf("want f1,f2,f3 in order, got %q,%q,%q", out[0].ID, out[1].ID, out[2].ID)
	}
	seen := map[string]bool{}
	for _, f := range out {
		if seen[f.ID] {
			t.Fatalf("duplicate id %q in %+v", f.ID, out)
		}
		seen[f.ID] = true
	}
}
