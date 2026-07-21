// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import "testing"

func TestValidRiskKind(t *testing.T) {
	if !ValidRiskKind(ModeCorrectness, RiskTestCoverageGap) {
		t.Fatal("test-coverage-gap should be valid for correctness")
	}
	if ValidRiskKind(ModeCorrectness, "style-nit") {
		t.Fatal("style-nit must be rejected")
	}
	if ValidRiskKind("no-such-mode", RiskTestCoverageGap) {
		t.Fatal("unknown mode must reject every kind")
	}
	if len(V1RiskKinds) != 6 {
		t.Fatalf("expected 6 v1 correctness risk kinds, got %d", len(V1RiskKinds))
	}
}

// TestRiskKindsGloballyUnique guards the invariant the fingerprint depends on: no risk-kind name is
// shared across modes, so fingerprints (project+kind+subsystem) never collide across modes and
// reconcile segregates modes with no mode-awareness.
func TestRiskKindsGloballyUnique(t *testing.T) {
	seen := map[string]string{}
	for mode, kinds := range RiskKindsByMode {
		for _, k := range kinds {
			if other, dup := seen[k]; dup {
				t.Fatalf("risk kind %q registered under both %q and %q — must be globally unique", k, other, mode)
			}
			seen[k] = mode
		}
	}
}
