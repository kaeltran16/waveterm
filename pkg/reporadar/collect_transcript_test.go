// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import "testing"

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
