// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Agent-authored learnings: the write side of the applied-learning loop. WriteLearning is the
// auto-commit path (corrections into the Claude hub, deduped like the Codex harvest); MarkSuperseded
// and TouchReferenced feed the pruning signals. See
// docs/superpowers/specs/2026-07-10-memory-applied-learning-design.md.
package memvault

import (
	"fmt"
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
	if existingHashes(hubDir)[hash] || archivedHashes()[hash] {
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

// FlagNote stamps metadata.gardener_flag on a hub note so classifyPrune surfaces it in the cleanup
// queue. reason: "stale" | "drift" | "duplicate". Idempotent (upsert).
func FlagNote(path, reason string) error {
	return editNoteMetadata(path, "gardener_flag", reason)
}

// ClearFlag removes metadata.gardener_flag (written as an empty value; empty and absent parse
// identically) so the note leaves the cleanup queue without being deleted. Used by the gardener's
// flag expiry for LLM-flagged notes.
func ClearFlag(path string) error {
	return editNoteMetadata(path, "gardener_flag", "")
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

// WrittenNote identifies one note a routing pass actually created. ID is the slug, which is also the note's
// frontmatter `name` and therefore the id memvault's scan reports — so a caller can address it without a
// second lookup. Title is the note's first line, which is what its `description` carries.
type WrittenNote struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// RouteResult is what a routing pass did. The counts were always returned; the identities were computed at
// the write and discarded, which left every consumer able to announce a volume and nothing else.
type RouteResult struct {
	Committed int
	Queued    int
	Written   []WrittenNote
}

// RouteLearnings writes distilled candidates into the vault: corrections auto-commit, everything
// else lands in the review tray. Supersedes and references are applied against the vault. Shared by
// MemoryLearnCommand and batch distillation.
func RouteLearnings(cwd string, candidates []LearnCandidate, references []string) (RouteResult, error) {
	target := DefaultVaultPath()
	var res RouteResult
	for _, cand := range candidates {
		if cand.IsCorrection {
			wrote, slug, err := WriteLearning(target, cand)
			if err != nil {
				return res, fmt.Errorf("writing learning: %w", err)
			}
			if wrote {
				res.Committed++
				// only a note that was actually created is a product: a deduped candidate carries a slug
				// but wrote no file, and offering to open it would be a dead button
				res.Written = append(res.Written, WrittenNote{ID: slug, Title: firstLine(cand.Body)})
			}
		} else {
			if _, err := WritePending(PendingDir(), cand, cwd); err != nil {
				return res, fmt.Errorf("queuing candidate: %w", err)
			}
			res.Queued++
		}
	}
	for _, cand := range candidates {
		if cand.Supersedes != "" {
			_, slug, _ := WriteLearning(target, LearnCandidate{Type: cand.Type, Scope: cand.Scope, Body: cand.Body})
			_ = MarkSuperseded(target, cand.Supersedes, slug)
		}
	}
	if len(references) > 0 {
		_ = TouchReferenced(target, references, time.Now().UTC().Format(time.RFC3339))
	}
	return res, nil
}
