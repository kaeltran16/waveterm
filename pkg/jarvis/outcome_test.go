// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"errors"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestNotifyChildOutcomeCallsHookAndContainsError(t *testing.T) {
	old := ChildOutcomeHook
	t.Cleanup(func() { ChildOutcomeHook = old })
	called := false
	ChildOutcomeHook = func(_ context.Context, worker string, data OutcomeData) error {
		called = true
		if worker != "tab:worker" || data.Status != "failed" {
			t.Fatalf("unexpected hook data: %q %+v", worker, data)
		}
		return errors.New("engine unavailable")
	}
	notifyChildOutcome(context.Background(), "tab:worker", OutcomeData{Status: "failed"})
	if !called {
		t.Fatal("child outcome hook was not called")
	}
}

func TestOutcomeStatus(t *testing.T) {
	cases := map[string]string{"done": "done", "failed": "failed", "waiting": "waiting", "": "done"}
	for in, want := range cases {
		if got := OutcomeStatus(in); got != want {
			t.Errorf("OutcomeStatus(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAlreadyHasFreshOutcome(t *testing.T) {
	// outcome newer than the latest dispatch -> fresh (skip re-post)
	fresh := &waveobj.Channel{Messages: []waveobj.ChannelMessage{
		{Kind: "dispatch", RefORef: "tab:w1", Ts: 1},
		{Kind: "outcome", RefORef: "tab:w1", Ts: 2},
	}}
	if !alreadyHasFreshOutcome(fresh, "tab:w1") {
		t.Error("want fresh=true when outcome is newer than dispatch")
	}
	// re-dispatched after the outcome -> not fresh (should post again)
	redispatched := &waveobj.Channel{Messages: []waveobj.ChannelMessage{
		{Kind: "outcome", RefORef: "tab:w1", Ts: 2},
		{Kind: "dispatch", RefORef: "tab:w1", Ts: 3},
	}}
	if alreadyHasFreshOutcome(redispatched, "tab:w1") {
		t.Error("want fresh=false when a newer dispatch supersedes the outcome")
	}
}
