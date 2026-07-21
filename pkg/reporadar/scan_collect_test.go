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

func TestCollectAllStreamsProgressPerCollector(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-q")
	writeFile(t, dir, "src/pay.ts", "export const pay = () => {}\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-q", "-m", "init")

	type ev struct{ kind, status string }
	var events []ev
	res, err := collectAll(ctx, "pay", dir, 0, func(kind, status string) {
		events = append(events, ev{kind, status})
	})
	if err != nil {
		t.Fatalf("collectAll: %v", err)
	}

	// every collector that reports a terminal status must emit CoverageRunning first, exactly once,
	// so the checklist can tick each collector queued -> running -> done as the scan progresses.
	seen := map[string]string{}
	for _, e := range events {
		if e.status == CoverageRunning {
			if seen[e.kind] != "" {
				t.Fatalf("collector %s emitted running after %q", e.kind, seen[e.kind])
			}
		} else if seen[e.kind] != CoverageRunning {
			t.Fatalf("collector %s emitted %q with no preceding running", e.kind, e.status)
		}
		seen[e.kind] = e.status
	}
	if seen[CollectorStructure] != CoverageOK || seen[CollectorGit] != CoverageOK {
		t.Fatalf("expected structure+git to stream to ok, got %+v", seen)
	}
	if res.coverage[CollectorGit] != CoverageOK {
		t.Fatalf("expected git coverage ok in result, got %+v", res.coverage)
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
