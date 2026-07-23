// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

const (
	CollMemory      = "memory"
	CollTasks       = "tasks"
	CollDecisions   = "decisions"
	CollAttachments = "attachments"
)

const defaultVaultSubpath = ".waveterm/vault"

// scaffoldDirs are the directories created on first open. tasks has active/archive subdirs; the
// read scopes address the top-level "tasks" collection (the scanner recurses).
var scaffoldDirs = []string{CollMemory, "tasks/active", "tasks/archive", CollDecisions, CollAttachments}

// Scope is the collection boundary: a Retriever built from a Scope can physically only read those
// collections (invariant 4). Attachments hold binaries and are not scanned into the node graph.
type Scope struct {
	Collections []string
}

func AllScope() Scope    { return Scope{Collections: []string{CollMemory, CollTasks, CollDecisions}} }
func WorkerScope() Scope { return Scope{Collections: []string{CollMemory, CollDecisions}} }

// Vault is a handle to one on-disk git-backed vault. machineFiles records, per absolute path, the
// content hash Jarvis last wrote — Commit uses it to author machine-only changes as Jarvis.
type Vault struct {
	Root         string
	mu           sync.Mutex
	machineFiles map[string]string
}

// DefaultVaultRoot resolves the vault path from config (jarvis:vaultpath) + home. Default
// ~/.waveterm/vault.
func DefaultVaultRoot() string {
	root := filepath.Join(wavebase.GetHomeDir(), defaultVaultSubpath)
	if cfg := wconfig.GetWatcher().GetFullConfig(); cfg.Settings.JarvisVaultPath != "" {
		root = wavebase.ExpandHomeDirSafe(cfg.Settings.JarvisVaultPath)
	}
	return root
}

// OpenVault opens (creating + git-initializing if needed) the configured vault.
func OpenVault(ctx context.Context) (*Vault, error) {
	return openVaultAt(ctx, DefaultVaultRoot())
}

// openVaultAt is the test seam: open a vault at an explicit root.
func openVaultAt(ctx context.Context, root string) (*Vault, error) {
	for _, d := range scaffoldDirs {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			return nil, err
		}
	}
	v := &Vault{Root: root, machineFiles: map[string]string{}}
	if err := v.ensureGit(ctx); err != nil {
		return nil, err
	}
	return v, nil
}

// ensureGit git-inits the vault if it is not already a repo, and sets a fallback identity so
// human-authored commits never fail with "unknown identity". Idempotent.
func (v *Vault) ensureGit(ctx context.Context) error {
	if _, err := os.Stat(filepath.Join(v.Root, ".git")); err == nil {
		return nil // already a repo — leave its identity/config alone
	}
	if _, err := runGitErr(ctx, v.Root, "init", "-b", "main"); err != nil {
		return err
	}
	if out, _ := runGit(ctx, v.Root, "config", "user.email"); strings.TrimSpace(out) == "" {
		if _, err := runGitErr(ctx, v.Root, "config", "user.email", "user@waveterm.local"); err != nil {
			return err
		}
		if _, err := runGitErr(ctx, v.Root, "config", "user.name", "Wave User"); err != nil {
			return err
		}
	}
	return nil
}
