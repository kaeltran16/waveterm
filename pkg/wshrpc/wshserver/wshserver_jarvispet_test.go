// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import "testing"

// The guard, not the reconcile. A double-press must not run two whole-vault rebuilds against one index db,
// and the second press is not an error the user should see — it is already happening.
func TestReconcileSingleFlight(t *testing.T) {
	reconcileRunning.Store(false)
	if !tryStartReconcile() {
		t.Fatal("first start should win")
	}
	if tryStartReconcile() {
		t.Error("second start should be refused while the first is running")
	}
	finishReconcile()
	if !tryStartReconcile() {
		t.Error("a start after completion should win again")
	}
	finishReconcile()
}
