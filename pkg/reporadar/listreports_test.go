// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Start() persists a report under a canonicalized path, so the read path must canonicalize the query
// path too — otherwise a report scanned before restart is stranded in the DB. In the real bug the FE
// re-sends a Windows backslash path against a forward-slashed stored path; a trailing slash reproduces
// the same write/read asymmetry portably.
func TestListReportsCanonicalizesQueryPath(t *testing.T) {
	ctx := context.Background()
	rpt, err := wstore.CreateRadarReport(ctx, "pay", canonPath("/repos/canon-restart"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := ListReports(ctx, "/repos/canon-restart/")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 1 || got[0].OID != rpt.OID {
		t.Fatalf("non-canonical query path must still find the stored report, got n=%d", len(got))
	}
}

// An empty query path must return reports across ALL projects, not the "." bucket canonPath would produce
// (canonPath("") == "."), so the Radar surface can pre-select the most-recently-scanned project on a fresh
// tab. Guards the pre-fix regression where ListReports("") matched nothing.
func TestListReportsEmptyPathReturnsAllProjects(t *testing.T) {
	ctx := context.Background()
	a, err := wstore.CreateRadarReport(ctx, "alpha", canonPath("/repos/list-all-alpha"))
	if err != nil {
		t.Fatalf("create alpha: %v", err)
	}
	b, err := wstore.CreateRadarReport(ctx, "beta", canonPath("/repos/list-all-beta"))
	if err != nil {
		t.Fatalf("create beta: %v", err)
	}
	got, err := ListReports(ctx, "")
	if err != nil {
		t.Fatalf("list all: %v", err)
	}
	seen := map[string]bool{}
	for _, r := range got {
		seen[r.OID] = true
	}
	if !seen[a.OID] || !seen[b.OID] {
		t.Fatalf("empty path must return reports across all projects; got n=%d alpha=%v beta=%v", len(got), seen[a.OID], seen[b.OID])
	}
}
