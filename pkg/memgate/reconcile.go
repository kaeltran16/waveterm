// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memgate

import (
	"context"
	"log"
	"slices"
	"time"

	"github.com/wavetermdev/waveterm/pkg/util/jobobject"
)

const (
	loopTick = 2 * time.Second
	// below lowWater the loop pauses a spiking worker per tick; above highWater it resumes one
	lowWater  = 1536 * mib
	highWater = 3 * gib
	// an idle claude sits at 0.35-0.7 GB and a typecheck adds ~2.8 GB: a GiB over its own floor is a command's spike
	spikeRise = 1 * gib
	// covers the gap between the request that refreshed the cache and its transcript write, plus resume and the
	// next request
	pauseMargin = 30 * time.Second
	// a shorter pause stops too little of a spike to be worth a suspend
	minPause = 15 * time.Second
	// a rise this large since the last room call may admit a held tree, so the room hook runs
	roomRise = 512 * mib
	// claude's API timeout is 10 min and the stall threshold 15: a 3 min pause risks neither
	pauseLimit    = 3 * time.Minute
	pauseCooldown = 10 * time.Minute
	// a bound job registers within the engine's workerJobWait (30 s); one not seen by then never will be
	bindStale = 60 * time.Second
)

const (
	ReasonMemory = "memory"
	ReasonLimit  = "limit"
	ReasonExited = "exited"
	ReasonDone   = "done" // the tree finished its work and its claim was released while it lives on
)

// the jobobject calls the loop makes; vars so tests run on any OS without real processes
var (
	liveUsage    = jobobject.LiveUsage
	suspendJob   = jobobject.Suspend
	resumeJob    = jobobject.Resume
	setCloseHook = jobobject.SetCloseHook
)

// loop holds the room-rise baseline; guarded by book.mu.
var loop struct {
	haveBase bool
	base     uint64 // the lowest Available since the loop last called the room hook
}

// StartLoop installs the jobobject close hook and reconciles the book every 2 s until ctx ends.
func StartLoop(ctx context.Context) {
	setCloseHook(func(o jobobject.Owner, _ int, peak uint64) { onJobClosed(o, peak) })
	go func() {
		ticker := time.NewTicker(loopTick)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				setCloseHook(nil)
				return
			case <-ticker.C:
				tick()
			}
		}
	}()
}

func tick() {
	use := make(map[jobobject.Owner]uint64)
	for _, u := range liveUsage() {
		use[u.Owner] += u.Current
	}
	t := now()
	if cands, avail, low := reconcile(use, t); low {
		pauseOne(cands, avail, t)
	}
}

// reconcile brings the book up to date with the live jobs and free memory, resuming a pause that is due. When free
// memory is under the low watermark it returns the pause candidates for pauseOne, which must run without the lock.
func reconcile(use map[jobobject.Owner]uint64, t time.Time) ([]pauseCand, uint64, bool) {
	book.mu.Lock()
	defer book.mu.Unlock()
	correctClaimsLocked(use, t)
	settleLocked(t)
	// the pause limit needs no reading, so a failing read never lets a pause outlive it
	resumeLimitedLocked(t)
	avail, err := readFreeLocked()
	if err != nil {
		return nil, 0, false
	}
	checkRiseLocked(avail)
	switch {
	case avail < lowWater:
		return pauseCandsLocked(t), avail, true
	case avail > highWater:
		resumeOldestLocked(avail, t)
	}
	return nil, 0, false
}

// correctClaimsLocked marks each bound claim whose job is live as seen and records its use, and drops a bound claim
// whose job was seen and is gone or never appeared. A never-seen job gets no close, so its owner's key goes with its
// claim; a seen one's close follows its unregister and still needs the key. An unbound claim is its caller's: a
// serial batch of Setups can hold one for many minutes.
func correctClaimsLocked(use map[jobobject.Owner]uint64, t time.Time) {
	for c := range book.claims {
		if !c.bound {
			continue
		}
		if u, ok := use[c.owner]; ok {
			if !c.seen {
				c.seen, c.use, c.floor = true, u, u
			}
			c.prevUse, c.use = c.use, u
			c.floor = min(c.floor, u)
			continue
		}
		if c.seen {
			dropLocked(c, t)
		} else if t.Sub(c.boundAt) >= bindStale {
			if c.key != (Key{}) {
				takeKeyLocked(c.owner)
			}
			dropLocked(c, t)
		}
	}
}

// settleLocked calls the room hook once claims have stopped counting their startup allowance: held trees may fit now,
// and nothing else would tick their runs.
func settleLocked(t time.Time) {
	var settled bool
	for c := range book.claims {
		if !c.settled && !c.startingLocked(t) {
			c.settled, settled = true, true
		}
	}
	if settled {
		roomFreedLocked()
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

// spikingLocked is whether c's use is well above its own floor and still rising: an idle tree frees nothing by
// pausing, and a pause stops a spike from growing but frees nothing already held.
func (c *Claim) spikingLocked() bool {
	return c.use >= c.floor+spikeRise && c.use > c.prevUse
}

// pausable is whether the loop may pause c: only a worker, since a reviewer's verdict is what lands work.
func pausable(c *Claim, t time.Time) bool {
	return c.bound && c.seen && c.tag.Role == RoleWorker && !t.Before(c.noPauseBefore) && c.spikingLocked()
}

type pauseCand struct {
	c           *Claim
	cacheExpiry func() (time.Time, bool)
}

// pauseCandsLocked lists the pausable claims, youngest admitted first, the oldest being likely near its end. None
// when pausing would leave no claim running: something must finish to free memory.
func pauseCandsLocked(t time.Time) []pauseCand {
	if unpausedLocked() <= 1 {
		return nil
	}
	var cands []pauseCand
	for c := range book.claims {
		if !c.paused && pausable(c, t) {
			cands = append(cands, pauseCand{c, c.cacheExpiry})
		}
	}
	slices.SortFunc(cands, func(a, b pauseCand) int { return b.c.admitted.Compare(a.c.admitted) })
	return cands
}

func unpausedLocked() int {
	var n int
	for c := range book.claims {
		if !c.paused {
			n++
		}
	}
	return n
}

// pauseOne pauses the first candidate whose pause can last minPause before its prompt cache would expire. It reads
// each expiry without book.mu, since that stats the sessions dir.
func pauseOne(cands []pauseCand, avail uint64, t time.Time) {
	for _, cand := range cands {
		if until, ok := pauseBound(cand.cacheExpiry, t); ok {
			pause(cand.c, until, avail, t)
			return
		}
	}
}

// pauseBound is when a pause from t must end: at pauseLimit, or pauseMargin before the prompt cache expires if that
// is sooner. Not ok when the expiry is unknown or the pause could not last minPause.
func pauseBound(cacheExpiry func() (time.Time, bool), t time.Time) (time.Time, bool) {
	if cacheExpiry == nil {
		return time.Time{}, false
	}
	exp, ok := cacheExpiry()
	if !ok {
		return time.Time{}, false
	}
	until := t.Add(pauseLimit)
	if beforeExp := exp.Add(-pauseMargin); beforeExp.Before(until) {
		until = beforeExp
	}
	return until, until.Sub(t) >= minPause
}

// pause suspends c's job until the bound, unless the book moved while its expiry was read.
func pause(c *Claim, until time.Time, avail uint64, t time.Time) {
	book.mu.Lock()
	defer book.mu.Unlock()
	if _, live := book.claims[c]; !live || c.paused || unpausedLocked() <= 1 {
		return
	}
	n, err := suspendJob(c.owner)
	if err != nil {
		log.Printf("memgate: pausing %s %s (%d suspended): %v", c.owner.Kind, c.owner.Id, n, err)
		if n == 0 {
			return
		}
	}
	c.paused, c.pausedAt, c.pauseUntil = true, t, until
	emitLocked(Event{Kind: EventPaused, Tag: c.tag, Free: avail, Need: highWater})
}

// resumeLimitedLocked resumes every pause that has reached its bound and keeps it from pausing again for a while.
func resumeLimitedLocked(t time.Time) {
	for c := range book.claims {
		if c.paused && !t.Before(c.pauseUntil) {
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

// onJobClosed records the closed job's peak under its owner's key, releases a block-owned claim and ends its pause.
// Close has already released the suspended handles; a plan command's claim is its caller's to release.
func onJobClosed(o jobobject.Owner, peak uint64) {
	book.mu.Lock()
	defer book.mu.Unlock()
	if k, ok := takeKeyLocked(o); ok && peak > 0 {
		// Close runs on a block's exit path or plancmd's cleanup: never hold it on the file write
		enqueue(func() { Record(k, peak) })
	}
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
