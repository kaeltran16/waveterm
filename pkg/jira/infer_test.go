// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jira

import (
	"context"
	"os"
	"os/exec"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func ticketed(project, ticket string) *waveobj.Effort {
	return &waveobj.Effort{Project: project, Ticket: ticket}
}

func TestInferClearWinner(t *testing.T) {
	efforts := []*waveobj.Effort{
		ticketed("a", "PAY-1"),
		ticketed("a", "pay-2"),
		ticketed("b", "OPS-3"), // another Jira project never counts
	}
	got := InferProject("PAY", efforts, map[string]int{"a": 5, "b": 9})
	want := Inference{Project: "a", Evidence: "2 initiatives, 5 tagged commits", Sure: true}
	if got != want {
		t.Errorf("got %+v want %+v", got, want)
	}
}

func TestInferCommitsOnly(t *testing.T) {
	got := InferProject("PAY", nil, map[string]int{"a": 6, "b": 2})
	if want := (Inference{Project: "a", Evidence: "0 initiatives, 6 tagged commits", Sure: true}); got != want {
		t.Errorf("6 vs 2: got %+v want %+v", got, want)
	}
	got = InferProject("PAY", nil, map[string]int{"a": 6, "b": 4})
	if want := (Inference{Evidence: "Tied: a and b"}); got != want {
		t.Errorf("6 vs 4: got %+v want %+v", got, want)
	}
}

func TestInferNoHistory(t *testing.T) {
	efforts := []*waveobj.Effort{ticketed("a", "PAY-1")}
	got := InferProject("GROW", efforts, map[string]int{"a": 0, "b": 0})
	if want := (Inference{Evidence: "No history for GROW"}); got != want {
		t.Errorf("got %+v want %+v", got, want)
	}
}

func TestInferSingularEvidence(t *testing.T) {
	got := InferProject("PAY", []*waveobj.Effort{ticketed("a", "PAY-1")}, map[string]int{"a": 1})
	if want := (Inference{Project: "a", Evidence: "1 initiative, 1 tagged commit", Sure: true}); got != want {
		t.Errorf("got %+v want %+v", got, want)
	}
}

func TestInferWeakWinnerUnsure(t *testing.T) {
	// below the bar (no initiative, under 3 commits) is unsure even with no rival
	got := InferProject("PAY", nil, map[string]int{"a": 2, "b": 0})
	if want := (Inference{Evidence: "0 initiatives, 2 tagged commits"}); got != want {
		t.Errorf("got %+v want %+v", got, want)
	}
}

func TestInferFullTieUnsure(t *testing.T) {
	efforts := []*waveobj.Effort{ticketed("b", "PAY-1"), ticketed("a", "PAY-2")}
	got := InferProject("PAY", efforts, map[string]int{"a": 0, "b": 0})
	if want := (Inference{Evidence: "Tied: a and b"}); got != want {
		t.Errorf("got %+v want %+v", got, want)
	}
}

func gitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func TestCommitCountsMatchesKeyBoundary(t *testing.T) {
	repo := t.TempDir()
	gitIn(t, repo, "init", "-q")
	for _, msg := range []string{"PAY-1 retry with backoff", "fix(XPAY-1): not ours", "chore: PAY-12, PAY-13", "PAY-x no number"} {
		gitIn(t, repo, "commit", "-q", "--allow-empty", "-m", msg)
	}
	empty := t.TempDir() // not a repo: counts 0
	got := CommitCounts(context.Background(), map[string]string{"pay": repo, "none": empty}, "PAY")
	if got["pay"] != 2 || got["none"] != 0 || len(got) != 2 {
		t.Errorf("got %v want pay:2 none:0", got)
	}
}
