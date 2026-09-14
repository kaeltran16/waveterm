// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agentobserve"
)

func TestExtractTranscriptToolErrors(t *testing.T) {
	lines := []string{
		`{"type":"user","cwd":"/repos/pay","message":{"content":"fix coupons"}}`,
		`{"type":"assistant","cwd":"/repos/pay","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/repos/pay/src/coupons/validate.ts"}}]}}`,
		`{"type":"user","cwd":"/repos/pay","message":{"content":[{"type":"tool_result","is_error":true,"content":"patch failed to apply"}]}}`,
	}
	facts := extractTranscript("sess1", "/repos/pay", lines)
	if facts == nil {
		t.Fatal("expected extracted facts for a project-matching transcript")
	}
	if facts.toolErrors == 0 {
		t.Fatalf("expected a tool error, got %d", facts.toolErrors)
	}
	if len(facts.files) == 0 || facts.files[0] != "src/coupons/validate.ts" {
		t.Fatalf("expected referenced file relative to project, got %v", facts.files)
	}
	// a transcript for another cwd is skipped
	if extractTranscript("s2", "/repos/other", lines) != nil {
		t.Fatal("cwd mismatch must be skipped")
	}
}

// TestExtractTranscriptSkipsUserRejections pins the fix for a false-positive Radar finding: Claude Code
// records a denied-permission tool call (and a declined AskUserQuestion) as a tool_result with
// is_error:true bodied "The tool use was rejected". Those are human decisions, not tool failures, so
// they must not inflate toolErrors — otherwise the transcript collector fabricates "explicit tool error"
// findings from sessions where the user simply declined a prompt. A genuine failure in the same
// transcript must still count. Covers both content shapes (string and [{text}] block array).
func TestExtractTranscriptSkipsUserRejections(t *testing.T) {
	rej := `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`
	lines := []string{
		`{"type":"user","cwd":"/repos/pay","message":{"content":"work"}}`,
		// genuine execution failure — must count
		`{"type":"user","cwd":"/repos/pay","message":{"content":[{"type":"tool_result","is_error":true,"content":"patch failed to apply"}]}}`,
		// denied Bash permission, string content — must NOT count
		`{"type":"user","cwd":"/repos/pay","message":{"content":[{"type":"tool_result","is_error":true,"content":"` + rej + `"}]}}`,
		// declined AskUserQuestion, block-array content — must NOT count
		`{"type":"user","cwd":"/repos/pay","message":{"content":[{"type":"tool_result","is_error":true,"content":[{"type":"text","text":"` + rej + `"}]}]}}`,
	}
	facts := extractTranscript("sess", "/repos/pay", lines)
	if facts == nil {
		t.Fatal("expected extracted facts for a project-matching transcript")
	}
	if facts.toolErrors != 1 {
		t.Fatalf("user rejections must not count as tool errors: got toolErrors=%d, want 1 (only the genuine failure)", facts.toolErrors)
	}
}

// Wave's own backend model calls are print-mode runs, and several use the scanned project as their
// working directory — so cwd cannot tell them apart. A tool failure inside one of our own maintenance
// passes is not evidence about the user's repo, so the whole transcript is skipped.
func TestExtractTranscriptSkipsPrintModeRuns(t *testing.T) {
	errLine := `{"type":"user","cwd":"/repo","message":{"content":[{"type":"tool_result","is_error":true,"tool_use_id":"t1","content":"boom"}]}}`
	if f := extractTranscript("s1", "/repo", []string{errLine}); f == nil || f.toolErrors != 1 {
		t.Fatalf("baseline: an interactive tool error should be counted, got %+v", f)
	}
	headless := `{"type":"user","cwd":"/repo","entrypoint":"` + agentobserve.HeadlessEntrypoint +
		`","message":{"content":[{"type":"tool_result","is_error":true,"tool_use_id":"t1","content":"boom"}]}}`
	if f := extractTranscript("s2", "/repo", []string{headless}); f != nil {
		t.Errorf("print-mode transcript should yield no facts, got %+v", f)
	}
}

// Files a session merely read say nothing about them, and listing them spread one session's signal
// across the repo. Only edited files and files whose own tool call failed are evidence; the error text
// rides along so the model sees what failed.
func TestExtractTranscriptScopesFilesToEditsAndFailures(t *testing.T) {
	lines := []string{
		`{"type":"assistant","cwd":"/repos/pay","message":{"content":[{"type":"tool_use","id":"u1","name":"Read","input":{"file_path":"/repos/pay/docs/readme.md"}}]}}`,
		`{"type":"assistant","cwd":"/repos/pay","message":{"content":[{"type":"tool_use","id":"u2","name":"Read","input":{"file_path":"/repos/pay/src/missing.ts"}}]}}`,
		`{"type":"user","cwd":"/repos/pay","message":{"content":[{"type":"tool_result","tool_use_id":"u2","is_error":true,"content":"File does not exist.\nmore detail"}]}}`,
		`{"type":"assistant","cwd":"/repos/pay","message":{"content":[{"type":"tool_use","id":"u3","name":"MultiEdit","input":{"file_path":"/repos/pay/src/coupons/validate.ts"}}]}}`,
	}
	facts := extractTranscript("s", "/repos/pay", lines)
	if facts == nil {
		t.Fatal("expected extracted facts for a project-matching transcript")
	}
	if len(facts.files) != 2 || facts.files[0] != "src/missing.ts" || facts.files[1] != "src/coupons/validate.ts" {
		t.Fatalf("want the failed read and the edit only, got %v", facts.files)
	}
	if facts.editsByFile["src/coupons/validate.ts"] != 1 {
		t.Fatalf("MultiEdit must count as an edit, got %v", facts.editsByFile)
	}
	if len(facts.errors) != 1 || facts.errors[0] != "File does not exist." {
		t.Fatalf("want the error's first line, got %q", facts.errors)
	}
	want := `transcript recorded 1 explicit tool error(s) across 2 file(s); first error: "File does not exist."`
	if got := transcriptSignal("s.jsonl", 1, facts).Summary; got != want {
		t.Fatalf("summary:\n got %s\nwant %s", got, want)
	}
}
