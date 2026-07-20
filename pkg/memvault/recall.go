// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Real recall telemetry: parse a finished Claude transcript for the memories it actually recalled.
// Recalled notes appear as `<system-reminder>This memory is N days old…</system-reminder>` blocks
// followed by the note's line-numbered file content (name: <slug> in frontmatter). This is ground
// truth for last_referenced, superseding the distiller's post-hoc `references` guess.
// See docs/superpowers/specs/2026-07-20-memory-relevance-gardener-design.md.
package memvault

import (
	"os"
	"regexp"
	"time"
)

// recallRe pairs each recall reminder with the first `name:` slug that follows it. Non-greedy `.*?`
// keeps each match inside one JSONL record (`.` excludes real newlines; embedded ones are literal \n).
var recallRe = regexp.MustCompile(`This memory is \d+ days? old.*?name:\s*([A-Za-z0-9_-]+)`)

// ParseRecalledSlugs returns the deduped, first-seen-ordered set of note slugs recalled in transcript.
func ParseRecalledSlugs(transcript string) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range recallRe.FindAllStringSubmatch(transcript, -1) {
		slug := m[1]
		if slug != "" && !seen[slug] {
			seen[slug] = true
			out = append(out, slug)
		}
	}
	return out
}

// RecordRecall reads a finished transcript, extracts recalled slugs, and stamps real last_referenced
// on each in cwd's Claude hub. Fail-safe: missing files / empty cwd touch nothing. Returns the count.
func RecordRecall(cwd, transcriptPath string, now time.Time) int {
	hub := HubDirForCwd(cwd)
	if hub == "" {
		return 0
	}
	return recordRecallInto(hub, transcriptPath, now)
}

// recordRecallInto is the testable core: parse transcriptPath and TouchReferenced each slug in hubDir.
func recordRecallInto(hubDir, transcriptPath string, now time.Time) int {
	data, err := os.ReadFile(transcriptPath)
	if err != nil {
		return 0
	}
	slugs := ParseRecalledSlugs(string(data))
	if len(slugs) == 0 {
		return 0
	}
	_ = TouchReferenced(hubDir, slugs, now.UTC().Format(time.RFC3339))
	return len(slugs)
}
