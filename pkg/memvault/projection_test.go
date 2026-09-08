// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memvault

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/memroots"
)

func TestRepoPathForHubDir(t *testing.T) {
	repo := `C:\Users\k\proj`
	projects := map[string]string{"proj": repo}
	hub := filepath.Join("root", ".claude", "projects", memroots.ProjectHash(repo), "memory")
	if got := repoPathForHubDir(hub, projects); got != repo {
		t.Fatalf("want %q got %q", repo, got)
	}
	if got := repoPathForHubDir(filepath.Join("root", ".claude", "projects", "C--unknown", "memory"), projects); got != "" {
		t.Fatalf("unknown hub should resolve to empty, got %q", got)
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
	// same notes projected to another lackey (pi) DO include the codex-sourced note
	pi := renderFacts("Krypton API", notes, "pi")
	if !strings.Contains(pi, "Codex learned") {
		t.Fatalf("codex note should project to pi:\n%s", pi)
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
	pi := filepath.Join(tmp, "PI.md")

	targets := []steeringTarget{{runtime: "codex", path: codex}, {runtime: "pi", path: pi}}
	if err := projectHubToTargets("krypton", readHubNotes(hub), targets); err != nil {
		t.Fatalf("projectHubToTargets: %v", err)
	}

	cb, _ := os.ReadFile(codex)
	if !strings.Contains(string(cb), "Prefer Postgres") || !strings.Contains(string(cb), "# user steering") {
		t.Fatalf("codex steering wrong:\n%s", cb)
	}
	pb, err := os.ReadFile(pi) // pi file did not exist -> created
	if err != nil || !strings.Contains(string(pb), "project=krypton") {
		t.Fatalf("pi steering not created/written: err=%v\n%s", err, pb)
	}
}

func TestProjectionStatus(t *testing.T) {
	tmp := t.TempDir()
	codex := filepath.Join(tmp, "AGENTS.md")
	os.WriteFile(codex, applySteeringRegionSeed("krypton"), 0o644)
	pi := filepath.Join(tmp, "PI.md") // absent

	st := projectionStatusFor([]steeringTarget{{runtime: "codex", path: codex}, {runtime: "pi", path: pi}})
	if st["codex"] != "krypton" {
		t.Fatalf("codex status = %q, want krypton", st["codex"])
	}
	if _, ok := st["pi"]; ok {
		t.Fatalf("absent steering file should not appear in status")
	}
}

func TestSanitizeLabel(t *testing.T) {
	cases := []struct{ in, want string }{
		{"waveterm", "waveterm"},
		{"Krypton API", "Krypton API"},
		{`C:\weird/name:*?`, "C--weird-name---"},
		{"trailing. ", "trailing"},
		{"", "project"},
		{"\x01bad", "-bad"},
	}
	for _, c := range cases {
		if got := sanitizeLabel(c.in); got != c.want {
			t.Errorf("sanitizeLabel(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestPiProjectionTargetPath(t *testing.T) {
	orig := piProjectsDir
	dir := filepath.Join(t.TempDir(), "projects")
	piProjectsDir = func() string { return dir }
	defer func() { piProjectsDir = orig }()

	got := piProjectionTarget("Krypton API")
	if got.runtime != "pi" {
		t.Fatalf("runtime = %q, want pi", got.runtime)
	}
	if want := filepath.Join(dir, "Krypton API.md"); got.path != want {
		t.Fatalf("path = %q, want %q", got.path, want)
	}
}

func TestPiProjectionStatus(t *testing.T) {
	orig := piProjectsDir
	dir := filepath.Join(t.TempDir(), "projects")
	piProjectsDir = func() string { return dir }
	defer func() { piProjectsDir = orig }()

	if _, ok := piProjectionStatus(); ok {
		t.Fatal("piProjectionStatus should be empty when no files exist")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(dir, "old.md")
	new := filepath.Join(dir, "new.md")
	if err := os.WriteFile(old, applySteeringRegionSeed("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(old, time.Unix(1, 0), time.Unix(1, 0)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(new, applySteeringRegionSeed("new"), 0o644); err != nil {
		t.Fatal(err)
	}

	label, ok := piProjectionStatus()
	if !ok || label != "new" {
		t.Fatalf("piProjectionStatus = %q, %v; want \"new\", true", label, ok)
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

func TestProjectExportSkipsClaudeEcho(t *testing.T) {
	hubDir := t.TempDir()
	exported, skipped, err := exportToHub(hubDir, []NoteWithBody{
		{Note: Note{ID: "human-note", Scope: "proj", Source: "vault", Type: "learning"}, Body: "human fact"},
		{Note: Note{ID: "claude-note", Scope: "proj", Source: "claude", Type: "learning"}, Body: "claude fact"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if exported != 1 || skipped != 1 {
		t.Fatalf("exported=%d skipped=%d, want 1/1", exported, skipped)
	}
	entries, _ := os.ReadDir(hubDir)
	if len(entries) != 1 || entries[0].Name() != "human-note.md" {
		t.Fatalf("hub = %v, want only human-note.md", entries)
	}
}

func TestVaultNotesForProjectFilter(t *testing.T) {
	vaultDir := t.TempDir()
	orig := DefaultVaultPath
	DefaultVaultPath = func() string { return vaultDir }
	defer func() { DefaultVaultPath = orig }()
	notes := []struct {
		name  string
		scope string
	}{
		{"registry-name.md", "rw-test-checkpoint"},
		{"leaf.md", "waveterm"},
		{"shared.md", "shared"},
		{"unscoped.md", ""},
		{"other.md", "SIEM"},
	}
	for _, n := range notes {
		fm := "---\nname: " + strings.TrimSuffix(n.name, ".md") + "\n"
		if n.scope != "" {
			fm += "metadata:\n  scope: " + n.scope + "\n"
		}
		fm += "---\n\nbody\n"
		os.WriteFile(filepath.Join(vaultDir, n.name), []byte(fm), 0o644)
	}
	// cwd's leaf (waveterm) and the registry label (rw-test-checkpoint) each match their own scope;
	// shared/empty always match; the other project's scope is excluded.
	got := vaultNotesForProject("C:/Users/kael02/IdeaProjects/waveterm", "rw-test-checkpoint")
	if len(got) != 4 {
		t.Fatalf("vaultNotesForProject = %d notes, want 4 (registry + leaf + shared + empty)", len(got))
	}
}

func TestSharedDirIsOutsideHarvestPath(t *testing.T) {
	repo := `C:\Users\k\proj`
	shared := SharedDirForCwd(repo)
	hub := HubDirForCwd(repo)
	if shared == hub {
		t.Fatalf("shared dir must not be the hub dir, both %q", shared)
	}
	if filepath.Base(shared) != "shared" {
		t.Fatalf("shared dir should end in 'shared', got %q", shared)
	}
	// the echo guarantee: both live under the same project hash, but only the hub is enumerated
	if filepath.Dir(shared) != filepath.Dir(hub) {
		t.Fatalf("shared %q and hub %q should be siblings", shared, hub)
	}
	if SharedDirForCwd("") != "" {
		t.Fatalf("empty cwd must yield empty shared dir")
	}
}

// the echo guarantee is structural, not filter logic: ClaudeHubDirs only ever yields */memory, so a
// sibling export dir can never be walked back into the vault.
func TestClaudeHubDirsNeverEnumeratesShared(t *testing.T) {
	for _, d := range ClaudeHubDirs() {
		if filepath.Base(d) != "memory" {
			t.Fatalf("harvest would walk a non-hub dir: %q", d)
		}
	}
}

func TestRenderManifestLines(t *testing.T) {
	dir := t.TempDir()
	notes := []NoteWithBody{
		{Note: Note{ID: "wsh-not-on-path", Description: "non-interactive launch leaves wsh off PATH"}, Body: "long body"},
		{Note: Note{ID: "no-desc-note"}, Body: "First sentence. Second sentence."},
	}
	got := renderManifestFrom("waveterm", dir, notes)
	if !strings.Contains(got, "Shared project memory: waveterm") {
		t.Fatalf("missing label header:\n%s", got)
	}
	if !strings.Contains(got, "- wsh-not-on-path — non-interactive launch leaves wsh off PATH") {
		t.Fatalf("missing manifest line:\n%s", got)
	}
	if !strings.Contains(got, "- no-desc-note — First sentence.") {
		t.Fatalf("missing synthesized line:\n%s", got)
	}
	if strings.Contains(got, "long body") {
		t.Fatalf("manifest must not carry bodies:\n%s", got)
	}
	if !strings.Contains(got, dir) {
		t.Fatalf("manifest must name the directory holding the bodies:\n%s", got)
	}
}

// authored descriptions in this vault routinely run to a full paragraph; the manifest is only worth
// injecting if every fact stays one scannable line
func TestRenderManifestCapsAuthoredDescriptions(t *testing.T) {
	long := strings.Repeat("word ", 200)
	notes := []NoteWithBody{{Note: Note{ID: "verbose", Description: long}, Body: "body"}}
	got := renderManifestFrom("waveterm", t.TempDir(), notes)
	for _, line := range strings.Split(strings.TrimSpace(got), "\n") {
		if strings.HasPrefix(line, "- ") && len(line) > 260 {
			t.Fatalf("manifest line not capped, len=%d: %s", len(line), line)
		}
	}
	if strings.Count(got, "\n- ") > 1 {
		t.Fatalf("one fact must render as exactly one line:\n%s", got)
	}
}

func TestRenderManifestEmptyIsBlank(t *testing.T) {
	if got := renderManifestFrom("waveterm", t.TempDir(), nil); got != "" {
		t.Fatalf("empty note set must render blank, got %q", got)
	}
}

func TestRenderManifestEmptyCwd(t *testing.T) {
	if got := RenderManifest(""); got != "" {
		t.Fatalf("empty cwd must render blank, got %q", got)
	}
}

func TestRemoveSteeringRegion(t *testing.T) {
	// the region and the blank line separating it from the user's text both go
	existing := "# My steering\n\nDo the thing.\n\n<!-- ARC-MEMORY:BEGIN project=krypton (generated -->\nfacts\n<!-- ARC-MEMORY:END -->\n"
	out, removed := removeSteeringRegion(existing)
	if !removed {
		t.Fatal("region present but not reported removed")
	}
	if out != "# My steering\n\nDo the thing.\n" {
		t.Fatalf("user content not preserved:\n%q", out)
	}

	// content AFTER the region survives, separated by exactly one blank line
	withTail := "# Head\n\n<!-- ARC-MEMORY:BEGIN project=k (generated -->\nfacts\n<!-- ARC-MEMORY:END -->\n\n# Tail\n"
	out, removed = removeSteeringRegion(withTail)
	if !removed || out != "# Head\n\n# Tail\n" {
		t.Fatalf("tail not rejoined: removed=%v out=%q", removed, out)
	}

	// CRLF (what these files actually are on Windows): the blank line must not survive as a stray CR
	crlf := "# Head\r\n\r\n<!-- ARC-MEMORY:BEGIN project=k (generated -->\r\nfacts\r\n<!-- ARC-MEMORY:END -->\r\n"
	out, removed = removeSteeringRegion(crlf)
	if !removed || out != "# Head\r\n" {
		t.Fatalf("CRLF region left residue: removed=%v out=%q", removed, out)
	}

	// no region -> byte-identical, and reported as such
	plain := "# Just mine\n"
	out, removed = removeSteeringRegion(plain)
	if removed || out != plain {
		t.Fatalf("no-op case altered the file: removed=%v out=%q", removed, out)
	}
}

func TestPruneOrphanRegionsSkipsLiveTargets(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	region := "<!-- ARC-MEMORY:BEGIN project=krypton (generated -->\nfacts\n<!-- ARC-MEMORY:END -->\n"
	write := func(path string) string {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("# mine\n\n"+region), 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}
	codex := write(filepath.Join(home, ".codex", "AGENTS.md"))
	pi := write(filepath.Join(home, ".pi", "agent", "AGENTS.md"))

	// codex's steering file IS a target; pi's target is the per-project file, so its AGENTS.md is not
	pruneOrphanRegions([]steeringTarget{
		{runtime: "codex", path: codex},
		{runtime: "pi", path: filepath.Join(home, ".pi", "agent", "memory", "projects", "krypton.md")},
	})

	if got, _ := os.ReadFile(codex); !strings.Contains(string(got), "ARC-MEMORY:BEGIN") {
		t.Fatalf("stripped a live target's region:\n%s", got)
	}
	got, err := os.ReadFile(pi)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(got), "ARC-MEMORY") {
		t.Fatalf("orphan region survived the prune:\n%s", got)
	}
	if string(got) != "# mine\n" {
		t.Fatalf("prune damaged the user's own text: %q", got)
	}
}
