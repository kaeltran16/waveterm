package memgarden

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/memvault"
)

func TestGardenProjectDeterministic(t *testing.T) {
	now := time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)
	oldCap := now.AddDate(0, 0, -40).Format(time.RFC3339)

	var archived, flagged []string
	g := testGardener(nil)
	g.now = func() time.Time { return now }
	g.repoPathFn = func(scope string) string { return "/repo" }
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

	g.gardenScope("proj", []memvault.NoteWithBody{
		{Note: memvault.Note{ID: "m-dead", Path: "/h/m-dead.md", Source: "agent", CapturedAt: oldCap}},
		{Note: memvault.Note{ID: "h-old", Path: "/h/h-old.md", Source: "vault", CapturedAt: oldCap}},
		{Note: memvault.Note{ID: "ref-dead", Path: "/h/ref-dead.md", Source: "agent", CapturedAt: oldCap}, Body: "about gone.go only"},
	})

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
	g := testGardener(nil)
	g.now = func() time.Time { return now }
	g.maxArchives = 2
	g.repoPathFn = func(string) string { return "" }
	g.repoIndexFn = func(string) map[string]bool { return map[string]bool{} }
	var n int
	g.archiveFn = func(path, reason string, _ time.Time) (string, error) { n++; return path, nil }
	g.flagFn = func(string, string) error { return nil }
	g.llmFn = func(string, string, string) (string, bool) { return "", false } // keep LLM pillars inert here
	var notes []memvault.NoteWithBody
	for i := 0; i < 5; i++ {
		notes = append(notes, memvault.NoteWithBody{Note: memvault.Note{ID: "x", Path: "/h/x.md", Source: "agent", CapturedAt: oldCap}})
	}
	g.gardenScope("proj", notes)
	if n != 2 {
		t.Fatalf("archive cap not respected: archived %d, want 2", n)
	}
}

func TestSweepSingleFlight(t *testing.T) {
	g := testGardener(nil)
	release := make(chan struct{})
	started := make(chan struct{}, 4)
	g.vaultNotesFn = func() []memvault.NoteWithBody {
		return []memvault.NoteWithBody{{Note: memvault.Note{ID: "n", Scope: "s"}}}
	}
	g.gardenFn = func(scope string, notes []memvault.NoteWithBody) {
		started <- struct{}{}
		<-release
	}
	g.sweep()
	g.sweep() // scope already inflight -> must not launch again
	<-started
	select {
	case <-started:
		close(release)
		t.Fatalf("single-flight violated: scope gardened twice concurrently")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
}

func TestGardenExpiresOldLLMFlags(t *testing.T) {
	now := time.Date(2026, 8, 14, 0, 0, 0, 0, time.UTC)
	dir := t.TempDir()
	write := func(name string, mtime time.Time) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatalf("setup: %v", err)
		}
		if err := os.Chtimes(p, mtime, mtime); err != nil {
			t.Fatalf("setup: %v", err)
		}
		return p
	}
	var cleared []string
	g := testGardener(nil)
	g.now = func() time.Time { return now }
	g.flagExpireDays = 14
	g.clearFlagFn = func(path string) error {
		cleared = append(cleared, path)
		return nil
	}
	// old drift flag (15d), fresh duplicate flag (1d), old deterministic stale flag (15d, exempt)
	old := now.AddDate(0, 0, -15)
	notes := []memvault.NoteWithBody{
		{Note: memvault.Note{ID: "old-drift", Path: write("old-drift.md", old), GardenerFlag: "drift"}},
		{Note: memvault.Note{ID: "fresh-dup", Path: write("fresh-dup.md", now.AddDate(0, 0, -1)), GardenerFlag: "duplicate"}},
		{Note: memvault.Note{ID: "old-stale", Path: write("old-stale.md", old), GardenerFlag: "stale"}},
	}
	g.gardenScope("proj", notes)
	if len(cleared) != 1 || !strings.HasSuffix(cleared[0], "old-drift.md") {
		t.Fatalf("want only the old drift flag cleared, got %v", cleared)
	}
}

func TestLoadStateResetsOnVaultSwitch(t *testing.T) {
	st := &gardenState{
		VaultRoot:    "/old/vault/memory",
		DedupFP:      map[string]string{"proj": "stale-fp"},
		DriftFP:      map[string]string{"/h/n.md": "stale-fp"},
		LastLLMSweep: map[string]string{"proj": "2026-08-14T00:00:00Z"},
	}
	g := testGardener(st)
	g.vaultRootFn = func() string { return "/new/vault/memory" }
	got := g.loadState()
	if len(got.DedupFP) != 0 || len(got.DriftFP) != 0 || len(got.LastLLMSweep) != 0 {
		t.Fatalf("vault switch must reset per-scope state: %v", got)
	}
	if got.VaultRoot != "/new/vault/memory" {
		t.Fatalf("vault root not updated: %q", got.VaultRoot)
	}
}

func TestSaveStateSerialized(t *testing.T) {
	// two concurrent per-scope sweeps calling saveState must not run the full-file write at the
	// same time — unsynchronized os.WriteFile calls interleave into a corrupt file (observed
	// 2026-08-14: a dev app's own sweeps corrupted its state file).
	g := testGardener(nil)
	var mu sync.Mutex
	active, maxActive := 0, 0
	g.saveStateFn = func(*gardenState) error {
		mu.Lock()
		active++
		if active > maxActive {
			maxActive = active
		}
		mu.Unlock()
		time.Sleep(2 * time.Millisecond) // widen the race window
		mu.Lock()
		active--
		mu.Unlock()
		return nil
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			g.saveState()
		}()
	}
	wg.Wait()
	if maxActive > 1 {
		t.Fatalf("saveState ran concurrently (%d) — full-file writes can interleave", maxActive)
	}
}

var _ = sync.Mutex{}
