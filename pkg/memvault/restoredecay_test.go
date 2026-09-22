// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memvault

import (
	"os"
	"path/filepath"
	"testing"
)

// archivedFixture writes one archived note carrying reason, restorable into vaultDir.
func archivedFixture(t *testing.T, archiveDir, vaultDir, slug, reason string) string {
	t.Helper()
	body := "---\nname: " + slug + "\nmetadata:\n" +
		"  type: learning\n  source: \"claude\"\n" +
		"  archived_at: \"2026-08-01T00:00:00Z\"\n" +
		"  archived_reason: " + reason + "\n" +
		"  archived_from: \"" + filepath.ToSlash(vaultDir) + "\"\n---\n\n" + slug + " body\n"
	p := filepath.Join(archiveDir, "20260801T000000.000-"+slug+".md")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestRestoreDecayArchiveRestoresOnlyDecayAndIsIdempotent(t *testing.T) {
	archiveDir := t.TempDir()
	vaultDir := t.TempDir()
	markerDir := t.TempDir()

	oldArchive := ArchiveDir
	ArchiveDir = func() string { return archiveDir }
	t.Cleanup(func() { ArchiveDir = oldArchive })
	oldMarker := decayRestoreMarker
	decayRestoreMarker = func() string { return filepath.Join(markerDir, "done.txt") }
	t.Cleanup(func() { decayRestoreMarker = oldMarker })
	useScanRoots(t, vaultDir)

	decayed := archivedFixture(t, archiveDir, vaultDir, "was-decayed", "decay")
	drifted := archivedFixture(t, archiveDir, vaultDir, "was-drifted", "drift")

	n, err := RestoreDecayArchive()
	if err != nil {
		t.Fatalf("RestoreDecayArchive: %v", err)
	}
	if n != 1 {
		t.Fatalf("restored %d, want 1 (only archived_reason: decay)", n)
	}
	if _, err := os.Stat(filepath.Join(vaultDir, "was-decayed.md")); err != nil {
		t.Fatalf("decayed note not restored into the vault: %v", err)
	}
	if _, err := os.Stat(decayed); !os.IsNotExist(err) {
		t.Fatalf("restored note must leave the archive, stat err = %v", err)
	}
	if _, err := os.Stat(drifted); err != nil {
		t.Fatalf("a drift archive must be left alone: %v", err)
	}

	// second run is a no-op: the marker, not the archive's emptiness, is what guards it
	archivedFixture(t, archiveDir, vaultDir, "later-decay", "decay")
	n, err = RestoreDecayArchive()
	if err != nil {
		t.Fatalf("second RestoreDecayArchive: %v", err)
	}
	if n != 0 {
		t.Fatalf("second run restored %d, want 0", n)
	}
}

func TestRestoreDecaySkipsASlugThatIsBackInTheVault(t *testing.T) {
	archiveDir := t.TempDir()
	vaultDir := t.TempDir()
	markerDir := t.TempDir()

	oldArchive := ArchiveDir
	ArchiveDir = func() string { return archiveDir }
	t.Cleanup(func() { ArchiveDir = oldArchive })
	oldMarker := decayRestoreMarker
	decayRestoreMarker = func() string { return filepath.Join(markerDir, "done.txt") }
	t.Cleanup(func() { decayRestoreMarker = oldMarker })
	useScanRoots(t, vaultDir)

	archivedFixture(t, archiveDir, vaultDir, "collides", "decay")
	live := filepath.Join(vaultDir, "collides.md")
	if err := os.WriteFile(live, []byte("---\nname: collides\n---\n\nthe live copy\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := RestoreDecayArchive(); err != nil {
		t.Fatalf("RestoreDecayArchive: %v", err)
	}
	data, err := os.ReadFile(live)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "---\nname: collides\n---\n\nthe live copy\n" {
		t.Fatalf("a slug already in the vault must not be overwritten, got:\n%s", data)
	}
}

// useScanRoots points VaultRoots at the test's own dirs. Restore now refuses to write outside a
// live scan root, so a test restoring into a temp hub has to register it the way production does.
func useScanRoots(t *testing.T, dirs ...string) {
	t.Helper()
	roots := make([]Root, 0, len(dirs))
	for _, d := range dirs {
		roots = append(roots, Root{Path: d, Source: "vault"})
	}
	old := VaultRoots
	VaultRoots = func() []Root { return roots }
	t.Cleanup(func() { VaultRoots = old })
}

// The bug this guards: archived_from is Restore's DESTINATION, not provenance. 34 archives in the
// real vault pointed at a root that was later retired and emptied, 30 of them decay archives the
// one-shot repair gives back — restoring there would have written them somewhere nothing scans and
// then marked the repair done. A dead origin must land in the vault instead.
func TestRestoreRedirectsWhenTheOriginHubIsNoLongerAScanRoot(t *testing.T) {
	archiveDir := t.TempDir()
	deadHub := t.TempDir() // stands in for the retired root: it exists, nothing scans it
	liveVault := t.TempDir()
	markerDir := t.TempDir()

	oldArchive := ArchiveDir
	ArchiveDir = func() string { return archiveDir }
	t.Cleanup(func() { ArchiveDir = oldArchive })
	oldMarker := decayRestoreMarker
	decayRestoreMarker = func() string { return filepath.Join(markerDir, "done.txt") }
	t.Cleanup(func() { decayRestoreMarker = oldMarker })
	oldDefault := DefaultVaultPath
	DefaultVaultPath = func() string { return liveVault }
	t.Cleanup(func() { DefaultVaultPath = oldDefault })
	useScanRoots(t, liveVault)

	archivedFixture(t, archiveDir, deadHub, "orphaned-origin", "decay")

	n, err := RestoreDecayArchive()
	if err != nil {
		t.Fatalf("RestoreDecayArchive: %v", err)
	}
	if n != 1 {
		t.Fatalf("restored %d, want 1", n)
	}
	if _, err := os.Stat(filepath.Join(liveVault, "orphaned-origin.md")); err != nil {
		t.Fatalf("a dead origin hub must redirect into the vault: %v", err)
	}
	if _, err := os.Stat(filepath.Join(deadHub, "orphaned-origin.md")); !os.IsNotExist(err) {
		t.Fatalf("nothing may be written into the retired root, stat err = %v", err)
	}
}
