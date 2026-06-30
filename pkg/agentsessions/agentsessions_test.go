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

	got := scanProvider(claudeProvider(dir), 0, 10)
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
	if got[0].ResumeCommand != "claude --resume sess-a" {
		t.Errorf("resumeCommand = %q", got[0].ResumeCommand)
	}
}

func TestScanRoot_skipsFilesWithoutHumanPrompt(t *testing.T) {
	dir := t.TempDir()
	// content is an array (a tool result), not a human string prompt
	writeJSONL(t, dir, "toolonly.jsonl",
		`{"type":"user","cwd":"/x","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}`,
		`{"type":"assistant","message":{"model":"claude-opus-4-8"}}`,
	)
	if got := scanProvider(claudeProvider(dir), 0, 10); len(got) != 0 {
		t.Fatalf("want 0 (no human prompt), got %d", len(got))
	}
}

func TestScanRoot_capsToLimit(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"a", "b", "c"} {
		writeJSONL(t, dir, n+".jsonl", `{"type":"user","cwd":"/x","message":{"content":"hi `+n+`"}}`)
	}
	if got := scanProvider(claudeProvider(dir), 0, 2); len(got) != 2 {
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

	got := scanProvider(claudeProvider(dir), 0, 2)
	if len(got) != 2 || got[0].ID != "new" || got[1].ID != "mid" {
		t.Fatalf("want newest [new mid], got %+v", got)
	}
	if len(reads) != 2 {
		t.Errorf("want only 2 content reads (newest up to limit), got %d: %v", len(reads), reads)
	}
}

func TestScanRoot_missingRootYieldsNothing(t *testing.T) {
	if got := scanProvider(claudeProvider(filepath.Join(t.TempDir(), "does-not-exist")), 0, 10); len(got) != 0 {
		t.Fatalf("missing root: want 0, got %d", len(got))
	}
}

func TestScanProvider_codexExtractsResumeKeyAndMeta(t *testing.T) {
	dir := t.TempDir()
	// matcher requires the rollout- prefix; the filename stem is NOT the resume key for codex.
	writeJSONL(t, dir, "rollout-2026-06-30T08-45-09-019f1633.jsonl",
		`{"type":"session_meta","payload":{"session_id":"019f1633-9e5d-7791","cwd":"/home/me/waveterm","git":{"branch":"main"}}}`,
		`{"type":"event_msg","payload":{"type":"task_started"}}`,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions"}]}}`,
		`{"type":"turn_context","payload":{"model":"gpt-5-codex"}}`,
		`{"type":"event_msg","payload":{"type":"user_message","message":"check the handoff"}}`,
	)

	got := scanProvider(codexProvider(dir), 0, 10)
	if len(got) != 1 {
		t.Fatalf("want 1 codex session, got %d", len(got))
	}
	s := got[0]
	if s.ID != "019f1633-9e5d-7791" {
		t.Errorf("ID (resume key) = %q, want the session_meta session_id", s.ID)
	}
	if s.Runtime != "codex" {
		t.Errorf("runtime = %q", s.Runtime)
	}
	if s.ProjectName != "waveterm" {
		t.Errorf("projectName = %q", s.ProjectName)
	}
	if s.Branch != "main" {
		t.Errorf("branch = %q", s.Branch)
	}
	if s.Model != "gpt-5-codex" {
		t.Errorf("model = %q", s.Model)
	}
	if s.Task != "check the handoff" {
		t.Errorf("task = %q (must be the user_message, not the AGENTS.md injection)", s.Task)
	}
	if s.ResumeCommand != "codex resume 019f1633-9e5d-7791" {
		t.Errorf("resumeCommand = %q", s.ResumeCommand)
	}
}

func TestScanProvider_codexSkipsFileWithoutUserMessage(t *testing.T) {
	dir := t.TempDir()
	writeJSONL(t, dir, "rollout-x.jsonl",
		`{"type":"session_meta","payload":{"session_id":"abc","cwd":"/x"}}`,
		`{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"env"}]}}`,
	)
	if got := scanProvider(codexProvider(dir), 0, 10); len(got) != 0 {
		t.Fatalf("want 0 (no human user_message), got %d", len(got))
	}
}
