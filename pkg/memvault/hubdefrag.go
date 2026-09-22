// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Hub de-fragmentation. Claude addresses its per-project memory by an encoded cwd, so one project
// reached through two spellings of its path owns two hubs and recall only ever sees the one matching
// the session's own encoding. This folds a doubled-separator hub into its canonical sibling, and
// removes hubs whose project is gone and whose every fact the vault already holds.
// See docs/superpowers/specs/2026-09-22-memory-utilization-design.md.
package memvault

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/memroots"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// claudeProjectsRoot is ~/.claude/projects. A var so tests can redirect it.
var claudeProjectsRoot = func() string {
	return filepath.Join(wavebase.GetHomeDir(), ".claude", "projects")
}

// ProjectHashForTest exposes the encoding to this package's tests, which need to build hub dirs that
// reverse-resolve to a real path.
func ProjectHashForTest(p string) string { return memroots.ProjectHash(filepath.Clean(p)) }

// CanonicalHubHash maps an encoded hub dir name to the name the same project would own had its cwd
// been spelled with single separators. A doubled cwd (C:\Users\k) encodes each separator twice, so
// a run of dashes halves — except the drive prefix, which is a two-dash run canonically and a
// three-dash run doubled, and so is normalized rather than halved. A lone dash from a real folder
// name maps to itself. The result is a candidate, never a conclusion: a merge happens only when that
// sibling exists.
func CanonicalHubHash(hash string) string {
	if len(hash) < 3 || hash[1] != '-' || hash[2] != '-' {
		return halveDashRuns(hash)
	}
	i := 1
	for i < len(hash) && hash[i] == '-' {
		i++
	}
	return hash[:1] + "--" + halveDashRuns(hash[i:])
}

// halveDashRuns maps every run of k dashes to ceil(k/2): a doubled separator (2) collapses to one,
// and a single dash stays a single dash.
func halveDashRuns(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); {
		if s[i] != '-' {
			b.WriteByte(s[i])
			i++
			continue
		}
		j := i
		for j < len(s) && s[j] == '-' {
			j++
		}
		for k := 0; k < (j-i+1)/2; k++ {
			b.WriteByte('-')
		}
		i = j
	}
	return b.String()
}

// MergeDoubledHubs folds every doubled-encoding hub into its canonical sibling and removes the
// emptied hub. Existence of the sibling is the proof that two spellings name one project; nothing is
// inferred from the string alone. Returns the number of notes moved.
func MergeDoubledHubs() (int, error) {
	root := claudeProjectsRoot()
	entries, err := os.ReadDir(root)
	if err != nil {
		return 0, nil // no claude dir: nothing to de-fragment
	}
	moved := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		canonical := CanonicalHubHash(e.Name())
		if canonical == e.Name() {
			continue
		}
		srcHub := filepath.Join(root, e.Name(), "memory")
		dstHub := filepath.Join(root, canonical, "memory")
		if !isDir(srcHub) || !isDir(dstHub) {
			continue
		}
		n, mergeErr := mergeHubNotes(srcHub, dstHub)
		moved += n
		if mergeErr != nil {
			return moved, mergeErr
		}
		// only an emptied hub is removed; a note left behind means something was not merged. The
		// project dir itself stays: it holds the session transcripts, which are not ours to delete.
		if remaining := hubFactNotes(srcHub); len(remaining) == 0 {
			_ = os.RemoveAll(srcHub)
		}
	}
	return moved, nil
}

// hubFactNotes is a hub's notes without its index. MEMORY.md is a table of contents, not a fact, so
// it is neither merged (dst maintains its own) nor expected to be backed by the vault.
func hubFactNotes(hubDir string) []NoteWithBody {
	var out []NoteWithBody
	for _, nw := range readHubNotes(hubDir) {
		if filepath.Base(nw.Note.Path) == memroots.IndexFile {
			continue
		}
		out = append(out, nw)
	}
	return out
}

// mergeHubNotes moves src's notes into dst, deduped by body hash, never overwriting a slug that dst
// already holds.
func mergeHubNotes(srcHub, dstHub string) (int, error) {
	existing := map[string]bool{}
	for _, nw := range hubFactNotes(dstHub) {
		existing[factHash(nw.Body)] = true
	}
	moved := 0
	for _, nw := range hubFactNotes(srcHub) {
		base := filepath.Base(nw.Note.Path)
		dst := filepath.Join(dstHub, base)
		if existing[factHash(nw.Body)] {
			if err := os.Remove(nw.Note.Path); err != nil {
				return moved, err
			}
			continue
		}
		if _, err := os.Stat(dst); err == nil {
			continue // slug collision with different content: leave it for human judgment
		}
		if err := os.Rename(nw.Note.Path, dst); err != nil {
			return moved, err
		}
		existing[factHash(nw.Body)] = true
		moved++
	}
	return moved, nil
}

// PruneDeadHubs removes every hub whose project path no longer exists on disk AND whose every note
// body the vault or the archive still holds. Both guards are required: a gone project alone does not
// license deleting the only copy of a fact. Only the memory subtree is removed. Returns hubs removed.
func PruneDeadHubs() (int, error) {
	backed := vaultBackedHashes(DefaultVaultPath())
	removed := 0
	for _, hub := range ClaudeHubDirs() {
		if resolveEncodedHubPath(filepath.Base(filepath.Dir(hub))) != "" {
			continue // the project is still on disk
		}
		allBacked := true
		for _, nw := range hubFactNotes(hub) {
			if !backed[factHash(nw.Body)] {
				allBacked = false
				break
			}
		}
		if !allBacked {
			continue
		}
		if err := os.RemoveAll(hub); err != nil {
			return removed, err
		}
		removed++
	}
	return removed, nil
}

// resolveEncodedHubPath finds the directory a hub dir name encodes, or "" when none exists. The
// encoding maps '\', '/' and ':' all to '-', so a dash is ambiguous — it may be a separator or a
// literal dash in a folder name, and guessing wrong on a live project reads as "dead". Walk the
// filesystem instead, trying each dash as a separator and pruning any branch that is not there. Only
// the common Windows shape "C--rest" resolves; anything else returns "" and is never pruned.
func resolveEncodedHubPath(name string) string {
	if len(name) < 4 || name[1:3] != "--" {
		return ""
	}
	root := name[:1] + ":\\"
	if !isDir(root) {
		return ""
	}
	return resolveEncodedRest(root, name[3:])
}

func resolveEncodedRest(base, rest string) string {
	for i := 0; i <= len(rest); i++ {
		if i < len(rest) && rest[i] != '-' {
			continue
		}
		next := filepath.Join(base, rest[:i])
		if !isDir(next) {
			continue
		}
		if i == len(rest) {
			return next
		}
		if got := resolveEncodedRest(next, rest[i+1:]); got != "" {
			return got
		}
	}
	return ""
}

func isDir(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}
