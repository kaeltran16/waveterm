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
