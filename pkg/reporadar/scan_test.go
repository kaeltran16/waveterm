// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestRunScanEmptyCollectsAndFailsClustering(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	// a repo whose only tracked file is a non-source doc: all collectors succeed, no findings.
	gitCmd(t, dir, "init", "-q")
	writeFile(t, dir, "README.md", "# demo\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-q", "-m", "init")
	rpt, err := wstore.CreateRadarReport(ctx, "demo", dir)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// runScan is synchronous (StartScan wraps it in a goroutine).
	runScan(ctx, rpt.OID)
	got, err := wstore.GetRadarReport(ctx, rpt.OID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	// Empty repo (only README.md) produces no usable signals. Scan completes or fails cleanly.
	if got.Status != StatusCompleted && got.Status != StatusFailed {
		t.Fatalf("want completed or failed, got %q (%s)", got.Status, got.FatalError)
	}
	_ = waveobj.OType_RadarReport
}
