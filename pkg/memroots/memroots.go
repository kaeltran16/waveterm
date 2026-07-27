// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package memroots is the single registry of durable-knowledge locations: the Wave Vault root, its
// memory collection (the one write target), the external agent-native memory dirs federated in as
// read-only mirrors, and the project-label/scope derivation both scanners share. Leaf package —
// pkg/memvault and pkg/wavevault both import it, neither imports the other.
package memroots

import (
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// Mirror is one scan location and its provenance tag.
type Mirror struct {
	Path   string
	Source string // "vault" | "claude" | "codex"
}

// IndexFile is a per-hub table of contents, not knowledge — every scanner skips it. Its copies also
// carry no frontmatter name, so all of them would collide on the id "MEMORY".
const IndexFile = "MEMORY.md"

const (
	vaultSubpath  = ".waveterm/vault"
	legacySubpath = ".waveterm/memory"
	memoryColl    = "memory"
)

// VaultRoot resolves the Wave Vault root from config (jarvis:vaultpath) + home.
func VaultRoot() string {
	root := filepath.Join(wavebase.GetHomeDir(), vaultSubpath)
	if cfg := wconfig.GetWatcher().GetFullConfig(); cfg.Settings.JarvisVaultPath != "" {
		root = wavebase.ExpandHomeDirSafe(cfg.Settings.JarvisVaultPath)
	}
	return root
}

// MemoryRoot is the vault's memory collection — the single write target for durable notes.
func MemoryRoot() string {
	return filepath.Join(VaultRoot(), memoryColl)
}

// LegacyRoot is the pre-unification memory root that MigrateLegacyRoot retires.
func LegacyRoot() string {
	return filepath.Join(wavebase.GetHomeDir(), legacySubpath)
}

// customLegacyRoot is a memory:vaultpath override, or "" when unset/default. A user-chosen directory
// is never migrated — it stays a mirror and is read in place.
func customLegacyRoot() string {
	cfg := wconfig.GetWatcher().GetFullConfig()
	if cfg.Settings.MemoryVaultPath == "" {
		return ""
	}
	p := wavebase.ExpandHomeDirSafe(cfg.Settings.MemoryVaultPath)
	if filepath.Clean(p) == filepath.Clean(LegacyRoot()) {
		return "" // the default location; the migrator handles it
	}
	return p
}

// buildMirrors is the pure core of Mirrors: the external, read-only roots.
func buildMirrors(home, customLegacy string) []Mirror {
	out := []Mirror{
		{Path: filepath.Join(home, ".claude", "projects"), Source: "claude"},
		{Path: filepath.Join(home, ".codex", "memories"), Source: "codex"},
	}
	if customLegacy != "" {
		out = append(out, Mirror{Path: customLegacy, Source: "vault"})
	}
	return out
}

// Mirrors are the external roots federated into the memory collection. Excludes MemoryRoot so the
// vault's own walk of <root>/memory is not duplicated.
func Mirrors() []Mirror {
	return buildMirrors(wavebase.GetHomeDir(), customLegacyRoot())
}

func buildAllRoots(memoryRoot string, mirrors []Mirror) []Mirror {
	return append([]Mirror{{Path: memoryRoot, Source: "vault"}}, mirrors...)
}

// AllRoots is every durable-knowledge root, the vault's own memory collection first (it wins id
// conflicts). This is memvault's scan-root view.
func AllRoots() []Mirror {
	return buildAllRoots(MemoryRoot(), Mirrors())
}

// ProjectHash encodes a cwd the way Claude Code names its per-project dir: every path separator
// (both \ and /) and colon becomes '-'. e.g. C:\Users\k\p -> C--Users-k-p.
func ProjectHash(cwd string) string {
	r := strings.NewReplacer(`\`, "-", "/", "-", ":", "-")
	return r.Replace(cwd)
}

// RegistryProjects reads the Projects registry (name -> path) from live config.
func RegistryProjects() map[string]string {
	out := map[string]string{}
	cfg := wconfig.GetWatcher().GetFullConfig()
	for name, pk := range cfg.Projects {
		if pk.Path != "" {
			out[name] = pk.Path
		}
	}
	return out
}

// LabelFromHash resolves a readable label from an encoded hash dir name (reverse of ProjectHash,
// which is lossy). Tries a registry match by re-encoding each registered path; falls back to the
// last '-'-delimited segment (the leaf folder in the common case).
func LabelFromHash(hash string, projects map[string]string) string {
	for name, p := range projects {
		if ProjectHash(filepath.Clean(p)) == hash {
			return name
		}
	}
	parts := strings.Split(strings.TrimRight(hash, "-"), "-")
	if len(parts) == 0 {
		return hash
	}
	return parts[len(parts)-1]
}

// ScopeForHubDir labels a Claude per-project hub dir against the live Projects registry.
func ScopeForHubDir(hubDir string) string {
	return LabelFromHash(hubDir, RegistryProjects())
}

// ScopeForPath derives a note's cluster: the first path segment below rootPath (a Claude hub dir is
// label-resolved), else "shared" for a note sitting directly in the root.
func ScopeForPath(rootPath, source, filePath string) string {
	rel, err := filepath.Rel(rootPath, filePath)
	if err != nil {
		return "shared"
	}
	dir := filepath.Dir(rel)
	if dir == "." || dir == "" {
		return "shared"
	}
	first := strings.Split(filepath.ToSlash(dir), "/")[0]
	if source == "claude" {
		return ScopeForHubDir(first)
	}
	return first
}
