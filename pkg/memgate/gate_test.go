// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memgate

import (
	"bytes"
	"context"
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
	book.waiters = nil
	book.freeFailing = false
	book.mu.Unlock()
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
	return Request{Tag: Tag{runId, taskId, RoleWorker}}
}

func mustAdmit(t *testing.T, r Request) *Claim {
	t.Helper()
	c, ok := TryAdmit(r)
	if !ok {
		t.Fatalf("TryAdmit(%v) refused", r.Tag)
	}
	return c
}

// waitQueued waits until n Waits are queued in the book.
func waitQueued(t *testing.T, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		book.mu.Lock()
		got := len(book.waiters)
		book.mu.Unlock()
		if got == n {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("%d Waits never queued", n)
}

// noRecheck makes a Release the only thing that wakes a Wait.
func noRecheck(t *testing.T) {
	old := waitRecheck
	waitRecheck = time.Hour
	t.Cleanup(func() { waitRecheck = old })
}

// a burst of admissions in one tick must not all count on the same free memory: each starting tree holds a Headroom
// until its memory shows in the reading
func TestStartupAllowanceBoundsABurst(t *testing.T) {
	newGate(t, 7*gib)
	var admitted []*Claim
	for _, id := range []string{"a", "b", "c", "d", "e"} {
		if c, ok := TryAdmit(req("", id)); ok {
			admitted = append(admitted, c)
		}
	}
	defer func() {
		for _, c := range admitted {
			c.Release()
		}
	}()
	// 7 GiB: the first starts (7 free), the second fits beside one allowance (4 free), the third would not (1 free)
	if len(admitted) != 2 {
		t.Fatalf("one tick admitted %d trees on 7 GiB free, want 2", len(admitted))
	}
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
	if held.Tag != r.Tag || held.Free != gib || held.Need != Headroom {
		t.Fatalf("held event = %+v, want tag %v, free 1 GiB, need the Headroom", held, r.Tag)
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

func TestWaitAdmitsOnRelease(t *testing.T) {
	newGate(t, 4*gib)
	noRecheck(t)
	live := mustAdmit(t, req("", "a"))
	done := make(chan *Claim)
	go func() {
		c, err := Wait(context.Background(), req("run1", ""))
		if err != nil {
			t.Error(err)
		}
		done <- c
	}()
	waitQueued(t, 1)
	select {
	case <-done:
		t.Fatal("Wait returned with the claim still live")
	case <-time.After(50 * time.Millisecond):
	}
	live.Release()
	select {
	case c := <-done:
		if c == nil {
			t.Fatal("nil claim")
		}
		c.Release()
	case <-time.After(5 * time.Second):
		t.Fatal("Wait still blocked after the release")
	}
}

func TestWaitCancel(t *testing.T) {
	rec := newGate(t, 4*gib)
	noRecheck(t)
	live := mustAdmit(t, req("", "a"))
	defer live.Release()
	ctx, cancel := context.WithCancel(context.Background())
	type result struct {
		c   *Claim
		err error
	}
	done := make(chan result)
	go func() {
		c, err := Wait(ctx, req("run1", ""))
		done <- result{c, err}
	}()
	waitQueued(t, 1)
	cancel()
	select {
	case res := <-done:
		if res.c != nil || !errors.Is(res.err, context.Canceled) {
			t.Fatalf("Wait = (%v, %v), want (nil, context.Canceled)", res.c, res.err)
		}
	case <-time.After(time.Second):
		t.Fatal("Wait not returned after cancel")
	}
	if got := rec.kinds(); !slices.Equal(got, []EventKind{EventHeld}) {
		t.Fatalf("events = %v, want [held]", got)
	}
	if n := LiveClaimsForTest(); n != 1 {
		t.Fatalf("book holds %d claims, want 1", n)
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

func TestTryAdmitYieldsToQueuedWait(t *testing.T) {
	newGate(t, 4*gib)
	noRecheck(t)
	live := mustAdmit(t, req("", "a"))
	done := make(chan *Claim)
	go func() {
		c, err := Wait(context.Background(), req("run1", ""))
		if err != nil {
			t.Error(err)
		}
		done <- c
	}()
	waitQueued(t, 1)

	// room for one more tree beside the starting one, with nothing waking the Wait: it is the Wait's
	setFree(t, 2*Headroom+gib)
	if _, ok := TryAdmit(req("run2", "t1")); ok {
		t.Fatal("TryAdmit took the room a queued Wait is waiting for")
	}
	live.Release()
	select {
	case c := <-done:
		c.Release()
	case <-time.After(5 * time.Second):
		t.Fatal("queued Wait not admitted")
	}
}
