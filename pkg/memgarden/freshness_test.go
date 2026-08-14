package memgarden

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/memvault"
)

func TestExtractRefs(t *testing.T) {
	body := "See `prune.go:25` and frontend/app/store/wshclientapi.ts plus a plain word and Foo.md."
	got := extractRefs(body)
	want := map[string]bool{"prune.go": true, "frontend/app/store/wshclientapi.ts": true, "Foo.md": true}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for _, g := range got {
		if !want[g] {
			t.Fatalf("unexpected ref %q in %v", g, got)
		}
	}
}

func TestAllRefsDead(t *testing.T) {
	index := map[string]bool{"prune.go": true, "a/b.ts": true}
	if allRefsDead(nil, index) {
		t.Fatalf("no refs -> not dead")
	}
	if allRefsDead([]string{"prune.go"}, index) {
		t.Fatalf("live ref -> not dead")
	}
	if !allRefsDead([]string{"gone.go", "also/gone.ts"}, index) {
		t.Fatalf("all-absent refs -> dead")
	}
	if allRefsDead([]string{"gone.go", "prune.go"}, index) {
		t.Fatalf("mixed -> not all dead")
	}
}

func TestBuildRepoIndex(t *testing.T) {
	repo := t.TempDir()
	_ = os.MkdirAll(filepath.Join(repo, "pkg"), 0o755)
	_ = os.WriteFile(filepath.Join(repo, "pkg", "x.go"), []byte("x"), 0o644)
	_ = os.MkdirAll(filepath.Join(repo, "node_modules", "y"), 0o755)
	_ = os.WriteFile(filepath.Join(repo, "node_modules", "y", "z.go"), []byte("z"), 0o644)
	idx := buildRepoIndex(repo)
	if !idx["x.go"] || !idx["pkg/x.go"] {
		t.Fatalf("expected x.go indexed by basename + rel path: %v", idx)
	}
	if idx["z.go"] {
		t.Fatalf("node_modules should be skipped")
	}
}

func TestParseDriftVerdict(t *testing.T) {
	if d, _ := parseDriftVerdict(`noise {"drift": true, "reason": "flag renamed"} trailing`); !d {
		t.Fatalf("should parse drift=true")
	}
	if d, _ := parseDriftVerdict(`{"drift": false, "reason": ""}`); d {
		t.Fatalf("should parse drift=false")
	}
	if d, _ := parseDriftVerdict(`not json`); d {
		t.Fatalf("unparseable -> drift=false (fail-safe)")
	}
}

func TestCheckSoftDriftFlagsAndGates(t *testing.T) {
	repo := t.TempDir()
	if err := os.WriteFile(filepath.Join(repo, "live.go"), []byte("package x"), 0o644); err != nil {
		t.Fatal(err)
	}

	var calls, flags int
	g := testGardener(nil)
	g.llmFn = func(model, prompt, corpus string) (string, bool) {
		calls++
		return `{"drift": true, "reason": "advice contradicts live.go"}`, true
	}
	g.flagFn = func(path, reason string) error {
		if reason == "drift" {
			flags++
		}
		return nil
	}
	notes := []memvault.NoteWithBody{
		{Note: memvault.Note{ID: "n1", Path: "/h/n1.md", Source: "agent"}, Body: "always call live.go the old way"},
		{Note: memvault.Note{ID: "flagged", Path: "/h/f.md", Source: "agent", GardenerFlag: "drift"}, Body: "live.go"}, // already flagged -> skip
		{Note: memvault.Note{ID: "norefs", Path: "/h/nr.md", Source: "agent"}, Body: "no path refs here"},              // no refs -> skip
	}
	g.checkSoftDrift(repo, notes)
	if calls != 1 || flags != 1 {
		t.Fatalf("want 1 llm call + 1 flag, got calls=%d flags=%d", calls, flags)
	}
	// second pass, files unchanged -> mtime gate skips n1 entirely
	g.checkSoftDrift(repo, notes)
	if calls != 1 {
		t.Fatalf("mtime gate failed: expected no new llm calls, got %d", calls)
	}
}

func TestCheckSoftDriftPersistsAcrossRestart(t *testing.T) {
	// the ref-mtime gate must survive a server restart, or every app start re-checks every ref'd
	// note and pays the LLM cost again (the in-memory gate did exactly that pre-2026-08-14).
	repo := t.TempDir()
	if err := os.WriteFile(filepath.Join(repo, "live.go"), []byte("package x"), 0o644); err != nil {
		t.Fatal(err)
	}
	st := &gardenState{DedupFP: map[string]string{}, DriftFP: map[string]string{}, LastLLMSweep: map[string]string{}}
	notes := []memvault.NoteWithBody{
		{Note: memvault.Note{ID: "n1", Path: "/h/n1.md", Source: "agent"}, Body: "always call live.go the old way"},
	}
	mkGardener := func() (*gardener, *int) {
		calls := 0
		g := testGardener(st)
		g.llmFn = func(model, prompt, corpus string) (string, bool) {
			calls++
			return `{"drift": true}`, true
		}
		g.flagFn = func(path, reason string) error { return nil }
		return g, &calls
	}
	g1, calls1 := mkGardener()
	g1.checkSoftDrift(repo, notes)
	if *calls1 != 1 {
		t.Fatalf("first run must check the note, got %d calls", *calls1)
	}
	g2, calls2 := mkGardener() // restart: fresh in-memory state, same persisted state
	g2.checkSoftDrift(repo, notes)
	if *calls2 != 0 {
		t.Fatalf("restart re-checked unchanged notes: %d LLM calls", *calls2)
	}
	// a referenced file change after the restart does re-check
	if err := os.WriteFile(filepath.Join(repo, "live.go"), []byte("package y"), 0o644); err != nil {
		t.Fatal(err)
	}
	g3, calls3 := mkGardener()
	g3.checkSoftDrift(repo, notes)
	if *calls3 == 0 {
		t.Fatalf("referenced file change must re-arm the drift check")
	}
}
