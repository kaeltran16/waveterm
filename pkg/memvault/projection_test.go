// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memvault

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRepoPathForHubDir(t *testing.T) {
	repo := `C:\Users\k\proj`
	projects := map[string]string{"proj": repo}
	hub := filepath.Join("root", ".claude", "projects", projectHash(repo), "memory")
	if got := repoPathForHubDir(hub, projects); got != repo {
		t.Fatalf("want %q got %q", repo, got)
	}
	if got := repoPathForHubDir(filepath.Join("root", ".claude", "projects", "C--unknown", "memory"), projects); got != "" {
		t.Fatalf("unknown hub should resolve to empty, got %q", got)
	}
}

func TestProjectHash(t *testing.T) {
	got := projectHash(`C:\Users\kael02\IdeaProjects\waveterm`)
	want := "C--Users-kael02-IdeaProjects-waveterm"
	if got != want {
		t.Fatalf("projectHash = %q, want %q", got, want)
	}
	// forward slashes normalize the same way
	if g := projectHash("/home/k/code/krypton"); g != "-home-k-code-krypton" {
		t.Fatalf("posix projectHash = %q", g)
	}
}

func TestProjectLabel(t *testing.T) {
	projects := map[string]string{"Krypton API": `C:\Users\kael02\IdeaProjects\krypton`}
	// registry hit wins
	if l := projectLabel(`C:\Users\kael02\IdeaProjects\krypton`, projects); l != "Krypton API" {
		t.Fatalf("registry label = %q", l)
	}
	// miss -> leaf folder
	if l := projectLabel(`C:\Users\kael02\IdeaProjects\waveterm`, projects); l != "waveterm" {
		t.Fatalf("leaf label = %q", l)
	}
	// label from an encoded hash, registry miss -> last segment
	if l := labelFromHash("C--Users-kael02-IdeaProjects-waveterm", projects); l != "waveterm" {
		t.Fatalf("hash leaf label = %q", l)
	}
	// label from an encoded hash, registry hit
	if l := labelFromHash("C--Users-kael02-IdeaProjects-krypton", projects); l != "Krypton API" {
		t.Fatalf("hash registry label = %q", l)
	}
}

func TestRenderFacts(t *testing.T) {
	notes := []NoteWithBody{
		{Note: Note{ID: "prefer-pg", Title: "Prefer Postgres", Description: "DB of record", Source: "claude"},
			Body: "Use Postgres, not a new dependency.\n"},
		{Note: Note{ID: "from-codex", Title: "Codex learned", Source: "codex"}, Body: "x"},
	}
	got := renderFacts("Krypton API", notes, "codex")
	// body header carries the project label (the BEGIN marker is added later by applySteeringRegion)
	if !strings.Contains(got, "Shared project memory: Krypton API") {
		t.Fatalf("missing project label in body:\n%s", got)
	}
	if !strings.Contains(got, "Prefer Postgres") || !strings.Contains(got, "Use Postgres") {
		t.Fatalf("claude note not rendered:\n%s", got)
	}
	// echo rule: a source:codex note must NOT appear in codex's projection
	if strings.Contains(got, "Codex learned") {
		t.Fatalf("echo rule violated — codex note projected back to codex:\n%s", got)
	}
	// same notes projected to agy DO include the codex-sourced note
	agy := renderFacts("Krypton API", notes, "antigravity")
	if !strings.Contains(agy, "Codex learned") {
		t.Fatalf("codex note should project to agy:\n%s", agy)
	}
}

func TestRenderFactsEmpty(t *testing.T) {
	got := renderFacts("waveterm", nil, "codex")
	if !strings.Contains(got, "Shared project memory: waveterm") {
		t.Fatalf("empty projection still needs the body header:\n%s", got)
	}
}

func TestApplySteeringRegion(t *testing.T) {
	// append when absent, preserving user content
	existing := "# My steering\n\nDo the thing.\n"
	out := applySteeringRegion(existing, "krypton", "BODY-ONE")
	if !strings.HasPrefix(out, existing) {
		t.Fatalf("user content not preserved on append:\n%s", out)
	}
	if !strings.Contains(out, "project=krypton") || !strings.Contains(out, "BODY-ONE") {
		t.Fatalf("region not appended:\n%s", out)
	}
	if !strings.Contains(out, "ARC-MEMORY:END") {
		t.Fatalf("missing END marker:\n%s", out)
	}

	// second apply REPLACES the region in place (idempotent — no duplicate region, user text intact)
	out2 := applySteeringRegion(out, "krypton", "BODY-TWO")
	if strings.Count(out2, "ARC-MEMORY:BEGIN") != 1 {
		t.Fatalf("duplicate region after re-apply:\n%s", out2)
	}
	if strings.Contains(out2, "BODY-ONE") || !strings.Contains(out2, "BODY-TWO") {
		t.Fatalf("region not replaced:\n%s", out2)
	}
	if !strings.Contains(out2, "Do the thing.") {
		t.Fatalf("user content lost on replace:\n%s", out2)
	}
}

func TestProjectToSteeringFiles(t *testing.T) {
	tmp := t.TempDir()
	hub := filepath.Join(tmp, "hub")
	if err := os.MkdirAll(hub, 0o755); err != nil {
		t.Fatal(err)
	}
	note := "---\nname: prefer-pg\ndescription: DB of record\nmetadata:\n  type: project\n---\n\n# Prefer Postgres\n\nUse Postgres.\n"
	if err := os.WriteFile(filepath.Join(hub, "prefer-pg.md"), []byte(note), 0o644); err != nil {
		t.Fatal(err)
	}
	codex := filepath.Join(tmp, "AGENTS.md")
	if err := os.WriteFile(codex, []byte("# user steering\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	agy := filepath.Join(tmp, "GEMINI.md")

	targets := []steeringTarget{{runtime: "codex", path: codex}, {runtime: "antigravity", path: agy}}
	if err := projectHubToTargets(hub, "krypton", targets); err != nil {
		t.Fatalf("projectHubToTargets: %v", err)
	}

	cb, _ := os.ReadFile(codex)
	if !strings.Contains(string(cb), "Prefer Postgres") || !strings.Contains(string(cb), "# user steering") {
		t.Fatalf("codex steering wrong:\n%s", cb)
	}
	ab, err := os.ReadFile(agy) // agy file did not exist -> created
	if err != nil || !strings.Contains(string(ab), "project=krypton") {
		t.Fatalf("agy steering not created/written: err=%v\n%s", err, ab)
	}
}

func TestProjectionStatus(t *testing.T) {
	tmp := t.TempDir()
	codex := filepath.Join(tmp, "AGENTS.md")
	os.WriteFile(codex, applySteeringRegionSeed("krypton"), 0o644)
	agy := filepath.Join(tmp, "GEMINI.md") // absent

	st := projectionStatusFor([]steeringTarget{{runtime: "codex", path: codex}, {runtime: "antigravity", path: agy}})
	if st["codex"] != "krypton" {
		t.Fatalf("codex status = %q, want krypton", st["codex"])
	}
	if _, ok := st["antigravity"]; ok {
		t.Fatalf("absent steering file should not appear in status")
	}
}

// applySteeringRegionSeed is a tiny test helper producing a file with a region.
func applySteeringRegionSeed(label string) []byte {
	return []byte(applySteeringRegion("", label, "body\n"))
}

func TestHubDirForCwd(t *testing.T) {
	got := HubDirForCwd(`C:\p\krypton`)
	if !strings.HasSuffix(filepath.ToSlash(got), ".claude/projects/C--p-krypton/memory") {
		t.Fatalf("HubDirForCwd = %q", got)
	}
	if HubDirForCwd("") != "" {
		t.Fatalf("empty cwd must yield empty hub dir")
	}
}
