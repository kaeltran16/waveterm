// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memroots

import (
	"path/filepath"
	"reflect"
	"testing"
)

func TestBuildMirrorsExternalsOnly(t *testing.T) {
	got := buildMirrors("/home/u", "")
	want := []Mirror{
		{Path: filepath.Join("/home/u", ".claude", "projects"), Source: "claude"},
		{Path: filepath.Join("/home/u", ".codex", "memories"), Source: "codex"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("buildMirrors = %v, want %v", got, want)
	}
}

func TestBuildMirrorsKeepsCustomLegacyRoot(t *testing.T) {
	got := buildMirrors("/home/u", "/custom/notes")
	if len(got) != 3 {
		t.Fatalf("len = %d, want 3: %v", len(got), got)
	}
	last := got[len(got)-1]
	if last.Path != "/custom/notes" || last.Source != "vault" {
		t.Fatalf("custom legacy mirror = %+v, want {/custom/notes vault}", last)
	}
}

func TestBuildAllRootsPutsMemoryRootFirst(t *testing.T) {
	got := buildAllRoots("/home/u/.waveterm/vault/memory", buildMirrors("/home/u", ""))
	var sources []string
	for _, m := range got {
		sources = append(sources, m.Source)
	}
	want := []string{"vault", "claude", "codex"}
	if !reflect.DeepEqual(sources, want) {
		t.Fatalf("sources = %v, want %v", sources, want)
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
