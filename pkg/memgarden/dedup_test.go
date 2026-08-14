package memgarden

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/memvault"
)

// testGardener returns a gardener with in-memory persisted state, so tests never touch the real
// state file and restart semantics can be simulated by sharing the state between two gardeners.
func testGardener(st *gardenState) *gardener {
	if st == nil {
		st = &gardenState{DedupFP: map[string]string{}, LastLLMSweep: map[string]string{}}
	}
	g := newGardener()
	g.loadStateFn = func() (*gardenState, error) { return st, nil }
	g.saveStateFn = func(*gardenState) error { return nil }
	return g
}

func TestParseClusters(t *testing.T) {
	got := parseClusters(`x {"clusters": [["a","b"], ["c","d","e"]]} y`)
	if len(got) != 2 || len(got[0]) != 2 || len(got[1]) != 3 {
		t.Fatalf("bad clusters: %v", got)
	}
	if len(parseClusters("nope")) != 0 {
		t.Fatalf("unparseable -> empty")
	}
}

func TestNoteSetFingerprintIgnoresFlagStamps(t *testing.T) {
	notes := []memvault.NoteWithBody{
		{Note: memvault.Note{ID: "a", Path: "/h/a.md"}, Body: "the tsc gotcha"},
		{Note: memvault.Note{ID: "b", Path: "/h/b.md"}, Body: "the tsc overflow gotcha"},
	}
	base := noteSetFingerprint(notes)
	// flag stamping rewrites only the frontmatter; the fingerprint must not move, or every flag
	// batch would re-arm the next dedup pass (the 2026-08-14 ratchet: 3 + 54 + 6 flags in a day).
	notes[0].Note.GardenerFlag = "duplicate"
	notes[0].Note.UpdatedTs = 999999
	if got := noteSetFingerprint(notes); got != base {
		t.Fatalf("flag stamp changed fingerprint: %s -> %s", base, got)
	}
	// a body edit must re-arm, so real duplicates created by an edit are still caught
	notes[0].Body = "the tsc overflow gotcha"
	if got := noteSetFingerprint(notes); got == base {
		t.Fatalf("body edit did not change fingerprint")
	}
	// a new note must re-arm, so dedup re-assesses after harvest/distill writes
	notes = append(notes, memvault.NoteWithBody{Note: memvault.Note{ID: "c", Path: "/h/c.md"}, Body: "unrelated"})
	if got := noteSetFingerprint(notes); got == base {
		t.Fatalf("new note did not change fingerprint")
	}
}

func TestSplitCluster(t *testing.T) {
	small := []string{"a", "b", "c"}
	got := splitCluster(small)
	if len(got) != 1 || len(got[0]) != 3 {
		t.Fatalf("small cluster must pass through whole: %v", got)
	}
	big := []string{"a", "b", "c", "d", "e", "f"}
	got = splitCluster(big)
	if len(got) != 2 {
		t.Fatalf("want 2 groups, got %v", got)
	}
	if len(got[0]) != 4 || len(got[1]) != 3 {
		t.Fatalf("bad group sizes: %v", got)
	}
	// every group is headed by the canonical note; members are not dropped
	for _, grp := range got {
		if grp[0] != "a" {
			t.Fatalf("group not headed by canonical note: %v", grp)
		}
	}
}

func TestCheckDedupFlagsNonCanonicalAndGates(t *testing.T) {
	notes := []memvault.NoteWithBody{
		{Note: memvault.Note{ID: "a", Path: "/h/a.md"}, Body: "the tsc gotcha"},
		{Note: memvault.Note{ID: "b", Path: "/h/b.md"}, Body: "the tsc overflow gotcha"},
		{Note: memvault.Note{ID: "c", Path: "/h/c.md"}, Body: "unrelated"},
	}
	var calls int
	flagged := map[string]bool{}
	g := testGardener(nil)
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
	notes := []memvault.NoteWithBody{
		{Note: memvault.Note{ID: "a", Path: "/h/a.md", GardenerFlag: "duplicate"}, Body: "the tsc gotcha"},
		{Note: memvault.Note{ID: "b", Path: "/h/b.md"}, Body: "the tsc overflow gotcha"},
		{Note: memvault.Note{ID: "c", Path: "/h/c.md"}, Body: "unrelated"},
	}
	var corpus string
	flagged := map[string]bool{}
	g := testGardener(nil)
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
	notes := []memvault.NoteWithBody{
		{Note: memvault.Note{ID: "a", Path: "/h/a.md"}, Body: "the tsc stack-size gotcha"},
		{Note: memvault.Note{ID: "b", Path: "/h/b.md"}, Body: "the tsc stack-size gotcha"},
		{Note: memvault.Note{ID: "c", Path: "/h/c.md"}, Body: "unrelated note"},
	}
	verifies := 0
	flagged := map[string]bool{}
	g := testGardener(nil)
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
	notes := []memvault.NoteWithBody{
		{Note: memvault.Note{ID: "a", Path: "/h/a.md"}, Body: "one"},
		{Note: memvault.Note{ID: "b", Path: "/h/b.md"}, Body: "two"},
	}
	flagged := map[string]bool{}
	g := testGardener(nil)
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

func TestCheckDedupCapsFlagsPerPassAndChunksVerify(t *testing.T) {
	notes := make([]memvault.NoteWithBody, 0, 9)
	for _, id := range []string{"a", "b", "c", "d", "e", "f", "g", "h", "i"} {
		notes = append(notes, memvault.NoteWithBody{Note: memvault.Note{ID: id, Path: "/h/" + id + ".md"}, Body: "duplicate-sounding note " + id})
	}
	verifySizes := []int{}
	flagged := map[string]bool{}
	g := testGardener(nil)
	g.llmFn = func(model, prompt, corpus string) (string, bool) {
		if strings.Contains(prompt, `"clusters"`) {
			return `{"clusters": [["a","b","c","d","e","f","g","h","i"]]}`, true
		}
		verifySizes = append(verifySizes, strings.Count(corpus, "--- NOTE:"))
		return `{"same": true}`, true
	}
	g.flagFn = func(path, reason string) error {
		flagged[path] = true
		return nil
	}
	g.checkDedup("/h", notes)
	if len(flagged) > maxFlagsPerDedupPass {
		t.Fatalf("flag cap violated: %d flags in one pass", len(flagged))
	}
	if flagged["/h/a.md"] {
		t.Fatalf("canonical note must not be flagged")
	}
	if len(verifySizes) == 0 {
		t.Fatalf("no verification calls")
	}
	for _, size := range verifySizes {
		if size > maxVerifyGroup {
			t.Fatalf("verification corpus exceeds %d members: %d", maxVerifyGroup, size)
		}
	}
	if len(flagged) != maxFlagsPerDedupPass {
		t.Fatalf("want exactly %d flags (cap), got %d", maxFlagsPerDedupPass, len(flagged))
	}
}

func TestCheckDedupPersistsAcrossRestart(t *testing.T) {
	// shared state simulates the persisted file: a server restart constructs a fresh gardener, and
	// the fingerprint must survive it — otherwise every restart re-flags (the 2026-08-14 pattern).
	st := &gardenState{DedupFP: map[string]string{}, LastLLMSweep: map[string]string{}}
	notes := []memvault.NoteWithBody{
		{Note: memvault.Note{ID: "a", Path: "/h/a.md"}, Body: "the tsc gotcha"},
		{Note: memvault.Note{ID: "b", Path: "/h/b.md"}, Body: "the tsc overflow gotcha"},
	}
	mkGardener := func() (*gardener, *int) {
		calls := 0
		g := testGardener(st)
		g.llmFn = func(model, prompt, corpus string) (string, bool) {
			calls++
			if strings.Contains(prompt, `"clusters"`) {
				return `{"clusters": [["a","b"]]}`, true
			}
			return `{"same": true}`, true
		}
		g.flagFn = func(path, reason string) error { return nil }
		return g, &calls
	}
	g1, calls1 := mkGardener()
	g1.checkDedup("/h", notes)
	if *calls1 != 2 {
		t.Fatalf("first run must cluster + verify, got %d calls", *calls1)
	}
	g2, calls2 := mkGardener() // restart: fresh in-memory state, same persisted state
	g2.checkDedup("/h", notes)
	if *calls2 != 0 {
		t.Fatalf("restart re-armed dedup: %d LLM calls on unchanged notes", *calls2)
	}
	// a new note after the restart does re-arm
	notes = append(notes, memvault.NoteWithBody{Note: memvault.Note{ID: "c", Path: "/h/c.md"}, Body: "the tsc stack-size gotcha"})
	g3, calls3 := mkGardener()
	g3.checkDedup("/h", notes)
	if *calls3 == 0 {
		t.Fatalf("new note must re-arm dedup")
	}
}
