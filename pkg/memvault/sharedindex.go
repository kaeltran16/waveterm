// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The shared-index region: Arc's links into the hub's sibling shared/ dir, written inside delimiters
// in the hub's MEMORY.md. Claude's memory tool is sandboxed to memory/, so a file in shared/ is only
// reachable through a link in the index — which is injected every session. Content outside the
// delimiters is the memory tool's own hand-maintained index and is never touched.
// See docs/superpowers/specs/2026-09-22-memory-utilization-design.md.
package memvault

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/memroots"
)

const (
	sharedRegionBegin = "<!-- ARC-SHARED:BEGIN (generated — do not edit; managed by Arc) -->"
	sharedRegionEnd   = "<!-- ARC-SHARED:END -->"
)

// applySharedIndexRegion returns existing with the ARC-SHARED region set to body. An empty body
// removes the region. Idempotent: applying the same body twice is a no-op.
func applySharedIndexRegion(existing, body string) string {
	stripped := existing
	if start := strings.Index(existing, sharedRegionBegin); start >= 0 {
		if end := strings.Index(existing[start:], sharedRegionEnd); end >= 0 {
			tail := strings.TrimLeft(existing[start+end+len(sharedRegionEnd):], "\n")
			stripped = existing[:start] + tail
		}
	}
	if strings.TrimSpace(body) == "" {
		return stripped
	}
	region := sharedRegionBegin + "\n" + body + sharedRegionEnd + "\n"
	if strings.TrimSpace(stripped) == "" {
		return region
	}
	return strings.TrimRight(stripped, "\n") + "\n\n" + region
}

// renderSharedIndex renders the region body: one markdown link per shared note. shared/ is a sibling
// of the hub, so every target is one level up.
func renderSharedIndex(notes []NoteWithBody) string {
	if len(notes) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("### Shared project memory (from the Arc vault)\n\n")
	for _, nw := range notes {
		desc := capLine(nw.Note.Description)
		if desc == "" {
			desc = synthDescription(nw.Body)
		}
		b.WriteString("- [" + nw.Note.ID + "](../shared/" + filepath.Base(nw.Note.Path) + ")")
		if desc != "" {
			b.WriteString(" — " + desc)
		}
		b.WriteString("\n")
	}
	return b.String()
}

// WriteSharedIndex rewrites the hub index's ARC-SHARED region from the notes currently in sharedDir.
// A hub with no index gets one; an empty sharedDir removes the region.
func WriteSharedIndex(hubDir, sharedDir string) error {
	if hubDir == "" {
		return nil
	}
	indexPath := filepath.Join(hubDir, memroots.IndexFile)
	var existing string
	if data, err := os.ReadFile(indexPath); err == nil {
		existing = string(data)
	}
	out := applySharedIndexRegion(existing, renderSharedIndex(readHubNotes(sharedDir)))
	if out == existing {
		return nil
	}
	if strings.TrimSpace(out) == "" {
		return nil // nothing to write and nothing was there
	}
	if err := os.MkdirAll(hubDir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(indexPath, []byte(out), 0o644)
}
