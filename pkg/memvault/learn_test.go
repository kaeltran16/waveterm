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
