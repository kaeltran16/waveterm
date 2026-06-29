// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsessions

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeJSONL(t *testing.T, dir, name string, lines ...string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestScanRoot_parsesAndSortsNewestFirst(t *testing.T) {
	dir := t.TempDir()
	writeJSONL(t, dir, "sess-a.jsonl",
		`{"type":"user","cwd":"/home/me/payments-api","gitBranch":"feat/auth","message":{"role":"user","content":"Fix the auth race"}}`,
		`{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`,
	)
	older := writeJSONL(t, dir, "sess-b.jsonl",
		`{"type":"user","cwd":"/home/me/web","gitBranch":"main","message":{"role":"user","content":"Add a button"}}`,
	)
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(older, old, old); err != nil {
		t.Fatal(err)
	}

	got := scanRoot(dir, 0, 10)
	if len(got) != 2 {
		t.Fatalf("want 2 sessions, got %d", len(got))
	}
	if got[0].ID != "sess-a" {
		t.Errorf("want newest sess-a first, got %q", got[0].ID)
	}
	if got[0].Task != "Fix the auth race" {
		t.Errorf("task = %q", got[0].Task)
	}
	if got[0].ProjectName != "payments-api" {
		t.Errorf("projectName = %q", got[0].ProjectName)
	}
	if got[0].Branch != "feat/auth" {
		t.Errorf("branch = %q", got[0].Branch)
	}
	if got[0].Model != "claude-opus-4-8" {
		t.Errorf("model = %q", got[0].Model)
	}
	if got[0].TokensTotal != 15 {
		t.Errorf("tokensTotal = %d", got[0].TokensTotal)
	}
	if got[0].Runtime != "claude" {
		t.Errorf("runtime = %q", got[0].Runtime)
	}
}

func TestScanRoot_skipsFilesWithoutHumanPrompt(t *testing.T) {
	dir := t.TempDir()
	// content is an array (a tool result), not a human string prompt
	writeJSONL(t, dir, "toolonly.jsonl",
		`{"type":"user","cwd":"/x","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}`,
		`{"type":"assistant","message":{"model":"claude-opus-4-8"}}`,
	)
	if got := scanRoot(dir, 0, 10); len(got) != 0 {
		t.Fatalf("want 0 (no human prompt), got %d", len(got))
	}
}

func TestScanRoot_capsToLimit(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"a", "b", "c"} {
		writeJSONL(t, dir, n+".jsonl", `{"type":"user","cwd":"/x","message":{"content":"hi `+n+`"}}`)
	}
	if got := scanRoot(dir, 0, 2); len(got) != 2 {
		t.Fatalf("cap: want 2, got %d", len(got))
	}
}

func TestScanRoot_readsOnlyNewestUpToLimit(t *testing.T) {
	dir := t.TempDir()
	mk := func(name string, agoHours int) {
		p := writeJSONL(t, dir, name, `{"type":"user","cwd":"/x","message":{"content":"hi `+name+`"}}`)
		ts := time.Now().Add(-time.Duration(agoHours) * time.Hour)
		if err := os.Chtimes(p, ts, ts); err != nil {
			t.Fatal(err)
		}
	}
	mk("new.jsonl", 1)
	mk("mid.jsonl", 2)
	mk("old.jsonl", 3)

	// instrument content reads: only the newest `limit` files should be read, not all 3.
	orig := readLines
	var reads []string
	readLines = func(path string) []string {
		reads = append(reads, filepath.Base(path))
		return orig(path)
	}
	defer func() { readLines = orig }()

	got := scanRoot(dir, 0, 2)
	if len(got) != 2 || got[0].ID != "new" || got[1].ID != "mid" {
		t.Fatalf("want newest [new mid], got %+v", got)
	}
	if len(reads) != 2 {
		t.Errorf("want only 2 content reads (newest up to limit), got %d: %v", len(reads), reads)
	}
}

func TestScanRoot_missingRootYieldsNothing(t *testing.T) {
	if got := scanRoot(filepath.Join(t.TempDir(), "does-not-exist"), 0, 10); len(got) != 0 {
		t.Fatalf("missing root: want 0, got %d", len(got))
	}
}
