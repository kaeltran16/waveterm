package usagestats

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestExtractClaude(t *testing.T) {
	line := `{"type":"assistant","timestamp":"2026-06-26T10:00:00.000Z","requestId":"req_1","message":{"id":"msg_1","model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":1000,"cache_creation_input_tokens":200,"cache_creation":{"ephemeral_1h_input_tokens":150}}}}`
	got := extractClaude([]string{line})
	if len(got) != 1 {
		t.Fatalf("want 1 record, got %d", len(got))
	}
	r := got[0]
	if r.Provider != "claude" || r.Model != "claude-opus-4-8" {
		t.Errorf("provider/model = %q/%q", r.Provider, r.Model)
	}
	if r.Input != 100 || r.Output != 50 || r.CacheRead != 1000 || r.CacheCreate != 200 || r.CacheCreate1h != 150 {
		t.Errorf("tokens = %+v", r)
	}
	if r.ID != "msg_1:req_1" {
		t.Errorf("id = %q", r.ID)
	}
	if !r.TS.Equal(time.Date(2026, 6, 26, 10, 0, 0, 0, time.UTC)) {
		t.Errorf("ts = %v", r.TS)
	}
}

func TestExtractClaudeSkips(t *testing.T) {
	cases := []string{
		`{"type":"user","message":{}}`,                             // non-assistant
		`{not json`,                                                // malformed
		`{"type":"assistant","message":{"model":"claude-opus-4"}}`, // no usage/timestamp
	}
	if got := extractClaude(cases); len(got) != 0 {
		t.Fatalf("want 0, got %d", len(got))
	}
}

func TestExtractClaudeNoDedupKeyWhenMissing(t *testing.T) {
	line := `{"type":"assistant","timestamp":"2026-06-26T10:00:00.000Z","message":{"id":"msg_1","model":"claude-opus-4","usage":{"output_tokens":5}}}`
	got := extractClaude([]string{line})
	if got[0].ID != "" {
		t.Errorf("want empty id, got %q", got[0].ID)
	}
}

func TestExtractCodex(t *testing.T) {
	turn := `{"timestamp":"2026-06-26T03:07:50.000Z","type":"turn_context","payload":{"model":"gpt-5.5"}}`
	count := `{"timestamp":"2026-06-26T03:08:00.663Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":9458,"cached_input_tokens":7040,"output_tokens":89,"total_tokens":9547}}}}`
	got := extractCodex([]string{turn, count})
	if len(got) != 1 {
		t.Fatalf("want 1, got %d", len(got))
	}
	r := got[0]
	if r.Provider != "codex" || r.Model != "gpt-5.5" {
		t.Errorf("provider/model = %q/%q", r.Provider, r.Model)
	}
	if r.Input != 9458-7040 || r.CacheRead != 7040 || r.Output != 89 || r.CacheCreate != 0 {
		t.Errorf("tokens = %+v", r)
	}
	if total := r.Input + r.Output + r.CacheRead + r.CacheCreate; total != 9547 {
		t.Errorf("tokensOf = %d, want 9547", total)
	}
}

func TestExtractCodexMaxCumulative(t *testing.T) {
	turn := `{"type":"turn_context","payload":{"model":"gpt-5.5"}}`
	small := `{"timestamp":"2026-06-26T03:08:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":10,"total_tokens":110}}}}`
	big := `{"timestamp":"2026-06-26T03:20:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":5000,"cached_input_tokens":1000,"output_tokens":500,"total_tokens":5500}}}}`
	got := extractCodex([]string{turn, small, big})
	if len(got) != 1 {
		t.Fatalf("want 1, got %d", len(got))
	}
	if total := got[0].Input + got[0].Output + got[0].CacheRead; total != 5500 {
		t.Errorf("want total 5500, got %d", total)
	}
}

func TestExtractCodexFallbackModelAndJunk(t *testing.T) {
	count := `{"timestamp":"2026-06-26T03:08:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"output_tokens":1,"total_tokens":11}}}}`
	if got := extractCodex([]string{count}); got[0].Model != "codex" {
		t.Errorf("want fallback model codex, got %q", got[0].Model)
	}
	junk := []string{`{not json`, `{"type":"event_msg","payload":{"type":"token_count","info":null}}`, `{"type":"response_item","payload":{}}`}
	if got := extractCodex(junk); len(got) != 0 {
		t.Fatalf("want 0 from junk, got %d", len(got))
	}
}

func TestDedupe(t *testing.T) {
	mk := func(id string, out int) Record {
		return Record{ID: id, Provider: "claude", Model: "claude-opus-4", Input: 100, Output: out}
	}
	// same key -> keep max output
	got := dedupe([]Record{mk("k", 10), mk("k", 50), mk("k", 30)})
	if len(got) != 1 || got[0].Output != 50 {
		t.Fatalf("want 1 record out=50, got %+v", got)
	}
	// keyless records are all kept; distinct keys kept separate
	got = dedupe([]Record{mk("", 1), mk("", 2), mk("a", 1), mk("b", 1)})
	if len(got) != 4 {
		t.Fatalf("want 4, got %d", len(got))
	}
}

func TestBucketDropsSyntheticAndGroups(t *testing.T) {
	day := time.Date(2026, 6, 26, 10, 0, 0, 0, time.Local)
	recs := []Record{
		{Provider: "claude", Model: "claude-opus-4-8", TS: day, Input: 100, Output: 50},
		{Provider: "claude", Model: "claude-opus-4-8", TS: day, CacheRead: 10},
		{Provider: "claude", Model: "<synthetic>", TS: day, Output: 999},
	}
	got := bucket(recs)
	if len(got) != 1 {
		t.Fatalf("want 1 bucket (synthetic dropped, opus merged), got %d", len(got))
	}
	b := got[0]
	if b.Model != "claude-opus-4-8" || b.Input != 100 || b.Output != 50 || b.CacheRead != 10 || b.Msgs != 2 {
		t.Errorf("bucket = %+v", b)
	}
	if b.Day != day.Format("2006-01-02") {
		t.Errorf("day = %q", b.Day)
	}
}

func TestScanRootsPrunesByModtime(t *testing.T) {
	dir := t.TempDir()
	claude := filepath.Join(dir, "claude")
	proj := filepath.Join(claude, "proj")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	line := `{"type":"assistant","timestamp":"2026-06-26T10:00:00.000Z","message":{"id":"m","model":"claude-haiku-4-5","usage":{"input_tokens":7}}}`
	fresh := filepath.Join(proj, "fresh.jsonl")
	stale := filepath.Join(proj, "stale.jsonl")
	for _, p := range []string{fresh, stale} {
		if err := os.WriteFile(p, []byte(line+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().AddDate(0, 0, -30)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}
	// window 7d (+1d margin) => stale (30d old) pruned, fresh kept
	got := scanRoots(claude, filepath.Join(dir, "codex-missing"), 7)
	if len(got) != 1 || got[0].Model != "claude-haiku-4-5" {
		t.Fatalf("want 1 haiku bucket from fresh file only, got %+v", got)
	}
	// windowDays 0 => no prune => both files counted (2 msgs, same model/day bucket)
	all := scanRoots(claude, filepath.Join(dir, "codex-missing"), 0)
	if len(all) != 1 || all[0].Msgs != 2 {
		t.Fatalf("want 1 bucket msgs=2 with no prune, got %+v", all)
	}
}

func TestSumTranscript(t *testing.T) {
	dir := t.TempDir()

	// Claude file: two assistant lines, second is a streaming re-emit of the first
	// (same message.id + requestId) so dedupe must keep only the larger-output copy.
	claude := filepath.Join(dir, "claude.jsonl")
	lines := "" +
		`{"type":"assistant","timestamp":"2026-06-26T10:00:00.000Z","requestId":"r1","message":{"id":"m1","model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":10,"cache_read_input_tokens":1000,"cache_creation_input_tokens":200}}}` + "\n" +
		`{"type":"assistant","timestamp":"2026-06-26T10:00:01.000Z","requestId":"r1","message":{"id":"m1","model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":1000,"cache_creation_input_tokens":200}}}` + "\n"
	if err := os.WriteFile(claude, []byte(lines), 0o644); err != nil {
		t.Fatal(err)
	}
	// deduped to the output:50 copy → 100+50+1000+200 = 1350
	got, err := SumTranscript(claude)
	if err != nil || got != 1350 {
		t.Fatalf("claude sum = %d, err = %v; want 1350", got, err)
	}

	// Codex file: one token_count with a cumulative total; Input = input - cached.
	codex := filepath.Join(dir, "rollout-x.jsonl")
	codexLines := "" +
		`{"timestamp":"2026-06-26T03:07:50.000Z","type":"turn_context","payload":{"model":"gpt-5.5"}}` + "\n" +
		`{"timestamp":"2026-06-26T03:08:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":9458,"cached_input_tokens":7040,"output_tokens":89,"total_tokens":9547}}}}` + "\n"
	if err := os.WriteFile(codex, []byte(codexLines), 0o644); err != nil {
		t.Fatal(err)
	}
	// Input = 9458-7040 = 2418; Output = 89; CacheRead = 7040; CacheCreate = 0 → 9547
	gotCodex, err := SumTranscript(codex)
	if err != nil || gotCodex != 9547 {
		t.Fatalf("codex sum = %d, err = %v; want 9547", gotCodex, err)
	}

	// Missing/unreadable file → 0, no error.
	gotMissing, err := SumTranscript(filepath.Join(dir, "does-not-exist.jsonl"))
	if err != nil || gotMissing != 0 {
		t.Fatalf("missing sum = %d, err = %v; want 0", gotMissing, err)
	}
}

func TestTranscriptUsage(t *testing.T) {
	dir := t.TempDir()

	// Claude file: two models (opus + haiku), opus streamed twice on one id → dedupe keeps output:50.
	claude := filepath.Join(dir, "claude.jsonl")
	lines := "" +
		`{"type":"assistant","timestamp":"2026-06-26T10:00:00.000Z","requestId":"r1","message":{"id":"m1","model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":10,"cache_read_input_tokens":1000,"cache_creation_input_tokens":200}}}` + "\n" +
		`{"type":"assistant","timestamp":"2026-06-26T10:00:01.000Z","requestId":"r1","message":{"id":"m1","model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":1000,"cache_creation_input_tokens":200}}}` + "\n" +
		`{"type":"assistant","timestamp":"2026-06-26T10:01:00.000Z","requestId":"r2","message":{"id":"m2","model":"claude-haiku-4-5","usage":{"input_tokens":12,"output_tokens":2}}}` + "\n"
	if err := os.WriteFile(claude, []byte(lines), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := TranscriptUsage(claude)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 buckets (opus, haiku), got %d: %+v", len(got), got)
	}
	byModel := map[string]Bucket{}
	for _, b := range got {
		byModel[b.Model] = b
	}
	opus := byModel["claude-opus-4-8"]
	if opus.Input != 100 || opus.Output != 50 || opus.CacheRead != 1000 || opus.CacheCreate != 200 || opus.Msgs != 1 {
		t.Errorf("opus bucket = %+v", opus)
	}
	if h := byModel["claude-haiku-4-5"]; h.Input != 12 || h.Output != 2 {
		t.Errorf("haiku bucket = %+v", h)
	}

	// Codex rollout: one cumulative record, no cache-write class.
	codex := filepath.Join(dir, "rollout-x.jsonl")
	codexLines := "" +
		`{"timestamp":"2026-06-26T03:07:50.000Z","type":"turn_context","payload":{"model":"gpt-5.5"}}` + "\n" +
		`{"timestamp":"2026-06-26T03:08:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":9458,"cached_input_tokens":7040,"output_tokens":89,"total_tokens":9547}}}}` + "\n"
	if err := os.WriteFile(codex, []byte(codexLines), 0o644); err != nil {
		t.Fatal(err)
	}
	cg, err := TranscriptUsage(codex)
	if err != nil || len(cg) != 1 {
		t.Fatalf("codex buckets = %+v, err = %v; want 1", cg, err)
	}
	if cg[0].Provider != "codex" || cg[0].Input != 2418 || cg[0].CacheRead != 7040 || cg[0].Output != 89 || cg[0].CacheCreate != 0 {
		t.Errorf("codex bucket = %+v", cg[0])
	}

	// Missing/empty → nil, no error.
	if mg, err := TranscriptUsage(filepath.Join(dir, "nope.jsonl")); err != nil || mg != nil {
		t.Fatalf("missing = %+v, err = %v; want nil/nil", mg, err)
	}
}

func TestLastCacheWrite(t *testing.T) {
	dir := t.TempDir()

	// Two cache-writing assistant messages: an earlier one on the default (5m) bucket, a later
	// one on the extended 1h bucket. LastCacheWrite must report the later one.
	path := filepath.Join(dir, "claude.jsonl")
	lines := "" +
		`{"type":"assistant","timestamp":"2026-06-26T10:00:00.000Z","requestId":"r1","message":{"id":"m1","model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":200}}}` + "\n" +
		`{"type":"assistant","timestamp":"2026-06-26T10:05:00.000Z","requestId":"r2","message":{"id":"m2","model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":300,"cache_creation":{"ephemeral_1h_input_tokens":300}}}}` + "\n" +
		`{"type":"assistant","timestamp":"2026-06-26T10:02:00.000Z","requestId":"r3","message":{"id":"m3","model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":5}}}` + "\n" // no cache write, in between -- must not win on TS ordering alone
	if err := os.WriteFile(path, []byte(lines), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := LastCacheWrite(path)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got == nil {
		t.Fatal("want non-nil CacheWrite")
	}
	if !got.OneHour {
		t.Errorf("want OneHour=true (the 10:05 write used the extended bucket), got false")
	}
	if !got.TS.Equal(time.Date(2026, 6, 26, 10, 5, 0, 0, time.UTC)) {
		t.Errorf("ts = %v, want 10:05:00", got.TS)
	}

	// No cache-write activity at all -> nil, no error.
	noCache := filepath.Join(dir, "no-cache.jsonl")
	noCacheLine := `{"type":"assistant","timestamp":"2026-06-26T10:00:00.000Z","message":{"id":"m1","model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":5}}}`
	if err := os.WriteFile(noCache, []byte(noCacheLine+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got2, err := LastCacheWrite(noCache)
	if err != nil || got2 != nil {
		t.Fatalf("want nil/no-error for no cache activity, got %+v, err=%v", got2, err)
	}

	// Codex-shaped transcript -> nil (extractClaude yields nothing for it), no error.
	codex := filepath.Join(dir, "rollout-x.jsonl")
	codexLine := `{"timestamp":"2026-06-26T03:08:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":10,"total_tokens":110}}}}`
	if err := os.WriteFile(codex, []byte(codexLine+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got3, err := LastCacheWrite(codex)
	if err != nil || got3 != nil {
		t.Fatalf("want nil/no-error for codex transcript, got %+v, err=%v", got3, err)
	}

	// Missing file -> nil, no error (mirrors SumTranscript's missing-file behavior).
	got4, err := LastCacheWrite(filepath.Join(dir, "does-not-exist.jsonl"))
	if err != nil || got4 != nil {
		t.Fatalf("want nil/no-error for missing file, got %+v, err=%v", got4, err)
	}
}

func TestWindowTokens(t *testing.T) {
	// Two records straddling a cutoff. WindowTokens sums records with TS >= cutoff.
	older := Record{TS: time.Date(2026, 6, 26, 8, 0, 0, 0, time.UTC), Provider: "claude", Model: "claude-opus-4-8", Input: 100, Output: 10}
	newer := Record{TS: time.Date(2026, 6, 26, 12, 0, 0, 0, time.UTC), Provider: "claude", Model: "claude-opus-4-8", Input: 200, Output: 20, CacheRead: 5}
	recs := []Record{older, newer}

	cutoffs := []time.Time{
		time.Date(2026, 6, 26, 10, 0, 0, 0, time.UTC), // excludes older, includes newer
		time.Time{},                                   // all-time: includes both
	}
	got := sumRecordsSinceCutoffs(recs, cutoffs)
	// cutoff[0]: only newer → 200+20+5 = 225 ; cutoff[1]: both → 110 + 225 = 335
	if got[0] != 225 || got[1] != 335 {
		t.Fatalf("window sums = %v; want [225 335]", got)
	}
}
