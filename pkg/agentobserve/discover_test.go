// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentobserve

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPickActiveMatchesCwdAndPrefersNewest(t *testing.T) {
	base := time.Date(2026, 7, 12, 10, 0, 0, 0, time.UTC)
	cands := []candidate{
		{Path: "old.jsonl", Cwd: `C:\proj`, ModTime: base},
		{Path: "new.jsonl", Cwd: `C:\proj`, ModTime: base.Add(time.Minute)},
		{Path: "other.jsonl", Cwd: `C:\somewhere-else`, ModTime: base.Add(time.Hour)}, // newest but wrong cwd
		{Path: "nocwd.jsonl", Cwd: "", ModTime: base.Add(2 * time.Hour)},              // no cwd -> ignored
	}
	// no create time -> mtime tiebreak, newest cwd-match wins
	got := pickActive(cands, `C:\proj`, 0)
	if got.Path != "new.jsonl" || got.Method != "mtime" || got.MatchCount != 2 {
		t.Fatalf("pickActive = %+v, want new.jsonl/mtime/2", got)
	}
}

func TestPickActiveDisambiguatesConcurrentByCreateTime(t *testing.T) {
	base := time.Date(2026, 7, 12, 10, 0, 0, 0, time.UTC)
	// Two sessions in the SAME cwd (the ambiguous case). The newer-mtime one is NOT the one whose
	// session start matches the process create time — mtime alone would mis-attribute.
	early := base.UnixMilli()
	late := base.Add(10 * time.Minute).UnixMilli()
	cands := []candidate{
		{Path: "early-session.jsonl", Cwd: `C:\proj`, ModTime: base.Add(time.Hour), StartMs: early}, // newest mtime
		{Path: "late-session.jsonl", Cwd: `C:\proj`, ModTime: base.Add(30 * time.Minute), StartMs: late},
	}
	got := pickActive(cands, `C:\proj`, late) // a process that started at `late`
	if got.Path != "late-session.jsonl" || got.Method != "createtime" {
		t.Fatalf("pickActive = %+v, want late-session.jsonl/createtime", got)
	}
	if got.MatchCount != 2 {
		t.Fatalf("MatchCount = %d, want 2 (ambiguity recorded)", got.MatchCount)
	}
}

func TestPickActiveNoMatch(t *testing.T) {
	cands := []candidate{{Path: "a.jsonl", Cwd: `C:\other`, ModTime: time.Now()}}
	got := pickActive(cands, `C:\proj`, 0)
	if got.Path != "" || got.Method != "none" || got.MatchCount != 0 {
		t.Fatalf("pickActive = %+v, want empty/none/0", got)
	}
}

func TestSameCwdCaseInsensitiveAndClean(t *testing.T) {
	if !sameCwd(`C:\Users\Kael\Proj`, `c:\users\kael\proj`) {
		t.Fatal("expected case-insensitive match")
	}
	if !sameCwd(`C:\a\b\..\b`, `C:\a\b`) {
		t.Fatal("expected clean to normalize")
	}
	if sameCwd(`C:\a`, `C:\b`) {
		t.Fatal("distinct paths must not match")
	}
}

// end-to-end against a temp projects dir: the slug picks the right directory and the active
// (newest, cwd-matching) transcript is returned.
func TestActiveTranscriptEndToEnd(t *testing.T) {
	root := t.TempDir()
	blockCwd := `C:\work\demo`
	dir := filepath.Join(root, SlugifyCwd(blockCwd))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, cwd string, mod time.Time) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(`{"type":"user","cwd":`+jsonStr(cwd)+`}`+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, mod, mod); err != nil {
			t.Fatal(err)
		}
		return p
	}
	base := time.Now().Add(-time.Hour)
	write("stale.jsonl", blockCwd, base)
	want := write("active.jsonl", blockCwd, base.Add(30*time.Minute))
	write("collision.jsonl", `C:\work-demo`, base.Add(time.Hour)) // slug-collides, wrong real cwd

	if got := ActiveTranscript(root, blockCwd); got != want {
		t.Fatalf("ActiveTranscript = %q, want %q", got, want)
	}
	if got := ActiveTranscript(root, `C:\work\missing`); got != "" {
		t.Fatalf("ActiveTranscript(missing) = %q, want empty", got)
	}
	// a trailing separator on the block cwd (observed from process Cwd on Windows) must still resolve
	if got := ActiveTranscript(root, blockCwd+`\`); got != want {
		t.Fatalf("ActiveTranscript(trailing sep) = %q, want %q", got, want)
	}
}

func jsonStr(s string) string {
	b := make([]byte, 0, len(s)+2)
	b = append(b, '"')
	for _, r := range s {
		if r == '\\' || r == '"' {
			b = append(b, '\\')
		}
		b = append(b, string(r)...)
	}
	b = append(b, '"')
	return string(b)
}

// Resolve reads each transcript's head: the first cwd and the first timestamp count, past a large first line.
func TestResolveReadsTranscriptHead(t *testing.T) {
	blockCwd := `C:\work\demo`
	base := time.Date(2026, 7, 12, 10, 0, 0, 0, time.UTC)
	stamp := func(min int) string { return jsonStr(base.Add(time.Duration(min) * time.Minute).Format(time.RFC3339)) }
	at := func(min int) int64 { return base.Add(time.Duration(min) * time.Minute).UnixMilli() }
	setup := func(t *testing.T, files map[string][]string) (string, string) {
		root := t.TempDir()
		dir := filepath.Join(root, SlugifyCwd(blockCwd))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		for name, lines := range files {
			body := ""
			for _, l := range lines {
				body += l + "\n"
			}
			if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		return root, dir
	}

	t.Run("first cwd wins and the start comes from a later record", func(t *testing.T) {
		root, dir := setup(t, map[string][]string{"a.jsonl": {
			`{"cwd":` + jsonStr(blockCwd) + `}`,
			`{"cwd":"/elsewhere","timestamp":` + stamp(0) + `}`,
		}})
		got := Resolve(root, blockCwd, at(0))
		want := Resolution{Path: filepath.Join(dir, "a.jsonl"), MatchCount: 1, Method: "createtime"}
		if got != want {
			t.Fatalf("Resolve = %+v, want %+v", got, want)
		}
	})

	t.Run("first timestamp wins and the cwd comes from a later record", func(t *testing.T) {
		// a.jsonl starts at 0 and b.jsonl at 15; a process created at 1 is a's. Were a's start read from its
		// second record (20), b would be the closer one.
		root, dir := setup(t, map[string][]string{
			"a.jsonl": {`{"timestamp":` + stamp(0) + `}`, `{"cwd":` + jsonStr(blockCwd) + `,"timestamp":` + stamp(20) + `}`},
			"b.jsonl": {`{"cwd":` + jsonStr(blockCwd) + `,"timestamp":` + stamp(15) + `}`},
		})
		got := Resolve(root, blockCwd, at(1))
		want := Resolution{Path: filepath.Join(dir, "a.jsonl"), MatchCount: 2, Method: "createtime"}
		if got != want {
			t.Fatalf("Resolve = %+v, want %+v", got, want)
		}
	})

	t.Run("a first line over a megabyte is read past", func(t *testing.T) {
		pad := strings.Repeat("x", 2*1024*1024)
		root, dir := setup(t, map[string][]string{"a.jsonl": {
			`{"type":"summary","pad":"` + pad + `"}`,
			`{"cwd":` + jsonStr(blockCwd) + `,"timestamp":` + stamp(0) + `}`,
		}})
		got := Resolve(root, blockCwd, at(0))
		want := Resolution{Path: filepath.Join(dir, "a.jsonl"), MatchCount: 1, Method: "createtime"}
		if got != want {
			t.Fatalf("Resolve = %+v, want %+v", got, want)
		}
	})
}
