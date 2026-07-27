// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memroots

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, dir, name, body string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestMigrateRootMovesNotesAndRemovesSource(t *testing.T) {
	base := t.TempDir()
	src := filepath.Join(base, "memory")
	dst := filepath.Join(base, "vault", "memory")
	writeFile(t, src, "one.md", "# one")
	writeFile(t, src, "two.md", "# two")

	moved, skipped, err := migrateRoot(src, dst)
	if err != nil {
		t.Fatalf("migrateRoot: %v", err)
	}
	if moved != 2 || len(skipped) != 0 {
		t.Fatalf("moved=%d skipped=%v, want 2 and none", moved, skipped)
	}
	for _, n := range []string{"one.md", "two.md"} {
		if _, err := os.Stat(filepath.Join(dst, n)); err != nil {
			t.Fatalf("%s not at destination: %v", n, err)
		}
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Fatalf("source dir survived: %v", err)
	}
}

func TestMigrateRootSkipsCollisionWithoutOverwriting(t *testing.T) {
	base := t.TempDir()
	src := filepath.Join(base, "memory")
	dst := filepath.Join(base, "vault", "memory")
	writeFile(t, src, "dup.md", "SOURCE")
	writeFile(t, dst, "dup.md", "DESTINATION")

	moved, skipped, err := migrateRoot(src, dst)
	if err != nil {
		t.Fatalf("migrateRoot: %v", err)
	}
	if moved != 0 || len(skipped) != 1 {
		t.Fatalf("moved=%d skipped=%v, want 0 and 1", moved, skipped)
	}
	got, err := os.ReadFile(filepath.Join(dst, "dup.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "DESTINATION" {
		t.Fatalf("destination overwritten: %q", got)
	}
	// a skipped file stays put, so the source dir must survive
	if _, err := os.Stat(filepath.Join(src, "dup.md")); err != nil {
		t.Fatalf("skipped source removed: %v", err)
	}
}

func TestMigrateRootAbsentSourceIsNoop(t *testing.T) {
	base := t.TempDir()
	moved, skipped, err := migrateRoot(filepath.Join(base, "nope"), filepath.Join(base, "dst"))
	if err != nil || moved != 0 || len(skipped) != 0 {
		t.Fatalf("moved=%d skipped=%v err=%v, want zero-values", moved, skipped, err)
	}
}

func TestMigrateRootSecondRunIsNoop(t *testing.T) {
	base := t.TempDir()
	src := filepath.Join(base, "memory")
	dst := filepath.Join(base, "vault", "memory")
	writeFile(t, src, "one.md", "# one")

	if _, _, err := migrateRoot(src, dst); err != nil {
		t.Fatalf("first run: %v", err)
	}
	moved, skipped, err := migrateRoot(src, dst)
	if err != nil || moved != 0 || len(skipped) != 0 {
		t.Fatalf("second run moved=%d skipped=%v err=%v, want zero-values", moved, skipped, err)
	}
}

func TestMigrateRootIgnoresNonMarkdown(t *testing.T) {
	base := t.TempDir()
	src := filepath.Join(base, "memory")
	dst := filepath.Join(base, "vault", "memory")
	writeFile(t, src, "note.md", "# n")
	writeFile(t, src, "notes.txt", "plain")

	moved, _, err := migrateRoot(src, dst)
	if err != nil {
		t.Fatal(err)
	}
	if moved != 1 {
		t.Fatalf("moved=%d, want 1", moved)
	}
	// a leftover non-markdown file means the source dir must not be removed
	if _, err := os.Stat(filepath.Join(src, "notes.txt")); err != nil {
		t.Fatalf("non-markdown file lost: %v", err)
	}
}
