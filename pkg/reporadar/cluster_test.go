// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// fakeStreamCiting returns a stream that cites the given signal IDs + files as one valid finding.
func fakeStreamCiting(ids, files []string) streamFn {
	return func(ctx context.Context, prompt string) ([]string, error) {
		inner := SynthResponse{Findings: []SynthFinding{{
			RiskKind: RiskTestCoverageGap, Risk: "r", Why: "w", Severity: "high",
			SignalIDs: ids, Files: files, Mission: "m",
		}}}
		b, _ := json.Marshal(inner)
		return []string{
			`{"type":"system","subtype":"init","model":"claude-sonnet-x"}`,
			`{"type":"result","subtype":"success","result":` + jsonString(string(b)) + `,"usage":{"input_tokens":10,"output_tokens":5}}`,
		}, nil
	}
}

func TestClusterModesRecordsCompletedRun(t *testing.T) {
	sigs := []waveobj.RadarSignal{
		newSignal(CollectorGit, "commit:1", 1, []string{"src/pay/a.ts"}, "x", nil, ""),
		newSignal(CollectorRuns, "run:1:phase:0", 2, []string{"src/pay/a.ts"}, "y", nil, ""),
		newSignal(CollectorTranscript, "tx:1", 3, []string{"src/pay/a.ts"}, "z", nil, ""),
	}
	fn := fakeStreamCiting([]string{sigs[0].ID, sigs[1].ID, sigs[2].ID}, []string{"src/pay/a.ts"})
	findings, runs := clusterModes(context.Background(), "pay", "/repos/pay", sigs, V1Modes, fn)
	if len(runs) != 1 || runs[0].Mode != ModeCorrectness || runs[0].Status != ModeRunCompleted {
		t.Fatalf("want 1 completed correctness run, got %+v", runs)
	}
	if runs[0].ResolvedModel != "claude-sonnet-x" || runs[0].FindingCount != 1 {
		t.Fatalf("run metadata not recorded: %+v", runs[0])
	}
	if len(findings) != 1 || findings[0].Mode != ModeCorrectness {
		t.Fatalf("want 1 correctness finding, got %+v", findings)
	}
}

func TestClusterModesRecordsFailure(t *testing.T) {
	fn := func(ctx context.Context, prompt string) ([]string, error) { return nil, fmt.Errorf("boom") }
	findings, runs := clusterModes(context.Background(), "pay", "/repos/pay", nil, V1Modes, fn)
	if len(findings) != 0 {
		t.Fatalf("no findings expected on failure, got %d", len(findings))
	}
	if len(runs) != 1 || runs[0].Status != ModeRunClusterFailed || runs[0].ClusterError == "" {
		t.Fatalf("want a clustering-failed run with an error, got %+v", runs)
	}
}
