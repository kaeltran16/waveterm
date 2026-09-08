// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memvault

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTestNote(t *testing.T, dir, slug, source, body string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	fm := "---\nname: " + slug + "\nmetadata:\n  type: reference\n"
	if source != "" {
		fm += "  source: " + source + "\n"
	}
	fm += "---\n\n" + body + "\n"
	if err := os.WriteFile(filepath.Join(dir, slug+".md"), []byte(fm), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestEvictMovesOnlyVaultBackedAgentNotes(t *testing.T) {
	hub := t.TempDir()
	shared := t.TempDir()

	// no frontmatter source => authored by claude's memory tool. readHubNotes seeds Source with the
	// root tag "claude", so an eviction guard testing for "" alone would move it.
	writeTestNote(t, hub, "authored-by-claude", "", "a fact claude wrote")
	writeTestNote(t, hub, "explicitly-claude", "claude", "another fact claude wrote")
	writeTestNote(t, hub, "safe-to-evict", "agent", "a fact arc exported")
	writeTestNote(t, hub, "orphan-not-in-vault", "agent", "a fact only here")
	backed := map[string]bool{factHash("a fact arc exported\n"): true}

	moved, kept, err := evictExportedNotes(hub, shared, backed)
	if err != nil {
		t.Fatal(err)
	}
	if moved != 1 {
		t.Fatalf("moved = %d, want 1", moved)
	}
	if kept != 1 {
		t.Fatalf("kept = %d, want 1 (the orphan)", kept)
	}
	if _, err := os.Stat(filepath.Join(hub, "authored-by-claude.md")); err != nil {
		t.Fatal("claude-authored note must never be touched")
	}
	if _, err := os.Stat(filepath.Join(hub, "explicitly-claude.md")); err != nil {
		t.Fatal("note tagged source: claude must never be touched")
	}
	if _, err := os.Stat(filepath.Join(hub, "safe-to-evict.md")); !os.IsNotExist(err) {
		t.Fatal("vault-backed agent note should have left the hub")
	}
	if _, err := os.Stat(filepath.Join(shared, "safe-to-evict.md")); err != nil {
		t.Fatal("evicted note should land in shared/")
	}
	// a fact that exists nowhere else must survive a namespace cleanup
	if _, err := os.Stat(filepath.Join(hub, "orphan-not-in-vault.md")); err != nil {
		t.Fatal("a note absent from the vault must be left in place, not moved")
	}
}

func TestEvictIsIdempotent(t *testing.T) {
	hub := t.TempDir()
	shared := t.TempDir()
	writeTestNote(t, hub, "already-in-vault", "agent", "a fact arc exported")
	backed := map[string]bool{factHash("a fact arc exported\n"): true}

	if moved, _, err := evictExportedNotes(hub, shared, backed); err != nil || moved != 1 {
		t.Fatalf("first pass moved = %d, err = %v, want 1/nil", moved, err)
	}
	moved, kept, err := evictExportedNotes(hub, shared, backed)
	if err != nil {
		t.Fatal(err)
	}
	if moved != 0 || kept != 0 {
		t.Fatalf("second pass moved = %d kept = %d, want 0/0", moved, kept)
	}
}

// an archived vault note is preserved, not lost, so its hub copy is safe to evict
func TestVaultBackedHashesIncludesActiveVaultNotes(t *testing.T) {
	vault := t.TempDir()
	writeTestNote(t, vault, "active", "vault", "an active fact")
	backed := vaultBackedHashes(vault)
	if !backed[factHash("an active fact\n")] {
		t.Fatal("active vault note missing from the backed set")
	}
	if backed[factHash("never written anywhere")] {
		t.Fatal("unknown fact must not be reported as vault-backed")
	}
}

func TestEvictRepointsIndexLinks(t *testing.T) {
	hub := t.TempDir()
	shared := t.TempDir()
	writeTestNote(t, hub, "safe-to-evict", "agent", "a fact arc exported")
	writeTestNote(t, hub, "orphan-not-in-vault", "agent", "a fact only here")
	writeTestNote(t, hub, "authored-by-claude", "", "a fact claude wrote")
	index := "# Memory index\n\n" +
		"- [Evicted](safe-to-evict.md) — hook one\n" +
		"- [Orphan](orphan-not-in-vault.md) — hook two\n" +
		"- [Authored](authored-by-claude.md) — hook three\n"
	if err := os.WriteFile(filepath.Join(hub, "MEMORY.md"), []byte(index), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, _, err := evictExportedNotes(hub, shared, map[string]bool{factHash("a fact arc exported\n"): true}); err != nil {
		t.Fatal(err)
	}

	got := readFileString(t, filepath.Join(hub, "MEMORY.md"))
	if !strings.Contains(got, "](../shared/safe-to-evict.md)") {
		t.Fatalf("moved note's link should point at shared/, got:\n%s", got)
	}
	if strings.Contains(got, "](safe-to-evict.md)") {
		t.Fatalf("stale link to the moved note survived, got:\n%s", got)
	}
	// a note we deliberately left in the hub must keep its plain link
	if !strings.Contains(got, "](orphan-not-in-vault.md)") {
		t.Fatalf("link to a note still in the hub was rewritten, got:\n%s", got)
	}
	if !strings.Contains(got, "](authored-by-claude.md)") {
		t.Fatalf("claude-authored link was rewritten, got:\n%s", got)
	}
	if !strings.Contains(got, "hook one") {
		t.Fatalf("hook text should survive the rewrite, got:\n%s", got)
	}
}

func TestRepointIndexLinksIsIdempotent(t *testing.T) {
	hub := t.TempDir()
	indexPath := filepath.Join(hub, "MEMORY.md")
	if err := os.WriteFile(indexPath, []byte("- [X](x.md) — hook\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if err := repointIndexLinks(hub, []string{"x.md"}); err != nil {
			t.Fatal(err)
		}
	}
	if got, want := readFileString(t, indexPath), "- [X](../shared/x.md) — hook\n"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestRepointIndexLinksNoIndexIsNoop(t *testing.T) {
	hub := t.TempDir()
	if err := repointIndexLinks(hub, []string{"x.md"}); err != nil {
		t.Fatalf("a hub with no index must not error: %v", err)
	}
	if _, err := os.Stat(filepath.Join(hub, "MEMORY.md")); !os.IsNotExist(err) {
		t.Fatal("repoint must not create an index that was never there")
	}
}

func readFileString(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
