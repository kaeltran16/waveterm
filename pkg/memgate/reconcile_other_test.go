//go:build !windows

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memgate

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/util/jobobject"
)

// off windows there are no job objects: no usage is ever read, so a bound tree is never seen, never paused, and its
// claim is dropped once bindStale passes. this runs the loop on the real no-op jobobject calls, not the fakes.
func TestNoJobObjectsOffWindows(t *testing.T) {
	rec, m := newLoop(t, 8*gib)
	liveUsage, suspendJob, resumeJob = jobobject.LiveUsage, jobobject.Suspend, jobobject.Resume

	restore := UncapForTest()
	w1 := mustAdmit(t, Request{Tag: Tag{"r1", "w1", RoleWorker, ""}, Owner: block("w1")})
	w2 := mustAdmit(t, Request{Tag: Tag{"r1", "w2", RoleWorker, ""}, Owner: block("w2")})
	restore()
	m.free.Store(gib)

	tickN(m, 1)
	if got := rec.ofKind(EventPaused); len(got) != 0 {
		t.Fatalf("paused %+v below the low watermark, want none: no tree is ever seen", got)
	}
	if got := LiveClaimsForTest(); got != 2 {
		t.Fatalf("%d claims before bindStale, want 2", got)
	}

	m.advance(bindStale)
	tickN(m, 1)
	if got := LiveClaimsForTest(); got != 0 {
		t.Fatalf("%d claims after bindStale, want the unseen bound claims dropped", got)
	}
	if !w1.released || !w2.released {
		t.Fatalf("claims released w1=%v w2=%v, want both", w1.released, w2.released)
	}
}
