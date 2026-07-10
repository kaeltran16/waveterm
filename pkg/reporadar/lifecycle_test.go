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
