// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import "testing"

func TestParseSynthesisStream(t *testing.T) {
	lines := []string{
		`{"type":"system","subtype":"init","model":"claude-sonnet-4-5-20250929","tools":[]}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"{\"findings\":[]}"}]}}`,
		`{"type":"result","subtype":"success","result":"{\"findings\":[]}","usage":{"input_tokens":1200,"output_tokens":300,"cache_read_input_tokens":50,"cache_creation_input_tokens":0}}`,
	}
	out := parseSynthesisStream(lines)
	if out.modelID != "claude-sonnet-4-5-20250929" {
		t.Fatalf("model id: %q", out.modelID)
	}
	if out.resultText != `{"findings":[]}` {
		t.Fatalf("result text: %q", out.resultText)
	}
	if out.totalTokens != 1550 {
		t.Fatalf("total tokens: %d, want 1550", out.totalTokens)
	}
	if !out.haveUsage {
		t.Fatal("expected exact usage")
	}
}

func TestParseSynthesisStreamNoUsage(t *testing.T) {
	lines := []string{
		`{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}`,
	}
	out := parseSynthesisStream(lines)
	if out.haveUsage {
		t.Fatal("no result event -> no exact usage")
	}
	if out.resultText != "hi" { // falls back to accumulated assistant text
		t.Fatalf("fallback text: %q", out.resultText)
	}
}
