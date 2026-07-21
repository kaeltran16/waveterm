// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The archive primitive: the gardener's reversible removal. Archiving MOVES a hub note into
// ~/.waveterm/memory-archive/ (a sibling of the vault + pending dirs, never a scan root), stamped
// archived_at/archived_reason/archived_from and keeping source_hash so the distiller won't re-learn
// it. Restore moves it back to its origin hub. No hard delete.
// See docs/superpowers/specs/2026-07-20-memory-relevance-gardener-design.md.
package memvault

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"gopkg.in/yaml.v3"
)

// ArchiveDir is the recoverable removal store: a sibling of the vault + pending dirs, never scanned.
func ArchiveDir() string {
	return filepath.Join(wavebase.GetHomeDir(), ".waveterm", "memory-archive")
}

type ArchivedNote struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	Type       string `json:"type"`       // original metadata.type (kept in the archived file), for the row's type badge
	Reason     string `json:"reason"`     // decay | drift
	ArchivedAt string `json:"archivedat"` // RFC3339
	Path       string `json:"path"`       // path inside the archive dir
	OriginHub  string `json:"originhub"`  // hub dir to restore into
}

type archivedFrontmatter struct {
	Metadata struct {
		ArchivedAt     string `yaml:"archived_at"`
		ArchivedReason string `yaml:"archived_reason"`
		ArchivedFrom   string `yaml:"archived_from"`
	} `yaml:"metadata"`
}

// Archive moves notePath into ArchiveDir, stamping archive metadata. reason is decay | drift.
func Archive(notePath, reason string, now time.Time) (string, error) {
	data, err := os.ReadFile(notePath)
	if err != nil {
		return "", err
	}
	n, _ := parseNote(notePath, data, "claude")
	hubDir := filepath.Dir(notePath)
	content := string(data)
	content = setMetadataField(content, "archived_at", yamlQuote(now.UTC().Format(time.RFC3339)))
	content = setMetadataField(content, "archived_reason", reason)
	content = setMetadataField(content, "archived_from", yamlQuote(hubDir))

	if err := os.MkdirAll(ArchiveDir(), 0o755); err != nil {
		return "", err
	}
	stamp := now.UTC().Format("20060102T150405.000")
	arcPath := filepath.Join(ArchiveDir(), stamp+"-"+n.ID+".md")
	if err := os.WriteFile(arcPath, []byte(content), 0o644); err != nil {
		return "", err
	}
	if err := os.Remove(notePath); err != nil {
		_ = os.Remove(arcPath) // don't leave a duplicate if the move half-failed
		return "", fmt.Errorf("removing archived source: %w", err)
	}
	return arcPath, nil
}

// Restore moves an archived note back to its origin hub (from archived_from), stripping archive fields.
func Restore(archivePath string) (string, error) {
	data, err := os.ReadFile(archivePath)
	if err != nil {
		return "", err
	}
	n, _ := parseNote(archivePath, data, "claude")
	var af archivedFrontmatter
	_ = yaml.Unmarshal(frontmatterBytes(data), &af)
	hub := af.Metadata.ArchivedFrom
	if hub == "" {
		return "", fmt.Errorf("archived note has no archived_from: %s", archivePath)
	}
	content := string(data)
	for _, k := range []string{"archived_at", "archived_reason", "archived_from"} {
		content = removeMetadataField(content, k)
	}
	if err := os.MkdirAll(hub, 0o755); err != nil {
		return "", err
	}
	dest := filepath.Join(hub, n.ID+".md")
	if err := os.WriteFile(dest, []byte(content), 0o644); err != nil {
		return "", err
	}
	if err := os.Remove(archivePath); err != nil {
		return "", fmt.Errorf("removing archive file after restore: %w", err)
	}
	return dest, nil
}

// ListArchived reads every note in ArchiveDir, newest archived_at first. Missing dir -> empty.
func ListArchived() []ArchivedNote {
	entries, err := os.ReadDir(ArchiveDir())
	if err != nil {
		return nil
	}
	var out []ArchivedNote
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		p := filepath.Join(ArchiveDir(), e.Name())
		data, readErr := os.ReadFile(p)
		if readErr != nil {
			continue
		}
		n, _ := parseNote(p, data, "claude")
		var af archivedFrontmatter
		_ = yaml.Unmarshal(frontmatterBytes(data), &af)
		out = append(out, ArchivedNote{
			ID: n.ID, Title: n.Title, Type: n.Type, Reason: af.Metadata.ArchivedReason,
			ArchivedAt: af.Metadata.ArchivedAt, Path: p, OriginHub: af.Metadata.ArchivedFrom,
		})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].ArchivedAt > out[j].ArchivedAt })
	return out
}

// archivedHashes returns the set of source_hashes already archived, so the distiller's dedup won't
// re-learn what the gardener removed (the load-bearing link — see harvest.go / learn.go).
func archivedHashes() map[string]bool {
	out := map[string]bool{}
	entries, err := os.ReadDir(ArchiveDir())
	if err != nil {
		return out
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		data, readErr := os.ReadFile(filepath.Join(ArchiveDir(), e.Name()))
		if readErr != nil {
			continue
		}
		if n, _ := parseNote("", data, "claude"); n.SourceHash != "" {
			out[n.SourceHash] = true
		}
	}
	return out
}

// frontmatterBytes returns the YAML frontmatter block (between the leading --- fences), or nil.
func frontmatterBytes(data []byte) []byte {
	s := string(data)
	if !strings.HasPrefix(s, "---\n") {
		return nil
	}
	if end := strings.Index(s[4:], "\n---"); end >= 0 {
		return []byte(s[4 : 4+end])
	}
	return nil
}

// removeMetadataField deletes a "  <key>: ..." line from the frontmatter metadata block. Inverse of
// setMetadataField. Content without frontmatter, or without the key, is returned unchanged.
func removeMetadataField(content, key string) string {
	if !strings.HasPrefix(content, "---\n") {
		return content
	}
	end := strings.Index(content[4:], "\n---")
	if end < 0 {
		return content
	}
	fmText := content[4 : 4+end]
	rest := content[4+end:]
	lines := strings.Split(fmText, "\n")
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		if strings.HasPrefix(l, "  ") && strings.HasPrefix(strings.TrimSpace(l), key+":") {
			continue
		}
		out = append(out, l)
	}
	return "---\n" + strings.Join(out, "\n") + rest
}
