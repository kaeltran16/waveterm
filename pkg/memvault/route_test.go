// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memvault

import "testing"

func TestRouteLearnings_CorrectionCommitsNonCorrectionQueues(t *testing.T) {
	// isolate the home dir so the test writes into a throwaway vault/pending store, not the real
	// ~/.waveterm/memory*. without this the correction dedups against a note left by a prior run
	// (committed=0) and the test is neither idempotent nor side-effect free.
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", t.TempDir()) // os.UserHomeDir reads %USERPROFILE% on Windows
	// no cwd -> hub is "" -> corrections go to the default vault, non-corrections to the pending tray.
	// We only assert the returned counts here; storage side effects are covered by existing learn tests.
	cands := []LearnCandidate{
		{Type: "feedback", Body: "always run the typechecker with the stack-size flag", IsCorrection: true},
		{Type: "learning", Body: "the sessions scanner walks ~/.claude/projects", IsCorrection: false},
	}
	committed, queued, err := RouteLearnings("", cands, nil)
	if err != nil {
		t.Fatalf("RouteLearnings error: %v", err)
	}
	if committed != 1 {
		t.Errorf("committed = %d, want 1", committed)
	}
	if queued != 1 {
		t.Errorf("queued = %d, want 1", queued)
	}
}
