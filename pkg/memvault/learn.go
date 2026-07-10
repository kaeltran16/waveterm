// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Agent-authored learnings: the write side of the applied-learning loop. WriteLearning is the
// auto-commit path (corrections into the Claude hub, deduped like the Codex harvest); MarkSuperseded
// and TouchReferenced feed the pruning signals. See
// docs/superpowers/specs/2026-07-10-memory-applied-learning-design.md.
package memvault

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// LearnCandidate is one distilled learning from a session, as routed by MemoryLearnCommand.
type LearnCandidate struct {
	Type         string `json:"type"`         // learning | feedback | project | reference
	Scope        string `json:"scope"`        // optional cluster label
	Body         string `json:"body"`         // the learning text
	IsCorrection bool   `json:"iscorrection"` // true -> auto-commit; false -> review tray
	Supersedes   string `json:"supersedes"`   // optional slug of an existing hub note this replaces
}

// WriteLearning writes c into hubDir as a source: agent, reviewed: false note, deduped by
// factHash(c.Body). Returns wrote=false (with the derived slug) when the fact is already present.
func WriteLearning(hubDir string, c LearnCandidate) (bool, string, error) {
	if err := os.MkdirAll(hubDir, 0o755); err != nil {
		return false, "", err
	}
	hash := factHash(c.Body)
	slug := harvestSlug(c.Body, hash)
	if existingHashes(hubDir)[hash] {
		return false, slug, nil
	}
	path := filepath.Join(hubDir, slug+".md")
	if _, err := os.Stat(path); err == nil {
		return false, slug, nil // slug collision (near-impossible; slug carries the hash)
	}
	noteType := c.Type
	if noteType == "" {
		noteType = "learning"
	}
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("name: " + slug + "\n")
	b.WriteString("description: " + yamlQuote(firstLine(c.Body)) + "\n")
	b.WriteString("metadata:\n")
	b.WriteString("  type: " + noteType + "\n")
	if c.Scope != "" {
		b.WriteString("  scope: " + c.Scope + "\n")
	}
	b.WriteString("  source: agent\n")
	b.WriteString("  source_hash: " + hash + "\n")
	b.WriteString("  captured_at: " + yamlQuote(time.Now().UTC().Format(time.RFC3339)) + "\n")
	b.WriteString("  reviewed: false\n")
	b.WriteString("---\n\n")
	b.WriteString(c.Body + "\n")
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		return false, slug, err
	}
	return true, slug, nil
}

// MarkSuperseded flags hubDir/<noteSlug>.md as replaced by bySlug (pruning's strong signal).
func MarkSuperseded(hubDir, noteSlug, bySlug string) error {
	return editNoteMetadata(filepath.Join(hubDir, noteSlug+".md"), "superseded_by", bySlug)
}

// TouchReferenced records ts as last_referenced on each named note (pruning's weak signal).
func TouchReferenced(hubDir string, slugs []string, ts string) error {
	for _, s := range slugs {
		if err := editNoteMetadata(filepath.Join(hubDir, s+".md"), "last_referenced", yamlQuote(ts)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func editNoteMetadata(path, key, value string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	out := setMetadataField(string(data), key, value)
	return os.WriteFile(path, []byte(out), 0o644)
}

// firstLine is the note description: the first non-empty line of the body, trimmed.
func firstLine(body string) string {
	for _, l := range strings.Split(body, "\n") {
		if t := strings.TrimSpace(l); t != "" {
			return t
		}
	}
	return strings.TrimSpace(body)
}
