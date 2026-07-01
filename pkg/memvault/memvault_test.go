// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memvault

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestParseNote(t *testing.T) {
	raw := `---
name: prefer-postgres
description: Use Postgres before adding a new dependency
metadata:
  type: preference
  scope: shared
---

# Prefer Postgres
When a problem can be solved with the existing Postgres db, do that.
Related: [[conventional-commits]] and [[vitest-for-tests]].
`
	n, body := parseNote("/vault/prefer-postgres.md", []byte(raw), "vault")
	if n.ID != "prefer-postgres" {
		t.Fatalf("ID = %q, want prefer-postgres", n.ID)
	}
	if n.Type != "preference" { // note: preference is NOT a canonical Claude type; kept verbatim
		t.Fatalf("Type = %q", n.Type)
	}
	if n.Scope != "shared" {
		t.Fatalf("Scope = %q, want shared", n.Scope)
	}
	if n.Description != "Use Postgres before adding a new dependency" {
		t.Fatalf("Description = %q", n.Description)
	}
	if n.Source != "vault" {
		t.Fatalf("Source = %q, want vault", n.Source)
	}
	wantLinks := []string{"conventional-commits", "vitest-for-tests"}
	if !reflect.DeepEqual(n.Links, wantLinks) {
		t.Fatalf("Links = %v, want %v", n.Links, wantLinks)
	}
	if body == "" || body[0] != '#' {
		t.Fatalf("body should start after frontmatter, got %q", body[:min(20, len(body))])
	}
}

func TestParseNoteNoFrontmatter(t *testing.T) {
	n, _ := parseNote("/vault/loose-note.md", []byte("# Loose\nno frontmatter here [[x]]"), "claude")
	if n.ID != "loose-note" { // falls back to filename stem
		t.Fatalf("ID = %q, want loose-note", n.ID)
	}
	if len(n.Links) != 1 || n.Links[0] != "x" {
		t.Fatalf("Links = %v, want [x]", n.Links)
	}
}

func TestScanVaultRoots(t *testing.T) {
	dir := t.TempDir()
	write := func(rel, content string) {
		p := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("vault/a.md", "---\nname: a\nmetadata:\n  type: project\n---\n# A\nlinks [[b]] and [[ghost]]")
	write("claude/C--Users-k-projx/b.md", "---\nname: b\nmetadata:\n  type: fact\n---\n# B")
	write("vault/notes.txt", "not markdown, ignored")

	roots := []Root{
		{Path: filepath.Join(dir, "vault"), Source: "vault"},
		{Path: filepath.Join(dir, "claude"), Source: "claude"},
	}
	g, err := ScanVault(roots)
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Notes) != 2 {
		t.Fatalf("got %d notes, want 2 (.txt ignored)", len(g.Notes))
	}
	// scope of b derives from its Claude encoded-hash folder, decoded to a readable leaf label
	var b *Note
	for i := range g.Notes {
		if g.Notes[i].ID == "b" {
			b = &g.Notes[i]
		}
	}
	if b == nil || b.Scope != "projx" {
		t.Fatalf("b.Scope = %v, want projx", b)
	}
	// only a->b resolves (ghost has no target note); a->ghost is dropped
	if len(g.Edges) != 1 || g.Edges[0].From != "a" || g.Edges[0].To != "b" {
		t.Fatalf("Edges = %v, want [a->b]", g.Edges)
	}
}

func TestVaultRootsIncludesSources(t *testing.T) {
	roots := buildRoots("/home/u", "/home/u/.waveterm/memory")
	var sources []string
	for _, r := range roots {
		sources = append(sources, r.Source)
	}
	want := []string{"vault", "claude", "codex"}
	if !reflect.DeepEqual(sources, want) {
		t.Fatalf("sources = %v, want %v", sources, want)
	}
	if roots[0].Path != "/home/u/.waveterm/memory" {
		t.Fatalf("vault root = %q", roots[0].Path)
	}
}

func TestReadNoteReturnsBody(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "n.md")
	os.WriteFile(p, []byte("---\nname: n\n---\n# N\nhello"), 0o644)
	nb, err := ReadNote(p, "vault")
	if err != nil {
		t.Fatal(err)
	}
	if nb.Note.ID != "n" || !strings.Contains(nb.Body, "hello") {
		t.Fatalf("got %+v", nb)
	}
}

func TestWriteNoteMtimeGuard(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "n.md")
	os.WriteFile(p, []byte("v1"), 0o644)
	info, _ := os.Stat(p)
	base := info.ModTime().UnixMilli()

	// stale base (older than on-disk) => conflict, no write
	res, err := WriteNote(p, "v2", base-10_000)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Conflict {
		t.Fatal("expected conflict for stale base mtime")
	}
	got, _ := os.ReadFile(p)
	if string(got) != "v1" {
		t.Fatalf("file was clobbered on conflict: %q", got)
	}

	// matching base => write succeeds
	res, err = WriteNote(p, "v2", base)
	if err != nil || res.Conflict {
		t.Fatalf("expected clean write, got %+v err=%v", res, err)
	}
	got, _ = os.ReadFile(p)
	if string(got) != "v2" {
		t.Fatalf("write failed: %q", got)
	}
}

func TestCreateNoteWritesToVault(t *testing.T) {
	dir := t.TempDir()
	p, err := CreateNote(dir, "my-note", "project", "shared", "the body")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(p) != "my-note.md" {
		t.Fatalf("path = %q", p)
	}
	data, _ := os.ReadFile(p)
	s := string(data)
	if !strings.Contains(s, "name: my-note") || !strings.Contains(s, "type: project") ||
		!strings.Contains(s, "scope: shared") || !strings.Contains(s, "the body") {
		t.Fatalf("frontmatter/body wrong:\n%s", s)
	}
}

func TestDeriveScopeReadableForClaude(t *testing.T) {
	r := Root{Path: `/home/k/.claude/projects`, Source: "claude"}
	// note lives under the encoded-hash project dir
	path := `/home/k/.claude/projects/-home-k-code-krypton/memory/note.md`
	if got := deriveScope(r, path); got != "krypton" {
		t.Fatalf("claude scope = %q, want readable leaf 'krypton'", got)
	}
	// vault-source notes keep the raw folder name
	rv := Root{Path: `/vault`, Source: "vault"}
	if got := deriveScope(rv, `/vault/teamx/note.md`); got != "teamx" {
		t.Fatalf("vault scope = %q, want 'teamx'", got)
	}
}
