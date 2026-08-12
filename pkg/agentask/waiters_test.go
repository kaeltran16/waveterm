// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentask

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

func TestResolveWaiterDeliversOnce(t *testing.T) {
	r := MakeRegistry()
	ch := r.RegisterWaiter("a1")
	if !r.ResolveWaiter("a1", WaitResult{Answers: []baseds.AgentAnswerItem{{SelectedIndexes: []int{1}}}}) {
		t.Fatal("resolve must report the waiter was registered")
	}
	select {
	case res := <-ch:
		if res.Cancelled || len(res.Answers) != 1 || res.Answers[0].SelectedIndexes[0] != 1 {
			t.Fatalf("bad result: %#v", res)
		}
	default:
		t.Fatal("waiter must receive the result")
	}
	// second resolve is a no-op (entry removed on first resolve)
	if r.ResolveWaiter("a1", WaitResult{Cancelled: true}) {
		t.Fatal("second resolve must report no waiter")
	}
}

func TestResolveWaiterNoWaiter(t *testing.T) {
	r := MakeRegistry()
	if r.ResolveWaiter("nope", WaitResult{Cancelled: true}) {
		t.Fatal("resolving an unregistered askId must be a no-op")
	}
}

func TestRemoveWaiterGivesUp(t *testing.T) {
	r := MakeRegistry()
	ch := r.RegisterWaiter("a1")
	r.RemoveWaiter("a1")
	if r.ResolveWaiter("a1", WaitResult{Cancelled: true}) {
		t.Fatal("removed waiter must not resolve")
	}
	if len(ch) != 0 {
		t.Fatal("removed waiter must not have a buffered result")
	}
}
