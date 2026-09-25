// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// snapshotFixture is a project and its run's landing tree, with a spec in the project checkout (the same
// repository, outside the tree) and a plan inside the tree, where the lead writes it.
func snapshotFixture(t *testing.T) (tree, spec, plan string) {
	t.Helper()
	dir := newGitRepo(t)
	tree, err := CreateRunWorktree(context.Background(), dir, "run-1", gitCmd(t, dir, "rev-parse", "HEAD"))
	if err != nil {
		t.Fatal(err)
	}
	spec = filepath.Join(dir, "docs", "specs", "s.md")
	plan = filepath.Join(tree, "docs", "plans", "p.md")
	writeDoc(t, spec, "# spec\n")
	writeDoc(t, plan, "# plan\n")
	return tree, spec, plan
}

func writeDoc(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func commitCount(t *testing.T, tree string) string {
	t.Helper()
	return gitCmd(t, tree, "rev-list", "--count", "HEAD")
}

func TestSnapshotDocsCommitsBothDocsOnTheRunsBranch(t *testing.T) {
	tree, spec, plan := snapshotFixture(t)
	rels, err := SnapshotDocs(context.Background(), tree, "run-1", "coupons", spec, plan)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"docs/specs/s.md", "docs/plans/p.md"}; !reflect.DeepEqual(rels, want) {
		t.Fatalf("paths = %v, want %v", rels, want)
	}
	if msg := gitCmd(t, tree, "log", "-1", "--format=%B"); msg != "docs: spec and plan for coupons\n\nArc-Run: run-1" {
		t.Fatalf("message = %q", msg)
	}
	files := strings.Fields(gitCmd(t, tree, "show", "--name-only", "--format=", "HEAD"))
	if want := []string{"docs/plans/p.md", "docs/specs/s.md"}; !reflect.DeepEqual(files, want) {
		t.Fatalf("commit files = %v, want %v", files, want)
	}
	if got := gitCmd(t, tree, "show", "wave/run-1:docs/specs/s.md"); got != "# spec" {
		t.Fatalf("the branch holds spec %q", got)
	}
}

// a retried submit, or docs the lead already committed, must not fail on an empty commit
func TestSnapshotDocsWithUnchangedDocsCommitsNothing(t *testing.T) {
	tree, spec, plan := snapshotFixture(t)
	if _, err := SnapshotDocs(context.Background(), tree, "run-1", "coupons", spec, plan); err != nil {
		t.Fatal(err)
	}
	before := commitCount(t, tree)
	rels, err := SnapshotDocs(context.Background(), tree, "run-1", "coupons", spec, plan)
	if err != nil {
		t.Fatalf("an identical snapshot must succeed: %v", err)
	}
	if want := []string{"docs/specs/s.md", "docs/plans/p.md"}; !reflect.DeepEqual(rels, want) {
		t.Fatalf("paths = %v, want %v", rels, want)
	}
	if after := commitCount(t, tree); after != before {
		t.Fatalf("commits went from %s to %s", before, after)
	}
}

// a resubmit after a failed plan review carries revised docs, including a spec edited outside the tree
func TestSnapshotDocsCommitsRevisedDocsAgain(t *testing.T) {
	tree, spec, plan := snapshotFixture(t)
	if _, err := SnapshotDocs(context.Background(), tree, "run-1", "coupons", spec, plan); err != nil {
		t.Fatal(err)
	}
	before := commitCount(t, tree)
	writeDoc(t, spec, "# spec, revised\n")
	writeDoc(t, plan, "# plan, revised\n")
	if _, err := SnapshotDocs(context.Background(), tree, "run-1", "coupons", spec, plan); err != nil {
		t.Fatal(err)
	}
	if after := commitCount(t, tree); after == before {
		t.Fatal("revised docs made no commit")
	}
	if got := gitCmd(t, tree, "show", "HEAD:docs/specs/s.md"); got != "# spec, revised" {
		t.Fatalf("the branch holds spec %q", got)
	}
	if got := gitCmd(t, tree, "show", "HEAD:docs/plans/p.md"); got != "# plan, revised" {
		t.Fatalf("the branch holds plan %q", got)
	}
}

// the lead's own staged work stays out of the engine's docs commit
func TestSnapshotDocsCommitsOnlyTheDocs(t *testing.T) {
	tree, spec, plan := snapshotFixture(t)
	writeDoc(t, filepath.Join(tree, "wip.txt"), "wip\n")
	gitCmd(t, tree, "add", "wip.txt")
	if _, err := SnapshotDocs(context.Background(), tree, "run-1", "coupons", spec, plan); err != nil {
		t.Fatal(err)
	}
	if files := gitCmd(t, tree, "show", "--name-only", "--format=", "HEAD"); strings.Contains(files, "wip.txt") {
		t.Fatalf("the docs commit took the lead's staged file: %v", files)
	}
}

func TestSnapshotDocsRefusesADocFromAnotherRepository(t *testing.T) {
	tree, _, plan := snapshotFixture(t)
	other := filepath.Join(newGitRepo(t), "spec.md")
	writeDoc(t, other, "# elsewhere\n")
	if _, err := SnapshotDocs(context.Background(), tree, "run-1", "coupons", other, plan); err == nil || !strings.Contains(err.Error(), other) {
		t.Fatalf("want an error naming %s, got %v", other, err)
	}
}

func TestSnapshotDocsKeepsAnEmptySlot(t *testing.T) {
	tree, _, plan := snapshotFixture(t)
	rels, err := SnapshotDocs(context.Background(), tree, "run-1", "coupons", "", plan)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"", "docs/plans/p.md"}; !reflect.DeepEqual(rels, want) {
		t.Fatalf("paths = %v, want %v", rels, want)
	}
}

func TestDocPath(t *testing.T) {
	tree := t.TempDir()
	abs := filepath.Join(t.TempDir(), "plan.md")
	g := &waveobj.TaskGroup{}
	for _, c := range []struct{ p, want string }{
		{"docs/plans/p.md", filepath.Join(tree, "docs", "plans", "p.md")},
		{abs, abs},
		{"", ""},
	} {
		if got := DocPath(g, tree, c.p); got != c.want {
			t.Fatalf("DocPath(%q) = %q, want %q", c.p, got, c.want)
		}
	}
}
