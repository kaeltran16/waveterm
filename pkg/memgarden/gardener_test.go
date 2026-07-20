package memgarden

import (
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/memvault"
)

func TestGardenProjectDeterministic(t *testing.T) {
	now := time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)
	oldCap := now.AddDate(0, 0, -40).Format(time.RFC3339)

	var archived, flagged []string
	g := newGardener()
	g.now = func() time.Time { return now }
	g.hubNotesFn = func(hub string) []memvault.NoteWithBody {
		return []memvault.NoteWithBody{
			{Note: memvault.Note{ID: "m-dead", Path: "/h/m-dead.md", Source: "agent", CapturedAt: oldCap}},
			{Note: memvault.Note{ID: "h-old", Path: "/h/h-old.md", Source: "claude", CapturedAt: oldCap}},
			{Note: memvault.Note{ID: "ref-dead", Path: "/h/ref-dead.md", Source: "agent", CapturedAt: oldCap}, Body: "about gone.go only"},
		}
	}
	g.repoPathFn = func(hub string) string { return "/repo" }
	g.repoIndexFn = func(repo string) map[string]bool { return map[string]bool{} }
	g.archiveFn = func(path, reason string, _ time.Time) (string, error) {
		archived = append(archived, path+":"+reason)
		return path, nil
	}
	g.flagFn = func(path, reason string) error {
		flagged = append(flagged, path+":"+reason)
		return nil
	}
	g.llmFn = func(string, string, string) (string, bool) { return "", false } // keep LLM pillars inert here

	g.gardenProject("/h")

	if len(archived) != 2 { // m-dead + ref-dead (both machine+old) archived by decay
		t.Fatalf("want 2 archives, got %v", archived)
	}
	if len(flagged) != 1 || flagged[0] != "/h/h-old.md:stale" {
		t.Fatalf("want 1 stale flag, got %v", flagged)
	}
}

func TestGardenProjectRespectsArchiveCap(t *testing.T) {
	now := time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)
	oldCap := now.AddDate(0, 0, -40).Format(time.RFC3339)
	g := newGardener()
	g.now = func() time.Time { return now }
	g.maxArchives = 2
	g.repoPathFn = func(string) string { return "" }
	g.repoIndexFn = func(string) map[string]bool { return map[string]bool{} }
	var n int
	g.archiveFn = func(path, reason string, _ time.Time) (string, error) { n++; return path, nil }
	g.flagFn = func(string, string) error { return nil }
	g.llmFn = func(string, string, string) (string, bool) { return "", false } // keep LLM pillars inert here
	g.hubNotesFn = func(string) []memvault.NoteWithBody {
		var out []memvault.NoteWithBody
		for i := 0; i < 5; i++ {
			out = append(out, memvault.NoteWithBody{Note: memvault.Note{ID: "x", Path: "/h/x.md", Source: "agent", CapturedAt: oldCap}})
		}
		return out
	}
	g.gardenProject("/h")
	if n != 2 {
		t.Fatalf("archive cap not respected: archived %d, want 2", n)
	}
}

func TestSweepSingleFlight(t *testing.T) {
	g := newGardener()
	release := make(chan struct{})
	started := make(chan struct{}, 4)
	g.hubDirsFn = func() []string { return []string{"/h"} }
	g.gardenFn = func(hub string) {
		started <- struct{}{}
		<-release
	}
	g.sweep()
	g.sweep() // /h already inflight -> must not launch again
	<-started
	select {
	case <-started:
		close(release)
		t.Fatalf("single-flight violated: /h gardened twice concurrently")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
}

var _ = sync.Mutex{}
