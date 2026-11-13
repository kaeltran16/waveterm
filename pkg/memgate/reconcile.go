// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memgate

import (
	"cmp"
	"context"
	"log"
	"slices"
	"time"

	"github.com/wavetermdev/waveterm/pkg/util/jobobject"
)

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
	live := make(map[jobobject.Owner]bool)
	for _, u := range liveUsage() {
		live[u.Owner] = true
	}

	book.mu.Lock()
	defer book.mu.Unlock()
	t := now()
	correctClaimsLocked(live, t)
	settleLocked(t)
	// the pause limit needs no reading, so a failing read never lets a pause outlive it
	resumeLimitedLocked(t)
	avail, err := readFreeLocked()
	if err != nil {
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

// correctClaimsLocked marks each bound claim whose job is live as seen, and drops a bound claim whose job was seen
// and is gone or never appeared. A never-seen job gets no close, so its owner's key goes with its claim; a seen one's
// close follows its unregister and still needs the key. An unbound claim is its caller's: a serial batch of Setups
// can hold one for many minutes.
func correctClaimsLocked(live map[jobobject.Owner]bool, t time.Time) {
	for c := range book.claims {
		if !c.bound {
			continue
		}
		if live[c.owner] {
			c.seen = true
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

func pausable(c *Claim) bool {
	return c.bound && c.seen && (c.tag.Role == RoleWorker || c.tag.Role == RoleReviewer)
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
			cmp.Compare(rolePauseOrder(a.tag.Role), rolePauseOrder(b.tag.Role)),
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
