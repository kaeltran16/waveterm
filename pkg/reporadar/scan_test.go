// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// withFakeSynth overrides the scan's model runner with a canned JSONL stream for the duration of a
// test, restoring the previous fn afterward. Use it in full-runScan tests that need specific findings.
func withFakeSynth(t *testing.T, lines []string) {
	prev := synthStreamFn
	synthStreamFn = func(ctx context.Context, prompt string) ([]string, error) { return lines, nil }
	t.Cleanup(func() { synthStreamFn = prev })
}

func TestRunScanEmptyCompletes(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	// a repo whose only tracked file is a non-source doc: all collectors succeed, no findings.
	// (a repo with zero commits has no HEAD, so git-based collection can't run — needs a commit.)
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
	if got.Status != StatusCompleted {
		t.Fatalf("want completed, got %q (%s)", got.Status, got.FatalError)
	}
	if len(got.Findings) != 0 {
		t.Fatalf("empty scan must have no findings, got %d", len(got.Findings))
	}
	_ = waveobj.OType_RadarReport
}
