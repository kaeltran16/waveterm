// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package memgate holds trees Arc starts at the door until available memory covers one tree's spike, and (in the
// reconciliation loop) pauses background trees when available memory still runs low.
package memgate

import (
	"context"
	"log"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shirou/gopsutil/v4/mem"
	"github.com/wavetermdev/waveterm/pkg/util/jobobject"
)

const (
	RoleWorker   = "worker"
	RoleReviewer = "reviewer"
)

const (
	mib = uint64(1) << 20
	gib = uint64(1) << 30
)

// Headroom is the available memory a tree is admitted on: one worker's spike, its claude plus a typecheck. It is
// fixed, not learned per tree: a learned peak reserved for a tree's whole life idled the machine while the tree used
// a fraction of it. The loop's pause on low water is what guards against spikes that land together.
const Headroom = 3 * gib

// startupGrace bounds how long a just-admitted tree counts a Headroom against available memory when the loop never
// sees its job (an unbound claim, or no job objects on this OS): long enough for its memory to show in the reading.
const startupGrace = 30 * time.Second

// Tag is where events about a tree go, and its Role whether the loop may pause it. RunId "" = no events.
type Tag struct{ RunId, TaskId, Role string }

type Request struct {
	Tag   Tag
	Owner jobobject.Owner // zero when bound later with Claim.Bind
}

type EventKind string

const (
	EventHeld     EventKind = "held"
	EventAdmitted EventKind = "admitted"
	EventPaused   EventKind = "paused"
	EventResumed  EventKind = "resumed"
)

type Event struct {
	Kind   EventKind
	Tag    Tag
	Free   uint64 // bytes the gate saw free: available less the startup allowances and a queued Wait's Headroom
	Need   uint64 // bytes: held, the Headroom; paused, the high watermark
	Reason string // resumed: memory | limit | exited
	Ms     int64  // admitted: time held; resumed: time paused
}

// Claim is an admitted tree's place in the book. It counts against available memory only while it starts.
type Claim struct {
	tag      Tag
	owner    jobobject.Owner
	bound    bool
	boundAt  time.Time
	admitted time.Time
	released bool

	// the reconciliation loop's view of the tree
	seen          bool // its job has appeared in a live usage read
	settled       bool // its startup allowance has ended and the loop has announced the room
	paused        bool
	pausedAt      time.Time
	noPauseBefore time.Time // after a pause hits its limit
}

// startingLocked is whether c still counts a Headroom against available memory: until its job shows up its memory
// may not be in the reading yet, and without the allowance one tick could admit a burst onto the same free memory.
func (c *Claim) startingLocked(t time.Time) bool {
	return !c.seen && t.Sub(c.admitted) < startupGrace
}

// waiter is a queued Wait; its tag also keeps it non-zero-sized, so each waiter's pointer is distinct.
type waiter struct{ tag Tag }

// waitRecheck bounds how long a Wait sleeps without a Release: free memory can rise with nothing in the book
// changing. A var so tests can make a release the only wake.
var waitRecheck = 2 * time.Second

// now is the clock; a var so tests can step it past the loop's limits.
var now = time.Now

// freeMem is the machine's available memory; a var so tests can stand in for the machine.
var freeMem = func() (uint64, error) {
	vm, err := mem.VirtualMemory()
	if err != nil {
		return 0, err
	}
	return vm.Available, nil
}

var book = struct {
	mu      sync.Mutex
	claims  map[*Claim]struct{}
	held    map[Tag]time.Time // tags refused or held, and since when
	waiters []*waiter         // queued Waits, oldest first
	room    chan struct{}     // closed (and replaced) whenever room may have freed
	// freeFailing is whether the last free-memory read failed, so a failing read logs once, not per check
	freeFailing bool
}{
	claims: make(map[*Claim]struct{}),
	held:   make(map[Tag]time.Time),
	room:   make(chan struct{}),
}

// readFreeLocked reads available memory, logging only when the read starts or stops failing: admission checks
// and loop ticks read it far too often to log each failure.
func readFreeLocked() (uint64, error) {
	avail, err := freeMem()
	switch {
	case err != nil && !book.freeFailing:
		log.Printf("memgate: reading free memory, admitting all and pausing nothing until it reads again: %v", err)
	case err == nil && book.freeFailing:
		log.Printf("memgate: reading free memory again")
	}
	book.freeFailing = err != nil
	return avail, err
}

// freeLocked is available memory less a Headroom per starting claim, and less one for the oldest queued Wait unless
// self is that Wait: without it, worker and reviewer TryAdmits racing each room kick could starve a blocked plan
// command. A running tree's use is already out of the reading, so it owes nothing more.
func freeLocked(self *waiter) uint64 {
	avail, err := readFreeLocked()
	if err != nil {
		// the gate guards the machine, it is not a correctness rule: an unreadable reading must not stop work
		return ^uint64(0)
	}
	var owed uint64
	t := now()
	for c := range book.claims {
		if c.startingLocked(t) {
			owed += Headroom
		}
	}
	if len(book.waiters) > 0 && book.waiters[0] != self {
		owed += Headroom
	}
	if owed >= avail {
		return 0
	}
	return avail - owed
}

// fitsLocked is the admission rule: free covers a Headroom. With the book empty one tree always starts, so memory
// used outside Arc slows runs instead of stalling them; a queued Wait is that tree when there is one.
func fitsLocked(self *waiter) (bool, uint64) {
	free := freeLocked(self)
	if len(book.claims) == 0 && (len(book.waiters) == 0 || book.waiters[0] == self) {
		return true, free
	}
	return free >= Headroom, free
}

func admitLocked(r Request) *Claim {
	ts := now()
	c := &Claim{tag: r.Tag, admitted: ts}
	if r.Owner != (jobobject.Owner{}) {
		c.owner, c.bound, c.boundAt = r.Owner, true, ts
	}
	book.claims[c] = struct{}{}
	if since, ok := book.held[r.Tag]; ok {
		delete(book.held, r.Tag)
		emitLocked(Event{Kind: EventAdmitted, Tag: r.Tag, Ms: ts.Sub(since).Milliseconds()})
	}
	return c
}

// holdLocked marks tag held, emitting held only on the transition.
func holdLocked(tag Tag, free uint64) {
	if tag.RunId == "" {
		return
	}
	if _, ok := book.held[tag]; ok {
		return
	}
	book.held[tag] = now()
	emitLocked(Event{Kind: EventHeld, Tag: tag, Free: free, Need: Headroom})
}

// TryAdmit admits r if it fits now and never blocks. A refusal marks r's Tag held.
func TryAdmit(r Request) (*Claim, bool) {
	book.mu.Lock()
	defer book.mu.Unlock()
	ok, free := fitsLocked(nil)
	if !ok {
		holdLocked(r.Tag, free)
		return nil, false
	}
	return admitLocked(r), true
}

// Hold marks r's Tag held without trying it: plan order means a task behind a refused one must not jump ahead.
func Hold(r Request) {
	book.mu.Lock()
	defer book.mu.Unlock()
	holdLocked(r.Tag, freeLocked(nil))
}

// Wait blocks until r is admitted or ctx ends. Waits are admitted oldest first.
func Wait(ctx context.Context, r Request) (*Claim, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	w := &waiter{tag: r.Tag}
	book.mu.Lock()
	book.waiters = append(book.waiters, w)
	for {
		ok, free := fitsLocked(w)
		if ok {
			removeWaiterLocked(w)
			c := admitLocked(r)
			book.mu.Unlock()
			return c, nil
		}
		holdLocked(r.Tag, free)
		room := book.room
		book.mu.Unlock()
		select {
		case <-ctx.Done():
			book.mu.Lock()
			removeWaiterLocked(w)
			delete(book.held, r.Tag) // readers bound a cancelled hold by the owning state
			roomFreedLocked()        // its Headroom no longer counts against the rest
			book.mu.Unlock()
			return nil, ctx.Err()
		case <-room:
		case <-time.After(waitRecheck):
		}
		book.mu.Lock()
	}
}

func removeWaiterLocked(w *waiter) {
	book.waiters = slices.DeleteFunc(book.waiters, func(x *waiter) bool { return x == w })
}

// roomFreedLocked wakes every Wait and calls the room hook with the runs that have a held Tag.
func roomFreedLocked() {
	close(book.room)
	book.room = make(chan struct{})
	var runIds []string
	for tag := range book.held {
		if !slices.Contains(runIds, tag.RunId) {
			runIds = append(runIds, tag.RunId)
		}
	}
	if len(runIds) == 0 {
		return
	}
	slices.Sort(runIds)
	enqueue(func() {
		if fn := roomHook.Load(); fn != nil {
			(*fn)(runIds)
		}
	})
}

// Bind ties the claim to the job its tree runs in, so the loop can follow its use and release it on close.
func (c *Claim) Bind(o jobobject.Owner) {
	if c == nil {
		return
	}
	book.mu.Lock()
	defer book.mu.Unlock()
	c.owner, c.bound, c.boundAt = o, true, now()
}

// Release returns the claim's room to the book. Idempotent and nil-safe.
func (c *Claim) Release() {
	if c == nil {
		return
	}
	book.mu.Lock()
	defer book.mu.Unlock()
	releaseLocked(c)
}

// ReleaseIfUnbound releases the claim only if Bind was never called: a bound claim belongs to its job's close.
// Idempotent and nil-safe.
func (c *Claim) ReleaseIfUnbound() {
	if c == nil {
		return
	}
	book.mu.Lock()
	defer book.mu.Unlock()
	if !c.bound {
		releaseLocked(c)
	}
}

// ReleaseOwner releases every claim bound to o, for a tree that finished its work but stays alive: a harness idles
// at its prompt after reporting done, and its claim would keep it in the book (a non-empty book admits only on
// Headroom) until the job closes. A paused tree is resumed first, since nothing would resume it once its claim is gone.
func ReleaseOwner(o jobobject.Owner) {
	book.mu.Lock()
	defer book.mu.Unlock()
	for c := range book.claims {
		if !c.bound || c.owner != o {
			continue
		}
		if c.paused {
			resumeLocked(c, ReasonDone, 0, now())
		}
		releaseLocked(c)
	}
}

func releaseLocked(c *Claim) {
	if c.released {
		return
	}
	c.released = true
	delete(book.claims, c)
	roomFreedLocked()
}

var (
	eventSink atomic.Pointer[func(Event)]
	roomHook  atomic.Pointer[func(runIds []string)]
)

// SetEventSink sets where events go (nil: nowhere). It is called on memgate's own goroutine, in order.
func SetEventSink(fn func(Event)) {
	if fn == nil {
		eventSink.Store(nil)
		return
	}
	eventSink.Store(&fn)
}

// SetRoomHook sets what is called, on memgate's own goroutine, with the runs that have a held Tag when room frees.
func SetRoomHook(fn func(runIds []string)) {
	if fn == nil {
		roomHook.Store(nil)
		return
	}
	roomHook.Store(&fn)
}

func emitLocked(ev Event) {
	if ev.Tag.RunId == "" {
		return
	}
	enqueue(func() {
		if fn := eventSink.Load(); fn != nil {
			(*fn)(ev)
		}
	})
}

// delivery runs sinks and hooks in order on one goroutine, so a tick or a waiting command never blocks on them.
var delivery = struct {
	mu      sync.Mutex
	queue   []func()
	wake    chan struct{}
	started bool
}{wake: make(chan struct{}, 1)}

func enqueue(f func()) {
	delivery.mu.Lock()
	delivery.queue = append(delivery.queue, f)
	if !delivery.started {
		delivery.started = true
		go deliverLoop()
	}
	delivery.mu.Unlock()
	select {
	case delivery.wake <- struct{}{}:
	default:
	}
}

func deliverLoop() {
	for range delivery.wake {
		for {
			delivery.mu.Lock()
			if len(delivery.queue) == 0 {
				delivery.queue = nil // drop the drained backing array
				delivery.mu.Unlock()
				break
			}
			f := delivery.queue[0]
			delivery.queue = delivery.queue[1:]
			delivery.mu.Unlock()
			f()
		}
	}
}

// UncapForTest makes free memory read as unlimited.
func UncapForTest() (restore func()) {
	return SetFreeForTest(func() (uint64, error) { return ^uint64(0), nil })
}

func SetFreeForTest(fn func() (uint64, error)) (restore func()) {
	book.mu.Lock()
	defer book.mu.Unlock()
	old := freeMem
	freeMem = fn
	return func() {
		book.mu.Lock()
		defer book.mu.Unlock()
		freeMem = old
	}
}

// LiveClaimsForTest is the number of claims in the book.
func LiveClaimsForTest() int {
	book.mu.Lock()
	defer book.mu.Unlock()
	return len(book.claims)
}
