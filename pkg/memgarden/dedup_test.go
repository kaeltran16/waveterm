package memgarden

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/memvault"
)

func TestParseClusters(t *testing.T) {
	got := parseClusters(`x {"clusters": [["a","b"], ["c","d","e"]]} y`)
	if len(got) != 2 || len(got[0]) != 2 || len(got[1]) != 3 {
		t.Fatalf("bad clusters: %v", got)
	}
	if len(parseClusters("nope")) != 0 {
		t.Fatalf("unparseable -> empty")
	}
}

func TestCheckDedupFlagsNonCanonicalAndGates(t *testing.T) {
	lastDedupCheck = map[string]string{}
	notes := []memvault.NoteWithBody{
		{Note: memvault.Note{ID: "a", Path: "/h/a.md"}, Body: "the tsc gotcha"},
		{Note: memvault.Note{ID: "b", Path: "/h/b.md"}, Body: "the tsc overflow gotcha"},
		{Note: memvault.Note{ID: "c", Path: "/h/c.md"}, Body: "unrelated"},
	}
	var calls int
	flagged := map[string]bool{}
	g := newGardener()
	g.hubNotesFn = func(string) []memvault.NoteWithBody { return notes }
	g.llmFn = func(model, prompt, corpus string) (string, bool) {
		calls++
		return `{"clusters": [["a","b"]]}`, true
	}
	g.flagFn = func(path, reason string) error {
		if reason == "duplicate" {
			flagged[path] = true
		}
		return nil
	}
	g.checkDedup("/h", notes)
	if calls != 1 {
		t.Fatalf("want 1 dedup call, got %d", calls)
	}
	if flagged["/h/a.md"] { // first in the cluster is canonical -> not flagged
		t.Fatalf("canonical note a should not be flagged")
	}
	if !flagged["/h/b.md"] {
		t.Fatalf("near-dup b should be flagged duplicate")
	}
	g.checkDedup("/h", notes) // note set unchanged -> gated
	if calls != 1 {
		t.Fatalf("dedup gate failed: got %d calls", calls)
	}
}
