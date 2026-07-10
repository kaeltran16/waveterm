// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"strings"
	"testing"
)

func TestParseSynthesisResponse(t *testing.T) {
	raw := `{"findings":[{"riskkind":"test-coverage-gap","boundarylabel":"checkout · coupons","risk":"X","why":"Y","severity":"high","signalids":["s1"],"files":["src/coupons/a.ts"],"mission":"add tests"}]}`
	resp, err := parseSynthesisResponse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(resp.Findings) != 1 || resp.Findings[0].RiskKind != "test-coverage-gap" {
		t.Fatalf("unexpected: %+v", resp)
	}
}

func TestParseSynthesisResponseToleratesFence(t *testing.T) {
	raw := "```json\n{\"findings\":[]}\n```"
	if _, err := parseSynthesisResponse(raw); err != nil {
		t.Fatalf("should strip code fence: %v", err)
	}
}

func TestPromptContainsTaxonomyAndDelimiters(t *testing.T) {
	groups, _ := prepareCandidates(nil, DefaultRadarPayloadBudget)
	p := buildSynthesisPrompt("payments-api", groups)
	if !strings.Contains(p, RiskTestCoverageGap) {
		t.Fatal("prompt must list the taxonomy")
	}
	if !strings.Contains(p, "BEGIN UNTRUSTED") {
		t.Fatal("prompt must delimit untrusted data")
	}
}
