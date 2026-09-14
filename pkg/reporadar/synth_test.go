// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/consult"
)

func TestModelLabel(t *testing.T) {
	cases := []struct {
		runtime string
		spec    consult.RuntimeSpec
		want    string
	}{
		{"openrouter", consult.RuntimeSpec{Model: "deepseek/deepseek-v4-pro"}, "openrouter:deepseek/deepseek-v4-pro"},
		{"claude", consult.RuntimeSpec{BaseArgs: []string{"-p", "--model", "sonnet"}}, "claude:sonnet"},
		// a runtime given no model runs its own default, which Radar cannot name
		{"codex", consult.RuntimeSpec{BaseArgs: []string{"exec"}}, "codex"},
	}
	for _, c := range cases {
		if got := modelLabel(c.runtime, c.spec); got != c.want {
			t.Fatalf("modelLabel(%s) = %q, want %q", c.runtime, got, c.want)
		}
	}
}

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
