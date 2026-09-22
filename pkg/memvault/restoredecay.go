// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// One-shot repair: give back every note the pre-epoch decay predicate archived. Those archives fired
// on the never-referenced branch, which no vault-only note could escape, so the archive is a record
// of a bug rather than of a decision. Runs once per installation, guarded by a marker file — the
// same shape as memroots' legacy-root fold. See
// docs/superpowers/specs/2026-09-22-memory-utilization-design.md.
package memvault

import (
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// decayRestoreMarker records that the repair has run, keyed to the profile's data dir. A var so
// tests can redirect it.
var decayRestoreMarker = func() string {
	dir := wavebase.GetWaveDataDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "memory-decay-restore-done.txt")
}

// RestoreDecayArchive moves every archived note whose reason is "decay" back to the collection it
// came from, stripping the archive metadata. Slug collisions are skipped, never overwritten: a note
// that is already back in the vault has a live copy that outranks the archived one. Idempotent —
// the marker, not the archive's emptiness, is what stops a second run, so a decay archive written
// after the repair (by the fixed predicate, on real evidence) is left alone.
func RestoreDecayArchive() (int, error) {
	marker := decayRestoreMarker()
	if marker == "" {
		return 0, nil // no data dir: nothing to remember having done
	}
	if _, err := os.Stat(marker); err == nil {
		return 0, nil
	}
	restored := 0
	for _, a := range ListArchived() {
		if a.Reason != "decay" {
			continue
		}
		if a.OriginHub != "" {
			if _, err := os.Stat(filepath.Join(a.OriginHub, a.ID+".md")); err == nil {
				continue // a live copy already holds the slug
			}
		}
		if _, err := Restore(a.Path); err != nil {
			// one unrestorable note must not strand the rest
			log.Printf("[memvault] restoring decayed note %s: %v\n", a.Path, err)
			continue
		}
		restored++
	}
	if err := os.WriteFile(marker, []byte(time.Now().UTC().Format(time.RFC3339)), 0o644); err != nil {
		return restored, err
	}
	return restored, nil
}
