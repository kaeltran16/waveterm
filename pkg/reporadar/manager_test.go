// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"testing"
)

func TestManagerRegisterCancel(t *testing.T) {
	m := newScanManager()
	ctx, ok := m.register("r1")
	if !ok {
		t.Fatal("first register should succeed")
	}
	if _, ok := m.register("r1"); ok {
		t.Fatal("duplicate register must fail (one active scan per report)")
	}
	if !m.cancel("r1") {
		t.Fatal("cancel of active report should return true")
	}
	if ctx.Err() == nil {
		t.Fatal("cancel must cancel the context")
	}
	if m.cancel("r1") {
		t.Fatal("cancel after cancel should return false")
	}
}
