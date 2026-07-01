// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memvault

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sampleMemoryMD = "# Task Group: auth boundary\n" +
	"scope: use for auth\n" +
	"applies_to: cwd=C:\\Users\\k\\IdeaProjects\\krypton; reuse_rule=safe\n" +
	"\n" +
	"## Task 1: do the thing, outcome success\n" +
	"### keywords\n- JWT\n" +
	"\n" +
	"## User preferences\n- when the user said X -> do Y [Task 1]\n" +
	"\n" +
	"## Reusable knowledge\n" +
	"- `src/main.py` is the auth-wiring seam [Task 1][Task 2]\n" +
	"- python-jose is required in the container\n" +
	"\n" +
	"## Failures and how to do differently\n- retried too late\n" +
	"\n" +
	"# Task Group: other project\n" +
	"applies_to: cwd=C:\\Users\\k\\IdeaProjects\\other; reuse_rule=safe\n" +
	"\n" +
	"## Reusable knowledge\n- unrelated fact for other\n"

func TestNormalizeCwd(t *testing.T) {
	cases := map[string]string{
		`\\?\C:\Users\k\krypton`: "c:/users/k/krypton",
		`C:\Users\k\krypton\`:    "c:/users/k/krypton",
		`/home/k/code/foo/`:      "/home/k/code/foo",
	}
	for in, want := range cases {
		if got := normalizeCwd(in); got != want {
			t.Fatalf("normalizeCwd(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestExtractCwd(t *testing.T) {
	line := `applies_to: cwd=C:\Users\k\krypton; reuse_rule=safe`
	if got := extractCwd(line); got != `C:\Users\k\krypton` {
		t.Fatalf("extractCwd = %q", got)
	}
	if got := extractCwd("scope: no cwd here"); got != "" {
		t.Fatalf("extractCwd(no cwd) = %q, want empty", got)
	}
}

func TestCleanBullet(t *testing.T) {
	if got := cleanBullet("- a fact [Task 1][Task 2]"); got != "a fact" {
		t.Fatalf("cleanBullet = %q", got)
	}
	if got := cleanBullet("-   spaced fact  "); got != "spaced fact" {
		t.Fatalf("cleanBullet spaced = %q", got)
	}
}

func TestParseCodexReusable(t *testing.T) {
	got := parseCodexReusable(sampleMemoryMD, `C:\Users\k\IdeaProjects\krypton`)
	want := []string{"`src/main.py` is the auth-wiring seam", "python-jose is required in the container"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("parseCodexReusable = %#v, want %#v", got, want)
	}
	// non-matching cwd -> no bullets
	if g := parseCodexReusable(sampleMemoryMD, `C:\Users\k\IdeaProjects\nope`); len(g) != 0 {
		t.Fatalf("expected no bullets for unmatched cwd, got %#v", g)
	}
	// the OTHER project's cwd -> only its bullet, never krypton's
	other := parseCodexReusable(sampleMemoryMD, `C:\Users\k\IdeaProjects\other`)
	if len(other) != 1 || other[0] != "unrelated fact for other" {
		t.Fatalf("other cwd bullets = %#v", other)
	}
}

func TestFactHash(t *testing.T) {
	// whitespace-normalized: differing internal spacing hashes the same
	a := factHash("use   postgres  not sqlite")
	b := factHash("use postgres not sqlite")
	if a != b {
		t.Fatalf("whitespace should normalize: %s != %s", a, b)
	}
	if factHash("different fact") == a {
		t.Fatalf("distinct content must hash differently")
	}
	if len(a) != 64 {
		t.Fatalf("sha256 hex length = %d, want 64", len(a))
	}
}

func TestHarvestSlug(t *testing.T) {
	slug := harvestSlug("`src/main.py` is the auth-wiring seam for the repo really", "abcdef0123456789")
	// first ~8 words slugified, plus an 8-char hash suffix
	if !strings.HasPrefix(slug, "src-main-py-is-the-auth-wiring-seam") {
		t.Fatalf("slug prefix wrong: %q", slug)
	}
	if !strings.HasSuffix(slug, "-abcdef01") {
		t.Fatalf("slug hash suffix wrong: %q", slug)
	}
	// empty bullet still yields a usable slug
	if s := harvestSlug("", "abcdef0123456789"); s != "codex-fact-abcdef01" {
		t.Fatalf("empty-bullet slug = %q", s)
	}
}

func TestHarvestIntoDedupes(t *testing.T) {
	tmp := t.TempDir()
	hub := filepath.Join(tmp, "hub")

	ing, skip, err := harvestInto(sampleMemoryMD, `C:\Users\k\IdeaProjects\krypton`, hub)
	if err != nil {
		t.Fatalf("harvestInto: %v", err)
	}
	if ing != 2 || skip != 0 {
		t.Fatalf("first harvest ingested=%d skipped=%d, want 2/0", ing, skip)
	}
	// two notes written, each with codex provenance the scanner can read back
	files, _ := os.ReadDir(hub)
	if len(files) != 2 {
		t.Fatalf("wrote %d files, want 2", len(files))
	}
	one := filepath.Join(hub, files[0].Name())
	data, _ := os.ReadFile(one)
	if !strings.Contains(string(data), "source: codex") || !strings.Contains(string(data), "source_hash:") {
		t.Fatalf("note missing provenance:\n%s", data)
	}
	n, _ := parseNote(one, data, "claude")
	if n.Source != "codex" {
		t.Fatalf("written note Source = %q, want codex", n.Source)
	}

	// second harvest of the same content ingests nothing (all hashes already present)
	ing2, skip2, err := harvestInto(sampleMemoryMD, `C:\Users\k\IdeaProjects\krypton`, hub)
	if err != nil {
		t.Fatalf("second harvestInto: %v", err)
	}
	if ing2 != 0 || skip2 != 2 {
		t.Fatalf("second harvest ingested=%d skipped=%d, want 0/2", ing2, skip2)
	}
}

func TestCodexMemoryPath(t *testing.T) {
	p := codexMemoryPath()
	if !strings.HasSuffix(filepath.ToSlash(p), ".codex/memories/MEMORY.md") {
		t.Fatalf("codexMemoryPath = %q", p)
	}
}

func TestHarvestEmptyCwd(t *testing.T) {
	if _, _, err := Harvest(""); err == nil {
		t.Fatalf("Harvest(\"\") must error")
	}
}
