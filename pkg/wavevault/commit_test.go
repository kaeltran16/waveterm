// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// lastAuthor returns the author name of HEAD.
func lastAuthor(t *testing.T, root string) string {
	t.Helper()
	out, err := runGit(context.Background(), root, "log", "-1", "--format=%an")
	if err != nil {
		t.Fatalf("git log: %v", err)
	}
	return strings.TrimSpace(out)
}

func commitCount(t *testing.T, root string) int {
	t.Helper()
	out, err := runGit(context.Background(), root, "rev-list", "--count", "HEAD")
	if err != nil {
		return 0 // no commits yet (unborn HEAD)
	}
	n := 0
	for _, r := range strings.TrimSpace(out) {
		n = n*10 + int(r-'0')
	}
	return n
}

func TestCommitAuthorsMachineChangeAsJarvis(t *testing.T) {
	v, p := writeVaultWithDossier(t)
	base := ContentHash(mustRead(t, p))
	if _, err := v.Write("t-1", wspec, []RegionEdit{{Kind: FrontmatterKey, Name: "status", Value: "active"}}, base); err != nil {
		t.Fatal(err)
	}
	if err := v.Commit(context.Background(), "task t-1 started"); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if got := lastAuthor(t, v.Root); got != "Jarvis" {
		t.Fatalf("machine change author = %q, want Jarvis", got)
	}
	// tracking cleared after commit
	v.mu.Lock()
	n := len(v.machineFiles)
	v.mu.Unlock()
	if n != 0 {
		t.Fatalf("machineFiles not cleared after commit: %d", n)
	}
}

func TestCommitAuthorsHumanEditAsUser(t *testing.T) {
	v, _ := writeVaultWithDossier(t)
	// a purely human file (A never wrote it), created directly on disk
	hp := filepath.Join(v.Root, "memory", "human-note.md")
	if err := os.WriteFile(hp, []byte("---\nid: hn\n---\n\nhuman wrote this\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := v.Commit(context.Background(), "flush"); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if got := lastAuthor(t, v.Root); got != "Wave User" {
		t.Fatalf("human change author = %q, want Wave User", got)
	}
}

func TestCommitMixedFileGoesToUser(t *testing.T) {
	v, p := writeVaultWithDossier(t)
	base := ContentHash(mustRead(t, p))
	if _, err := v.Write("t-1", wspec, []RegionEdit{{Kind: FrontmatterKey, Name: "status", Value: "active"}}, base); err != nil {
		t.Fatal(err)
	}
	// a human then edits the SAME file externally (hash now differs from what A recorded)
	cur := mustRead(t, p)
	if err := os.WriteFile(p, append(cur, []byte("\nhuman appended line\n")...), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := v.Commit(context.Background(), "flush"); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	// mixed file (A-written + human-touched) commits as the user, per the file-granular rule
	if got := lastAuthor(t, v.Root); got != "Wave User" {
		t.Fatalf("mixed-file author = %q, want Wave User", got)
	}
}

func TestFlushCommitsPending(t *testing.T) {
	v, p := writeVaultWithDossier(t)
	base := ContentHash(mustRead(t, p))
	if _, err := v.Write("t-1", wspec, []RegionEdit{{Kind: FrontmatterKey, Name: "status", Value: "active"}}, base); err != nil {
		t.Fatal(err)
	}
	before := commitCount(t, v.Root)
	if err := v.Flush(context.Background()); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if commitCount(t, v.Root) <= before {
		t.Fatal("Flush should have produced a commit for the pending write")
	}
}

func TestCommitNothingStagedIsNoop(t *testing.T) {
	v, _ := writeVaultWithDossier(t)
	// no writes; the seeded dossier is untracked, so a commit stages it as the user, then a second
	// commit with nothing pending must not error or add a commit.
	if err := v.Commit(context.Background(), "first"); err != nil {
		t.Fatal(err)
	}
	after := commitCount(t, v.Root)
	if err := v.Commit(context.Background(), "second-empty"); err != nil {
		t.Fatalf("empty commit must not error: %v", err)
	}
	if commitCount(t, v.Root) != after {
		t.Fatal("a commit with nothing staged must not create a commit")
	}
}
