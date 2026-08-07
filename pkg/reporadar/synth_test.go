// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import "testing"

func TestParseSynthesisResponse_Tolerant(t *testing.T) {
	resp, err := parseSynthesisResponse(`{"findings":[]}`)
	if err != nil {
		t.Fatalf("parseSynthesisResponse: %v", err)
	}
	if len(resp.Findings) != 0 {
		t.Fatalf("expected empty findings, got %d", len(resp.Findings))
	}
}

func TestParseSynthesisResponse_CodeFence(t *testing.T) {
	resp, err := parseSynthesisResponse("```json\n{\"findings\":[]}\n```")
	if err != nil {
		t.Fatalf("parseSynthesisResponse: %v", err)
	}
	if len(resp.Findings) != 0 {
		t.Fatalf("expected empty findings, got %d", len(resp.Findings))
	}
}
