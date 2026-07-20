// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memdistill

import (
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/memvault"
)

func mkTime(s string) time.Time {
	t, _ := time.Parse(time.RFC3339, s)
	return t
}

func TestShouldFlush_ThresholdAndMaxAge(t *testing.T) {
	now := mkTime("2026-07-15T12:00:00Z")
	var eight []pendingSession
	for i := 0; i < 8; i++ {
		eight = append(eight, pendingSession{EnqueuedAt: "2026-07-15T11:59:00Z"})
	}
	if !shouldFlush(eight, now) {
		t.Error("8 fresh sessions should flush on threshold")
	}
	old := []pendingSession{{EnqueuedAt: "2026-07-14T00:00:00Z"}} // >24h old
	if !shouldFlush(old, now) {
		t.Error("a single >maxAge session should flush on backstop")
	}
	fresh := []pendingSession{{EnqueuedAt: "2026-07-15T11:59:00Z"}}
	if shouldFlush(fresh, now) {
		t.Error("one fresh session should not flush")
	}
	if shouldFlush(nil, now) {
		t.Error("empty bucket should not flush")
	}
}

func TestFlush_RoutesAndClearsBucket(t *testing.T) {
	path := filepath.Join(t.TempDir(), "q.json")
	d := newDistiller(path)
	var routedCwd string
	var routedBodies []string
	d.distillFn = func(claudePath, model, corpus string) (string, bool) {
		return `{"candidates":[{"type":"feedback","body":"x","iscorrection":true}],"references":[]}`, true
	}
	d.routeFn = func(cwd string, cands []memvault.LearnCandidate, refs []string) (int, int, error) {
		routedCwd = cwd
		for _, c := range cands {
			routedBodies = append(routedBodies, c.Body)
		}
		return len(cands), 0, nil
	}
	d.enqueue("/repo/a", "/t/1.jsonl", "/usr/bin/claude") // writes queue, no flush (below threshold)
	d.flush("/repo/a")
	if routedCwd != "/repo/a" || len(routedBodies) != 1 || routedBodies[0] != "x" {
		t.Fatalf("flush did not route candidates: cwd=%q bodies=%+v", routedCwd, routedBodies)
	}
	if got := loadQueue(path); len(got.Buckets["/repo/a"]) != 0 {
		t.Errorf("bucket not cleared after flush: %+v", got.Buckets["/repo/a"])
	}
}

func TestFlush_KeepsBucketOnDistillFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "q.json")
	d := newDistiller(path)
	d.distillFn = func(claudePath, model, corpus string) (string, bool) { return "", false }
	routed := false
	d.routeFn = func(string, []memvault.LearnCandidate, []string) (int, int, error) { routed = true; return 0, 0, nil }
	d.enqueue("/repo/a", "/t/1.jsonl", "")
	d.flush("/repo/a")
	if routed {
		t.Error("routeFn must not run when distill fails")
	}
	if got := loadQueue(path); len(got.Buckets["/repo/a"]) != 1 {
		t.Error("bucket must be retained when distill fails")
	}
}

func TestSweepRunsRegisteredHooks(t *testing.T) {
	var n int32
	RegisterSweepHook(func() { atomic.AddInt32(&n, 1) })
	t.Cleanup(func() { sweepHooks = nil })
	d := newDistiller(filepath.Join(t.TempDir(), "q.json"))
	d.runSweepHooks()
	if atomic.LoadInt32(&n) != 1 {
		t.Fatalf("hook not run: %d", n)
	}
}
