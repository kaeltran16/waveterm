// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package storagereport

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func gitT(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// newRepo makes a repo on main with one commit.
func newRepo(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "proj")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	gitT(t, dir, "init", "-q", "-b", "main")
	commitFile(t, dir, "README.md", "hello\n", "initial")
	return dir
}

func commitFile(t *testing.T, dir, name, content, subject string) string {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	gitT(t, dir, "add", name)
	gitT(t, dir, "commit", "-q", "-m", subject)
	return gitT(t, dir, "rev-parse", "HEAD")
}

func TestGitFactsBranchOnAnotherBranch(t *testing.T) {
	repo := newRepo(t)
	gitT(t, repo, "checkout", "-q", "-b", "wave/x")
	tip := commitFile(t, repo, "a.txt", "a\n", "add a")
	gitT(t, repo, "branch", "backup")
	gitT(t, repo, "checkout", "-q", "main")

	f, err := branchGitFacts(context.Background(), repo, "wave/x", tip, "main")
	if err != nil {
		t.Fatal(err)
	}
	if f.OnlyCount != 0 || len(f.OnlyCommits) != 0 {
		t.Fatalf("OnlyCount = %d %v, want 0", f.OnlyCount, f.OnlyCommits)
	}
	if f.AlsoOn != "backup" {
		t.Fatalf("AlsoOn = %q, want backup", f.AlsoOn)
	}
}

func TestGitFactsAlsoOnPrefersTheBaseBranch(t *testing.T) {
	repo := newRepo(t)
	gitT(t, repo, "checkout", "-q", "-b", "wave/x")
	tip := commitFile(t, repo, "a.txt", "a\n", "add a")
	gitT(t, repo, "branch", "aaa-backup")
	gitT(t, repo, "checkout", "-q", "main")
	gitT(t, repo, "merge", "-q", "--ff-only", "wave/x")

	f, err := branchGitFacts(context.Background(), repo, "wave/x", tip, "main")
	if err != nil {
		t.Fatal(err)
	}
	if f.OnlyCount != 0 || f.AlsoOn != "main" {
		t.Fatalf("OnlyCount %d AlsoOn %q, want 0 main", f.OnlyCount, f.AlsoOn)
	}
}

func TestGitFactsUniqueCommits(t *testing.T) {
	repo := newRepo(t)
	gitT(t, repo, "checkout", "-q", "-b", "wave/x")
	commitFile(t, repo, "a.txt", "a\n", "docs: first unique")
	tip := commitFile(t, repo, "b.txt", "b\n", "docs: second unique")
	gitT(t, repo, "checkout", "-q", "main")

	f, err := branchGitFacts(context.Background(), repo, "wave/x", tip, "main")
	if err != nil {
		t.Fatal(err)
	}
	if f.OnlyCount != 2 || len(f.OnlyCommits) != 2 {
		t.Fatalf("OnlyCount = %d %v, want 2", f.OnlyCount, f.OnlyCommits)
	}
	if f.OnlyCommits[0].Subject != "docs: second unique" || f.OnlyCommits[1].Subject != "docs: first unique" {
		t.Fatalf("subjects = %v, want newest first", f.OnlyCommits)
	}
	if !strings.HasPrefix(tip, f.OnlyCommits[0].Sha) || len(f.OnlyCommits[0].Sha) >= len(tip) {
		t.Fatalf("Sha = %q, want an abbreviation of %s", f.OnlyCommits[0].Sha, tip)
	}
	if f.AlsoOn != "" {
		t.Fatalf("AlsoOn = %q, want none", f.AlsoOn)
	}
}

// a branch whose commit was cherry-picked onto the base: same patch, new sha. It loses nothing.
func TestGitFactsPatchEqualOnBase(t *testing.T) {
	repo := newRepo(t)
	gitT(t, repo, "checkout", "-q", "-b", "wave/x")
	tip := commitFile(t, repo, "a.txt", "a\n", "add a")
	gitT(t, repo, "checkout", "-q", "main")
	commitFile(t, repo, "other.txt", "o\n", "unrelated on main")
	gitT(t, repo, "cherry-pick", tip)

	f, err := branchGitFacts(context.Background(), repo, "wave/x", tip, "main")
	if err != nil {
		t.Fatal(err)
	}
	if f.OnlyCount != 0 {
		t.Fatalf("OnlyCount = %d %v, want 0", f.OnlyCount, f.OnlyCommits)
	}
	if f.AlsoOn != "main" {
		t.Fatalf("AlsoOn = %q, want main (patch-equal)", f.AlsoOn)
	}

	// without its base branch the patch match is not looked for
	f, err = branchGitFacts(context.Background(), repo, "wave/x", tip, "gone")
	if err != nil {
		t.Fatal(err)
	}
	if f.OnlyCount != 1 {
		t.Fatalf("OnlyCount with a missing base = %d, want 1", f.OnlyCount)
	}
}

func TestGitFactsProjectRefs(t *testing.T) {
	repo := newRepo(t)
	gitT(t, repo, "branch", "wave/x")
	gitT(t, repo, "branch", "other")
	p := loadProject(context.Background(), "proj", repo)
	if p.err != nil {
		t.Fatal(p.err)
	}
	if len(p.branches) != 1 || p.branches["wave/x"].tip == "" || p.branches["wave/x"].ts == 0 {
		t.Fatalf("branches = %v, want only wave/x with tip and time", p.branches)
	}
	if !p.isTracked(repo) {
		t.Fatalf("the main checkout must be listed as tracked: %v", p.tracked)
	}

	missing := loadProject(context.Background(), "gone", filepath.Join(t.TempDir(), "nope"))
	if missing.err == nil {
		t.Fatal("a missing project path must fail")
	}
	notRepo := loadProject(context.Background(), "plain", t.TempDir())
	if notRepo.err == nil || !strings.Contains(notRepo.err.Error(), "git exited 128") || !strings.Contains(notRepo.err.Error(), "not a git repository") {
		t.Fatalf("err = %v, want git's exit code and reason", notRepo.err)
	}
}
