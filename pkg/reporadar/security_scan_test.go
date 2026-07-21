// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// fakeStreamSecurity cites the given ids + files as one auth-boundary-fragility finding.
func fakeStreamSecurity(ids, files []string) streamFn {
	return func(ctx context.Context, prompt string) ([]string, error) {
		inner := SynthResponse{Findings: []SynthFinding{{
			RiskKind: RiskAuthBoundaryFragility, Risk: "r", Why: "w", Severity: "high",
			SignalIDs: ids, Files: files, Mission: "m",
		}}}
		b, _ := json.Marshal(inner)
		return []string{
			`{"type":"system","subtype":"init","model":"claude-sonnet-x"}`,
			`{"type":"result","subtype":"success","result":` + jsonString(string(b)) + `,"usage":{"input_tokens":10,"output_tokens":5}}`,
		}, nil
	}
}

func TestSecurityLensClustersBoundaryFinding(t *testing.T) {
	boundary := newSignal(CollectorStructure, "struct:security-boundary:src/auth/session.ts", 1, []string{"src/auth/session.ts"}, "auth boundary", map[string]any{"classes": []string{ClassSecurityBoundary}, "boundary": "auth"}, "")
	churn := newSignal(CollectorGit, "commit:1", 2, []string{"src/auth/session.ts"}, "changed", nil, "")
	fn := fakeStreamSecurity([]string{boundary.ID, churn.ID}, []string{"src/auth/session.ts"})

	findings, runs := clusterModes(context.Background(), "pay", "/repos/pay", []waveobj.RadarSignal{boundary, churn}, []string{ModeSecurity}, fn)
	if len(runs) != 1 || runs[0].Mode != ModeSecurity || runs[0].Status != ModeRunCompleted {
		t.Fatalf("want 1 completed security run, got %+v", runs)
	}
	if len(findings) != 1 || findings[0].Mode != ModeSecurity || findings[0].RiskKind != RiskAuthBoundaryFragility {
		t.Fatalf("want 1 security auth-boundary finding, got %+v", findings)
	}
}
