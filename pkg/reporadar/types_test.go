// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import "testing"

func TestValidRiskKind(t *testing.T) {
	if !ValidRiskKind(RiskTestCoverageGap) {
		t.Fatal("test-coverage-gap should be valid")
	}
	if ValidRiskKind("style-nit") {
		t.Fatal("style-nit must be rejected")
	}
	if len(V1RiskKinds) != 6 {
		t.Fatalf("expected 6 v1 risk kinds, got %d", len(V1RiskKinds))
	}
}
