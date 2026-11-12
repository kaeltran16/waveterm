// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memgate

import (
	"context"
	"errors"
	"os"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/util/jobobject"
)

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "memgate-test")
	if err != nil {
		panic(err)
	}
	SetStoreDirForTest(dir)
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

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

func req(runId, taskId string, need uint64) Request {
	return Request{Key: Key{"c:\\proj", RoleWorker}, Need: need, Tag: Tag{runId, taskId, RoleWorker}}
}

func mustAdmit(t *testing.T, r Request) *Claim {
	t.Helper()
	c, ok := TryAdmit(r)
	if !ok {
		t.Fatalf("TryAdmit(%v, need %d) refused", r.Tag, r.Need)
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

func TestAdmitByFreeLessOwed(t *testing.T) {
	newGate(t, 8*gib)
	live := mustAdmit(t, req("", "a", 3*gib))
	defer live.Release()
	c := mustAdmit(t, req("", "b", 4*gib))
	c.Release()
	if _, ok := TryAdmit(req("", "c", 6*gib)); ok {
		t.Fatal("6 GiB admitted with 8 GiB free and 3 GiB owed")
	}
}

func TestOneTreeAlwaysStarts(t *testing.T) {
	newGate(t, gib)
	c := mustAdmit(t, req("", "a", 3584*mib))
	defer c.Release()
	if _, ok := TryAdmit(req("", "b", 3584*mib)); ok {
		t.Fatal("second tree admitted with 1 GiB free and one claim live")
	}
}

func TestHeldOncePerTransition(t *testing.T) {
	rec := newGate(t, 8*gib)
	live := mustAdmit(t, req("", "a", 6*gib))
	r := req("run1", "t1", 4*gib)
	for range 3 {
		if _, ok := TryAdmit(r); ok {
			t.Fatal("admitted behind a 6 GiB claim with 8 GiB free")
		}
	}
	live.Release()
	c := mustAdmit(t, r)
	defer c.Release()
	if got := rec.kinds(); !slices.Equal(got, []EventKind{EventHeld, EventAdmitted}) {
		t.Fatalf("events = %v, want [held admitted]", got)
	}
	held := rec.events[0]
	if held.Tag != r.Tag || held.Free != 2*gib || held.Need != 4*gib {
		t.Fatalf("held event = %+v, want tag %v, free 2 GiB, need 4 GiB", held, r.Tag)
	}
}

func TestWaitAdmitsOnRelease(t *testing.T) {
	newGate(t, 8*gib)
	noRecheck(t)
	live := mustAdmit(t, req("", "a", 6*gib))
	done := make(chan *Claim)
	go func() {
		c, err := Wait(context.Background(), req("run1", "", 4*gib))
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
	rec := newGate(t, 8*gib)
	noRecheck(t)
	live := mustAdmit(t, req("", "a", 6*gib))
	defer live.Release()
	ctx, cancel := context.WithCancel(context.Background())
	type result struct {
		c   *Claim
		err error
	}
	done := make(chan result)
	go func() {
		c, err := Wait(ctx, req("run1", "", 4*gib))
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
	r := req("run1", "t2", 4*gib)
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
	rec := newGate(t, 8*gib)
	a := mustAdmit(t, req("", "a", 6*gib))
	r := req("run1", "t1", 4*gib)
	if _, ok := TryAdmit(r); ok {
		t.Fatal("admitted behind a 6 GiB claim with 8 GiB free")
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
	unbound := mustAdmit(t, req("", "a", gib))
	bound := mustAdmit(t, req("", "b", gib))
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
	newGate(t, 8*gib)
	noRecheck(t)
	big := mustAdmit(t, req("", "big", 6*gib))
	defer big.Release()
	small := mustAdmit(t, req("", "small", mib))
	done := make(chan *Claim)
	go func() {
		c, err := Wait(context.Background(), req("run1", "", 3*gib))
		if err != nil {
			t.Error(err)
		}
		done <- c
	}()
	waitQueued(t, 1)

	setFree(t, 9*gib+mib) // room for exactly one 3 GiB tree, with nothing waking the Wait
	if _, ok := TryAdmit(req("run2", "t1", 3*gib)); ok {
		t.Fatal("TryAdmit took the room a queued Wait is waiting for")
	}
	small.Release()
	select {
	case c := <-done:
		c.Release()
	case <-time.After(5 * time.Second):
		t.Fatal("queued Wait not admitted")
	}
}
