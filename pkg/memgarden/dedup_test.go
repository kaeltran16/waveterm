package memgarden

import (
	"strings"
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
	g.llmFn = func(model, prompt, corpus string) (string, bool) {
		calls++
		if strings.Contains(prompt, `"clusters"`) {
			return `{"clusters": [["a","b"]]}`, true
		}
		return `{"same": true}`, true
	}
	g.flagFn = func(path, reason string) error {
		if reason == "duplicate" {
			flagged[path] = true
		}
		return nil
	}
	g.checkDedup("/h", notes)
	if calls != 2 { // one clustering call + one verification call
		t.Fatalf("want 2 dedup calls, got %d", calls)
	}
	if flagged["/h/a.md"] { // first in the cluster is canonical -> not flagged
		t.Fatalf("canonical note a should not be flagged")
	}
	if !flagged["/h/b.md"] {
		t.Fatalf("near-dup b should be flagged duplicate")
	}
	g.checkDedup("/h", notes) // note set unchanged -> gated
	if calls != 2 {
		t.Fatalf("dedup gate failed: got %d calls", calls)
	}
}

func TestCheckDedupSkipsFlaggedNotes(t *testing.T) {
	lastDedupCheck = map[string]string{}
	notes := []memvault.NoteWithBody{
		{Note: memvault.Note{ID: "a", Path: "/h/a.md", GardenerFlag: "duplicate"}, Body: "the tsc gotcha"},
		{Note: memvault.Note{ID: "b", Path: "/h/b.md"}, Body: "the tsc overflow gotcha"},
		{Note: memvault.Note{ID: "c", Path: "/h/c.md"}, Body: "unrelated"},
	}
	var corpus string
	flagged := map[string]bool{}
	g := newGardener()
	g.llmFn = func(model, prompt, c string) (string, bool) {
		if strings.Contains(prompt, `"clusters"`) {
			corpus = c
			return `{"clusters": [["a","b"]]}`, true
		}
		return `{"same": true}`, true
	}
	g.flagFn = func(path, reason string) error {
		flagged[path] = true
		return nil
	}
	g.checkDedup("/h", notes)
	if strings.Contains(corpus, "a:") {
		t.Fatalf("already-flagged note a must be excluded from the corpus")
	}
	if !strings.Contains(corpus, "b:") || !strings.Contains(corpus, "c:") {
		t.Fatalf("live notes must stay in the corpus: %q", corpus)
	}
	if flagged["/h/b.md"] {
		t.Fatalf("b must not be flagged: its only cluster partner a is already flagged")
	}
}

func TestCheckDedupVerifiesBeforeFlagging(t *testing.T) {
	lastDedupCheck = map[string]string{}
	notes := []memvault.NoteWithBody{
		{Note: memvault.Note{ID: "a", Path: "/h/a.md"}, Body: "the tsc stack-size gotcha"},
		{Note: memvault.Note{ID: "b", Path: "/h/b.md"}, Body: "the tsc stack-size gotcha"},
		{Note: memvault.Note{ID: "c", Path: "/h/c.md"}, Body: "unrelated note"},
	}
	verifies := 0
	flagged := map[string]bool{}
	g := newGardener()
	g.llmFn = func(model, prompt, corpus string) (string, bool) {
		if strings.Contains(prompt, `"clusters"`) {
			return `{"clusters": [["a","b"],["a","c"]]}`, true
		}
		verifies++
		if strings.Contains(corpus, "unrelated note") {
			return `{"same": false}`, true
		}
		return `{"same": true}`, true
	}
	g.flagFn = func(path, reason string) error {
		flagged[path] = true
		return nil
	}
	g.checkDedup("/h", notes)
	if verifies != 2 {
		t.Fatalf("want 2 verification calls, got %d", verifies)
	}
	if !flagged["/h/b.md"] {
		t.Fatalf("verified duplicate b should be flagged")
	}
	if flagged["/h/c.md"] {
		t.Fatalf("cluster rejected by verification must not flag c")
	}
}

func TestCheckDedupVerifyFailureDropsCluster(t *testing.T) {
	lastDedupCheck = map[string]string{}
	notes := []memvault.NoteWithBody{
		{Note: memvault.Note{ID: "a", Path: "/h/a.md"}, Body: "one"},
		{Note: memvault.Note{ID: "b", Path: "/h/b.md"}, Body: "two"},
	}
	flagged := map[string]bool{}
	g := newGardener()
	g.llmFn = func(model, prompt, corpus string) (string, bool) {
		if strings.Contains(prompt, `"clusters"`) {
			return `{"clusters": [["a","b"]]}`, true
		}
		return "", false // verification LLM failed
	}
	g.flagFn = func(path, reason string) error {
		flagged[path] = true
		return nil
	}
	g.checkDedup("/h", notes)
	if len(flagged) != 0 {
		t.Fatalf("unverifiable cluster must not flag anything: %v", flagged)
	}
}
