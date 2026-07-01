// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Harvest extracts Codex's curated "Reusable knowledge" facts (from ~/.codex/memories/MEMORY.md)
// into the focused project's Claude memory hub — deduped by content hash, tagged source: codex,
// bulk-reversible. Pure helpers are unit-tested; Harvest() wires real paths + an mtime guard.
// See docs/superpowers/specs/2026-07-01-memory-sync-phase-b-codex-harvest-design.md.
package memvault

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// normalizeCwd makes two cwd strings comparable: strip a Windows \\?\ long-path prefix, unify
// separators to /, drop a trailing separator, and case-fold. Codex records some cwds as \\?\C:\...
func normalizeCwd(p string) string {
	p = strings.TrimPrefix(p, `\\?\`)
	p = strings.ReplaceAll(p, `\`, "/")
	p = strings.TrimRight(p, "/")
	return strings.ToLower(p)
}

// extractCwd pulls the path out of a Codex `applies_to: cwd=<path>; reuse_rule=...` line.
func extractCwd(line string) string {
	i := strings.Index(line, "cwd=")
	if i < 0 {
		return ""
	}
	rest := line[i+len("cwd="):]
	if j := strings.Index(rest, ";"); j >= 0 {
		rest = rest[:j]
	}
	return strings.TrimSpace(rest)
}

var taskRefRe = regexp.MustCompile(`(\s*\[Task[^\]]*\])+\s*$`)

// cleanBullet strips the leading "- " and any trailing [Task N]… back-reference markers.
func cleanBullet(line string) string {
	s := strings.TrimSpace(line)
	s = strings.TrimPrefix(s, "- ")
	s = strings.TrimSpace(s)
	s = taskRefRe.ReplaceAllString(s, "")
	return strings.TrimSpace(s)
}

// parseCodexReusable returns the cleaned "## Reusable knowledge" bullets from every Task-Group
// block whose applies_to cwd matches targetCwd. User preferences / Failures sections are ignored.
func parseCodexReusable(md, targetCwd string) []string {
	target := normalizeCwd(targetCwd)
	var out []string
	matched := false
	inReusable := false
	for _, line := range strings.Split(md, "\n") {
		trimmed := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "# Task Group:"):
			matched = false
			inReusable = false
		case strings.HasPrefix(trimmed, "applies_to:"):
			if cwd := extractCwd(trimmed); cwd != "" {
				matched = normalizeCwd(cwd) == target
			}
		case strings.HasPrefix(line, "## "):
			inReusable = matched && strings.HasPrefix(line, "## Reusable knowledge")
		case strings.HasPrefix(line, "# "):
			matched = false
			inReusable = false
		case inReusable && strings.HasPrefix(trimmed, "- "):
			if fact := cleanBullet(trimmed); fact != "" {
				out = append(out, fact)
			}
		}
	}
	return out
}

// factHash is the ingest-once dedup key: sha256 of the whitespace-normalized bullet.
func factHash(body string) string {
	norm := strings.Join(strings.Fields(body), " ")
	sum := sha256.Sum256([]byte(norm))
	return hex.EncodeToString(sum[:])
}

// harvestSlug builds a readable, collision-proof note filename stem: the bullet's first ~8 words
// slugified, plus the first 8 hex chars of its hash.
func harvestSlug(bullet, hash string) string {
	words := strings.Fields(bullet)
	if len(words) > 8 {
		words = words[:8]
	}
	base := slugify(strings.Join(words, " ")) // slugify lives in memvault.go
	if base == "" {
		base = "codex-fact"
	}
	short := hash
	if len(short) > 8 {
		short = short[:8]
	}
	return base + "-" + short
}

// existingHashes scans hubDir for notes carrying a source_hash, returning the set already ingested.
func existingHashes(hubDir string) map[string]bool {
	out := map[string]bool{}
	entries, err := os.ReadDir(hubDir)
	if err != nil {
		return out
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		p := filepath.Join(hubDir, e.Name())
		data, readErr := os.ReadFile(p)
		if readErr != nil {
			continue
		}
		if n, _ := parseNote(p, data, "claude"); n.SourceHash != "" {
			out[n.SourceHash] = true
		}
	}
	return out
}

// yamlQuote makes an arbitrary single-line string safe as a double-quoted YAML scalar.
func yamlQuote(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return `"` + s + `"`
}

// writeHarvestedNote writes one bullet into hubDir as a source: codex note with provenance
// frontmatter. Skips silently if a same-slug file already exists (near-impossible; slug carries the
// hash). Returns whether a file was written.
func writeHarvestedNote(hubDir, bullet, hash string) (bool, error) {
	if err := os.MkdirAll(hubDir, 0o755); err != nil {
		return false, err
	}
	slug := harvestSlug(bullet, hash)
	path := filepath.Join(hubDir, slug+".md")
	if _, err := os.Stat(path); err == nil {
		return false, nil // already present (slug collision) — do not overwrite
	}
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("name: " + slug + "\n")
	b.WriteString("description: " + yamlQuote(bullet) + "\n")
	b.WriteString("metadata:\n")
	b.WriteString("  type: reference\n")
	b.WriteString("  source: codex\n")
	b.WriteString("  source_hash: " + hash + "\n")
	b.WriteString("  harvested_at: " + time.Now().UTC().Format(time.RFC3339) + "\n")
	b.WriteString("---\n\n")
	b.WriteString(bullet + "\n")
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		return false, err
	}
	return true, nil
}

// harvestInto parses codex memory content for cwd's facts, dedups against hubDir, and writes the
// new ones. State-free (no global mtime cache, no real-path lookups) so it is fully testable.
func harvestInto(memoryMD, cwd, hubDir string) (ingested, skipped int, err error) {
	bullets := parseCodexReusable(memoryMD, cwd)
	existing := existingHashes(hubDir)
	for _, bullet := range bullets {
		h := factHash(bullet)
		if existing[h] {
			skipped++
			continue
		}
		wrote, werr := writeHarvestedNote(hubDir, bullet, h)
		if werr != nil {
			return ingested, skipped, fmt.Errorf("writing harvested note: %w", werr)
		}
		existing[h] = true // guard against duplicate bullets within the same file
		if wrote {
			ingested++
		} else {
			skipped++
		}
	}
	return ingested, skipped, nil
}

// codexMemoryPath is Codex's curated global memory file.
func codexMemoryPath() string {
	return filepath.Join(wavebase.GetHomeDir(), ".codex", "memories", "MEMORY.md")
}

var (
	lastHarvestMu    sync.Mutex
	lastHarvestMtime = map[string]int64{} // projectHash(cwd) -> MEMORY.md mtime at last harvest
)

// Harvest ingests cwd's Codex reusable-knowledge facts into that project's Claude hub. Returns
// (ingested, skipped). Missing MEMORY.md is a no-op, not an error. An unchanged MEMORY.md mtime
// since this project's last harvest short-circuits before parsing (cheap frequent calls). Public
// entry point for the MemoryHarvestCommand RPC (launch hook, cadence timer, manual button).
func Harvest(cwd string) (int, int, error) {
	if cwd == "" {
		return 0, 0, fmt.Errorf("cwd is required")
	}
	info, err := os.Stat(codexMemoryPath())
	if err != nil {
		return 0, 0, nil // no Codex memory file -> nothing to harvest
	}
	key := projectHash(cwd)
	mtime := info.ModTime().UnixMilli()
	lastHarvestMu.Lock()
	last, seen := lastHarvestMtime[key]
	lastHarvestMu.Unlock()
	if seen && last == mtime {
		return 0, 0, nil // unchanged since last harvest for this project
	}
	data, err := os.ReadFile(codexMemoryPath())
	if err != nil {
		return 0, 0, fmt.Errorf("reading codex memory: %w", err)
	}
	ingested, skipped, err := harvestInto(string(data), cwd, HubDirForCwd(cwd))
	if err != nil {
		return ingested, skipped, err
	}
	lastHarvestMu.Lock()
	lastHarvestMtime[key] = mtime
	lastHarvestMu.Unlock()
	return ingested, skipped, nil
}
