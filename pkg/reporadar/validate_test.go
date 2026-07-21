// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestValidateRejectsBadFindings(t *testing.T) {
	// three corroborating sources over one subsystem => strong evidence (>=2 sources AND >=3 signals).
	sigs := []waveobj.RadarSignal{
		newSignal(CollectorGit, "commit:1", 1, []string{"src/coupons/validate.ts"}, "x", nil, ""),
		newSignal(CollectorRuns, "run:1:phase:0", 2, []string{"src/coupons/validate.ts"}, "y", nil, ""),
		newSignal(CollectorTranscript, "tx:1", 3, []string{"src/coupons/validate.ts"}, "z", nil, ""),
	}
	byID := map[string]waveobj.RadarSignal{}
	for _, s := range sigs {
		byID[s.ID] = s
	}
	resp := &SynthResponse{Findings: []SynthFinding{
		{RiskKind: RiskTestCoverageGap, Risk: "ok", Why: "w", Severity: "high",
			SignalIDs: []string{sigs[0].ID, sigs[1].ID, sigs[2].ID}, Files: []string{"src/coupons/validate.ts"}, Mission: "m"},
		{RiskKind: "style-nit", Risk: "bad kind", SignalIDs: []string{sigs[0].ID}}, // unknown kind -> reject
		{RiskKind: RiskTestCoverageGap, Risk: "ghost", SignalIDs: []string{"nope"}}, // unknown signal -> reject
		{RiskKind: RiskMigrationSafety, Risk: "wrongfile", SignalIDs: []string{sigs[0].ID}, Files: []string{"src/other.ts"}}, // file not in signals -> reject
	}}
	findings := validateFindings("/repos/pay", ModeCorrectness, resp, byID)
	if len(findings) != 1 {
		t.Fatalf("expected 1 valid finding, got %d", len(findings))
	}
	f := findings[0]
	if f.Subsystem != "src/coupons" {
		t.Fatalf("canonical subsystem should derive from signal paths, got %q", f.Subsystem)
	}
	if f.Fingerprint == "" || f.Strength != StrengthStrong {
		t.Fatalf("expected fingerprint + strong strength, got fp=%q str=%q", f.Fingerprint, f.Strength)
	}
}

func TestValidateEnforcesTenCap(t *testing.T) {
	byID := map[string]waveobj.RadarSignal{}
	var findings []SynthFinding
	// use runs signals (an explicit failure) so each single-signal finding survives validation;
	// 15 distinct-subsystem survivors then force the ten-cap to actually truncate.
	for i := 0; i < 15; i++ {
		s := newSignal(CollectorRuns, "run:x"+string(rune('a'+i))+":phase:0", int64(i), []string{"src/m" + string(rune('a'+i)) + "/f.ts"}, "s", nil, "")
		byID[s.ID] = s
		findings = append(findings, SynthFinding{
			RiskKind: RiskTestCoverageGap, Risk: "r", Why: "w", Severity: "low",
			SignalIDs: []string{s.ID}, Files: s.Paths, Mission: "m",
		})
	}
	out := validateFindings("/repos/pay", ModeCorrectness, &SynthResponse{Findings: findings}, byID)
	if len(out) != MaxFindings {
		t.Fatalf("expected exactly %d after cap, got %d", MaxFindings, len(out))
	}
}

func TestValidateStampsModeAndRejectsForeignKind(t *testing.T) {
	sigs := []waveobj.RadarSignal{
		newSignal(CollectorGit, "commit:1", 1, []string{"src/pay/a.ts"}, "x", nil, ""),
		newSignal(CollectorRuns, "run:1:phase:0", 2, []string{"src/pay/a.ts"}, "y", nil, ""),
		newSignal(CollectorTranscript, "tx:1", 3, []string{"src/pay/a.ts"}, "z", nil, ""),
	}
	byID := map[string]waveobj.RadarSignal{}
	for _, s := range sigs {
		byID[s.ID] = s
	}
	resp := &SynthResponse{Findings: []SynthFinding{
		{RiskKind: RiskTestCoverageGap, Risk: "ok", Why: "w", Severity: "high",
			SignalIDs: []string{sigs[0].ID, sigs[1].ID, sigs[2].ID}, Files: []string{"src/pay/a.ts"}, Mission: "m"},
	}}
	// validated under correctness: kept, and stamped correctness.
	got := validateFindings("/repos/pay", ModeCorrectness, resp, byID)
	if len(got) != 1 || got[0].Mode != ModeCorrectness {
		t.Fatalf("expected 1 finding stamped correctness, got %+v", got)
	}
	// the same correctness kind under a mode that does not own it: rejected.
	if out := validateFindings("/repos/pay", ModeSecurity, resp, byID); len(out) != 0 {
		t.Fatalf("a correctness kind must be rejected under the security mode, got %d", len(out))
	}
}
