package memvault

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

func TestTouchReferencedIncrementsAndPreservesMtime(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "n1.md")
	content := "---\nname: n1\nmetadata:\n  type: learning\n---\n\nbody\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	// a stable, clearly-in-the-past mtime so a bump is unmistakable
	base := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	if err := os.Chtimes(path, base, base); err != nil {
		t.Fatal(err)
	}

	if err := TouchReferenced(dir, []string{"n1"}, "2026-09-22T10:00:00Z"); err != nil {
		t.Fatalf("TouchReferenced: %v", err)
	}
	nw, err := ReadNote(path, "vault")
	if err != nil {
		t.Fatal(err)
	}
	if nw.Note.LastReferenced != "2026-09-22T10:00:00Z" {
		t.Fatalf("last_referenced = %q, want the stamped ts", nw.Note.LastReferenced)
	}
	if nw.Note.ReferenceCount != 1 {
		t.Fatalf("reference_count = %d, want 1", nw.Note.ReferenceCount)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !info.ModTime().UTC().Equal(base) {
		t.Fatalf("mtime = %v, want it preserved at %v (a recall is a read, not an edit)", info.ModTime().UTC(), base)
	}

	// second touch increments rather than resetting
	if err := TouchReferenced(dir, []string{"n1"}, "2026-09-23T10:00:00Z"); err != nil {
		t.Fatalf("second TouchReferenced: %v", err)
	}
	nw, err = ReadNote(path, "vault")
	if err != nil {
		t.Fatal(err)
	}
	if nw.Note.ReferenceCount != 2 {
		t.Fatalf("reference_count after second touch = %d, want 2", nw.Note.ReferenceCount)
	}
}

func TestTouchReferencedMissingNoteIsNotAnError(t *testing.T) {
	if err := TouchReferenced(t.TempDir(), []string{"absent"}, "2026-09-22T10:00:00Z"); err != nil {
		t.Fatalf("missing note must be fail-safe, got %v", err)
	}
}
