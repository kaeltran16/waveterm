// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// With no streamFn injectable, clusterModes calls the real synthesize which calls consult.Run.
// Without an OpenRouter key in tests, synthesis fails and is recorded as cluster-failed.

func TestSecurityLensClustersFailureOnMissingBackend(t *testing.T) {
	boundary := newSignal(CollectorStructure, "struct:security-boundary:src/auth/session.ts", 1, []string{"src/auth/session.ts"}, "auth boundary", map[string]any{"classes": []string{ClassSecurityBoundary}, "boundary": "auth"}, "")
	churn := newSignal(CollectorGit, "commit:1", 2, []string{"src/auth/session.ts"}, "changed", nil, "")

	findings, runs := clusterModes(context.Background(), "pay", "/repos/pay", []waveobj.RadarSignal{boundary, churn}, []string{ModeSecurity})
	if len(findings) != 0 {
		t.Fatalf("no findings expected on backend failure, got %d", len(findings))
	}
	if len(runs) != 1 || runs[0].Mode != ModeSecurity || runs[0].Status != ModeRunClusterFailed {
		t.Fatalf("want a clustering-failed security run, got %+v", runs)
	}
}
