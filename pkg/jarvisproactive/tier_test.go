// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisproactive

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/consult"
)

// S3's relevance judge picks one shortlist entry or "none" — bounded classification, so J3 put it on
// the cheap tier. SetJudgeForTest replaces the whole judge func, spec construction included, so every
// existing test here is blind to which tier the real body selects; reverting it to consult.SpecFor
// broke nothing. This exercises the real judge against a swapped process runner instead.
func TestJudgeRunsOnTheCheapTier(t *testing.T) {
	var got consult.RuntimeSpec
	prev := judgeRun
	judgeRun = func(_ context.Context, spec consult.RuntimeSpec, _ string, _ string, _ func(string)) (string, error) {
		got = spec
		return "none", nil
	}
	t.Cleanup(func() { judgeRun = prev })

	if _, err := judge(context.Background(), "", "pick one"); err != nil {
		t.Fatalf("judge: %v", err)
	}
	if got.Model != consult.OpenrouterCheapModel() {
		t.Fatalf("expected Model %q in the spec handed to the runner, got %q", consult.OpenrouterCheapModel(), got.Model)
	}
}
