// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memvault

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCanonicalHubHashHalvesSeparatorRuns(t *testing.T) {
	cases := []struct{ in, want string }{
		{"C---Users--kael02--IdeaProjects--waveterm", "C--Users-kael02-IdeaProjects-waveterm"},
		{"C---Users--kael02--IdeaProjects--SIEM--src--cyber_ai--cyber_assistant", "C--Users-kael02-IdeaProjects-SIEM-src-cyber_ai-cyber_assistant"},
		// a lone dash from a real folder name maps to itself
		{"C--Users-kael02-my-project", "C--Users-kael02-my-project"},
	}
	for _, c := range cases {
		if got := CanonicalHubHash(c.in); got != c.want {
			t.Fatalf("CanonicalHubHash(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// hubFixture writes one note into <root>/<hash>/memory and returns that hub dir.
func hubFixture(t *testing.T, root, hash, slug, body string) string {
	t.Helper()
	hub := filepath.Join(root, hash, "memory")
	if err := os.MkdirAll(hub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hub, slug+".md"),
		[]byte("---\nname: "+slug+"\nmetadata:\n  type: learning\n  source: \"claude\"\n---\n\n"+body+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return hub
}

func TestMergeDoubledHubsRequiresAnExistingCanonicalSibling(t *testing.T) {
	root := t.TempDir()
	oldRoot := claudeProjectsRoot
	claudeProjectsRoot = func() string { return root }
	t.Cleanup(func() { claudeProjectsRoot = oldRoot })

	canonical := hubFixture(t, root, "C--Users-k-proj", "canon-note", "canonical body")
	doubled := hubFixture(t, root, "C---Users--k--proj", "doubled-note", "doubled body")
	orphan := hubFixture(t, root, "C---Users--k--noSibling", "orphan-note", "orphan body")

	moved, err := MergeDoubledHubs()
	if err != nil {
		t.Fatalf("MergeDoubledHubs: %v", err)
	}
	if moved != 1 {
		t.Fatalf("moved %d notes, want 1", moved)
	}
	if _, err := os.Stat(filepath.Join(canonical, "doubled-note.md")); err != nil {
		t.Fatalf("doubled note not merged into the canonical hub: %v", err)
	}
	if _, err := os.Stat(doubled); !os.IsNotExist(err) {
		t.Fatalf("emptied doubled hub should be removed, stat err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(orphan, "orphan-note.md")); err != nil {
		t.Fatalf("a doubled hub with no canonical sibling must be left untouched: %v", err)
	}
}

func TestPruneDeadHubsNeedsBothGuards(t *testing.T) {
	root := t.TempDir()
	vault := t.TempDir()
	liveRepo := t.TempDir()

	oldRoot := claudeProjectsRoot
	claudeProjectsRoot = func() string { return root }
	t.Cleanup(func() { claudeProjectsRoot = oldRoot })
	oldVault := DefaultVaultPath
	DefaultVaultPath = func() string { return vault }
	t.Cleanup(func() { DefaultVaultPath = oldVault })
	oldArchive := ArchiveDir
	ArchiveDir = func() string { return filepath.Join(t.TempDir(), "archive") }
	t.Cleanup(func() { ArchiveDir = oldArchive })

	// backed: its body is in the vault. unbacked: it exists nowhere else.
	backedHub := hubFixture(t, root, ProjectHashForTest(filepath.Join(root, "gone-repo")), "backed", "a backed body")
	unbackedHub := hubFixture(t, root, ProjectHashForTest(filepath.Join(root, "gone-repo-2")), "unbacked", "a body held nowhere else")
	liveHub := hubFixture(t, root, ProjectHashForTest(liveRepo), "live", "a backed body")

	if err := os.WriteFile(filepath.Join(vault, "backed.md"),
		[]byte("---\nname: backed\n---\n\na backed body\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	removed, err := PruneDeadHubs()
	if err != nil {
		t.Fatalf("PruneDeadHubs: %v", err)
	}
	if removed != 1 {
		t.Fatalf("removed %d hubs, want 1 (only dead AND fully backed)", removed)
	}
	if _, err := os.Stat(backedHub); !os.IsNotExist(err) {
		t.Fatalf("dead, fully-backed hub should be removed, stat err = %v", err)
	}
	if _, err := os.Stat(unbackedHub); err != nil {
		t.Fatalf("a hub holding an unbacked fact must survive: %v", err)
	}
	if _, err := os.Stat(liveHub); err != nil {
		t.Fatalf("a hub whose repo still exists must survive: %v", err)
	}
}
