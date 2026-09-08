// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memvault

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/memroots"
)

// vaultBackedHashes is every fact body the vault can still produce: active notes plus the archive.
// The gardener archives rather than deletes, so an archived fact is preserved, not lost — which
// makes it safe to evict its hub copy out of Claude's namespace.
func vaultBackedHashes(vaultDir string) map[string]bool {
	out := map[string]bool{}
	for _, nw := range readHubNotes(vaultDir) {
		out[factHash(nw.Body)] = true
	}
	for h := range archivedHashes() {
		out[h] = true
	}
	return out
}

// evictExportedNotes moves Arc-written notes out of Claude's authored hub and into the shared dir.
// readHubNotes tags every note it parses with the root source "claude", so a note is ours only when
// frontmatter carried some other provenance. A note whose body hash is not in backed is left in
// place: a fact that exists nowhere else must not be destroyed by a namespace cleanup.
func evictExportedNotes(hubDir, sharedDir string, backed map[string]bool) (int, int, error) {
	moved, kept := 0, 0
	var movedNames []string
	for _, nw := range readHubNotes(hubDir) {
		if nw.Note.Source == "" || nw.Note.Source == "claude" {
			continue // authored by the memory tool; not ours to move
		}
		if !backed[factHash(nw.Body)] {
			kept++
			continue
		}
		if err := os.MkdirAll(sharedDir, 0o755); err != nil {
			return moved, kept, err
		}
		base := filepath.Base(nw.Note.Path)
		if err := os.Rename(nw.Note.Path, filepath.Join(sharedDir, base)); err != nil {
			return moved, kept, err
		}
		movedNames = append(movedNames, base)
		moved++
	}
	if err := repointIndexLinks(hubDir, movedNames); err != nil {
		return moved, kept, err
	}
	return moved, kept, nil
}

// repointIndexLinks rewrites the hub index's links for notes we just moved to shared/. The memory
// tool hand-maintains MEMORY.md and has no idea a file left the directory, so a silent rename turns
// its entry into a dead link -- which is the same class of bug the shared/ split was meant to end.
// shared/ is a sibling of the hub, so the target is one level up. Missing index is a no-op.
func repointIndexLinks(hubDir string, movedNames []string) error {
	if hubDir == "" || len(movedNames) == 0 {
		return nil
	}
	indexPath := filepath.Join(hubDir, memroots.IndexFile)
	data, err := os.ReadFile(indexPath)
	if err != nil {
		return nil // no index to maintain
	}
	out := string(data)
	for _, base := range movedNames {
		// an already-repointed link reads "](../shared/x.md)" and no longer matches "](x.md)",
		// so re-running over the same index is a no-op
		out = strings.ReplaceAll(out, "]("+base+")", "](../shared/"+base+")")
	}
	if out == string(data) {
		return nil
	}
	return os.WriteFile(indexPath, []byte(out), 0o644)
}

// EvictExportedHubNotes clears Arc's own output out of cwd's Claude memory hub. Called from Project
// so it is self-healing across every project; idempotent, since a moved note is no longer in the hub.
func EvictExportedHubNotes(cwd string) (int, int, error) {
	if cwd == "" {
		return 0, 0, nil
	}
	return evictExportedNotes(HubDirForCwd(cwd), SharedDirForCwd(cwd), vaultBackedHashes(DefaultVaultPath()))
}
