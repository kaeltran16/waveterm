// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pending review store: agent-distilled candidates that are NOT auto-committed (facts, prefs) land
// here until a human accepts or rejects them. Lives outside all scan roots so ScanVault never
// surfaces unreviewed notes. See docs/superpowers/specs/2026-07-10-memory-applied-learning-design.md.
package memvault

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// PendingNote is one queued candidate awaiting human review.
type PendingNote struct {
	Path  string `json:"path"`
	Type  string `json:"type"`
	Scope string `json:"scope"`
	Body  string `json:"body"`
	Cwd   string `json:"cwd"`
}

// PendingDir is the review-queue directory: a sibling of the vault root, never a scan root.
func PendingDir() string {
	return filepath.Join(wavebase.GetHomeDir(), ".waveterm", "memory-pending")
}

// WritePending writes c into dir as a candidate note, recording the target cwd in frontmatter so
// AcceptPending knows which hub to commit into. Filename carries a timestamp for stable ordering.
func WritePending(dir string, c LearnCandidate, cwd string) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	slug := slugify(firstLine(c.Body))
	if slug == "" {
		slug = "candidate"
	}
	if len(slug) > 48 {
		slug = slug[:48]
	}
	stamp := time.Now().UTC().Format("20060102T150405.000")
	path := filepath.Join(dir, stamp+"-"+slug+".md")
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("name: " + slug + "\n")
	b.WriteString("metadata:\n")
	b.WriteString("  type: " + nonEmpty(c.Type, "learning") + "\n")
	if c.Scope != "" {
		b.WriteString("  scope: " + c.Scope + "\n")
	}
	b.WriteString("  source: agent\n")
	b.WriteString("  cwd: " + yamlQuote(cwd) + "\n")
	b.WriteString("---\n\n")
	b.WriteString(c.Body + "\n")
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		return "", err
	}
	return path, nil
}

func nonEmpty(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

// ListPending reads every candidate in dir. Missing dir -> empty slice. Sorted by filename (the
// timestamp prefix -> chronological).
func ListPending(dir string) []PendingNote {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []PendingNote
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		p := filepath.Join(dir, e.Name())
		data, readErr := os.ReadFile(p)
		if readErr != nil {
			continue
		}
		n, body := parseNote(p, data, "pending")
		out = append(out, PendingNote{Path: p, Type: n.Type, Scope: n.Scope, Body: strings.TrimSpace(body), Cwd: pendingCwd(data)})
	}
	return out
}

// pendingCwd extracts the recorded cwd from a pending note's frontmatter (parseNote doesn't carry it).
func pendingCwd(data []byte) string {
	lines := strings.Split(string(data), "\n")
	for i, line := range lines {
		t := strings.TrimSpace(line)
		if i > 0 && t == "---" {
			break // end of frontmatter
		}
		if strings.HasPrefix(t, "cwd:") {
			v := strings.TrimSpace(strings.TrimPrefix(t, "cwd:"))
			return strings.Trim(v, `"`)
		}
	}
	return ""
}

// AcceptPending commits a queued candidate into its recorded project hub (or the default vault when
// no cwd), then removes the pending file. Returns the created note path.
func AcceptPending(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	n, body := parseNote(path, data, "pending")
	target := DefaultVaultPath()
	if hub := HubDirForCwd(pendingCwd(data)); hub != "" {
		target = hub
	}
	return acceptPendingInto(PendingNote{Path: path, Type: n.Type, Scope: n.Scope, Body: strings.TrimSpace(body)}, target)
}

// acceptPendingInto is the testable core: create the note in targetDir, then remove the pending file.
func acceptPendingInto(pn PendingNote, targetDir string) (string, error) {
	created, err := CreateNote(targetDir, firstLine(pn.Body), pn.Type, pn.Scope, pn.Body)
	if err != nil {
		return "", err
	}
	_ = os.Remove(pn.Path)
	return created, nil
}
