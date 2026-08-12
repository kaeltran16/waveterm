// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memroots

import (
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// MigrateLegacyRoot folds the pre-unification ~/.waveterm/memory root into the vault's memory
// collection. Idempotent: an absent source, or a second call, is a no-op. MemoryRoot() follows the
// configured root (memory:vaultpath first), so the fold lands wherever the vault is.
func MigrateLegacyRoot() (int, []string, error) {
	return migrateRoot(LegacyRoot(), MemoryRoot())
}

// MigrateVaultToConfiguredRoot copies the last-known vault root's memory collection into the
// current one (memory:vaultpath → jarvis:vaultpath → default) when the root changed since the
// previous boot. Runs once at boot before the harvest fold: notes already in the old root must not
// become invisible when the root switches. Copy, never move — switching back leaves both copies
// intact. Idempotent: a root that didn't change copies nothing. The last-used root is recorded in
// the wave data dir so a configured→configured switch (e.g. Obsidian → test_vault) copies too, not
// just the default→configured first switch.
func MigrateVaultToConfiguredRoot() (int, int, error) {
	current := VaultRoot()
	last := readLastRoot()
	if last == "" {
		// first run of the migration machinery: no recorded history, fall back to the default root
		// (the pre-configuration location) as the source
		last = filepath.Join(wavebase.GetHomeDir(), vaultSubpath)
	}
	copied, skipped, err := migrateVaultRoot(last, current)
	if err == nil {
		writeLastRoot(current)
	}
	return copied, skipped, err
}

// migrateVaultRoot is the pure core: copy lastRoot's memory into currentRoot's. Same root -> no-op.
func migrateVaultRoot(lastRoot, currentRoot string) (int, int, error) {
	if filepath.Clean(lastRoot) == filepath.Clean(currentRoot) {
		return 0, 0, nil
	}
	return copyRootNotes(filepath.Join(lastRoot, memoryColl), filepath.Join(currentRoot, memoryColl))
}

// lastRootFile is where the last-used vault root is recorded, keyed to the profile (dev vs prod
// data dirs). The migration source for the next root switch.
func lastRootFile() string {
	return filepath.Join(wavebase.GetWaveDataDir(), "memory-vault-root.txt")
}

func readLastRoot() string {
	if wavebase.GetWaveDataDir() == "" {
		return "" // no data dir (tests/embedded): no recorded history
	}
	data, err := os.ReadFile(lastRootFile())
	if err != nil {
		return "" // absent or unreadable: no recorded history
	}
	return strings.TrimSpace(string(data))
}

func writeLastRoot(root string) {
	if wavebase.GetWaveDataDir() == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(lastRootFile()), 0o755); err != nil {
		log.Printf("memroots: cannot record vault root %s: %v", root, err)
		return
	}
	if err := os.WriteFile(lastRootFile(), []byte(root), 0o644); err != nil {
		log.Printf("memroots: cannot record vault root %s: %v", root, err)
	}
}

// copyRootNotes copies src's *.md into dst, skipping (never overwriting) name collisions. The
// source is left intact — this is a copy, not a move.
func copyRootNotes(src, dst string) (int, int, error) {
	entries, err := os.ReadDir(src)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, 0, nil
		}
		return 0, 0, err
	}
	copied, skipped := 0, 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		from := filepath.Join(src, e.Name())
		to := filepath.Join(dst, e.Name())
		if _, statErr := os.Stat(to); statErr == nil {
			skipped++
			continue
		}
		if mkErr := os.MkdirAll(dst, 0o755); mkErr != nil {
			return copied, skipped, mkErr
		}
		data, readErr := os.ReadFile(from)
		if readErr != nil {
			return copied, skipped, readErr
		}
		if writeErr := os.WriteFile(to, data, 0o644); writeErr != nil {
			return copied, skipped, writeErr
		}
		copied++
	}
	if copied > 0 {
		log.Printf("memroots: copied %d vault note(s) from %s into %s", copied, src, dst)
	}
	return copied, skipped, nil
}

// migrateRoot moves src's *.md into dst, skipping (never overwriting) name collisions, and removes
// src only once it is empty. Skips and leftovers are reported rather than forced.
func migrateRoot(src, dst string) (int, []string, error) {
	entries, err := os.ReadDir(src)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil, nil
		}
		return 0, nil, err
	}
	var moved int
	var skipped []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		from := filepath.Join(src, e.Name())
		to := filepath.Join(dst, e.Name())
		if _, statErr := os.Stat(to); statErr == nil {
			skipped = append(skipped, from)
			log.Printf("memroots: migration skipped %s — %s already exists", from, to)
			continue
		}
		if mkErr := os.MkdirAll(dst, 0o755); mkErr != nil {
			return moved, skipped, mkErr
		}
		if renErr := os.Rename(from, to); renErr != nil {
			return moved, skipped, renErr
		}
		moved++
	}
	// Remove only succeeds on an empty dir, which is exactly the guard we want: anything left behind
	// (a skipped note, a non-markdown file, a subdir) keeps the source root alive.
	if err := os.Remove(src); err != nil && !os.IsNotExist(err) {
		log.Printf("memroots: legacy root %s kept — not empty after migration", src)
	}
	if moved > 0 {
		log.Printf("memroots: migrated %d note(s) from %s into %s", moved, src, dst)
	}
	return moved, skipped, nil
}
