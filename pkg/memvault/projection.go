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
	"time"

	"github.com/wavetermdev/waveterm/pkg/harness"
	"github.com/wavetermdev/waveterm/pkg/memroots"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

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
	runtime string // "codex" | "pi" | "opencode"
	path    string
}

// steeringTargets are the static home-level steering files for runtimes that only ingest AGENTS.md
// (codex, opencode). pi's leg of the projection is NOT a steering file: it is the per-project
// reference file under the pi-memory store (see piProjectionTarget), which pi-memory's qmd index
// makes searchable instead of ambient context. Global (home) files only — never repo-tracked files.
func steeringTargets() []steeringTarget {
	home := wavebase.GetHomeDir()
	var out []steeringTarget
	for _, runtime := range []string{"codex", "opencode"} {
		spec, ok := harness.Lookup(runtime)
		if !ok {
			continue
		}
		out = append(out, steeringTarget{runtime: runtime, path: spec.SteeringPath(home)})
	}
	return out
}

// piProjectsDir is the per-project projection store inside pi-memory's directory
// (~/.pi/agent/memory/projects). pi-memory's ambient injection only ever reads MEMORY.md, the daily
// log, and the scratchpad, and HarvestPiMemory only parses MEMORY.md — so these files are pull-only:
// qmd indexes the whole memory dir (memory_search finds them) and nothing ever echoes them back into
// the vault. A var so tests can stub it.
var piProjectsDir = func() string {
	return filepath.Join(wavebase.GetHomeDir(), ".pi", "agent", "memory", "projects")
}

// sanitizeLabel maps a project label onto a filesystem-safe stem: Windows-invalid filename
// characters become '-', trailing dots/spaces are trimmed, and the result is capped at 80 runes.
func sanitizeLabel(label string) string {
	var b strings.Builder
	for _, r := range label {
		switch r {
		case '<', '>', ':', '"', '/', '\\', '|', '?', '*':
			b.WriteByte('-')
		default:
			if r < 0x20 {
				b.WriteByte('-')
			} else {
				b.WriteRune(r)
			}
		}
	}
	runes := []rune(strings.Trim(b.String(), " ."))
	if len(runes) == 0 {
		return "project"
	}
	if len(runes) > 80 {
		runes = runes[:80]
	}
	return string(runes)
}

// piProjectionTarget is pi's projection target: one delimited-region file per project inside the
// pi-memory store. The label is embedded in both the filename and the region marker, so
// piProjectionStatus can read it back without trusting the filename.
func piProjectionTarget(label string) steeringTarget {
	return steeringTarget{runtime: "pi", path: filepath.Join(piProjectsDir(), sanitizeLabel(label)+".md")}
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

// vaultNotesForProject filters the vault's notes to those belonging to cwd's project: the registry
// label, the leaf folder, and the hub-dir-derived label (covers registry renames after the fold
// baked old labels into frontmatter), plus global notes (empty/shared).
func vaultNotesForProject(cwd, label string) []NoteWithBody {
	leaf := filepath.Base(filepath.Clean(cwd))
	hubLabel := memroots.LabelFromHash(memroots.ProjectHash(filepath.Clean(cwd)), memroots.RegistryProjects())
	out := []NoteWithBody{}
	for _, nw := range readHubNotes(DefaultVaultPath()) {
		switch nw.Note.Scope {
		case label, leaf, hubLabel, "", "shared":
			out = append(out, nw)
		}
	}
	return out
}

// exportToHub writes the vault notes into hubDir as source: vault notes, skipping claude-source
// ones (echo rule: don't send claude its own facts back). Deduped by body hash against the hub.
func exportToHub(hubDir string, notes []NoteWithBody) (int, int, error) {
	if hubDir == "" {
		return 0, 0, nil
	}
	if err := os.MkdirAll(hubDir, 0o755); err != nil {
		return 0, 0, err
	}
	existing := existingHashes(hubDir)
	exported, skipped := 0, 0
	for _, nw := range notes {
		if nw.Note.Source == "claude" {
			skipped++
			continue
		}
		h := factHash(nw.Body)
		if existing[h] {
			skipped++
			continue
		}
		wrote, werr := writeSourcedNote(hubDir, boundedSlug(nw.Note.ID, "note"), nw.Note.Type, nw.Note.Scope, "vault", h, nw.Body)
		if werr != nil {
			return exported, skipped, fmt.Errorf("exporting note: %w", werr)
		}
		existing[h] = true
		if wrote {
			exported++
		} else {
			skipped++
		}
	}
	return exported, skipped, nil
}

// projectHubToTargets renders the notes and writes each target's steering region.
func projectHubToTargets(label string, notes []NoteWithBody, targets []steeringTarget) error {
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

// HubDirForCwd returns the Claude per-project memory dir for a cwd, or "" for an empty cwd.
func HubDirForCwd(cwd string) string {
	if cwd == "" {
		return ""
	}
	return filepath.Join(wavebase.GetHomeDir(), ".claude", "projects", memroots.ProjectHash(cwd), "memory")
}

// Project renders the vault's memory for cwd's project into the steering files + the project hub.
// This is the public entry point called by the MemoryProjectCommand RPC at agent launch (and the
// manual button).
func Project(cwd string) error {
	if cwd == "" {
		return fmt.Errorf("cwd is required")
	}
	label := projectLabel(cwd, memroots.RegistryProjects())
	notes := vaultNotesForProject(cwd, label)
	hubDir := HubDirForCwd(cwd)
	if _, _, err := exportToHub(hubDir, notes); err != nil {
		return fmt.Errorf("exporting to hub: %w", err)
	}
	targets := append(steeringTargets(), piProjectionTarget(label))
	return projectHubToTargets(label, notes, targets)
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

// piProjectionStatus reads the per-project files back: the label of the newest file carrying a
// valid region marker (the active project), or ("", false) when none exists yet.
func piProjectionStatus() (string, bool) {
	entries, err := os.ReadDir(piProjectsDir())
	if err != nil {
		return "", false
	}
	var (
		newest    string
		newestMod time.Time
	)
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(piProjectsDir(), e.Name()))
		if err != nil {
			continue
		}
		m := projectionMarkerRe.FindStringSubmatch(string(data))
		if m == nil {
			continue
		}
		if info, err := e.Info(); err == nil && info.ModTime().After(newestMod) {
			newestMod = info.ModTime()
			newest = m[1]
		}
	}
	return newest, newest != ""
}

// ProjectionStatus is the public status entry point for the RPC.
func ProjectionStatus() map[string]string {
	out := projectionStatusFor(steeringTargets())
	if label, ok := piProjectionStatus(); ok {
		out["pi"] = label
	}
	return out
}

// ClaudeHubDirs enumerates every existing Claude per-project memory hub (~/.claude/projects/*/memory).
// A var so tests can stub it.
var ClaudeHubDirs = func() []string {
	root := filepath.Join(wavebase.GetHomeDir(), ".claude", "projects")
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		hub := filepath.Join(root, e.Name(), "memory")
		if info, statErr := os.Stat(hub); statErr == nil && info.IsDir() {
			out = append(out, hub)
		}
	}
	return out
}

// RepoPathForHubDir reverse-resolves a hub dir to its repo path via the Projects registry, or "" when
// unknown (the hash is lossy; we re-encode each registered path to match).
func RepoPathForHubDir(hubDir string) string {
	return repoPathForHubDir(hubDir, memroots.RegistryProjects())
}

// repoPathForHubDir is the pure core (testable without config).
func repoPathForHubDir(hubDir string, projects map[string]string) string {
	hash := filepath.Base(filepath.Dir(hubDir)) // .../projects/<hash>/memory
	for _, p := range projects {
		if memroots.ProjectHash(filepath.Clean(p)) == hash {
			return p
		}
	}
	return ""
}

// HubNotes reads every note (with body) directly under hubDir. Exported for the gardener.
func HubNotes(hubDir string) []NoteWithBody {
	return readHubNotes(hubDir)
}

// VaultNotes reads every note (with body) in the vault memory collection. Exported for the gardener.
func VaultNotes() []NoteWithBody {
	return readHubNotes(DefaultVaultPath())
}
