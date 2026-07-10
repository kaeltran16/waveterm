// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import "testing"

func TestFingerprintStableUnderRephrasedBoundary(t *testing.T) {
	// same project, kind, and canonical subsystem => same fingerprint, regardless of the model's
	// free-text boundary label.
	a := fingerprint("/repos/pay", RiskTestCoverageGap, "src/coupons")
	b := fingerprint("/repos/pay", RiskTestCoverageGap, "src/coupons")
	if a != b {
		t.Fatalf("expected stable fingerprint: %q vs %q", a, b)
	}
	c := fingerprint("/repos/pay", RiskTestCoverageGap, "src/checkout")
	if a == c {
		t.Fatal("different subsystem must change fingerprint")
	}
	d := fingerprint("/repos/pay", RiskMigrationSafety, "src/coupons")
	if a == d {
		t.Fatal("different risk kind must change fingerprint")
	}
}
