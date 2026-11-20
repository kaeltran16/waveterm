// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package memgate holds new workers at the door until available memory covers the median of their learned peaks,
// counts work that must progress without ever holding it, and (in the reconciliation loop) pauses a spiking worker
// when available memory still runs low.
package memgate

import (
	"cmp"
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

// startupGrace bounds how long a just-admitted tree counts its estimate against available memory when the loop never
// sees its job (an unbound claim, or no job objects on this OS): long enough for its memory to show in the reading.
const startupGrace = 30 * time.Second

// Tag is where events about a tree go, and its Role whether the loop may pause it. RunId "" = no events. TabId names
// a tree an agent started outside any run.
type Tag struct{ RunId, TaskId, Role, TabId string }

// Holder is a claim in the book: Use is its job's last reading, or its estimate while it starts.
type Holder struct {
	Tag Tag
	Use uint64
}

// Shortfall is what a refusal reports: the free memory the gate saw, the request's estimate, and the claims that
// hold memory, largest first.
type Shortfall struct {
	Free, Need uint64
	Holders    []Holder
}

type Request struct {
	Key   Key // what the tree is sized on, and where its peak is recorded at its job's close
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
	Free   uint64 // bytes the gate saw free: available less what starting claims owe
	Need   uint64 // bytes: held, the request's estimate; paused, the high watermark
	Reason string // resumed: memory | limit | exited
	Ms     int64  // admitted: time held; resumed: time paused
}

// Claim is an admitted tree's place in the book. It counts its need against available memory only while it starts.
type Claim struct {
	key      Key
	need     uint64 // Estimate(key) at admission
	tag      Tag
	owner    jobobject.Owner
	bound    bool
	boundAt  time.Time
	admitted time.Time
	released bool

	// the reconciliation loop's view of the tree
	seen          bool   // its job has appeared in a live usage read
	settled       bool   // its startup allowance has ended and the loop has announced the room
	use, prevUse  uint64 // its job's memory at this tick and the last
	floor         uint64 // the lowest it has read since the loop first saw it
	paused        bool
	pausedAt      time.Time
	pauseUntil    time.Time // pauseLimit, or before its prompt cache expires
	noPauseBefore time.Time // after a pause hits its limit
	// when the tree's prompt cache expires; nil or false = unknown
	cacheExpiry func() (time.Time, bool)
}

// startingLocked is whether c still counts its need against available memory: until its job shows up its memory
// may not be in the reading yet, and without the allowance one tick could admit a burst onto the same free memory.
func (c *Claim) startingLocked(t time.Time) bool {
	return !c.seen && t.Sub(c.admitted) < startupGrace
}

// ownerKey is the key a bound owner's peak is recorded under at its job's close, and how many binds still await a
// close: two live jobs under one owner both record.
type ownerKey struct {
	key Key
	n   int
}

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
	mu     sync.Mutex
	claims map[*Claim]struct{}
	held   map[Tag]time.Time // tags refused or held, and since when
	// a bound owner's key outlives its claim: a run's done releases the claim before its lane's job closes
	ownerKeys map[jobobject.Owner]*ownerKey
	// freeFailing is whether the last free-memory read failed, so a failing read logs once, not per check
	freeFailing bool
}{
	claims:    make(map[*Claim]struct{}),
	held:      make(map[Tag]time.Time),
	ownerKeys: make(map[jobobject.Owner]*ownerKey),
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

// freeLocked is available memory less the need of each starting claim. A running tree's use is already out of the
// reading, so it owes nothing more.
func freeLocked() uint64 {
	avail, err := readFreeLocked()
	if err != nil {
		// the gate guards the machine, it is not a correctness rule: an unreadable reading must not stop work
		return ^uint64(0)
	}
	var owed uint64
	t := now()
	for c := range book.claims {
		if c.startingLocked(t) {
			owed += c.need
		}
	}
	if owed >= avail {
		return 0
	}
	return avail - owed
}

// fitsLocked is the admission rule: free covers need. With the book empty one tree always starts, so memory used
// outside Arc slows runs instead of stalling them.
func fitsLocked(need uint64) (bool, uint64) {
	free := freeLocked()
	if len(book.claims) == 0 {
		return true, free
	}
	return free >= need, free
}

func admitLocked(r Request, need uint64) *Claim {
	ts := now()
	c := &Claim{key: r.Key, need: need, tag: r.Tag, admitted: ts}
	if r.Owner != (jobobject.Owner{}) {
		bindLocked(c, r.Owner, ts)
	}
	book.claims[c] = struct{}{}
	if since, ok := book.held[r.Tag]; ok {
		delete(book.held, r.Tag)
		emitLocked(Event{Kind: EventAdmitted, Tag: r.Tag, Ms: ts.Sub(since).Milliseconds()})
	}
	return c
}

// holdLocked marks tag held, emitting held only on the transition.
func holdLocked(tag Tag, free, need uint64) {
	if tag.RunId == "" {
		return
	}
	if _, ok := book.held[tag]; ok {
		return
	}
	book.held[tag] = now()
	emitLocked(Event{Kind: EventHeld, Tag: tag, Free: free, Need: need})
}

// TryAdmit admits r if free memory covers its estimate now, and never blocks. A refusal marks r's Tag held.
func TryAdmit(r Request) (*Claim, bool) {
	c, _ := TryAdmitOrWhy(r)
	return c, c != nil
}

// TryAdmitOrWhy is TryAdmit that says why it refused: exactly one result is non-nil.
func TryAdmitOrWhy(r Request) (*Claim, *Shortfall) {
	// outside book.mu: the store has its own lock and may read the file
	need := Estimate(r.Key)
	book.mu.Lock()
	defer book.mu.Unlock()
	ok, free := fitsLocked(need)
	if !ok {
		holdLocked(r.Tag, free, need)
		return nil, &Shortfall{Free: free, Need: need, Holders: holdersLocked(now())}
	}
	return admitLocked(r, need), nil
}

// holdersLocked lists the claims in the book by what each holds now, largest first.
func holdersLocked(t time.Time) []Holder {
	hs := make([]Holder, 0, len(book.claims))
	for c := range book.claims {
		use := c.use
		if c.startingLocked(t) {
			use = c.need
		}
		hs = append(hs, Holder{Tag: c.tag, Use: use})
	}
	slices.SortFunc(hs, func(a, b Holder) int { return cmp.Compare(b.Use, a.Use) })
	return hs
}

// Admit always admits r and never blocks, for work that must progress: its claim counts its estimate while it
// starts, like any claim, so a worker is not admitted onto memory it is about to use.
func Admit(r Request) *Claim {
	need := Estimate(r.Key)
	book.mu.Lock()
	defer book.mu.Unlock()
	return admitLocked(r, need)
}

// Hold marks r's Tag held without trying it: plan order means a task behind a refused one must not jump ahead.
func Hold(r Request) {
	need := Estimate(r.Key)
	book.mu.Lock()
	defer book.mu.Unlock()
	holdLocked(r.Tag, freeLocked(), need)
}

// roomFreedLocked calls the room hook with the runs that have a held Tag.
func roomFreedLocked() {
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

// Bind ties the claim to the job its tree runs in, so the loop can follow its use, release it on close and record
// its peak under the claim's key.
func (c *Claim) Bind(o jobobject.Owner) {
	if c == nil {
		return
	}
	book.mu.Lock()
	defer book.mu.Unlock()
	bindLocked(c, o, now())
}

// bindLocked binds c to o and remembers o's key for its job's close, once per claim and owner.
func bindLocked(c *Claim, o jobobject.Owner, t time.Time) {
	rebind := c.bound && c.owner == o
	c.owner, c.bound, c.boundAt = o, true, t
	if rebind || c.key == (Key{}) {
		return
	}
	ref := book.ownerKeys[o]
	if ref == nil {
		ref = &ownerKey{}
		book.ownerKeys[o] = ref
	}
	ref.key = c.key
	ref.n++
}

// takeKeyLocked returns the key o's closing job records under, forgetting one bind of it.
func takeKeyLocked(o jobobject.Owner) (Key, bool) {
	ref := book.ownerKeys[o]
	if ref == nil {
		return Key{}, false
	}
	if ref.n--; ref.n <= 0 {
		delete(book.ownerKeys, o)
	}
	return ref.key, true
}

// SetCacheExpiry sets how the loop learns when the tree's prompt cache expires, so a pause can end before it does.
// Nil-safe.
func (c *Claim) SetCacheExpiry(fn func() (time.Time, bool)) {
	if c == nil {
		return
	}
	book.mu.Lock()
	defer book.mu.Unlock()
	c.cacheExpiry = fn
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
// at its prompt after reporting done, and its claim would keep it in the book (a non-empty book admits only what
// free memory covers) until the job closes. A paused tree is resumed first, since nothing would resume it once its
// claim is gone. The owner's key stays remembered for that close.
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

// HasCacheExpiryForTest is whether c has a cache-expiry function set.
func HasCacheExpiryForTest(c *Claim) bool {
	if c == nil {
		return false
	}
	book.mu.Lock()
	defer book.mu.Unlock()
	return c.cacheExpiry != nil
}

// LiveClaimsForTest is the number of claims in the book.
func LiveClaimsForTest() int {
	book.mu.Lock()
	defer book.mu.Unlock()
	return len(book.claims)
}
