// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memroots

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

func TestVaultRootDelegatesToWconfig(t *testing.T) {
	configDir := t.TempDir()
	vaultDir := filepath.Join(t.TempDir(), "vault")
	barr, err := json.Marshal(map[string]any{wconfig.ConfigKey_MemoryVaultPath: vaultDir})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(filepath.Join(configDir, wconfig.SettingsFile), barr, 0o644); err != nil {
		t.Fatalf("write settings: %v", err)
	}
	prev := wavebase.ConfigHome_VarCache
	wavebase.ConfigHome_VarCache = configDir
	t.Cleanup(func() { wavebase.ConfigHome_VarCache = prev })

	// no watcher started: the root is read from the local settings file, not the watcher's cached config
	if got := VaultRoot(); got != wconfig.VaultRoot() || got != filepath.Clean(vaultDir) {
		t.Fatalf("VaultRoot() = %q, wconfig.VaultRoot() = %q, want %q", got, wconfig.VaultRoot(), vaultDir)
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
