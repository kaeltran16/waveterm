// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memvault

import "testing"

// isolateHome points os.UserHomeDir at a throwaway dir so a test writes into a scratch vault/pending store
// rather than the real ~/.waveterm/memory*. Without it a correction dedups against a note a prior run left
// behind (committed=0) and the test is neither idempotent nor side-effect free.
func isolateHome(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home) // os.UserHomeDir reads %USERPROFILE% on Windows
}

func TestRouteLearnings_CorrectionCommitsNonCorrectionQueues(t *testing.T) {
	isolateHome(t)
	// no cwd -> hub is "" -> corrections go to the default vault, non-corrections to the pending tray.
	// We only assert the returned counts here; storage side effects are covered by existing learn tests.
	cands := []LearnCandidate{
		{Type: "feedback", Body: "always run the typechecker with the stack-size flag", IsCorrection: true},
		{Type: "learning", Body: "the sessions scanner walks ~/.claude/projects", IsCorrection: false},
	}
	res, err := RouteLearnings("", cands, nil)
	if err != nil {
		t.Fatalf("RouteLearnings error: %v", err)
	}
	if res.Committed != 1 {
		t.Errorf("Committed = %d, want 1", res.Committed)
	}
	if res.Queued != 1 {
		t.Errorf("Queued = %d, want 1", res.Queued)
	}
}

// The identities were computed and dropped: WriteLearning returns the slug it wrote and RouteLearnings threw
// it away, which is why the creature could only ever announce a count.
func TestRouteLearningsReportsWhatItWrote(t *testing.T) {
	isolateHome(t)
	res, err := RouteLearnings("", []LearnCandidate{
		{Type: "feedback", Body: "prefer tailwind over scss\nmore detail", IsCorrection: true},
	}, nil)
	if err != nil {
		t.Fatalf("RouteLearnings: %v", err)
	}
	if res.Committed != 1 {
		t.Fatalf("Committed = %d, want 1", res.Committed)
	}
	if len(res.Written) != 1 {
		t.Fatalf("Written = %+v, want one note", res.Written)
	}
	if res.Written[0].ID == "" {
		t.Error("a written note with no id cannot be opened from the peek, which is the whole point")
	}
	if res.Written[0].Title != "prefer tailwind over scss" {
		t.Errorf("Title = %q, want the note's first line", res.Written[0].Title)
	}
}

// A candidate that deduped against an existing fact wrote nothing, so it is not a product: offering to open
// it would be a button that navigates to a note this pass did not create.
func TestRouteLearningsOmitsADedupedCandidate(t *testing.T) {
	isolateHome(t)
	cand := LearnCandidate{Type: "feedback", Body: "never commit without approval", IsCorrection: true}
	first, err := RouteLearnings("", []LearnCandidate{cand}, nil)
	if err != nil {
		t.Fatalf("first RouteLearnings: %v", err)
	}
	if len(first.Written) != 1 {
		t.Fatalf("first pass Written = %+v, want one note", first.Written)
	}
	second, err := RouteLearnings("", []LearnCandidate{cand}, nil)
	if err != nil {
		t.Fatalf("second RouteLearnings: %v", err)
	}
	if second.Committed != 0 {
		t.Errorf("Committed = %d, want 0 on a deduped candidate", second.Committed)
	}
	if len(second.Written) != 0 {
		t.Errorf("Written = %+v, want none: nothing was created", second.Written)
	}
}
