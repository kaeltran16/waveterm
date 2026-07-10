// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import "testing"

func TestSubsystemForPaths(t *testing.T) {
	cases := []struct {
		paths []string
		want  string
	}{
		{[]string{"src/coupons/validate.ts", "src/coupons/rules.ts"}, "src/coupons"},
		{[]string{"src/checkout/cart.ts", "src/coupons/validate.ts"}, "src"},
		{[]string{"migrations/0007_x.sql"}, "migrations"},
		{[]string{"main.go"}, "."},
		{nil, "unknown"},
	}
	for _, c := range cases {
		if got := subsystemForPaths(c.paths); got != c.want {
			t.Fatalf("paths=%v want %q got %q", c.paths, c.want, got)
		}
	}
}

func TestSubsystemStableUnderReorder(t *testing.T) {
	a := subsystemForPaths([]string{"src/a/x.ts", "src/a/y.ts"})
	b := subsystemForPaths([]string{"src/a/y.ts", "src/a/x.ts"})
	if a != b {
		t.Fatalf("subsystem must be order-independent: %q vs %q", a, b)
	}
}
