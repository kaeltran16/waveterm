// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/memgate"
)

// the submit RPC runs the landing tree's Setup inline, so a gate that refuses every tree must not hold it: the
// caller would wait with no way to learn why
func TestSubmitSetupNeverWaits(t *testing.T) {
	ctx := context.Background()
	// a failing Setup is handed to the lead with its output, which shows it ran
	ch, _, plan, _ := newSetupPlanRun(t, "echo setup-ran && exit 3")
	prompt := stubLeadSpawn(t, nil)
	blocker, ok := memgate.TryAdmit(memgate.Request{Tag: memgate.Tag{Role: "test"}})
	if !ok {
		t.Fatal("an empty book must admit")
	}
	restoreFree := memgate.SetFreeForTest(func() (uint64, error) { return 0, nil })
	t.Cleanup(func() {
		restoreFree()
		blocker.Release()
	})

	done := make(chan error, 1)
	go func() {
		_, err := startPlanRun(ctx, ch, plan)
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("a submit with a Setup must complete while the gate refuses everything: %v", err)
		}
		if !strings.Contains(*prompt, "setup-ran") {
			t.Fatalf("the Setup did not run: the lead's prompt is:\n%s", *prompt)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the submit's Setup waited at the memory gate")
	}
}
