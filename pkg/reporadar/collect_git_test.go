// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func gitCmd(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func writeFile(t *testing.T, dir, rel, content string) {
	t.Helper()
	full := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCollectGitProducesCommitSignals(t *testing.T) {
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-q")
	writeFile(t, dir, "src/x.ts", "export const x = 1\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-q", "-m", "add x")

	sigs, err := collectGit(context.Background(), collectInput{projectPath: dir, sinceTs: 0})
	if err != nil {
		t.Fatalf("collectGit: %v", err)
	}
	if len(sigs) == 0 {
		t.Fatal("expected at least one commit signal")
	}
	var found bool
	for _, s := range sigs {
		if s.Collector == CollectorGit {
			found = true
		}
	}
	if !found {
		t.Fatal("expected a git-collector signal")
	}
	// HEAD + dirty fingerprint are readable
	head, err := gitHead(context.Background(), dir)
	if err != nil || head == "" {
		t.Fatalf("gitHead: %v head=%q", err, head)
	}
}
