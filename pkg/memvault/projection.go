// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Projection renders a project's Claude memory (the hub) into the delimited region of each
// lackey runtime's home-level steering file. Pure helpers here are unit-tested; Project()
// wires them to the filesystem. See docs/superpowers/specs/2026-07-01-memory-sync-engine-design.md.
package memvault

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// projectHash encodes a cwd the way Claude Code names its per-project dir: every path separator
// (both \ and /) and colon becomes '-'. e.g. C:\Users\k\p -> C--Users-k-p.
func projectHash(cwd string) string {
	r := strings.NewReplacer(`\`, "-", "/", "-", ":", "-")
	return r.Replace(cwd)
}

// projectLabel is the human-readable name for a cwd: its Projects-registry name if the cwd
// matches a registered path, else the leaf folder. projects maps registry name -> path.
func projectLabel(cwd string, projects map[string]string) string {
	clean := filepath.Clean(cwd)
	for name, p := range projects {
		if filepath.Clean(p) == clean {
			return name
		}
	}
	base := filepath.Base(clean)
	if base == "." || base == string(filepath.Separator) || base == "" {
		return clean
	}
	return base
}

// labelFromHash resolves a readable label from an encoded hash dir name (reverse of projectHash,
// which is lossy). Tries a registry match by re-encoding each registered path; falls back to the
// last '-'-delimited segment (the leaf folder in the common case).
func labelFromHash(hash string, projects map[string]string) string {
	for name, p := range projects {
		if projectHash(filepath.Clean(p)) == hash {
			return name
		}
	}
	parts := strings.Split(strings.TrimRight(hash, "-"), "-")
	if len(parts) == 0 {
		return hash
	}
	return parts[len(parts)-1]
}

// projectionHeader is embedded in the region's BEGIN line so the status command can read back
// which project each steering file currently reflects.
const projectionHeader = "<!-- ARC-MEMORY:BEGIN project=%s (generated — do not edit; managed by Arc) -->"

// renderFacts renders the region body: a project header plus each note as facts-to-know, excluding
// notes whose Source equals targetRuntime (echo rule). Deterministic order = notes as passed in.
func renderFacts(label string, notes []NoteWithBody, targetRuntime string) string {
	var b strings.Builder
	b.WriteString("## Shared project memory: " + label + "\n\n")
	b.WriteString("These are facts about this project, projected from the primary agent's memory.\n\n")
	for _, n := range notes {
		if n.Note.Source == targetRuntime {
			continue // echo rule: don't send a runtime its own harvested facts
		}
		title := n.Note.Title
		if title == "" {
			title = n.Note.ID
		}
		b.WriteString("### " + title + "\n")
		if n.Note.Description != "" {
			b.WriteString(n.Note.Description + "\n\n")
		}
		body := strings.TrimSpace(n.Body)
		if body != "" {
			b.WriteString(body + "\n\n")
		}
	}
	return strings.TrimRight(b.String(), "\n") + "\n"
}

const projectionEnd = "<!-- ARC-MEMORY:END -->"

// applySteeringRegion returns existing with the ARC-MEMORY region set to body (for project label).
// Replaces an existing region in place; appends one (separated by a blank line) if none is present.
// Content outside the markers is untouched.
func applySteeringRegion(existing, label, body string) string {
	begin := fmt.Sprintf(projectionHeader, label)
	region := begin + "\n" + body + projectionEnd + "\n"

	startIdx := strings.Index(existing, "<!-- ARC-MEMORY:BEGIN")
	if startIdx >= 0 {
		endIdx := strings.Index(existing[startIdx:], projectionEnd)
		if endIdx >= 0 {
			tail := existing[startIdx+endIdx+len(projectionEnd):]
			tail = strings.TrimLeft(tail, "\n")
			head := existing[:startIdx]
			return head + region + tail
		}
	}
	if existing != "" && !strings.HasSuffix(existing, "\n") {
		existing += "\n"
	}
	if existing != "" {
		existing += "\n"
	}
	return existing + region
}

type steeringTarget struct {
	runtime string // "codex" | "antigravity"
	path    string
}

// steeringTargets are the home-level steering files for each lackey runtime. Global (home) files
// only — never repo-tracked files. Paths mirror the spike findings.
func steeringTargets() []steeringTarget {
	home := wavebase.GetHomeDir()
	return []steeringTarget{
		{runtime: "codex", path: filepath.Join(home, ".codex", "AGENTS.md")},
		{runtime: "antigravity", path: filepath.Join(home, ".gemini", "GEMINI.md")},
	}
}

// readHubNotes reads every .md note (with body) directly under hubDir. Missing dir -> empty slice.
func readHubNotes(hubDir string) []NoteWithBody {
	entries, err := os.ReadDir(hubDir)
	if err != nil {
		return nil
	}
	var out []NoteWithBody
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		p := filepath.Join(hubDir, e.Name())
		data, readErr := os.ReadFile(p)
		if readErr != nil {
			continue
		}
		n, body := parseNote(p, data, "claude")
		out = append(out, NoteWithBody{Note: n, Body: body})
	}
	return out
}

// projectHubToTargets renders the hub notes and writes each target's steering region.
func projectHubToTargets(hubDir, label string, targets []steeringTarget) error {
	notes := readHubNotes(hubDir)
	for _, tgt := range targets {
		var existing string
		if data, err := os.ReadFile(tgt.path); err == nil {
			existing = string(data)
		}
		body := renderFacts(label, notes, tgt.runtime)
		out := applySteeringRegion(existing, label, body)
		if err := os.MkdirAll(filepath.Dir(tgt.path), 0o755); err != nil {
			return fmt.Errorf("creating steering dir for %s: %w", tgt.runtime, err)
		}
		if err := os.WriteFile(tgt.path, []byte(out), 0o644); err != nil {
			return fmt.Errorf("writing %s steering: %w", tgt.runtime, err)
		}
	}
	return nil
}

// registryProjects reads the Projects registry (name -> path) from live config.
func registryProjects() map[string]string {
	out := map[string]string{}
	cfg := wconfig.GetWatcher().GetFullConfig()
	for name, pk := range cfg.Projects {
		if pk.Path != "" {
			out[name] = pk.Path
		}
	}
	return out
}

// HubDirForCwd returns the Claude per-project memory dir for a cwd, or "" for an empty cwd.
func HubDirForCwd(cwd string) string {
	if cwd == "" {
		return ""
	}
	return filepath.Join(wavebase.GetHomeDir(), ".claude", "projects", projectHash(cwd), "memory")
}

// Project renders cwd's Claude hub memory into all lackey steering files. This is the public
// entry point called by the MemoryProjectCommand RPC at agent launch (and the manual button).
func Project(cwd string) error {
	if cwd == "" {
		return fmt.Errorf("cwd is required")
	}
	hubDir := HubDirForCwd(cwd)
	label := projectLabel(cwd, registryProjects())
	return projectHubToTargets(hubDir, label, steeringTargets())
}

var projectionMarkerRe = regexp.MustCompile(`<!-- ARC-MEMORY:BEGIN project=(.+?) \(generated`)

// projectionStatusFor returns runtime -> project label for each steering file that currently has
// an ARC-MEMORY region. Files without a region (or absent) are omitted.
func projectionStatusFor(targets []steeringTarget) map[string]string {
	out := map[string]string{}
	for _, tgt := range targets {
		data, err := os.ReadFile(tgt.path)
		if err != nil {
			continue
		}
		if m := projectionMarkerRe.FindStringSubmatch(string(data)); m != nil {
			out[tgt.runtime] = m[1]
		}
	}
	return out
}

// ProjectionStatus is the public status entry point for the RPC.
func ProjectionStatus() map[string]string {
	return projectionStatusFor(steeringTargets())
}
