// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/memroots"
)

// mirrorFixture builds a vault plus one claude-shaped and one codex-shaped mirror root, and installs
// them on the vault. Mirrors are opt-in per vault: only OpenVault installs the real ones, so every
// other package's fixture vault stays out of the developer's ~/.claude and ~/.codex.
func mirrorFixture(t *testing.T) (*Vault, string) {
	t.Helper()
	base := t.TempDir()
	v, err := OpenVaultAtForTest(context.Background(), filepath.Join(base, "vault"))
	if err != nil {
		t.Fatalf("OpenVaultAtForTest: %v", err)
	}
	claudeRoot := filepath.Join(base, "claude", "projects")
	codexRoot := filepath.Join(base, "codex", "memories")
	v.mirrors = func() []memroots.Mirror {
		return []memroots.Mirror{
			{Path: claudeRoot, Source: "claude"},
			{Path: codexRoot, Source: "codex"},
		}
	}
	return v, base
}

// claudeHub is the per-project memory dir inside the fixture's claude-shaped mirror root.
func claudeHub(base string) string {
	return filepath.Join(base, "claude", "projects", "C--Users-k-krypton", "memory")
}

func writeNote(t *testing.T, dir, name, body string) string {
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

// A fixture vault must never inherit the real mirror roots — otherwise every sibling package's
// fixture vault (jarvisdossier, jarvisrecall, wshserver, …) would start walking the developer's
// home directory. This is the mirror twin of TestOpenVaultAtForTestDoesNotMigrate.
func TestFixtureVaultHasNoMirrors(t *testing.T) {
	v, err := OpenVaultAtForTest(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("OpenVaultAtForTest: %v", err)
	}
	if v.mirrors != nil {
		t.Fatal("fixture vault carries mirror roots; mirrors must be installed by OpenVault only")
	}
}

func TestMirroredNotesEnterMemoryCollection(t *testing.T) {
	v, base := mirrorFixture(t)
	writeNote(t, claudeHub(base), "hub-note.md", "---\nname: hub-note\n---\n\n# Hub note\nbody\n")
	writeNote(t, filepath.Join(base, "codex", "memories"), "cx.md", "---\nname: cx\n---\n\n# Cx\nbody\n")

	nodes, err := v.Retriever(AllScope()).Query(Filter{})
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	byID := map[string]Node{}
	for _, n := range nodes {
		byID[n.ID] = n
	}
	hn, ok := byID["hub-note"]
	if !ok {
		t.Fatalf("hub-note absent; got %v", byID)
	}
	if hn.Collection != CollMemory {
		t.Errorf("hub-note Collection = %q, want %q", hn.Collection, CollMemory)
	}
	if hn.Source != "claude" {
		t.Errorf("hub-note Source = %q, want claude", hn.Source)
	}
	if hn.Scope != "krypton" {
		t.Errorf("hub-note Scope = %q, want krypton", hn.Scope)
	}
	if cx, ok := byID["cx"]; !ok || cx.Source != "codex" {
		t.Errorf("codex note = %+v, want Source codex", cx)
	}
}

// memvault reads an explicit scope from metadata.scope, so wavevault must honour the same nested key
// — otherwise the two scanners report different scopes for the same file, which is the desync
// memroots exists to prevent.
func TestFrontmatterMetadataScopeWinsOverPath(t *testing.T) {
	v, base := mirrorFixture(t)
	writeNote(t, claudeHub(base), "tagged.md",
		"---\nname: tagged\nmetadata:\n  scope: shared\n---\n\n# Tagged\nbody\n")

	nb, err := v.Retriever(AllScope()).Read("tagged")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if nb.Node.Scope != "shared" {
		t.Fatalf("Scope = %q, want shared (metadata.scope overrides the hub dir)", nb.Node.Scope)
	}
}

// Scope is a memory-collection concept. Deriving it for tasks/decisions would label a dossier at
// tasks/active/x.md with the project "active", which recall then prints on its grounding card.
func TestScopeNotDerivedForNonMemoryCollections(t *testing.T) {
	v, _ := mirrorFixture(t)
	if _, err := v.CreateHuman(CollTasks, "active/d1.md", "---\nname: d1\n---\n\n# D1\nbody\n"); err != nil {
		t.Fatalf("CreateHuman: %v", err)
	}

	nb, err := v.Retriever(AllScope()).Read("d1")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if nb.Node.Scope != "" {
		t.Fatalf("Scope = %q, want empty for a tasks node", nb.Node.Scope)
	}
	if nb.Node.Source != "vault" {
		t.Fatalf("Source = %q, want vault", nb.Node.Source)
	}
}

func TestMirroredWikilinkResolvesAcrossRoots(t *testing.T) {
	v, base := mirrorFixture(t)
	if _, err := v.CreateHuman(CollMemory, "own.md", "---\nname: own\n---\n\n# Own\nsee [[hub-note]]\n"); err != nil {
		t.Fatalf("CreateHuman: %v", err)
	}
	writeNote(t, claudeHub(base), "hub-note.md", "---\nname: hub-note\n---\n\n# Hub note\nbody\n")

	sg, err := v.Retriever(AllScope()).Graph()
	if err != nil {
		t.Fatalf("Graph: %v", err)
	}
	for _, e := range sg.Edges {
		if e.From == "own" && e.To == "hub-note" {
			return
		}
	}
	t.Fatalf("edge own->hub-note absent; edges = %v", sg.Edges)
}

func TestVaultOwnNoteWinsIDConflict(t *testing.T) {
	v, base := mirrorFixture(t)
	if _, err := v.CreateHuman(CollMemory, "dup.md", "---\nname: dup\n---\n\n# Dup\nVAULT COPY\n"); err != nil {
		t.Fatalf("CreateHuman: %v", err)
	}
	writeNote(t, claudeHub(base), "dup.md", "---\nname: dup\n---\n\n# Dup\nMIRROR COPY\n")

	nb, err := v.Retriever(AllScope()).Read("dup")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if !strings.Contains(nb.Body, "VAULT COPY") {
		t.Fatalf("mirror won the conflict; body = %q", nb.Body)
	}
	if nb.Node.Source != "vault" {
		t.Errorf("Source = %q, want vault", nb.Node.Source)
	}
}

func TestIndexFileExcludedFromGraph(t *testing.T) {
	v, base := mirrorFixture(t)
	writeNote(t, claudeHub(base), memroots.IndexFile, "# Memory index\n- [x](x.md)\n")

	nodes, err := v.Retriever(AllScope()).Query(Filter{})
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range nodes {
		if strings.TrimSuffix(memroots.IndexFile, ".md") == n.ID {
			t.Fatalf("index file entered the graph as %+v", n)
		}
	}
}

func TestMirroredFileIsNotWritable(t *testing.T) {
	v, base := mirrorFixture(t)
	writeNote(t, claudeHub(base), "hub-note.md", "---\nname: hub-note\n---\n\n# Hub note\nbody\n")

	if _, err := v.resolvePath("hub-note"); err == nil {
		t.Fatal("resolvePath reached a mirrored file; mirrors must be read-only")
	}
}

func TestMirrorScanLeavesVaultGitClean(t *testing.T) {
	v, base := mirrorFixture(t)
	writeNote(t, claudeHub(base), "hub-note.md", "---\nname: hub-note\n---\n\n# Hub note\nbody\n")
	if _, err := v.Retriever(AllScope()).Query(Filter{}); err != nil {
		t.Fatal(err)
	}

	out, err := runGit(context.Background(), v.Root, "status", "--porcelain")
	if err != nil {
		t.Fatalf("git status: %v", err)
	}
	if strings.TrimSpace(out) != "" {
		t.Fatalf("vault dirty after mirror scan: %q", out)
	}
}
