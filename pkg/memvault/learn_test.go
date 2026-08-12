package memvault

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteLearningWritesProvenance(t *testing.T) {
	dir := t.TempDir()
	wrote, slug, err := WriteLearning(dir, LearnCandidate{Type: "feedback", Scope: "myproj", Body: "prefer tabs over spaces"})
	if err != nil || !wrote {
		t.Fatalf("wrote=%v err=%v", wrote, err)
	}
	data, _ := os.ReadFile(filepath.Join(dir, slug+".md"))
	s := string(data)
	for _, want := range []string{"source: agent", "type: feedback", "scope: myproj", "reviewed: false", "source_hash: ", "captured_at: "} {
		if !strings.Contains(s, want) {
			t.Fatalf("missing %q in:\n%s", want, s)
		}
	}
}

func TestWriteLearningDedups(t *testing.T) {
	dir := t.TempDir()
	if _, _, err := WriteLearning(dir, LearnCandidate{Type: "feedback", Body: "same fact"}); err != nil {
		t.Fatal(err)
	}
	wrote, _, err := WriteLearning(dir, LearnCandidate{Type: "feedback", Body: "same   fact"}) // whitespace-normalized dup
	if err != nil {
		t.Fatal(err)
	}
	if wrote {
		t.Fatalf("expected dedup (wrote=false)")
	}
}

func TestMarkSupersededAndTouch(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, "old.md")
	os.WriteFile(old, []byte("---\nname: old\nmetadata:\n  type: project\n---\n\nold body\n"), 0o644)
	if err := MarkSuperseded(dir, "old", "new-slug"); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(old)
	if !strings.Contains(string(data), "superseded_by: new-slug") {
		t.Fatalf("no superseded_by:\n%s", string(data))
	}
	if err := TouchReferenced(dir, []string{"old"}, "2026-07-10T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(old)
	if !strings.Contains(string(data), `last_referenced: "2026-07-10T00:00:00Z"`) {
		t.Fatalf("no last_referenced:\n%s", string(data))
	}
	if !strings.Contains(string(data), "old body") {
		t.Fatalf("body dropped:\n%s", string(data))
	}
}

func TestRouteLearningsTargetsVault(t *testing.T) {
	isolateHome(t)
	vaultDir := t.TempDir()
	orig := DefaultVaultPath
	DefaultVaultPath = func() string { return vaultDir }
	defer func() { DefaultVaultPath = orig }()
	res, err := RouteLearnings("C:\\proj\\x", []LearnCandidate{
		{Type: "learning", Scope: "x", Body: "always use pnpm here", IsCorrection: true},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Committed != 1 {
		t.Fatalf("Committed = %d, want 1", res.Committed)
	}
	entries, _ := os.ReadDir(vaultDir)
	if len(entries) != 1 || !strings.HasSuffix(entries[0].Name(), ".md") {
		t.Fatalf("vault dir = %v, want exactly one note file", entries)
	}
	data, _ := os.ReadFile(filepath.Join(vaultDir, entries[0].Name()))
	if !strings.Contains(string(data), "source_hash:") {
		t.Fatalf("note missing source_hash:\n%s", data)
	}
}
