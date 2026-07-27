// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memroots

import (
	"log"
	"os"
	"path/filepath"
	"strings"
)

// MigrateLegacyRoot folds the pre-unification ~/.waveterm/memory root into the vault's memory
// collection. Idempotent: an absent source, or a second call, is a no-op. A custom memory:vaultpath
// is deliberately not migrated — it stays a mirror and is read in place.
func MigrateLegacyRoot() (int, []string, error) {
	return migrateRoot(LegacyRoot(), MemoryRoot())
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
