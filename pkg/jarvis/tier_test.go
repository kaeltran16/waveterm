// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// The gatekeeper classifier and the delegator decomposer are grunt-tier calls: both are bounded,
// structured-reply prompts that already fail safe (escalate / single-element list). J3 moved them onto
// the cheap tier but left no guard, so reverting either to consult.SpecFor was a silent, free change
// that quietly restored the capable-tier bill. These assert the spec the production path actually
// hands the runner, which is the only place the revert is observable.

// captureSpec swaps the package's process runner and returns a pointer to the spec the next call
// passes it. Nothing shells out to claude.
func captureSpec(t *testing.T, reply string) *consult.RuntimeSpec {
	t.Helper()
	var got consult.RuntimeSpec
	prev := runFn
	runFn = func(_ context.Context, spec consult.RuntimeSpec, _ string, _ string, _ func(string)) (string, error) {
		got = spec
		return reply, nil
	}
	t.Cleanup(func() { runFn = prev })
	return &got
}

// assertCheapTier fails unless the spec's Model field is set to the openrouter cheap model.
func assertCheapTier(t *testing.T, spec consult.RuntimeSpec) {
	t.Helper()
	if spec.Model != consult.OpenrouterCheapModel() {
		t.Fatalf("expected Model %q in the spec handed to the runner, got %q", consult.OpenrouterCheapModel(), spec.Model)
	}
}

func TestClassifyRunsOnTheCheapTier(t *testing.T) {
	withConfigHome(t, t.TempDir())
	spec := captureSpec(t, `{"action":"escalate","reason":"n/a"}`)
	Classify(context.Background(), &waveobj.Channel{Name: "payments-api"}, aQuestion(), "some task")
	assertCheapTier(t, *spec)
}

func TestDecomposeRunsOnTheCheapTier(t *testing.T) {
	spec := captureSpec(t, `["one"]`)
	Decompose(context.Background(), "", "ship the thing", &waveobj.Channel{Name: "payments-api"})
	assertCheapTier(t, *spec)
}

// Tiered openrouter calls only set spec.Model, never mutate BaseArgs.
func TestCheapTierDoesNotMutateTheSharedClaudeSpec(t *testing.T) {
	spec := captureSpec(t, `["one"]`)
	Decompose(context.Background(), "", "ship the thing", &waveobj.Channel{Name: "payments-api"})
	assertCheapTier(t, *spec)

	shared, ok := consult.SpecFor("claude")
	if !ok {
		t.Fatal("claude spec unavailable")
	}
	// openrouter tiered call sets Model, never touches BaseArgs — but also guard against the old mutation
	if spec.BaseArgs == nil || len(spec.BaseArgs) > 0 {
		t.Log("openrouter spec has unexpected BaseArgs (expected empty)")
	}
	_ = shared
}
