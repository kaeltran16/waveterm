// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisrecall

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/consult"
)

// Recall's grounded answer moved from the capable tier (no --model flag, so whatever the operator
// configured — Opus-class) to the mid tier: retrieval has already narrowed the sources, so the model
// only answers from a handful of numbered snippets. SetSynthesizeForTest replaces spec construction
// along with the call, so every other test here is blind to which tier the real body picks — a revert
// to TierCapable would break nothing. This runs the real synthesize against a swapped process runner.
func TestSynthesizeRunsOnTheMidTier(t *testing.T) {
	var got consult.RuntimeSpec
	prev := runFn
	runFn = func(_ context.Context, spec consult.RuntimeSpec, _ string, _ string, _ func(string)) (string, error) {
		got = spec
		return "answer [1]", nil
	}
	t.Cleanup(func() { runFn = prev })

	if _, err := synthesize(context.Background(), "", "why did we pick sqlite-vec?", func(string) {}); err != nil {
		t.Fatalf("synthesize: %v", err)
	}
	// adjacency, not substring: a bare --model check would pass on the cheap tier's flag too
	for i, a := range got.BaseArgs {
		if a == "--model" && i+1 < len(got.BaseArgs) && got.BaseArgs[i+1] == consult.MidModel {
			return
		}
	}
	t.Fatalf("expected --model %s in the spec handed to the runner, got %v", consult.MidModel, got.BaseArgs)
}

// Guards the floor specifically: the cheap tier is the wrong home for this call because citation
// discipline is what degrades first on a small model, and selectTerminal grades citations.
func TestSynthesizeIsNotOnTheCheapTier(t *testing.T) {
	var got consult.RuntimeSpec
	prev := runFn
	runFn = func(_ context.Context, spec consult.RuntimeSpec, _ string, _ string, _ func(string)) (string, error) {
		got = spec
		return "answer [1]", nil
	}
	t.Cleanup(func() { runFn = prev })

	if _, err := synthesize(context.Background(), "", "q", func(string) {}); err != nil {
		t.Fatalf("synthesize: %v", err)
	}
	for i, a := range got.BaseArgs {
		if a == "--model" && i+1 < len(got.BaseArgs) && got.BaseArgs[i+1] == consult.CheapModel {
			t.Fatalf("synthesize must not run on the cheap tier, got %v", got.BaseArgs)
		}
	}
}
