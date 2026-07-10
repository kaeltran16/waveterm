// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestRunScanCollectsAndRecordsCoverage(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-q")
	writeFile(t, dir, "src/pay.ts", "export const pay = () => {}\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-q", "-m", "init")

	rpt, _ := wstore.CreateRadarReport(ctx, "pay", dir)
	runScan(ctx, rpt.OID)

	got, _ := wstore.GetRadarReport(ctx, rpt.OID)
	if got.StartHead == "" {
		t.Fatal("expected StartHead captured")
	}
	if got.Coverage[CollectorGit] != "ok" || got.Coverage[CollectorStructure] != "ok" {
		t.Fatalf("expected git+structure coverage ok, got %+v", got.Coverage)
	}
	// the default fake synth returns zero findings, so the full pipeline completes and prunes
	// candidates; the terminal state proves collect->prepare->synth->finalize ran end to end.
	if got.Status != StatusCompleted {
		t.Fatalf("expected completed scan, got %q (%s)", got.Status, got.FatalError)
	}
	if len(got.Candidates) != 0 {
		t.Fatalf("candidates must be pruned on success, got %d", len(got.Candidates))
	}
}

func TestRunScanFatalOnNonRepo(t *testing.T) {
	ctx := context.Background()
	rpt, _ := wstore.CreateRadarReport(ctx, "x", t.TempDir()) // not a git repo
	runScan(ctx, rpt.OID)
	got, _ := wstore.GetRadarReport(ctx, rpt.OID)
	if got.Status != StatusFailed {
		t.Fatalf("non-repo scan must fail, got %q", got.Status)
	}
}
