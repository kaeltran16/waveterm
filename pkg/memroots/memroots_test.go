// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memroots

import (
	"path/filepath"
	"testing"
)

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

func TestVaultCollectionsAreSiblings(t *testing.T) {
	root := filepath.Join("/home/u", ".waveterm", "vault")
	if got, want := steeringDocIn(root), filepath.Join(root, "steering", "AGENTS.md"); got != want {
		t.Errorf("steeringDocIn = %q, want %q", got, want)
	}
	if got, want := skillsRootIn(root), filepath.Join(root, "skills"); got != want {
		t.Errorf("skillsRootIn = %q, want %q", got, want)
	}
	if skillsRootIn(root) == filepath.Join(root, memoryColl) {
		t.Error("skills collection must not alias the memory collection")
	}
}
