// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memgate

import (
	"bytes"
	"errors"
	"log"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/util/jobobject"
)

type recorder struct {
	mu     sync.Mutex
	events []Event
	rooms  [][]string
}

// newGate gives a test an empty book, free memory of free bytes and a recorder of events and room calls.
func newGate(t *testing.T, free uint64) *recorder {
	t.Helper()
	book.mu.Lock()
	book.claims = make(map[*Claim]struct{})
	book.held = make(map[Tag]time.Time)
	book.ownerKeys = make(map[jobobject.Owner]*ownerKey)
	book.freeFailing = false
	book.mu.Unlock()
	t.Cleanup(SetStoreDirForTest(t.TempDir()))
	t.Cleanup(SetFreeForTest(func() (uint64, error) { return free, nil }))
	// events still queued by an earlier test would land in this test's recorder
	flush()
	rec := &recorder{}
	SetEventSink(func(ev Event) {
		rec.mu.Lock()
		defer rec.mu.Unlock()
		rec.events = append(rec.events, ev)
	})
	SetRoomHook(func(runIds []string) {
		rec.mu.Lock()
		defer rec.mu.Unlock()
		rec.rooms = append(rec.rooms, runIds)
	})
	t.Cleanup(func() {
		flush()
		SetEventSink(nil)
		SetRoomHook(nil)
	})
	return rec
}

// flush waits until everything enqueued so far has been delivered.
func flush() {
	done := make(chan struct{})
	enqueue(func() { close(done) })
	<-done
}

func (r *recorder) kinds() []EventKind {
	flush()
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []EventKind
	for _, ev := range r.events {
		out = append(out, ev.Kind)
	}
	return out
}

func (r *recorder) roomCalls() [][]string {
	flush()
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.rooms)
}

func setFree(t *testing.T, free uint64) {
	t.Cleanup(SetFreeForTest(func() (uint64, error) { return free, nil }))
}

func req(runId, taskId string) Request {
	return Request{Key: Key{Role: RoleWorker}, Tag: Tag{runId, taskId, RoleWorker}}
}

func mustAdmit(t *testing.T, r Request) *Claim {
	t.Helper()
	c, ok := TryAdmit(r)
	if !ok {
		t.Fatalf("TryAdmit(%v) refused", r.Tag)
	}
	return c
}

// markSeen marks c as seen by the loop, so it no longer counts its estimate against available memory.
func markSeen(c *Claim) {
	book.mu.Lock()
	defer book.mu.Unlock()
	c.seen = true
}

// a burst of admissions in one tick must not all count on the same free memory: each starting tree owes its own
// median until the loop sees its job
func TestStartingClaimCountsItsMedian(t *testing.T) {
	newGate(t, 5*gib)
	k := Key{"c:\\proj", RoleWorker}
	for range 3 {
		Record(k, 2*gib)
	}
	var admitted []*Claim
	defer func() {
		for _, c := range admitted {
			c.Release()
		}
	}()
	for _, id := range []string{"a", "b", "c", "d"} {
		if c, ok := TryAdmit(Request{Key: k, Tag: Tag{"", id, RoleWorker}}); ok {
			admitted = append(admitted, c)
		}
	}
	// 5 GiB: the first starts (5 free), the second fits beside one 2 GiB median (3 free), the third would not (1 free)
	if len(admitted) != 2 {
		t.Fatalf("one tick admitted %d trees on 5 GiB free with a 2 GiB median, want 2", len(admitted))
	}
	for _, c := range admitted {
		markSeen(c)
	}
	c, ok := TryAdmit(Request{Key: k, Tag: Tag{"", "c", RoleWorker}})
	if !ok {
		t.Fatal("a seen tree still counted its median against the next admission")
	}
	admitted = append(admitted, c)
}

func TestOneTreeAlwaysStarts(t *testing.T) {
	newGate(t, gib)
	c := mustAdmit(t, req("", "a"))
	defer c.Release()
	if _, ok := TryAdmit(req("", "b")); ok {
		t.Fatal("second tree admitted with 1 GiB free and one claim live")
	}
}

func TestHeldOncePerTransition(t *testing.T) {
	rec := newGate(t, 4*gib)
	live := mustAdmit(t, req("", "a"))
	r := req("run1", "t1")
	for range 3 {
		if _, ok := TryAdmit(r); ok {
			t.Fatal("admitted beside a starting tree with 4 GiB free")
		}
	}
	live.Release()
	c := mustAdmit(t, r)
	defer c.Release()
	if got := rec.kinds(); !slices.Equal(got, []EventKind{EventHeld, EventAdmitted}) {
		t.Fatalf("events = %v, want [held admitted]", got)
	}
	held := rec.events[0]
	need := Estimate(r.Key)
	if held.Tag != r.Tag || held.Free != 4*gib-need || held.Need != need {
		t.Fatalf("held event = %+v, want tag %v, free 4 GiB less a starting worker, need the estimate %d", held, r.Tag, need)
	}
}

func TestUnreadableFreeLogsOncePerTransition(t *testing.T) {
	newGate(t, 8*gib)
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	var failing atomic.Bool
	readFree := func() (uint64, error) {
		if failing.Load() {
			return 0, errors.New("unreadable")
		}
		return 8 * gib, nil
	}
	t.Cleanup(SetFreeForTest(readFree))
	check := func() {
		c := mustAdmit(t, req("r1", "a"))
		c.Release()
	}

	failing.Store(true)
	check()
	check()
	check()
	failing.Store(false)
	check()
	check()
	failing.Store(true)
	check()

	got := strings.Count(buf.String(), "memgate: reading free memory")
	if got != 3 {
		t.Fatalf("logged %d free-memory lines, want 3 (fail, recover, fail):\n%s", got, buf.String())
	}
}

func TestHoldMarksWithoutAdmitting(t *testing.T) {
	rec := newGate(t, 64*gib)
	r := req("run1", "t2")
	Hold(r)
	Hold(r)
	if got := rec.kinds(); !slices.Equal(got, []EventKind{EventHeld}) {
		t.Fatalf("events = %v, want [held]", got)
	}
	if n := LiveClaimsForTest(); n != 0 {
		t.Fatalf("book holds %d claims, want 0", n)
	}
}

func TestRoomHookOnRelease(t *testing.T) {
	rec := newGate(t, 4*gib)
	a := mustAdmit(t, req("", "a"))
	r := req("run1", "t1")
	if _, ok := TryAdmit(r); ok {
		t.Fatal("admitted beside a starting tree with 4 GiB free")
	}
	a.Release()
	if got := rec.roomCalls(); len(got) != 1 || !slices.Equal(got[0], []string{"run1"}) {
		t.Fatalf("room calls = %v, want [[run1]]", got)
	}

	c := mustAdmit(t, r) // no longer held
	c.Release()
	if got := rec.roomCalls(); len(got) != 1 {
		t.Fatalf("room calls = %v, want none after the first with nothing held", got)
	}
}

func TestReleaseIfUnbound(t *testing.T) {
	newGate(t, 64*gib)
	unbound := mustAdmit(t, req("", "a"))
	bound := mustAdmit(t, req("", "b"))
	bound.Bind(jobobject.Owner{Kind: jobobject.OwnerKind_Block, Id: "blk"})
	unbound.ReleaseIfUnbound()
	unbound.ReleaseIfUnbound()
	bound.ReleaseIfUnbound()
	var nilClaim *Claim
	nilClaim.ReleaseIfUnbound()
	if n := LiveClaimsForTest(); n != 1 {
		t.Fatalf("book holds %d claims, want the bound one only", n)
	}
	bound.Release()
	bound.Release()
	nilClaim.Release()
	if n := LiveClaimsForTest(); n != 0 {
		t.Fatalf("book holds %d claims after release, want 0", n)
	}
}

const gbDec = uint64(1_000_000_000)

func TestMedianAdmitsWithinFree(t *testing.T) {
	rec := newGate(t, 5*gbDec)
	k := Key{"c:\\waveterm", RoleWorker}
	for _, p := range []uint64{4600, 4800, 4200, 4100, 5300} {
		Record(k, p*gbDec/1000)
	}
	running := mustAdmit(t, req("", "running"))
	defer running.Release()
	markSeen(running)

	c, ok := TryAdmit(Request{Key: k, Tag: Tag{"run1", "t1", RoleWorker}})
	if !ok {
		t.Fatal("a 4.6 GB median was refused with 5.0 GB free")
	}
	c.Release()

	setFree(t, 4500*gbDec/1000)
	r := Request{Key: k, Tag: Tag{"run1", "t2", RoleWorker}}
	if _, ok := TryAdmit(r); ok {
		t.Fatal("a 4.6 GB median was admitted with 4.5 GB free")
	}
	held := rec.ofKind(EventHeld)
	if len(held) != 1 || held[0].Tag != r.Tag || held[0].Need != 4600*gbDec/1000 {
		t.Fatalf("held events %+v, want one for %v needing the 4.6 GB median", held, r.Tag)
	}
}

func TestAdmitNeverHolds(t *testing.T) {
	rec := newGate(t, 0)
	blocker := mustAdmit(t, req("", "blocker"))
	defer blocker.Release()
	verify := Admit(Request{Key: Key{"c:\\proj", "Verify"}, Tag: Tag{"run1", "", "Verify"}})
	if verify == nil {
		t.Fatal("Admit returned no claim")
	}
	defer verify.Release()
	if got := rec.kinds(); len(got) != 0 {
		t.Fatalf("Admit emitted %v, want nothing", got)
	}
	if n := LiveClaimsForTest(); n != 2 {
		t.Fatalf("book holds %d claims, want the blocker and the admitted command", n)
	}

	// room for one worker, but not beside the starting command's 3.5 GiB default
	markSeen(blocker)
	setFree(t, 5*gib)
	if _, ok := TryAdmit(req("", "w")); ok {
		t.Fatal("a worker was admitted onto memory a starting plan command is about to use")
	}
}

func TestSetCacheExpiryIsNilSafe(t *testing.T) {
	newGate(t, 64*gib)
	fn := func() (time.Time, bool) { return time.Time{}, false }
	var nilClaim *Claim
	nilClaim.SetCacheExpiry(fn)
	if HasCacheExpiryForTest(nilClaim) {
		t.Fatal("a nil claim reports a cache expiry")
	}
	c := mustAdmit(t, req("", "a"))
	defer c.Release()
	if HasCacheExpiryForTest(c) {
		t.Fatal("a fresh claim reports a cache expiry")
	}
	c.SetCacheExpiry(fn)
	if !HasCacheExpiryForTest(c) {
		t.Fatal("SetCacheExpiry did not store the function")
	}
}

func TestPeakRecordedOnClose(t *testing.T) {
	newGate(t, 64*gib)
	k := Key{"c:\\proj", RoleWorker}
	o := block("a")
	c := mustAdmit(t, Request{Key: k, Tag: Tag{"r1", "a", RoleWorker}, Owner: o})
	onJobClosed(o, 5*gib)
	flush()
	if got := Estimate(k); got != 5*gib {
		t.Fatalf("estimate after close = %d, want the 5 GiB peak", got)
	}
	if !c.released {
		t.Fatal("a block claim stayed in the book after its job closed")
	}

	// two live jobs under one owner both record
	k2 := Key{"c:\\proj", RoleReviewer}
	o2 := block("twice")
	for range 2 {
		mustAdmit(t, Request{Key: k2, Tag: Tag{"r1", "b", RoleReviewer}, Owner: o2})
	}
	onJobClosed(o2, 2*gib)
	onJobClosed(o2, 4*gib)
	onJobClosed(o2, 9*gib) // no bind left for it
	flush()
	if got := Estimate(k2); got != 3*gib {
		t.Fatalf("estimate after two closes = %d, want the median of 2 and 4 GiB", got)
	}

	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	onJobClosed(block("never-bound"), 7*gib)
	flush()
	if buf.Len() != 0 {
		t.Fatalf("a close for an owner no claim bound logged: %s", buf.String())
	}
	if got := Estimate(k); got != 5*gib {
		t.Fatalf("a close for an unbound owner changed the estimate to %d", got)
	}
}

func TestPeakRecordedAfterEarlyRelease(t *testing.T) {
	newGate(t, 64*gib)
	k := Key{"c:\\proj", RoleWorker}
	o := block("done")
	c := mustAdmit(t, Request{Key: k, Tag: Tag{"r1", "a", RoleWorker}})
	c.Bind(o)
	ReleaseOwner(o) // the run went done; its lane is reaped later
	if n := LiveClaimsForTest(); n != 0 {
		t.Fatalf("book holds %d claims after ReleaseOwner", n)
	}
	onJobClosed(o, 6*gib)
	flush()
	if got := Estimate(k); got != 6*gib {
		t.Fatalf("estimate after a close past the release = %d, want the 6 GiB peak", got)
	}
}
