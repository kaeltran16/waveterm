// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Dedup: surface semantic near-duplicate notes for human-confirmed merge. Flag-only (never auto-merged
// or archived) because exact-content dups are already blocked at write time (existingHashes) and
// judgment-heavy near-dups are too risky to auto-merge. One LLM cluster call per project, gated by an
// in-memory note-set fingerprint. See docs/superpowers/specs/2026-07-20-memory-relevance-gardener-design.md.
package memgarden

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/memvault"
)

const dedupPrompt = "You are finding semantic near-duplicate project memory notes. Input: a list of " +
	"notes as `slug: first line`. Group notes that say essentially the same thing (near-duplicates), " +
	`ignoring notes that are merely related. Output ONLY JSON: {"clusters": [["slugA","slugB"], ...]}. ` +
	"Only include clusters of 2+ genuinely redundant notes. If none, return {\"clusters\": []}."

var (
	lastDedupCheckMu sync.Mutex
	lastDedupCheck   = map[string]string{}
)

// parseClusters extracts {"clusters":[[...],...]} from an LLM response. Fail-safe: empty on any problem.
func parseClusters(raw string) [][]string {
	i := strings.IndexByte(raw, '{')
	j := strings.LastIndexByte(raw, '}')
	if i < 0 || j <= i {
		return nil
	}
	var v struct {
		Clusters [][]string `json:"clusters"`
	}
	if json.Unmarshal([]byte(raw[i:j+1]), &v) != nil {
		return nil
	}
	return v.Clusters
}

// dedupCorpus renders `slug: first line` for each note.
func dedupCorpus(notes []memvault.NoteWithBody) string {
	var b strings.Builder
	for _, n := range notes {
		fmt.Fprintf(&b, "%s: %s\n", n.Note.ID, firstLine(n.Body))
	}
	return b.String()
}

// firstLine is the first non-empty trimmed line of a body.
func firstLine(body string) string {
	for _, l := range strings.Split(body, "\n") {
		if t := strings.TrimSpace(l); t != "" {
			return t
		}
	}
	return ""
}

// noteSetFingerprint hashes the sorted (id:mtime) set so dedup re-runs only when a note is added,
// removed, or changed.
func noteSetFingerprint(notes []memvault.NoteWithBody) string {
	parts := make([]string, 0, len(notes))
	for _, n := range notes {
		parts = append(parts, fmt.Sprintf("%s:%d", n.Note.ID, n.Note.UpdatedTs))
	}
	sort.Strings(parts)
	sum := sha256.Sum256([]byte(strings.Join(parts, "|")))
	return hex.EncodeToString(sum[:])
}

// checkDedup flags every non-canonical note in each near-dup cluster (the first slug is canonical).
// Gated by the note-set fingerprint. Notes already flagged are re-flagged idempotently.
func (g *gardener) checkDedup(hubDir string, notes []memvault.NoteWithBody) {
	if len(notes) < 2 {
		return
	}
	fp := noteSetFingerprint(notes)
	lastDedupCheckMu.Lock()
	unchanged := lastDedupCheck[hubDir] == fp
	lastDedupCheckMu.Unlock()
	if unchanged {
		return
	}
	corpus := dedupCorpus(notes)
	raw, ok := g.llmFn(pickModel(corpus), dedupPrompt, corpus)
	if !ok {
		return // retain state, retry next sweep
	}
	lastDedupCheckMu.Lock()
	lastDedupCheck[hubDir] = fp
	lastDedupCheckMu.Unlock()

	pathByID := map[string]string{}
	for _, n := range notes {
		pathByID[n.Note.ID] = n.Note.Path
	}
	for _, cluster := range parseClusters(raw) {
		for i, slug := range cluster {
			if i == 0 {
				continue // keep the first as canonical
			}
			if p := pathByID[slug]; p != "" {
				if err := g.flagFn(p, "duplicate"); err != nil {
					log.Printf("[memgarden] flag duplicate %s: %v\n", p, err)
				}
			}
		}
	}
}
