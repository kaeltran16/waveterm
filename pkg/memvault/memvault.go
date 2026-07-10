// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package memvault scans markdown memory vaults (a dedicated Wave vault plus each agent's
// native markdown memory dir) into a source-tagged node+edge graph, and reads/writes notes.
// Sibling to pkg/agentsessions. Notes use the Claude memory schema: frontmatter name +
// description + metadata.type + [[wikilinks]] in the body.
package memvault

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"gopkg.in/yaml.v3"
)

// Note is one memory note. Body is populated only by ReadNote (Scan omits it to keep the payload small).
type Note struct {
	ID          string   `json:"id"`          // frontmatter name; falls back to filename stem
	Title       string   `json:"title"`       // first markdown heading, else ID
	Description string   `json:"description"` // frontmatter description
	Type        string   `json:"type"`        // metadata.type (verbatim)
	Scope       string   `json:"scope"`       // cluster: metadata.scope, else project dir, else "shared"
	Source      string   `json:"source"`      // "vault" | "claude" | "codex" (frontmatter overrides root)
	SourceHash  string   `json:"sourcehash"`  // metadata.source_hash for harvested notes (dedup key)
	Path        string   `json:"path"`        // absolute file path
	Links       []string `json:"links"`       // [[targets]] from the body, in order, deduped
	UpdatedTs   int64    `json:"updatedts"`   // file mtime, UnixMilli

	Reviewed       bool   `json:"reviewed"`       // metadata.reviewed; false = machine-written, awaiting human review
	CapturedAt     string `json:"capturedat"`     // metadata.captured_at (RFC3339) for agent-written notes
	SupersededBy   string `json:"supersededby"`   // metadata.superseded_by: slug of the note that replaced this one
	LastReferenced string `json:"lastreferenced"` // metadata.last_referenced (RFC3339): last session that used this note
}

type Edge struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type Graph struct {
	Notes []Note `json:"notes"`
	Edges []Edge `json:"edges"`
}

type frontmatter struct {
	Name        string `yaml:"name"`
	Description string `yaml:"description"`
	Metadata    struct {
		Type           string `yaml:"type"`
		Scope          string `yaml:"scope"`
		Source         string `yaml:"source"`
		SourceHash     string `yaml:"source_hash"`
		Reviewed       bool   `yaml:"reviewed"`
		CapturedAt     string `yaml:"captured_at"`
		SupersededBy   string `yaml:"superseded_by"`
		LastReferenced string `yaml:"last_referenced"`
	} `yaml:"metadata"`
}

var (
	linkRe    = regexp.MustCompile(`\[\[([^\]]+)\]\]`)
	headingRe = regexp.MustCompile(`(?m)^#\s+(.+)$`)
)

// parseNote splits frontmatter from body, extracts metadata + links. scope defaults set by caller
// via deriveScope when frontmatter carries none. source is the root tag.
func parseNote(path string, data []byte, source string) (Note, string) {
	n := Note{Path: path, Source: source}
	body := string(data)
	if strings.HasPrefix(body, "---\n") {
		if end := strings.Index(body[4:], "\n---"); end >= 0 {
			fmText := body[4 : 4+end]
			rest := body[4+end+4:]
			rest = strings.TrimLeft(rest, "\n")
			var fm frontmatter
			if err := yaml.Unmarshal([]byte(fmText), &fm); err == nil {
				n.ID = fm.Name
				n.Description = fm.Description
				n.Type = fm.Metadata.Type
				n.Scope = fm.Metadata.Scope
				n.SourceHash = fm.Metadata.SourceHash
				n.Reviewed = fm.Metadata.Reviewed
				n.CapturedAt = fm.Metadata.CapturedAt
				n.SupersededBy = fm.Metadata.SupersededBy
				n.LastReferenced = fm.Metadata.LastReferenced
				if fm.Metadata.Source != "" {
					n.Source = fm.Metadata.Source // frontmatter provenance overrides the root tag
				}
			}
			body = rest
		}
	}
	if n.ID == "" {
		n.ID = strings.TrimSuffix(filepath.Base(path), ".md")
	}
	if m := headingRe.FindStringSubmatch(body); m != nil {
		n.Title = strings.TrimSpace(m[1])
	} else {
		n.Title = n.ID
	}
	seen := map[string]bool{}
	for _, m := range linkRe.FindAllStringSubmatch(body, -1) {
		t := strings.TrimSpace(m[1])
		if t != "" && !seen[t] {
			seen[t] = true
			n.Links = append(n.Links, t)
		}
	}
	return n, body
}

// Root is one scan location and its provenance tag.
type Root struct {
	Path   string
	Source string // "vault" | "claude" | "codex"
}

// ScanVault walks each root for .md files, parses them, derives scope, and resolves [[links]]
// into edges (only links whose target ID exists become edges — dangling links are dropped).
// On duplicate IDs across roots, the dedicated "vault" source wins, else first-seen wins.
func ScanVault(roots []Root) (*Graph, error) {
	byID := map[string]Note{}
	var order []string
	for _, r := range roots {
		_ = filepath.WalkDir(r.Path, func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ".md") {
				return nil
			}
			data, readErr := os.ReadFile(path)
			if readErr != nil {
				return nil
			}
			n, _ := parseNote(path, data, r.Source)
			if n.Scope == "" {
				n.Scope = deriveScope(r, path)
			}
			if info, statErr := d.Info(); statErr == nil {
				n.UpdatedTs = info.ModTime().UnixMilli()
			}
			if existing, ok := byID[n.ID]; ok {
				if !(r.Source == "vault" && existing.Source != "vault") {
					return nil // keep existing
				}
			} else {
				order = append(order, n.ID)
			}
			byID[n.ID] = n
			return nil
		})
	}
	g := &Graph{}
	for _, id := range order {
		g.Notes = append(g.Notes, byID[id])
	}
	sort.Slice(g.Notes, func(i, j int) bool { return g.Notes[i].UpdatedTs > g.Notes[j].UpdatedTs })
	for _, n := range g.Notes {
		for _, l := range n.Links {
			if _, ok := byID[l]; ok {
				g.Edges = append(g.Edges, Edge{From: n.ID, To: l})
			}
		}
	}
	return g, nil
}

// deriveScope: the note's immediate parent folder name if it sits below the root
// (e.g. Claude's per-project dir), else "shared".
func deriveScope(r Root, path string) string {
	rel, err := filepath.Rel(r.Path, path)
	if err != nil {
		return "shared"
	}
	dir := filepath.Dir(rel)
	if dir == "." || dir == "" {
		return "shared"
	}
	parts := strings.Split(filepath.ToSlash(dir), "/")
	first := parts[0]
	if r.Source == "claude" {
		// first is Claude's encoded project-hash dir; show a readable label instead.
		return labelFromHash(first, registryProjects())
	}
	return first
}

const defaultVaultSubpath = ".waveterm/memory"

// buildRoots is the pure core of VaultRoots (testable without config/home lookups).
func buildRoots(home, vaultPath string) []Root {
	return []Root{
		{Path: vaultPath, Source: "vault"},
		{Path: filepath.Join(home, ".claude", "projects"), Source: "claude"},
		{Path: filepath.Join(home, ".codex", "memories"), Source: "codex"},
	}
}

// VaultRoots resolves the scan roots from config (memory:vaultpath) + home.
func VaultRoots() []Root {
	home := wavebase.GetHomeDir()
	vaultPath := filepath.Join(home, defaultVaultSubpath)
	if cfg := wconfig.GetWatcher().GetFullConfig(); cfg.Settings.MemoryVaultPath != "" {
		vaultPath = wavebase.ExpandHomeDirSafe(cfg.Settings.MemoryVaultPath)
	}
	return buildRoots(home, vaultPath)
}

// DefaultVaultPath is the write target for cockpit-created notes.
func DefaultVaultPath() string {
	for _, r := range VaultRoots() {
		if r.Source == "vault" {
			return r.Path
		}
	}
	return filepath.Join(wavebase.GetHomeDir(), defaultVaultSubpath)
}

// NoteWithBody is a note plus its markdown body (ReadNote only).
type NoteWithBody struct {
	Note Note   `json:"note"`
	Body string `json:"body"`
}

type WriteResult struct {
	Mtime    int64 `json:"mtime"`
	Conflict bool  `json:"conflict"`
}

func ReadNote(path, source string) (*NoteWithBody, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	n, body := parseNote(path, data, source)
	if info, statErr := os.Stat(path); statErr == nil {
		n.UpdatedTs = info.ModTime().UnixMilli()
	}
	return &NoteWithBody{Note: n, Body: body}, nil
}

// WriteNote overwrites path with content unless the file changed since baseMtime (last-write with
// mtime guard). baseMtime<=0 skips the check (new-in-editor). Returns Conflict=true without writing
// when on-disk mtime is newer than baseMtime.
func WriteNote(path, content string, baseMtime int64) (*WriteResult, error) {
	if baseMtime > 0 {
		if info, err := os.Stat(path); err == nil {
			if info.ModTime().UnixMilli() > baseMtime {
				return &WriteResult{Mtime: info.ModTime().UnixMilli(), Conflict: true}, nil
			}
		}
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	return &WriteResult{Mtime: info.ModTime().UnixMilli()}, nil
}

// CreateNote writes a new note into vaultDir with a standard frontmatter block. name is slugified
// into the filename; a collision returns an error (no silent overwrite).
func CreateNote(vaultDir, name, noteType, scope, body string) (string, error) {
	slug := slugify(name)
	if slug == "" {
		slug = "note"
	}
	if err := os.MkdirAll(vaultDir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(vaultDir, slug+".md")
	if _, err := os.Stat(path); err == nil {
		return "", os.ErrExist
	}
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("name: " + slug + "\n")
	if noteType != "" {
		b.WriteString("metadata:\n  type: " + noteType + "\n")
		if scope != "" {
			b.WriteString("  scope: " + scope + "\n")
		}
	}
	b.WriteString("---\n\n")
	b.WriteString(body)
	if !strings.HasSuffix(body, "\n") {
		b.WriteString("\n")
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		return "", err
	}
	return path, nil
}

func DeleteNote(path string) error {
	return os.Remove(path)
}

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = slugRe.ReplaceAllString(s, "-")
	return strings.Trim(s, "-")
}

// setMetadataField upserts "  <key>: <value>" inside the frontmatter metadata block, preserving the
// body and all other frontmatter. value is written verbatim — the caller quotes it if YAML requires.
// If there is no metadata: block, one is created before the closing ---. Content without frontmatter
// is returned unchanged.
func setMetadataField(content, key, value string) string {
	if !strings.HasPrefix(content, "---\n") {
		return content
	}
	end := strings.Index(content[4:], "\n---")
	if end < 0 {
		return content
	}
	fmText := content[4 : 4+end]
	rest := content[4+end:] // starts at "\n---"
	lines := strings.Split(fmText, "\n")
	newLine := "  " + key + ": " + value
	metaIdx := -1
	for i, l := range lines {
		if l == "metadata:" || strings.HasPrefix(l, "metadata:") {
			metaIdx = i
			break
		}
	}
	if metaIdx < 0 {
		lines = append(lines, "metadata:", newLine)
		return "---\n" + strings.Join(lines, "\n") + rest
	}
	// scan the indented block under metadata: for an existing key
	replaced := false
	lastMeta := metaIdx
	for i := metaIdx + 1; i < len(lines); i++ {
		if !strings.HasPrefix(lines[i], "  ") {
			break
		}
		lastMeta = i
		trimmed := strings.TrimSpace(lines[i])
		if strings.HasPrefix(trimmed, key+":") {
			lines[i] = newLine
			replaced = true
			break
		}
	}
	if !replaced {
		out := make([]string, 0, len(lines)+1)
		out = append(out, lines[:lastMeta+1]...)
		out = append(out, newLine)
		out = append(out, lines[lastMeta+1:]...)
		lines = out
	}
	return "---\n" + strings.Join(lines, "\n") + rest
}
