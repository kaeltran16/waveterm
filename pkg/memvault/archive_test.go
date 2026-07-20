package memvault

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeHubNote(t *testing.T, hub, slug, source, hash string) string {
	t.Helper()
	p := filepath.Join(hub, slug+".md")
	body := "---\nname: " + slug + "\ndescription: \"d\"\nmetadata:\n  type: reference\n  source: " + source + "\n  source_hash: " + hash + "\n---\n\n# " + slug + "\n\nbody\n"
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestArchiveRestoreRoundTrip(t *testing.T) {
	t.Setenv("HOME", t.TempDir())              // unix
	t.Setenv("USERPROFILE", os.Getenv("HOME")) // windows
	hub := t.TempDir()
	notePath := writeHubNote(t, hub, "dead-note", "agent", "abc123")
	now := time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)

	arcPath, err := Archive(notePath, "decay", now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(notePath); !os.IsNotExist(err) {
		t.Fatalf("note should have left the hub")
	}
	data, _ := os.ReadFile(arcPath)
	s := string(data)
	if !strings.Contains(s, "archived_reason: decay") || !strings.Contains(s, "archived_from:") || !strings.Contains(s, "source_hash: abc123") {
		t.Fatalf("archive frontmatter missing fields:\n%s", s)
	}
	if got := archivedHashes(); !got["abc123"] {
		t.Fatalf("archived hash not indexed: %v", got)
	}
	list := ListArchived()
	if len(list) != 1 || list[0].ID != "dead-note" || list[0].Reason != "decay" {
		t.Fatalf("ListArchived wrong: %+v", list)
	}

	restored, err := Restore(arcPath)
	if err != nil {
		t.Fatal(err)
	}
	if restored != filepath.Join(hub, "dead-note.md") {
		t.Fatalf("restored to wrong path: %s", restored)
	}
	if _, err := os.Stat(arcPath); !os.IsNotExist(err) {
		t.Fatalf("archive file should be gone after restore")
	}
	rdata, _ := os.ReadFile(restored)
	if strings.Contains(string(rdata), "archived_") {
		t.Fatalf("restored note should have archive fields stripped:\n%s", rdata)
	}
}

func TestWriteLearningSkipsArchivedHash(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	hub := t.TempDir()

	c := LearnCandidate{Type: "learning", Body: "avoid the tsc stack overflow gotcha", IsCorrection: true}
	wrote, slug, err := WriteLearning(hub, c)
	if err != nil || !wrote {
		t.Fatalf("first write should succeed: wrote=%v err=%v", wrote, err)
	}
	// archive it, then try to re-learn the identical fact — must be suppressed.
	if _, err := Archive(filepath.Join(hub, slug+".md"), "decay", time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	wrote2, _, err := WriteLearning(hub, c)
	if err != nil {
		t.Fatal(err)
	}
	if wrote2 {
		t.Fatalf("re-learning an archived fact must be suppressed")
	}
}
