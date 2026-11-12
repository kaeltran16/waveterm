// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memgate

import (
	"context"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/util/jobobject"
)

// fakeMachine stands in for the jobs, free memory and clock the loop reads.
type fakeMachine struct {
	free atomic.Uint64

	mu        sync.Mutex
	live      map[jobobject.Owner]jobobject.JobUsage
	suspended []jobobject.Owner
	resumed   []jobobject.Owner

	clock time.Time
}

func newLoop(t *testing.T, free uint64) (*recorder, *fakeMachine) {
	t.Helper()
	rec := newGate(t, 0)
	m := &fakeMachine{live: make(map[jobobject.Owner]jobobject.JobUsage), clock: time.Unix(1_000_000_000, 0)}
	m.free.Store(free)
	t.Cleanup(SetFreeForTest(func() (uint64, error) { return m.free.Load(), nil }))

	oldUsage, oldSuspend, oldResume, oldNow := liveUsage, suspendJob, resumeJob, now
	liveUsage = func() []jobobject.JobUsage {
		m.mu.Lock()
		defer m.mu.Unlock()
		var out []jobobject.JobUsage
		for _, u := range m.live {
			out = append(out, u)
		}
		return out
	}
	suspendJob = func(o jobobject.Owner) (int, error) {
		m.mu.Lock()
		defer m.mu.Unlock()
		m.suspended = append(m.suspended, o)
		return 1, nil
	}
	resumeJob = func(o jobobject.Owner) error {
		m.mu.Lock()
		defer m.mu.Unlock()
		m.resumed = append(m.resumed, o)
		return nil
	}
	now = func() time.Time { return m.clock }
	book.mu.Lock()
	loop.haveBase, loop.base = false, 0
	book.mu.Unlock()
	ownerKeys.mu.Lock()
	ownerKeys.keys = make(map[jobobject.Owner]Key)
	ownerKeys.mu.Unlock()
	t.Cleanup(func() {
		liveUsage, suspendJob, resumeJob, now = oldUsage, oldSuspend, oldResume, oldNow
		SetResolver(nil)
		book.mu.Lock()
		for c := range book.claims {
			c.released = true
		}
		book.claims = make(map[*Claim]struct{})
		book.mu.Unlock()
	})
	return rec, m
}

func (m *fakeMachine) advance(d time.Duration) { m.clock = m.clock.Add(d) }

func (m *fakeMachine) setLive(o jobobject.Owner, cur, peak uint64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.live[o] = jobobject.JobUsage{Owner: o, Current: cur, Peak: peak}
}

func (m *fakeMachine) gone(o jobobject.Owner) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.live, o)
}

func (m *fakeMachine) suspends() []jobobject.Owner {
	m.mu.Lock()
	defer m.mu.Unlock()
	return slices.Clone(m.suspended)
}

func (m *fakeMachine) resumes() []jobobject.Owner {
	m.mu.Lock()
	defer m.mu.Unlock()
	return slices.Clone(m.resumed)
}

func block(id string) jobobject.Owner {
	return jobobject.Owner{Kind: jobobject.OwnerKind_Block, Id: id}
}

// liveTree admits a tree of role bound to a live block job and steps the clock, so admissions are ordered.
func (m *fakeMachine) liveTree(t *testing.T, runId, taskId, role string) (*Claim, jobobject.Owner) {
	t.Helper()
	o := block(taskId)
	restore := UncapForTest()
	c, ok := TryAdmit(Request{Key: Key{"c:\\proj", role}, Need: gib, Tag: Tag{runId, taskId, role}, Owner: o})
	restore()
	if !ok {
		t.Fatalf("admitting %s refused", taskId)
	}
	m.setLive(o, 100*mib, 100*mib)
	m.advance(time.Second)
	return c, o
}

func (r *recorder) ofKind(k EventKind) []Event {
	flush()
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []Event
	for _, ev := range r.events {
		if ev.Kind == k {
			out = append(out, ev)
		}
	}
	return out
}

func tickN(m *fakeMachine, n int) {
	for range n {
		tick(context.Background())
		m.advance(loopTick)
	}
}

func TestPauseReviewersBeforeWorkers(t *testing.T) {
	rec, m := newLoop(t, 8*gib)
	_, rev := m.liveTree(t, "r1", "rev", RoleReviewer)
	_, w1 := m.liveTree(t, "r1", "w1", RoleWorker)
	_, w2 := m.liveTree(t, "r1", "w2", RoleWorker)
	m.free.Store(gib)

	tickN(m, 1)
	if got := m.suspends(); !slices.Equal(got, []jobobject.Owner{rev}) {
		t.Fatalf("first pause hit %v, want the reviewer", got)
	}
	tickN(m, 1)
	if got := m.suspends(); !slices.Equal(got, []jobobject.Owner{rev, w2}) {
		t.Fatalf("second pause hit %v, want the newest worker", got)
	}
	tickN(m, 1)
	if got := m.suspends(); len(got) != 2 {
		t.Fatalf("paused %v: %v is the last unpaused tree", got, w1)
	}
	paused := rec.ofKind(EventPaused)
	if len(paused) != 2 || paused[0].Tag.TaskId != "rev" || paused[1].Tag.TaskId != "w2" {
		t.Fatalf("paused events %+v", paused)
	}
	if paused[0].Need != highWater || paused[0].Free != gib {
		t.Fatalf("paused event free %d need %d, want %d and %d", paused[0].Free, paused[0].Need, gib, highWater)
	}
}

func TestNeverPauseLastTree(t *testing.T) {
	rec, m := newLoop(t, 8*gib)
	m.liveTree(t, "r1", "w1", RoleWorker)
	m.free.Store(512 * mib)
	tickN(m, 5)
	if got := m.suspends(); len(got) != 0 {
		t.Fatalf("paused %v with one gated tree live", got)
	}
	if got := rec.ofKind(EventPaused); len(got) != 0 {
		t.Fatalf("paused events %+v", got)
	}
}

func TestResumeAboveHigh(t *testing.T) {
	rec, m := newLoop(t, 8*gib)
	m.liveTree(t, "r1", "a", RoleWorker)
	_, b := m.liveTree(t, "r1", "b", RoleWorker)
	_, c := m.liveTree(t, "r1", "c", RoleWorker)
	m.free.Store(gib)
	tickN(m, 2) // pauses c, then b
	if got := m.suspends(); !slices.Equal(got, []jobobject.Owner{c, b}) {
		t.Fatalf("paused %v, want c then b", got)
	}

	m.free.Store(2 * gib) // between the watermarks
	tickN(m, 3)
	if got := m.resumes(); len(got) != 0 {
		t.Fatalf("resumed %v below the high watermark", got)
	}

	m.free.Store(4 * gib)
	tickN(m, 1)
	if got := m.resumes(); !slices.Equal(got, []jobobject.Owner{c}) {
		t.Fatalf("first resume %v, want the oldest pause (c)", got)
	}
	tickN(m, 1)
	if got := m.resumes(); !slices.Equal(got, []jobobject.Owner{c, b}) {
		t.Fatalf("resumes %v, want c then b", got)
	}
	resumed := rec.ofKind(EventResumed)
	if len(resumed) != 2 || resumed[0].Reason != ReasonMemory || resumed[0].Tag.TaskId != "c" || resumed[0].Ms <= 0 {
		t.Fatalf("resumed events %+v", resumed)
	}
}

func TestPauseLimit(t *testing.T) {
	rec, m := newLoop(t, 8*gib)
	_, w := m.liveTree(t, "r1", "w", RoleWorker)
	// a plan command stays unpaused, so the worker is never the last tree and is the only pausable one
	verify := jobobject.Owner{Kind: jobobject.OwnerKind_RunCmd, Id: "r1", Cmd: "Verify"}
	restore := UncapForTest()
	vc, _ := TryAdmit(Request{Key: Key{"c:\\proj", "Verify"}, Need: gib, Owner: verify})
	restore()
	defer vc.Release()
	m.setLive(verify, 100*mib, 100*mib)
	m.free.Store(gib)

	tickN(m, 1)
	if got := m.suspends(); !slices.Equal(got, []jobobject.Owner{w}) {
		t.Fatalf("paused %v, want the worker", got)
	}
	m.advance(pauseLimit)
	tickN(m, 1)
	resumed := rec.ofKind(EventResumed)
	if len(resumed) != 1 || resumed[0].Reason != ReasonLimit {
		t.Fatalf("resumed events %+v, want one with reason limit", resumed)
	}
	if got := m.resumes(); !slices.Equal(got, []jobobject.Owner{w}) {
		t.Fatalf("resumed %v, want the worker", got)
	}
	resumedAt := m.clock.Add(-loopTick)

	for m.clock.Before(resumedAt.Add(pauseCooldown)) {
		tickN(m, 1)
	}
	if got := m.suspends(); len(got) != 1 {
		t.Fatalf("paused again within the cooldown: %v", got)
	}
	tickN(m, 1)
	if got := m.suspends(); len(got) != 2 {
		t.Fatalf("not paused again after the cooldown: %v", got)
	}
}

func TestCloseRecordsPeakAndReleases(t *testing.T) {
	_, m := newLoop(t, 8*gib)
	cached := Key{"c:\\close-proj", RoleWorker}
	SetResolver(func(_ context.Context, o jobobject.Owner) (Key, bool) {
		if o.Id == "w" {
			return cached, true
		}
		return Key{}, false
	})
	_, w := m.liveTree(t, "r1", "w", RoleWorker)
	verify := jobobject.Owner{Kind: jobobject.OwnerKind_RunCmd, Id: "r1", Cmd: "Verify"}
	restore := UncapForTest()
	vc, _ := TryAdmit(Request{Key: Key{"c:\\proj", "Verify"}, Need: gib, Owner: verify})
	restore()
	defer vc.Release()
	tickN(m, 1)

	// the block is gone by the time its job closes: the key cached while it was live is used
	SetResolver(nil)
	m.gone(w)
	onJobClosed(w, 5*gib)
	if got := Estimate(cached); got != 5*gib {
		t.Fatalf("estimate after close = %d, want the recorded peak %d", got, 5*gib)
	}
	if got := LiveClaimsForTest(); got != 1 {
		t.Fatalf("%d live claims after the block closed, want only the plan command's", got)
	}

	// a plan command's claim is its caller's to release
	onJobClosed(verify, gib)
	if got := LiveClaimsForTest(); got != 1 {
		t.Fatalf("%d live claims after the plan command's job closed, want 1", got)
	}

	// uncached: resolved at close
	uncached := Key{"c:\\close-proj", "terminal"}
	SetResolver(func(context.Context, jobobject.Owner) (Key, bool) { return uncached, true })
	onJobClosed(block("t"), 2*gib)
	if got := Estimate(uncached); got != 2*gib {
		t.Fatalf("estimate of an uncached owner after close = %d, want %d", got, 2*gib)
	}
}

func TestPausedTreeExit(t *testing.T) {
	rec, m := newLoop(t, 8*gib)
	m.liveTree(t, "r1", "a", RoleWorker)
	_, b := m.liveTree(t, "r1", "b", RoleWorker)
	_, c := m.liveTree(t, "r1", "c", RoleWorker)
	m.free.Store(gib)
	tickN(m, 2) // pauses c, then b

	m.gone(c)
	onJobClosed(c, gib)
	resumed := rec.ofKind(EventResumed)
	if len(resumed) != 1 || resumed[0].Reason != ReasonExited || resumed[0].Tag.TaskId != "c" {
		t.Fatalf("resumed events after a paused tree closed: %+v", resumed)
	}

	// a paused tree whose job vanishes before its close is handled is dropped with the same event
	m.gone(b)
	tickN(m, 1)
	resumed = rec.ofKind(EventResumed)
	if len(resumed) != 2 || resumed[1].Reason != ReasonExited || resumed[1].Tag.TaskId != "b" {
		t.Fatalf("resumed events after a paused tree vanished: %+v", resumed)
	}
	if got := LiveClaimsForTest(); got != 1 {
		t.Fatalf("%d live claims, want 1", got)
	}
}

func TestDropDeadAndStaleClaims(t *testing.T) {
	_, m := newLoop(t, 8*gib)
	restore := UncapForTest()
	dead, _ := TryAdmit(Request{Key: Key{"c:\\proj", RoleWorker}, Need: gib, Owner: block("dead")})
	stale, _ := TryAdmit(Request{Key: Key{"c:\\proj", RoleWorker}, Need: gib, Owner: block("stale")})
	unbound, _ := TryAdmit(Request{Key: Key{"c:\\proj", RoleWorker}, Need: gib})
	restore()
	defer unbound.Release()
	isLive := func(c *Claim) bool {
		book.mu.Lock()
		defer book.mu.Unlock()
		_, ok := book.claims[c]
		return ok
	}

	m.setLive(block("dead"), 2*gib, 3*gib)
	tickN(m, 1)
	book.mu.Lock()
	cur, need := dead.cur, dead.need
	book.mu.Unlock()
	if cur != 2*gib || need != 3*gib {
		t.Fatalf("seen claim cur %d need %d, want its use %d and its peak %d", cur, need, 2*gib, 3*gib)
	}
	m.gone(block("dead"))
	tickN(m, 1)
	if isLive(dead) {
		t.Fatal("a claim whose job was seen and is gone was not dropped")
	}

	m.clock = stale.boundAt.Add(bindStale - time.Second)
	tickN(m, 1)
	if !isLive(stale) {
		t.Fatal("a claim dropped before its job had 60 s to appear")
	}
	m.clock = stale.boundAt.Add(bindStale)
	tickN(m, 1)
	if isLive(stale) {
		t.Fatal("a claim whose job never appeared 60 s after the bind was not dropped")
	}

	m.advance(24 * time.Hour)
	tickN(m, 1)
	if !isLive(unbound) {
		t.Fatal("the loop dropped an unbound claim")
	}
}

func TestRoomHookOnRise(t *testing.T) {
	rec, m := newLoop(t, gib)
	live := mustAdmit(t, req("", "a", 3*gib)) // empty book: always starts
	defer live.Release()
	if _, ok := TryAdmit(req("r1", "b", 4*gib)); ok {
		t.Fatal("4 GiB admitted with 1 GiB free and a claim live")
	}
	tickN(m, 1) // the baseline
	before := len(rec.roomCalls())

	m.free.Store(gib + roomRise - mib)
	tickN(m, 1)
	if got := rec.roomCalls(); len(got) != before {
		t.Fatalf("room hook called on a rise under 512 MiB: %v", got[before:])
	}
	m.free.Store(gib + roomRise)
	tickN(m, 1)
	got := rec.roomCalls()
	if len(got) != before+1 || !slices.Equal(got[before], []string{"r1"}) {
		t.Fatalf("room calls after a 512 MiB rise: %v, want one with [r1]", got[before:])
	}
	tickN(m, 1)
	if got := rec.roomCalls(); len(got) != before+1 {
		t.Fatalf("room hook called again with no further rise: %v", got[before:])
	}
}
