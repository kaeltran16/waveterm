// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memgate

import (
	"cmp"
	"context"
	"log"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wavetermdev/waveterm/pkg/util/jobobject"
)

// Resolver names the footprint key a live job's owner records its peak under; false when it cannot (block or
// run gone).
type Resolver func(ctx context.Context, o jobobject.Owner) (Key, bool)

const (
	loopTick = 2 * time.Second
	// below lowWater the loop pauses a background tree per tick; above highWater it resumes one
	lowWater  = 1536 * mib
	highWater = 3 * gib
	// a rise this large since the last room call may admit a held tree, so the room hook runs
	roomRise = 512 * mib
	// claude's API timeout is 10 min and the stall threshold 15: a 3 min pause risks neither
	pauseLimit    = 3 * time.Minute
	pauseCooldown = 10 * time.Minute
	// a bound job registers within the engine's workerJobWait (30 s); one not seen by then never will be
	bindStale      = 60 * time.Second
	resolveTimeout = 5 * time.Second
)

const (
	ReasonMemory = "memory"
	ReasonLimit  = "limit"
	ReasonExited = "exited"
)

// the jobobject calls the loop makes; vars so tests run on any OS without real processes
var (
	liveUsage    = jobobject.LiveUsage
	suspendJob   = jobobject.Suspend
	resumeJob    = jobobject.Resume
	setCloseHook = jobobject.SetCloseHook
)

var resolver atomic.Pointer[Resolver]

// SetResolver sets how a live job's owner is classified for its footprint key (nil: never).
func SetResolver(r Resolver) {
	if r == nil {
		resolver.Store(nil)
		return
	}
	resolver.Store(&r)
}

// ownerKeys caches each live owner's resolved key, so a job resolves once and its close records under the key its
// block or run had while alive.
var ownerKeys = struct {
	mu   sync.Mutex
	keys map[jobobject.Owner]Key
}{keys: make(map[jobobject.Owner]Key)}

// loop holds the room-rise baseline; guarded by book.mu.
var loop struct {
	haveBase bool
	base     uint64 // the lowest Available since the loop last called the room hook
}

// StartLoop installs the jobobject close hook and reconciles the book every 2 s until ctx ends.
func StartLoop(ctx context.Context) {
	setCloseHook(func(o jobobject.Owner, _ int, peak uint64) {
		// Close runs on a block's exit path or plancmd's cleanup: never block it on the resolver or the store
		go onJobClosed(o, peak)
	})
	go func() {
		ticker := time.NewTicker(loopTick)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				setCloseHook(nil)
				return
			case <-ticker.C:
				tick(ctx)
			}
		}
	}()
}

func resolve(ctx context.Context, o jobobject.Owner) (Key, bool) {
	r := resolver.Load()
	if r == nil {
		return Key{}, false
	}
	ctx, cancel := context.WithTimeout(ctx, resolveTimeout)
	defer cancel()
	return (*r)(ctx, o)
}

type ownerUsage struct{ cur, peak uint64 }

func tick(ctx context.Context) {
	usage := make(map[jobobject.Owner]ownerUsage)
	for _, u := range liveUsage() {
		ou := usage[u.Owner]
		ou.cur += u.Current
		ou.peak = max(ou.peak, u.Peak)
		usage[u.Owner] = ou
	}
	cacheKeys(ctx, usage)

	book.mu.Lock()
	defer book.mu.Unlock()
	t := now()
	correctClaimsLocked(usage, t)
	// the pause limit needs no reading, so a failing read never lets a pause outlive it
	resumeLimitedLocked(t)
	avail, err := freeMem()
	if err != nil {
		log.Printf("memgate: reading free memory, not pausing or resuming: %v", err)
		return
	}
	checkRiseLocked(avail)
	switch {
	case avail < lowWater:
		pauseOneLocked(avail, t)
	case avail > highWater:
		resumeOldestLocked(avail, t)
	}
}

// cacheKeys resolves each live owner not yet cached; a failure is retried next tick.
func cacheKeys(ctx context.Context, usage map[jobobject.Owner]ownerUsage) {
	for o := range usage {
		ownerKeys.mu.Lock()
		_, ok := ownerKeys.keys[o]
		ownerKeys.mu.Unlock()
		if ok {
			continue
		}
		k, ok := resolve(ctx, o)
		if !ok {
			continue
		}
		ownerKeys.mu.Lock()
		ownerKeys.keys[o] = k
		ownerKeys.mu.Unlock()
	}
}

// correctClaimsLocked sets each bound claim's use and raises its need to its tree's peak, and drops a bound claim
// whose job was seen and is gone or never appeared. An unbound claim is its caller's: a serial batch of Setups can
// hold one for many minutes.
func correctClaimsLocked(usage map[jobobject.Owner]ownerUsage, t time.Time) {
	for c := range book.claims {
		if !c.bound {
			continue
		}
		if u, ok := usage[c.owner]; ok {
			c.seen, c.cur = true, u.cur
			c.need = max(c.need, u.peak)
			continue
		}
		if c.seen || t.Sub(c.boundAt) >= bindStale {
			dropLocked(c, t)
		}
	}
}

// dropLocked releases c, ending its pause first so no row stays paused.
func dropLocked(c *Claim, t time.Time) {
	if c.paused {
		endPauseLocked(c, ReasonExited, 0, t)
	}
	releaseLocked(c)
}

// checkRiseLocked calls the room hook when Available has risen roomRise above its lowest since the last call.
func checkRiseLocked(avail uint64) {
	if !loop.haveBase || avail < loop.base {
		loop.haveBase, loop.base = true, avail
		return
	}
	if avail-loop.base >= roomRise {
		loop.base = avail
		roomFreedLocked()
	}
}

func pausable(c *Claim) bool {
	return c.bound && c.seen && (c.key.Role == RoleWorker || c.key.Role == RoleReviewer)
}

// pauseOneLocked pauses one background tree: reviewers before workers, the most recently admitted first. It never
// pauses the last unpaused claim: something must finish to free memory.
func pauseOneLocked(avail uint64, t time.Time) {
	var unpaused int
	var cands []*Claim
	for c := range book.claims {
		if c.paused {
			continue
		}
		unpaused++
		if pausable(c) && !t.Before(c.noPauseBefore) {
			cands = append(cands, c)
		}
	}
	if unpaused <= 1 || len(cands) == 0 {
		return
	}
	slices.SortFunc(cands, func(a, b *Claim) int {
		return cmp.Or(
			cmp.Compare(rolePauseOrder(a.key.Role), rolePauseOrder(b.key.Role)),
			b.admitted.Compare(a.admitted),
		)
	})
	c := cands[0]
	n, err := suspendJob(c.owner)
	if err != nil {
		log.Printf("memgate: pausing %s %s (%d suspended): %v", c.owner.Kind, c.owner.Id, n, err)
		if n == 0 {
			return
		}
	}
	c.paused, c.pausedAt = true, t
	emitLocked(Event{Kind: EventPaused, Tag: c.tag, Free: avail, Need: highWater})
}

func rolePauseOrder(role string) int {
	if role == RoleReviewer {
		return 0
	}
	return 1
}

// resumeLimitedLocked resumes every pause that has reached its limit and keeps it from pausing again for a while.
func resumeLimitedLocked(t time.Time) {
	for c := range book.claims {
		if c.paused && t.Sub(c.pausedAt) >= pauseLimit {
			resumeLocked(c, ReasonLimit, 0, t)
			c.noPauseBefore = t.Add(pauseCooldown)
		}
	}
}

func resumeOldestLocked(avail uint64, t time.Time) {
	var oldest *Claim
	for c := range book.claims {
		if c.paused && (oldest == nil || c.pausedAt.Before(oldest.pausedAt)) {
			oldest = c
		}
	}
	if oldest != nil {
		resumeLocked(oldest, ReasonMemory, avail, t)
	}
}

func resumeLocked(c *Claim, reason string, avail uint64, t time.Time) {
	if err := resumeJob(c.owner); err != nil {
		// Resume closes every kept handle whatever fails, so the tree is no longer held paused by us
		log.Printf("memgate: resuming %s %s: %v", c.owner.Kind, c.owner.Id, err)
	}
	endPauseLocked(c, reason, avail, t)
}

func endPauseLocked(c *Claim, reason string, avail uint64, t time.Time) {
	c.paused = false
	emitLocked(Event{Kind: EventResumed, Tag: c.tag, Free: avail, Reason: reason, Ms: t.Sub(c.pausedAt).Milliseconds()})
}

// onJobClosed records a closed job's peak under its owner's key, releases a block-owned claim and ends its pause.
// Close has already released the suspended handles; a plan command's claim is its caller's to release.
func onJobClosed(o jobobject.Owner, peak uint64) {
	ownerKeys.mu.Lock()
	k, ok := ownerKeys.keys[o]
	delete(ownerKeys.keys, o)
	ownerKeys.mu.Unlock()
	if !ok {
		k, ok = resolve(context.Background(), o)
	}
	if ok {
		Record(k, peak)
	} else {
		log.Printf("memgate: no footprint key for closed %s %s %s, peak %d not recorded", o.Kind, o.Id, o.Cmd, peak)
	}

	book.mu.Lock()
	defer book.mu.Unlock()
	for c := range book.claims {
		if !c.bound || c.owner != o {
			continue
		}
		if c.paused {
			endPauseLocked(c, ReasonExited, 0, now())
		}
		if o.Kind == jobobject.OwnerKind_Block {
			releaseLocked(c)
		}
	}
}
