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

func bySubsystem(fs []waveobj.RadarFinding) map[string]waveobj.RadarFinding {
	out := map[string]waveobj.RadarFinding{}
	for _, f := range fs {
		out[f.Subsystem] = f
	}
	return out
}

func TestReconcileClassifies(t *testing.T) {
	// previous report had coupons (open) and checkout (open)
	prev := []waveobj.RadarFinding{
		{Fingerprint: fp("src/coupons"), Group: GroupNew, RiskKind: RiskTestCoverageGap, Subsystem: "src/coupons"},
		{Fingerprint: fp("src/checkout"), Group: GroupNew, RiskKind: RiskTestCoverageGap, Subsystem: "src/checkout"},
	}
	// current scan still finds coupons, plus a brand-new auth finding; checkout disappeared
	current := []waveobj.RadarFinding{find("src/coupons"), find("src/auth")}
	out := bySubsystem(reconcile(current, prev, nil, nil))

	if out["src/coupons"].Group != GroupRecurring {
		t.Fatalf("coupons should recur, got %q", out["src/coupons"].Group)
	}
	if out["src/auth"].Group != GroupNew {
		t.Fatalf("auth should be new, got %q", out["src/auth"].Group)
	}
	// one miss is usually model variance, not vanished evidence
	if c := out["src/checkout"]; c.Group != GroupNew || c.MissCount != 1 {
		t.Fatalf("checkout should stay open after one miss, got group=%q misses=%d", c.Group, c.MissCount)
	}
}

func TestReconcileMovesToNoLongerAfterConsecutiveMisses(t *testing.T) {
	scan1 := reconcile(nil, []waveobj.RadarFinding{find("src/checkout")}, nil, nil)
	scan2 := reconcile(nil, scan1, nil, nil)
	if len(scan2) != 1 || scan2[0].Group != GroupNoLonger {
		t.Fatalf("a second consecutive miss must move it to no-longer-detected, got %+v", scan2)
	}
	if scan3 := reconcile(nil, scan2, nil, nil); len(scan3) != 0 {
		t.Fatalf("a no-longer-detected finding missed again is dropped, got %+v", scan3)
	}
}

func TestReconcileRedetectionResetsMisses(t *testing.T) {
	missed := find("src/checkout")
	missed.MissCount = 1
	out := reconcile([]waveobj.RadarFinding{find("src/checkout")}, []waveobj.RadarFinding{missed}, nil, nil)
	if len(out) != 1 || out[0].Group != GroupRecurring || out[0].MissCount != 0 {
		t.Fatalf("a redetected finding recurs with its misses cleared, got %+v", out)
	}
}

// A dismissal or suppression is a user decision. It must outlive the finding going undetected, or the
// next detection would resurface it as New.
func TestReconcileKeepsDecisionsWhenUndetected(t *testing.T) {
	dismissed := find("src/legacy")
	dismissed.Group, dismissed.Disposition = GroupDismissed, &waveobj.RadarDisposition{Action: "dismiss", Ts: 50}
	suppressed := find("src/vendor")
	suppressed.Group, suppressed.Disposition = GroupSuppressed, &waveobj.RadarDisposition{Action: "suppress", Ts: 50}

	missedTwice := reconcile(nil, reconcile(nil, []waveobj.RadarFinding{dismissed, suppressed}, nil, nil), nil, nil)
	out := bySubsystem(missedTwice)
	if f := out["src/legacy"]; f.Group != GroupDismissed || f.Disposition == nil {
		t.Fatalf("undetected dismissal must carry with its disposition, got %+v", f)
	}
	if f := out["src/vendor"]; f.Group != GroupSuppressed || f.Disposition == nil {
		t.Fatalf("undetected suppression must carry with its disposition, got %+v", f)
	}

	// detected again on evidence older than the dismissal, it stays dismissed
	back := bySubsystem(reconcile([]waveobj.RadarFinding{find("src/legacy")}, missedTwice, map[string]int64{fp("src/legacy"): 10}, nil))
	if f := back["src/legacy"]; f.Group != GroupDismissed || f.Disposition == nil {
		t.Fatalf("redetection on old evidence must not reopen a dismissal, got %+v", f)
	}
}

// A lens that failed to cluster says nothing about its findings, so they carry unchanged.
func TestReconcileCarriesFailedLensFindingsUnchanged(t *testing.T) {
	sec := find("src/auth")
	sec.Mode, sec.Group = ModeSecurity, GroupRecurring
	legacy := find("src/coupons") // written before modes existed: no mode, which meant correctness
	failed := map[string]bool{ModeSecurity: true, ModeCorrectness: true}

	out := bySubsystem(reconcile(nil, []waveobj.RadarFinding{sec, legacy}, nil, failed))
	if f := out["src/auth"]; f.Group != GroupRecurring || f.MissCount != 0 {
		t.Fatalf("a failed lens's finding must carry unchanged, got %+v", f)
	}
	if f := out["src/coupons"]; f.Group != GroupNew || f.MissCount != 0 {
		t.Fatalf("a mode-less finding belongs to the correctness lens, got %+v", f)
	}
}

func TestReconcileCarriesSuppression(t *testing.T) {
	prev := []waveobj.RadarFinding{
		{Fingerprint: fp("src/legacy"), Group: GroupSuppressed, RiskKind: RiskTestCoverageGap, Subsystem: "src/legacy",
			Disposition: &waveobj.RadarDisposition{Action: "suppress", Ts: 50}},
	}
	current := []waveobj.RadarFinding{find("src/legacy")}
	out := reconcile(current, prev, nil, nil)
	if len(out) != 1 || out[0].Group != GroupSuppressed {
		t.Fatalf("suppressed fingerprint must stay suppressed, got %+v", out)
	}
	if out[0].Disposition == nil {
		t.Fatalf("carried suppression must retain its disposition")
	}
}

func TestReconcileReopensDismissedOnNewerEvidence(t *testing.T) {
	prev := []waveobj.RadarFinding{
		{Fingerprint: fp("src/coupons"), Group: GroupDismissed, RiskKind: RiskTestCoverageGap, Subsystem: "src/coupons",
			Disposition: &waveobj.RadarDisposition{Action: "dismiss", Ts: 50}},
	}
	current := []waveobj.RadarFinding{find("src/coupons")}

	// newer evidence than the dismissal -> reopened as recurring
	reopened := reconcile(current, prev, map[string]int64{fp("src/coupons"): 100}, nil)
	if reopened[0].Group != GroupRecurring || reopened[0].Disposition != nil {
		t.Fatalf("newer evidence must reopen dismissal, got %+v", reopened[0])
	}

	// no newer evidence -> stays dismissed with its disposition carried forward
	stale := reconcile(current, prev, map[string]int64{fp("src/coupons"): 10}, nil)
	if stale[0].Group != GroupDismissed || stale[0].Disposition == nil {
		t.Fatalf("stale evidence must stay dismissed, got %+v", stale[0])
	}
}

// Standing facts carry the scan window as their observed time; counting them as evidence time would
// reopen every dismissal once the rolling window moved past it.
func TestEvidenceTimestampsIgnoreStandingFacts(t *testing.T) {
	structure := newSignal(CollectorStructure, "struct:no-test:src", 900, []string{"src/a.ts"}, "n", nil, "")
	commit := newSignal(CollectorGit, "commit:1", 100, []string{"src/a.ts"}, "c", nil, "")
	byID := map[string]waveobj.RadarSignal{structure.ID: structure, commit.ID: commit}
	f := waveobj.RadarFinding{Fingerprint: "RAD-x", SignalIDs: []string{structure.ID, commit.ID}}
	if got := evidenceTimestamps([]waveobj.RadarFinding{f}, byID)["RAD-x"]; got != 100 {
		t.Fatalf("evidence time must come from the commit (100), got %d", got)
	}
}

func TestReconcileCarriesInvestigationForward(t *testing.T) {
	inv := &waveobj.RadarInvestigation{RunID: "r1", Status: "done", CompletedTs: 40, FilesTouched: 3}
	prev := []waveobj.RadarFinding{
		{Fingerprint: fp("src/coupons"), Group: GroupNew, RiskKind: RiskTestCoverageGap, Subsystem: "src/coupons", Investigation: inv},
	}
	// still detected -> Recurring, but the investigation record rides along (the "still detected" signal)
	out := reconcile([]waveobj.RadarFinding{find("src/coupons")}, prev, nil, nil)
	if len(out) != 1 || out[0].Group != GroupRecurring {
		t.Fatalf("expected recurring, got %+v", out)
	}
	if out[0].Investigation == nil || out[0].Investigation.RunID != "r1" {
		t.Fatalf("investigation must carry forward, got %+v", out[0].Investigation)
	}
}

func TestReconcileDoesNotInventInvestigationForNewFinding(t *testing.T) {
	out := reconcile([]waveobj.RadarFinding{find("src/auth")}, nil, nil, nil)
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
