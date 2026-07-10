// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pruning: surface outdated hub notes for human-confirmed removal. Two signals — superseded (strong,
// set by the distiller when a new learning replaces an old one) and stale (weak, no last_referenced
// activity in StaleDays). See docs/superpowers/specs/2026-07-10-memory-applied-learning-design.md.
package memvault

import (
	"sort"
	"time"
)

const StaleDays = 30

// PruneCandidate is one note the cleanup queue suggests removing (never auto-removed).
type PruneCandidate struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Reason string `json:"reason"` // "superseded" | "stale"
	Path   string `json:"path"`
}

// classifyPrune is the pure core: superseded first, then stale (last_referenced older than StaleDays).
// A note with no last_referenced is NOT stale (never-referenced human notes are left alone).
func classifyPrune(notes []Note, now time.Time) []PruneCandidate {
	var out []PruneCandidate
	cutoff := now.AddDate(0, 0, -StaleDays)
	for _, n := range notes {
		switch {
		case n.SupersededBy != "":
			out = append(out, PruneCandidate{ID: n.ID, Title: n.Title, Reason: "superseded", Path: n.Path})
		case n.LastReferenced != "":
			if ts, err := time.Parse(time.RFC3339, n.LastReferenced); err == nil && ts.Before(cutoff) {
				out = append(out, PruneCandidate{ID: n.ID, Title: n.Title, Reason: "stale", Path: n.Path})
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].Reason == "superseded" && out[j].Reason != "superseded"
	})
	return out
}

// PruneCandidates scans all vault roots and classifies them against now.
func PruneCandidates(now time.Time) []PruneCandidate {
	g, err := ScanVault(VaultRoots())
	if err != nil {
		return nil
	}
	return classifyPrune(g.Notes, now)
}
