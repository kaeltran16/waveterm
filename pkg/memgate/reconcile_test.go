// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memgate

import (
	"errors"
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
	rising    map[jobobject.Owner]bool // each read adds a GiB to these jobs' use
	suspended []jobobject.Owner
	resumed   []jobobject.Owner

	clock time.Time
}

// idleUse is what a live tree uses until a test raises it.
const idleUse = 100 * mib

func newLoop(t *testing.T, free uint64) (*recorder, *fakeMachine) {
	t.Helper()
	rec := newGate(t, 0)
	m := &fakeMachine{
		live:   make(map[jobobject.Owner]jobobject.JobUsage),
		rising: make(map[jobobject.Owner]bool),
		clock:  time.Unix(1_000_000_000, 0),
	}
	m.free.Store(free)
	t.Cleanup(SetFreeForTest(func() (uint64, error) { return m.free.Load(), nil }))

	oldUsage, oldSuspend, oldResume, oldNow := liveUsage, suspendJob, resumeJob, now
	liveUsage = func() []jobobject.JobUsage {
		m.mu.Lock()
		defer m.mu.Unlock()
		var out []jobobject.JobUsage
		for o, u := range m.live {
			if m.rising[o] {
				u.Current += gib
				m.live[o] = u
			}
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
	t.Cleanup(func() {
		liveUsage, suspendJob, resumeJob, now = oldUsage, oldSuspend, oldResume, oldNow
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

func (m *fakeMachine) setLive(o jobobject.Owner) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.live[o] = jobobject.JobUsage{Owner: o, Current: idleUse}
}

// setUse sets o's job live at bytes of memory.
func (m *fakeMachine) setUse(o jobobject.Owner, bytes uint64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.live[o] = jobobject.JobUsage{Owner: o, Current: bytes}
}

// freshCache is a prompt cache written just now at every read, so it never ends a pause before pauseLimit.
func freshCache() (time.Time, bool) { return now().Add(10 * time.Minute), true }

func expiresAt(exp time.Time) func() (time.Time, bool) {
	return func() (time.Time, bool) { return exp, true }
}

// spikingWorker admits a live worker whose use rises a GiB at every read and whose cache stays fresh: the loop may
// pause it from its second tick, once it has read the worker's floor.
func (m *fakeMachine) spikingWorker(t *testing.T, runId, taskId string) (*Claim, jobobject.Owner) {
	t.Helper()
	c, o := m.liveTree(t, runId, taskId, RoleWorker)
	m.mu.Lock()
	m.rising[o] = true
	m.mu.Unlock()
	c.SetCacheExpiry(freshCache)
	return c, o
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
	c, ok := TryAdmit(Request{Tag: Tag{runId, taskId, role, ""}, Owner: o})
	restore()
	if !ok {
		t.Fatalf("admitting %s refused", taskId)
	}
	m.setLive(o)
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
		tick()
		m.advance(loopTick)
	}
}

// the youngest worker is likely the furthest from done, the oldest verifying near its end; an idle one frees nothing
func TestPausesYoungestSpikingWorker(t *testing.T) {
	rec, m := newLoop(t, 8*gib)
	var ws []jobobject.Owner
	for _, id := range []string{"t0", "t1", "t2"} {
		c, o := m.liveTree(t, "r1", id, RoleWorker)
		c.SetCacheExpiry(expiresAt(m.clock.Add(4 * time.Minute)))
		ws = append(ws, o)
	}
	tickN(m, 1) // the loop reads each worker's floor
	m.setUse(ws[0], idleUse+2*gib)
	m.setUse(ws[1], idleUse+2*gib)
	m.free.Store(lowWater - mib)

	tickN(m, 1)
	if got := m.suspends(); !slices.Equal(got, ws[1:2]) {
		t.Fatalf("paused %v, want only the youngest spiking worker %v", got, ws[1])
	}
	m.setUse(ws[0], idleUse+3*gib)
	tickN(m, 1)
	if got := m.suspends(); !slices.Equal(got, []jobobject.Owner{ws[1], ws[0]}) {
		t.Fatalf("paused %v, want %v then %v", got, ws[1], ws[0])
	}
	paused := rec.ofKind(EventPaused)
	if len(paused) != 2 || paused[0].Tag.TaskId != "t1" || paused[1].Tag.TaskId != "t0" {
		t.Fatalf("paused events %+v", paused)
	}
	if paused[0].Need != highWater || paused[0].Free != lowWater-mib {
		t.Fatalf("paused event free %d need %d, want %d and %d", paused[0].Free, paused[0].Need, lowWater-mib, highWater)
	}
}

// an agent-started worker carries a TabId and no RunId, and is paused like a run worker
func TestPausesWorkerStartedByAnAgent(t *testing.T) {
	_, m := newLoop(t, 8*gib)
	m.liveTree(t, "r1", "idle", RoleWorker)
	o := block("agent-tab")
	c, ok := TryAdmit(Request{Tag: Tag{TabId: "agent-tab", Role: RoleWorker}, Owner: o})
	if !ok {
		t.Fatal("admitting the agent-started worker refused")
	}
	m.setLive(o)
	m.advance(time.Second)
	m.mu.Lock()
	m.rising[o] = true
	m.mu.Unlock()
	c.SetCacheExpiry(freshCache)
	tickN(m, 1)
	m.free.Store(lowWater - mib)
	tickN(m, 1)
	if got := m.suspends(); !slices.Equal(got, []jobobject.Owner{o}) {
		t.Fatalf("paused %v, want the agent-started worker %v", got, o)
	}
}

func TestNeverPausesAReviewer(t *testing.T) {
	_, m := newLoop(t, 8*gib)
	m.liveTree(t, "r1", "w", RoleWorker) // idle, so the reviewer is not the last unpaused tree
	rc, rev := m.liveTree(t, "r1", "rev", RoleReviewer)
	rc.SetCacheExpiry(freshCache)
	tickN(m, 1)
	m.free.Store(lowWater - mib)
	for i := range uint64(3) {
		m.setUse(rev, idleUse+(2+i)*gib)
		tickN(m, 1)
	}
	if got := m.suspends(); len(got) != 0 {
		t.Fatalf("paused %v, a spiking reviewer", got)
	}
}

// a pause stops a spike from growing; it frees nothing already held
func TestPausesOnlyRisingSpikes(t *testing.T) {
	_, m := newLoop(t, 8*gib)
	m.liveTree(t, "r1", "idle", RoleWorker)
	c, w := m.liveTree(t, "r1", "w", RoleWorker)
	c.SetCacheExpiry(freshCache)
	tickN(m, 1)

	m.free.Store(lowWater - mib)
	m.setUse(w, idleUse+spikeRise-mib)
	tickN(m, 1)
	if got := m.suspends(); len(got) != 0 {
		t.Fatalf("paused %v, rising but under spikeRise above its floor", got)
	}

	m.free.Store(8 * gib)
	m.setUse(w, idleUse+2*gib)
	tickN(m, 1)
	m.free.Store(lowWater - mib)
	tickN(m, 1) // 2 GiB above its floor, no higher than last tick
	if got := m.suspends(); len(got) != 0 {
		t.Fatalf("paused %v, a plateaued spike", got)
	}

	m.setUse(w, idleUse+2*gib+mib)
	tickN(m, 1)
	if got := m.suspends(); !slices.Equal(got, []jobobject.Owner{w}) {
		t.Fatalf("paused %v once the spike rose again, want %v", got, w)
	}
}

// a pause without a known cache expiry could outlive the cache and cost the worker a full prompt rewrite
func TestNoPauseWithoutKnownCacheExpiry(t *testing.T) {
	for name, expiry := range map[string]func() (time.Time, bool){
		"nil":     nil,
		"unknown": func() (time.Time, bool) { return time.Time{}, false },
	} {
		t.Run(name, func(t *testing.T) {
			_, m := newLoop(t, 8*gib)
			oc, old := m.liveTree(t, "r1", "old", RoleWorker)
			oc.SetCacheExpiry(freshCache)
			yc, young := m.liveTree(t, "r1", "young", RoleWorker)
			yc.SetCacheExpiry(expiry)
			tickN(m, 1)

			m.setUse(young, idleUse+2*gib)
			m.free.Store(lowWater - mib)
			tickN(m, 1)
			if got := m.suspends(); len(got) != 0 {
				t.Fatalf("paused %v, the only spiking worker, with no known cache expiry", got)
			}
			m.setUse(young, idleUse+3*gib)
			m.setUse(old, idleUse+2*gib)
			tickN(m, 1)
			if got := m.suspends(); !slices.Equal(got, []jobobject.Owner{old}) {
				t.Fatalf("paused %v, want the older spiking worker %v with a known expiry", got, old)
			}
		})
	}
}

func TestNoPauseNearCacheExpiry(t *testing.T) {
	_, m := newLoop(t, 8*gib)
	oc, old := m.liveTree(t, "r1", "old", RoleWorker)
	yc, young := m.liveTree(t, "r1", "young", RoleWorker)
	tickN(m, 1)
	yc.SetCacheExpiry(expiresAt(m.clock.Add(40 * time.Second))) // its pause could last 10 s, under minPause
	oc.SetCacheExpiry(expiresAt(m.clock.Add(2 * time.Minute)))

	m.setUse(young, idleUse+2*gib)
	m.free.Store(lowWater - mib)
	tickN(m, 1)
	if got := m.suspends(); len(got) != 0 {
		t.Fatalf("paused %v, 40 s from its cache's expiry", got)
	}
	m.setUse(young, idleUse+3*gib)
	m.setUse(old, idleUse+2*gib)
	tickN(m, 1)
	if got := m.suspends(); !slices.Equal(got, []jobobject.Owner{old}) {
		t.Fatalf("paused %v, want the older worker %v with time left on its cache", got, old)
	}
}

func TestPauseEndsBeforeCacheExpires(t *testing.T) {
	for _, tc := range []struct {
		name      string
		expiresIn time.Duration // from the pause
		endsAfter time.Duration
	}{
		{"cache", 2 * time.Minute, 2*time.Minute - pauseMargin},
		{"limit", 10 * time.Minute, pauseLimit},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec, m := newLoop(t, 8*gib)
			m.liveTree(t, "r1", "idle", RoleWorker)
			c, w := m.liveTree(t, "r1", "w", RoleWorker)
			tickN(m, 1)
			pausedAt := m.clock
			c.SetCacheExpiry(expiresAt(pausedAt.Add(tc.expiresIn)))
			m.setUse(w, idleUse+2*gib)
			m.free.Store(lowWater - mib)
			tickN(m, 1)
			if got := m.suspends(); !slices.Equal(got, []jobobject.Owner{w}) {
				t.Fatalf("paused %v, want %v", got, w)
			}

			m.clock = pausedAt.Add(tc.endsAfter - time.Second)
			tick()
			if got := m.resumes(); len(got) != 0 {
				t.Fatalf("resumed %v a second before the pause's end", got)
			}
			m.clock = pausedAt.Add(tc.endsAfter)
			tick()
			if got := m.resumes(); !slices.Equal(got, []jobobject.Owner{w}) {
				t.Fatalf("resumed %v at the pause's end, want %v", got, w)
			}
			resumed := rec.ofKind(EventResumed)
			if len(resumed) != 1 || resumed[0].Reason != ReasonLimit || resumed[0].Ms != tc.endsAfter.Milliseconds() {
				t.Fatalf("resumed events %+v, want one with reason limit after %v", resumed, tc.endsAfter)
			}
		})
	}
}

// reading the expiry stats the sessions dir, so the loop must never hold the book locked across it
func TestCacheExpiryReadWithoutTheBookLock(t *testing.T) {
	_, m := newLoop(t, 8*gib)
	m.liveTree(t, "r1", "idle", RoleWorker)
	c, w := m.liveTree(t, "r1", "w", RoleWorker)
	tickN(m, 1)
	var read atomic.Bool
	c.SetCacheExpiry(func() (time.Time, bool) {
		LiveClaimsForTest()
		read.Store(true)
		return freshCache()
	})
	m.setUse(w, idleUse+2*gib)
	m.free.Store(lowWater - mib)

	done := make(chan struct{})
	go func() {
		tick()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the tick deadlocked: it read the cache expiry holding book.mu")
	}
	if got := m.suspends(); !read.Load() || !slices.Equal(got, []jobobject.Owner{w}) {
		t.Fatalf("expiry read %v, paused %v; want true and %v", read.Load(), got, w)
	}
}

func TestNeverPauseLastTree(t *testing.T) {
	rec, m := newLoop(t, 8*gib)
	m.spikingWorker(t, "r1", "w1")
	tickN(m, 1)
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
	_, b := m.spikingWorker(t, "r1", "b")
	_, c := m.spikingWorker(t, "r1", "c")
	tickN(m, 1)
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
	_, w := m.spikingWorker(t, "r1", "w")
	// a plan command stays unpaused, so the worker is never the last tree and is the only pausable one
	verify := jobobject.Owner{Kind: jobobject.OwnerKind_RunCmd, Id: "r1", Cmd: "Verify"}
	restore := UncapForTest()
	vc, _ := TryAdmit(Request{Tag: Tag{Role: "Verify"}, Owner: verify})
	restore()
	defer vc.Release()
	m.setLive(verify)
	tickN(m, 1)
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

func TestPauseLimitWithoutFreeReading(t *testing.T) {
	rec, m := newLoop(t, 8*gib)
	_, w := m.spikingWorker(t, "r1", "w")
	verify := jobobject.Owner{Kind: jobobject.OwnerKind_RunCmd, Id: "r1", Cmd: "Verify"}
	restore := UncapForTest()
	vc, _ := TryAdmit(Request{Tag: Tag{Role: "Verify"}, Owner: verify})
	restore()
	defer vc.Release()
	m.setLive(verify)
	tickN(m, 1)
	m.free.Store(gib)

	tickN(m, 1)
	if got := m.suspends(); !slices.Equal(got, []jobobject.Owner{w}) {
		t.Fatalf("paused %v, want the worker", got)
	}
	t.Cleanup(SetFreeForTest(func() (uint64, error) { return 0, errors.New("unreadable") }))
	m.advance(pauseLimit)
	tickN(m, 1)
	resumed := rec.ofKind(EventResumed)
	if len(resumed) != 1 || resumed[0].Reason != ReasonLimit {
		t.Fatalf("resumed events %+v, want one with reason limit", resumed)
	}
	if got := m.resumes(); !slices.Equal(got, []jobobject.Owner{w}) {
		t.Fatalf("resumed %v, want the worker", got)
	}
}

func TestCloseReleasesBlockClaims(t *testing.T) {
	_, m := newLoop(t, 8*gib)
	_, w := m.liveTree(t, "r1", "w", RoleWorker)
	verify := jobobject.Owner{Kind: jobobject.OwnerKind_RunCmd, Id: "r1", Cmd: "Verify"}
	restore := UncapForTest()
	vc, _ := TryAdmit(Request{Tag: Tag{Role: "Verify"}, Owner: verify})
	restore()
	defer vc.Release()
	tickN(m, 1)

	m.gone(w)
	onJobClosed(w, 0)
	if got := LiveClaimsForTest(); got != 1 {
		t.Fatalf("%d live claims after the block closed, want only the plan command's", got)
	}

	// a plan command's claim is its caller's to release
	onJobClosed(verify, 0)
	if got := LiveClaimsForTest(); got != 1 {
		t.Fatalf("%d live claims after the plan command's job closed, want 1", got)
	}
}

// the 2026-11-13 06:00 stall: two running workers each reserved their learned peak (4.84 GB, a typecheck spike) for
// their whole working life while using about 0.4 GB, so four tasks were held with 7.7 GB available. Running trees
// owe nothing beyond what the reading already shows: available memory covering its estimate admits the next.
func TestRunningTreesThatUseLittleDoNotBlock(t *testing.T) {
	_, m := newLoop(t, 7700*mib)
	m.liveTree(t, "r1", "w1", RoleWorker)
	m.liveTree(t, "r2", "w2", RoleWorker)
	tickN(m, 1) // the loop sees both jobs: their startup allowances end

	c, ok := TryAdmit(Request{Tag: Tag{"r2", "w3", RoleWorker, ""}})
	if !ok {
		t.Fatal("a third worker was refused with 7.7 GB available beside two running workers")
	}
	c.Release()
}

// a just-admitted tree counts its estimate only until the loop sees its job, or startupGrace passes when it never
// will; then the room hook ticks the runs whose trees were held on it
func TestStartupAllowanceEndsOnSeenOrGrace(t *testing.T) {
	rec, m := newLoop(t, 4*gib)
	wk := Key{Role: RoleWorker}
	restore := UncapForTest()
	seen := mustAdmit(t, Request{Key: wk, Tag: Tag{"r1", "a", RoleWorker, ""}, Owner: block("a")})
	restore()
	defer seen.Release()
	held := Request{Key: wk, Tag: Tag{"r1", "b", RoleWorker, ""}}
	if _, ok := TryAdmit(held); ok {
		t.Fatal("admitted beside a starting tree with 4 GiB free")
	}

	m.setLive(block("a"))
	tickN(m, 1)
	if got := rec.roomCalls(); len(got) != 1 || !slices.Equal(got[0], []string{"r1"}) {
		t.Fatalf("room calls once the starting tree was seen: %v, want [[r1]]", got)
	}
	unseen := mustAdmit(t, held)
	defer unseen.Release()

	// an unbound claim is never seen: its allowance ends at startupGrace
	if _, ok := TryAdmit(Request{Key: wk, Tag: Tag{"r2", "c", RoleWorker, ""}}); ok {
		t.Fatal("admitted beside a starting unbound tree with 4 GiB free")
	}
	m.clock = unseen.admitted.Add(startupGrace - time.Second)
	tick()
	if _, ok := TryAdmit(Request{Key: wk, Tag: Tag{"r2", "c", RoleWorker, ""}}); ok {
		t.Fatal("an unseen tree stopped counting its allowance before startupGrace")
	}
	m.clock = unseen.admitted.Add(startupGrace)
	tick()
	if got := rec.roomCalls(); len(got) != 2 || !slices.Equal(got[1], []string{"r2"}) {
		t.Fatalf("room calls after startupGrace: %v, want a second with [r2]", got)
	}
	c := mustAdmit(t, Request{Key: wk, Tag: Tag{"r2", "c", RoleWorker, ""}})
	c.Release()
}

// admitting on available memory lets trees start that may spike together: the loop's pause on low water is the
// guard, and it still pauses once their use takes available memory below it
func TestLowWaterPausesTreesAdmittedOnTheirEstimate(t *testing.T) {
	rec, m := newLoop(t, 8*gib)
	for _, id := range []string{"a", "b"} {
		o := block(id)
		c := mustAdmit(t, Request{Tag: Tag{"r1", id, RoleWorker, ""}, Owner: o})
		c.SetCacheExpiry(freshCache)
		m.setLive(o)
		tickN(m, 1)
	}
	m.setUse(block("a"), idleUse+2*gib)
	m.setUse(block("b"), idleUse+2*gib)
	m.free.Store(lowWater - mib)
	tickN(m, 1)
	if got := rec.ofKind(EventPaused); len(got) != 1 || got[0].Tag.TaskId != "b" {
		t.Fatalf("paused events %+v, want the newest worker paused below low water", got)
	}
}

func TestReleaseOwnerResumesAPausedTreeAndSparesOthers(t *testing.T) {
	rec, m := newLoop(t, 8*gib)
	_, a := m.spikingWorker(t, "r1", "a")
	_, b := m.spikingWorker(t, "r1", "b")
	tickN(m, 1)
	m.free.Store(gib)
	tickN(m, 1) // pauses b, the most recent

	ReleaseOwner(b)
	if got := m.resumes(); len(got) != 1 || got[0] != b {
		t.Fatalf("resumed %v, want the released paused tree %v", got, b)
	}
	resumed := rec.ofKind(EventResumed)
	if len(resumed) != 1 || resumed[0].Reason != ReasonDone || resumed[0].Tag.TaskId != "b" {
		t.Fatalf("resumed events after releasing a paused tree: %+v", resumed)
	}
	if got := LiveClaimsForTest(); got != 1 {
		t.Fatalf("%d live claims, want only %v's", got, a)
	}
	ReleaseOwner(b) // idempotent
	if got := LiveClaimsForTest(); got != 1 {
		t.Fatalf("a second release changed the book: %d claims", got)
	}
}

func TestPausedTreeExit(t *testing.T) {
	rec, m := newLoop(t, 8*gib)
	m.liveTree(t, "r1", "a", RoleWorker)
	_, b := m.spikingWorker(t, "r1", "b")
	_, c := m.spikingWorker(t, "r1", "c")
	tickN(m, 1)
	m.free.Store(gib)
	tickN(m, 2) // pauses c, then b

	m.gone(c)
	onJobClosed(c, 0)
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
	dead, _ := TryAdmit(Request{Tag: Tag{Role: RoleWorker}, Owner: block("dead")})
	stale, _ := TryAdmit(Request{Tag: Tag{Role: RoleWorker}, Owner: block("stale")})
	unbound, _ := TryAdmit(Request{Tag: Tag{Role: RoleWorker}})
	restore()
	defer unbound.Release()
	isLive := func(c *Claim) bool {
		book.mu.Lock()
		defer book.mu.Unlock()
		_, ok := book.claims[c]
		return ok
	}

	m.setLive(block("dead"))
	tickN(m, 1)
	book.mu.Lock()
	wasSeen := dead.seen
	book.mu.Unlock()
	if !wasSeen {
		t.Fatal("a claim whose job is live was not marked seen")
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
	live := mustAdmit(t, req("", "a")) // empty book: always starts
	defer live.Release()
	if _, ok := TryAdmit(req("r1", "b")); ok {
		t.Fatal("admitted with 1 GiB free and a claim live")
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

// a key is remembered from bind to its job's close; a claim dropped because its job never registered gets no close,
// so its key goes with it, while a seen claim dropped as gone keeps its key for the close that follows
func TestNeverSeenClaimForgetsItsKey(t *testing.T) {
	_, m := newLoop(t, 8*gib)
	k := Key{"c:\\proj", RoleWorker}
	restore := UncapForTest()
	ghost := mustAdmit(t, Request{Key: k, Tag: Tag{"r1", "ghost", RoleWorker, ""}, Owner: block("ghost")})
	restore()
	m.clock = ghost.boundAt.Add(bindStale)
	tickN(m, 1)
	if !ghost.released {
		t.Fatal("a claim whose job never appeared was not dropped")
	}
	book.mu.Lock()
	n := len(book.ownerKeys)
	book.mu.Unlock()
	if n != 0 {
		t.Fatalf("%d remembered keys after the never-seen claim was dropped, want 0", n)
	}

	o := block("seen")
	restore = UncapForTest()
	mustAdmit(t, Request{Key: k, Tag: Tag{"r1", "seen", RoleWorker, ""}, Owner: o})
	restore()
	m.setLive(o)
	tickN(m, 1)
	m.gone(o)
	tickN(m, 1)
	book.mu.Lock()
	_, kept := book.ownerKeys[o]
	book.mu.Unlock()
	if LiveClaimsForTest() != 0 || !kept {
		t.Fatalf("after a seen job left live usage: %d claims, key kept %v; want 0 and true", LiveClaimsForTest(), kept)
	}
	onJobClosed(o, 5*gib)
	flush()
	book.mu.Lock()
	n = len(book.ownerKeys)
	book.mu.Unlock()
	if n != 0 || Estimate(k) != 5*gib {
		t.Fatalf("after the close: %d remembered keys, estimate %d; want 0 and the 5 GiB peak", n, Estimate(k))
	}
}
