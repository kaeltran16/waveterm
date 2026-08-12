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

	"github.com/wavetermdev/waveterm/pkg/memroots"
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

// writeSourcedNote is the one note-file writer: deterministic slug, frontmatter with type/scope/
// source/source_hash, body. Skips silently when the slug already exists. Shared by the codex
// harvest, the claude-hub fold, pi-memory harvest, and the vault→hub export.
func writeSourcedNote(dir, slug, noteType, scope, source, hash, body string) (bool, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false, err
	}
	path := filepath.Join(dir, slug+".md")
	if _, err := os.Stat(path); err == nil {
		return false, nil // slug collision — never overwrite
	}
	if noteType == "" {
		noteType = "learning"
	}
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("name: " + slug + "\n")
	b.WriteString("metadata:\n")
	b.WriteString("  type: " + noteType + "\n")
	if scope != "" {
		b.WriteString("  scope: " + scope + "\n")
	}
	if source != "" {
		b.WriteString("  source: " + source + "\n")
	}
	if hash != "" {
		b.WriteString("  source_hash: " + hash + "\n")
	}
	b.WriteString("---\n\n")
	b.WriteString(body)
	if !strings.HasSuffix(body, "\n") {
		b.WriteString("\n")
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		return false, err
	}
	return true, nil
}

func writeHarvestedNote(vaultDir, bullet, hash, scope string) (bool, error) {
	return writeSourcedNote(vaultDir, harvestSlug(bullet, hash), "reference", scope, "codex", hash, bullet)
}

// harvestInto parses codex memory content for cwd's facts, dedups against vaultDir, and writes the
// new ones scoped to the project. State-free (no global mtime cache, no real-path lookups) so it is
// fully testable.
func harvestInto(memoryMD, cwd, vaultDir string) (ingested, skipped int, err error) {
	bullets := parseCodexReusable(memoryMD, cwd)
	scope := projectLabel(cwd, memroots.RegistryProjects())
	existing := existingHashes(vaultDir)
	for h := range archivedHashes() { // don't re-harvest what the gardener archived
		existing[h] = true
	}
	for _, bullet := range bullets {
		h := factHash(bullet)
		if existing[h] {
			skipped++
			continue
		}
		wrote, werr := writeHarvestedNote(vaultDir, bullet, h, scope)
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
	lastHarvestMtime = map[string]int64{} // memroots.ProjectHash(cwd) -> MEMORY.md mtime at last harvest
)

// foldHubNote writes one hub note into the vault, preserving its slug, scope, and provenance so
// wikilinks and the prune/decay signals survive the fold.
func foldHubNote(vaultDir string, n Note, body string) (bool, error) {
	if n.Scope == "" {
		n.Scope = "shared"
	}
	slug := boundedSlug(n.ID, "note")
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("name: " + slug + "\n")
	b.WriteString("metadata:\n")
	b.WriteString("  type: " + nonEmpty(n.Type, "learning") + "\n")
	b.WriteString("  scope: " + yamlQuote(n.Scope) + "\n")
	if n.Source != "" {
		b.WriteString("  source: " + yamlQuote(n.Source) + "\n")
	}
	b.WriteString("  source_hash: " + factHash(body) + "\n")
	if n.CapturedAt != "" {
		b.WriteString("  captured_at: " + yamlQuote(n.CapturedAt) + "\n")
	}
	if n.Reviewed {
		b.WriteString("  reviewed: true\n")
	}
	if n.SupersededBy != "" {
		b.WriteString("  superseded_by: " + yamlQuote(n.SupersededBy) + "\n")
	}
	if n.LastReferenced != "" {
		b.WriteString("  last_referenced: " + yamlQuote(n.LastReferenced) + "\n")
	}
	if n.GardenerFlag != "" {
		b.WriteString("  gardener_flag: " + yamlQuote(n.GardenerFlag) + "\n")
	}
	b.WriteString("---\n\n")
	b.WriteString(strings.TrimSpace(body) + "\n")
	path := filepath.Join(vaultDir, slug+".md")
	if _, err := os.Stat(path); err == nil {
		return false, nil
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		return false, err
	}
	return true, nil
}

// HarvestClaudeHubs folds every Claude hub note into the vault, deduped by body hash. The first run
// is the migration; later runs pick up new organic writes. Idempotent and add-only.
func HarvestClaudeHubs() (int, int, error) {
	vaultDir := DefaultVaultPath()
	if err := os.MkdirAll(vaultDir, 0o755); err != nil {
		return 0, 0, err
	}
	existing := existingHashes(vaultDir)
	for h := range archivedHashes() {
		existing[h] = true
	}
	ingested, skipped := 0, 0
	for _, hubDir := range ClaudeHubDirs() {
		for _, nw := range readHubNotes(hubDir) {
			n := nw.Note
			if n.Scope == "" {
				// a hub dir's hash encodes the project; derive the same label the scan does so folded
				// notes keep their project grouping instead of collapsing into "shared"
				n.Scope = memroots.ScopeForHubDir(filepath.Dir(hubDir))
			}
			h := factHash(nw.Body)
			if existing[h] {
				skipped++
				continue
			}
			wrote, werr := foldHubNote(vaultDir, n, nw.Body)
			if werr != nil {
				return ingested, skipped, fmt.Errorf("folding hub note: %w", werr)
			}
			existing[h] = true
			if wrote {
				ingested++
			} else {
				skipped++
			}
		}
	}
	return ingested, skipped, nil
}

var piEntryRe = regexp.MustCompile(`(?m)^<!--.*?-->$`)

// parsePiMemory splits pi-memory's curated MEMORY.md into entry texts. Entries are separated by
// <!-- ts [id] --> marker comments; markers and surrounding whitespace are dropped.
func parsePiMemory(md string) []string {
	var out []string
	for _, chunk := range piEntryRe.Split(md, -1) {
		if t := strings.TrimSpace(chunk); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// piTypeFromTag maps a pi-memory #tag to a note type; unknown/absent tags -> learning.
var piTagRe = regexp.MustCompile(`^#([a-z][a-z0-9-]*)`)

func piTypeFromTag(entry string) string {
	if m := piTagRe.FindStringSubmatch(entry); m != nil {
		switch m[1] {
		case "preference", "decision", "lesson", "project", "reference", "feedback":
			return m[1]
		}
	}
	return "learning"
}

// piMemoryPath is pi-memory's curated long-term memory file. A var so tests can stub it.
var piMemoryPath = func() string {
	return filepath.Join(wavebase.GetHomeDir(), ".pi", "agent", "memory", "MEMORY.md")
}

// harvestPiMemoryInto is the testable core: parse entries, dedup by body hash against vaultDir,
// write source: pi notes. Scope is left unset (shared) — pi-memory is a home-level store.
func harvestPiMemoryInto(vaultDir, md string) (int, int, error) {
	if err := os.MkdirAll(vaultDir, 0o755); err != nil {
		return 0, 0, err
	}
	existing := existingHashes(vaultDir)
	for h := range archivedHashes() {
		existing[h] = true
	}
	ingested, skipped := 0, 0
	for _, entry := range parsePiMemory(md) {
		h := factHash(entry)
		if existing[h] {
			skipped++
			continue
		}
		slug := harvestSlug(firstLine(entry), h)
		wrote, werr := writeSourcedNote(vaultDir, slug, piTypeFromTag(entry), "", "pi", h, entry)
		if werr != nil {
			return ingested, skipped, fmt.Errorf("writing pi note: %w", werr)
		}
		existing[h] = true
		if wrote {
			ingested++
		} else {
			skipped++
		}
	}
	return ingested, skipped, nil
}

// HarvestPiMemory folds pi-memory's curated entries into the vault. Missing file (package not
// installed) is a no-op, not an error — pi without pi-memory contributes via transcripts instead.
func HarvestPiMemory() (int, int, error) {
	data, err := os.ReadFile(piMemoryPath())
	if err != nil {
		return 0, 0, nil
	}
	return harvestPiMemoryInto(DefaultVaultPath(), string(data))
}

// HarvestAll runs every native-memory harvest into the vault (claude hubs + pi-memory). The codex
// harvest stays cwd-scoped on demand (MemoryHarvestCommand). Registered as the memory sweep hook:
// the first run at boot is the migration fold, then hourly for new organic writes.
func HarvestAll() (int, int, error) {
	cIngested, cSkipped, err := HarvestClaudeHubs()
	if err != nil {
		return cIngested, cSkipped, err
	}
	pIngested, pSkipped, err := HarvestPiMemory()
	if err != nil {
		return cIngested + pIngested, cSkipped + pSkipped, err
	}
	return cIngested + pIngested, cSkipped + pSkipped, nil
}

// Harvest ingests cwd's Codex reusable-knowledge facts into the vault. Returns (ingested, skipped).
// Missing MEMORY.md is a no-op, not an error. An unchanged MEMORY.md mtime since this project's last
// harvest short-circuits before parsing (cheap frequent calls). Public entry point for the
// MemoryHarvestCommand RPC (launch hook, cadence timer, manual button).
func Harvest(cwd string) (int, int, error) {
	if cwd == "" {
		return 0, 0, fmt.Errorf("cwd is required")
	}
	info, err := os.Stat(codexMemoryPath())
	if err != nil {
		return 0, 0, nil // no Codex memory file -> nothing to harvest
	}
	key := memroots.ProjectHash(cwd)
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
	ingested, skipped, err := harvestInto(string(data), cwd, DefaultVaultPath())
	if err != nil {
		return ingested, skipped, err
	}
	lastHarvestMu.Lock()
	lastHarvestMtime[key] = mtime
	lastHarvestMu.Unlock()
	return ingested, skipped, nil
}
