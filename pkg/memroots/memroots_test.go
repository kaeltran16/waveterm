// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memroots

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMirrorsEmpty(t *testing.T) {
	got := buildMirrors("/home/u", "/custom/notes")
	if len(got) != 0 {
		t.Fatalf("buildMirrors = %v, want none (claude/codex are derived sync surfaces now)", got)
	}
}

func TestAllRootsVaultOnly(t *testing.T) {
	got := buildAllRoots("/home/u/.waveterm/vault/memory", buildMirrors("/home/u", ""))
	want := []string{"vault"}
	if len(got) != len(want) || got[0].Source != "vault" {
		t.Fatalf("buildAllRoots = %v, want vault root only", got)
	}
	if got[0].Path != "/home/u/.waveterm/vault/memory" {
		t.Fatalf("memory root = %q", got[0].Path)
	}
}

func TestProjectHash(t *testing.T) {
	if got := ProjectHash(`C:\Users\kael02\IdeaProjects\waveterm`); got != "C--Users-kael02-IdeaProjects-waveterm" {
		t.Fatalf("ProjectHash(win) = %q", got)
	}
	if got := ProjectHash("/home/k/code/krypton"); got != "-home-k-code-krypton" {
		t.Fatalf("ProjectHash(posix) = %q", got)
	}
}

func TestLabelFromHash(t *testing.T) {
	projects := map[string]string{"Krypton API": `C:\Users\kael02\IdeaProjects\krypton`}
	if l := LabelFromHash("C--Users-kael02-IdeaProjects-krypton", projects); l != "Krypton API" {
		t.Fatalf("registry hit = %q, want Krypton API", l)
	}
	if l := LabelFromHash("C--Users-kael02-IdeaProjects-waveterm", projects); l != "waveterm" {
		t.Fatalf("fallback = %q, want waveterm", l)
	}
}

func TestScopeForPath(t *testing.T) {
	hubRoot := filepath.Join("/home/k", ".claude", "projects")
	notePath := filepath.Join(hubRoot, "C--Users-kael02-IdeaProjects-krypton", "memory", "n.md")
	if got := ScopeForPath(hubRoot, "claude", notePath); got != "krypton" {
		t.Fatalf("claude hub scope = %q, want krypton", got)
	}
	if got := ScopeForPath("/vault", "vault", "/vault/teamx/note.md"); got != "teamx" {
		t.Fatalf("subdir scope = %q, want teamx", got)
	}
	if got := ScopeForPath("/vault", "vault", "/vault/note.md"); got != "shared" {
		t.Fatalf("flat scope = %q, want shared", got)
	}
}

func TestIndexFileConst(t *testing.T) {
	if IndexFile != "MEMORY.md" {
		t.Fatalf("IndexFile = %q", IndexFile)
	}
}

func TestRegistryPathForLabel(t *testing.T) {
	// registry name match
	if p := registryPathForLabel("Krypton API", map[string]string{"Krypton API": `C:\Users\k\krypton`}); p != `C:\Users\k\krypton` {
		t.Fatalf("name match = %q", p)
	}
	// leaf folder match
	if p := registryPathForLabel("waveterm", map[string]string{"Krypton API": `C:\Users\k\krypton`}); p != "" {
		t.Fatalf("unregistered leaf should resolve empty, got %q", p)
	}
	// ambiguous leaves: first registered path wins
	if p := registryPathForLabel("app", map[string]string{"a": `C:\x\app`, "b": `C:\y\app`}); p != `C:\x\app` {
		t.Fatalf("ambiguous leaf = %q, want first", p)
	}
}

func TestMigrateVaultToConfiguredRootCopies(t *testing.T) {
	src := t.TempDir()
	dstRoot := t.TempDir()
	if err := os.MkdirAll(filepath.Join(src, "memory"), 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(src, "memory", "a.md"), []byte("---\nname: a\n---\n\nfact a\n"), 0o644)
	os.WriteFile(filepath.Join(src, "memory", "b.md"), []byte("---\nname: b\n---\n\nfact b\n"), 0o644)

	copied, skipped, err := copyRootNotes(filepath.Join(src, "memory"), filepath.Join(dstRoot, "memory"))
	if err != nil {
		t.Fatal(err)
	}
	if copied != 2 || skipped != 0 {
		t.Fatalf("copied=%d skipped=%d, want 2/0", copied, skipped)
	}
	if _, err := os.Stat(filepath.Join(dstRoot, "memory", "a.md")); err != nil {
		t.Fatalf("note not copied: %v", err)
	}
	// copy, never move: the source survives
	if _, err := os.Stat(filepath.Join(src, "memory", "a.md")); err != nil {
		t.Fatalf("source removed — migration must copy, not move: %v", err)
	}
	// idempotent: a second run copies nothing new
	copied2, _, err := copyRootNotes(filepath.Join(src, "memory"), filepath.Join(dstRoot, "memory"))
	if err != nil || copied2 != 0 {
		t.Fatalf("second run copied=%d err=%v, want 0/nil", copied2, err)
	}
}

func TestMigrateVaultToConfiguredRootUnset(t *testing.T) {
	if copied, skipped, err := MigrateVaultToConfiguredRoot(); err != nil || copied != 0 || skipped != 0 {
		t.Fatalf("no root switch should no-op, got copied=%d skipped=%d err=%v", copied, skipped, err)
	}
}

func TestMigrateVaultRootSwitch(t *testing.T) {
	src := t.TempDir()
	dst := t.TempDir()
	if err := os.MkdirAll(filepath.Join(src, "memory"), 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(src, "memory", "a.md"), []byte("---\nname: a\n---\n\nfact a\n"), 0o644)

	// configured -> configured switch copies the old root's notes
	copied, skipped, err := migrateVaultRoot(src, dst)
	if err != nil {
		t.Fatal(err)
	}
	if copied != 1 || skipped != 0 {
		t.Fatalf("copied=%d skipped=%d, want 1/0", copied, skipped)
	}
	if _, err := os.Stat(filepath.Join(dst, "memory", "a.md")); err != nil {
		t.Fatalf("note not copied: %v", err)
	}
	// source kept intact (copy, not move)
	if _, err := os.Stat(filepath.Join(src, "memory", "a.md")); err != nil {
		t.Fatalf("source removed: %v", err)
	}
	// idempotent: second run copies nothing
	copied2, _, err := migrateVaultRoot(src, dst)
	if err != nil || copied2 != 0 {
		t.Fatalf("second run copied=%d err=%v, want 0/nil", copied2, err)
	}
	// same root -> no-op even with content
	copied3, _, err := migrateVaultRoot(src, src)
	if err != nil || copied3 != 0 {
		t.Fatalf("same-root run copied=%d err=%v, want 0/nil", copied3, err)
	}
}

