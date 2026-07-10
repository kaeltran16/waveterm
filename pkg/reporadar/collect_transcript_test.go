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
