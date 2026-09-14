// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package agentask holds the in-memory registry of pending agent ask requests.
// AskCommand registers a pending ask keyed by the block's ORef; AnswerAgentCommand
// looks it up to encode + inject the answer; the clear path drops it. Keyed by ORef
// because an agent blocks on one AskUserQuestion at a time (at most one pending ask per block).
package agentask

import (
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

// Owners of a dag child's ask. Only asks raised by dag children have one; the queue is how the lead
// and the human take turns on a question, and every other ask keeps Owner "".
const (
	AskOwner_Lead = "lead"
	AskOwner_User = "user"
)

// AnswerClearTimeout bounds how long a typed answer may go unconfirmed. Hook delivery is sub-second;
// this absorbs a slow turn start.
const AnswerClearTimeout = 30 * time.Second

// AnswerUnconfirmedNote is the note on an ask whose typed answer never cleared it.
const AnswerUnconfirmedNote = "answer was sent but never confirmed"

// a second unconfirmed delivery means typing into this child does not work, so the human takes it.
const maxDeliveryMisses = 2

// PendingAsk is the question set currently awaiting an answer for a block.
type PendingAsk struct {
	AskId     string
	BlockId   string
	Questions []baseds.AgentAskQuestion
	// Ts is the UnixMilli the ask was raised, copied from AgentAskData.Ts. Drives the "waiting 41m"
	// age in the attention list; without it the list can say what is waiting but not for how long.
	Ts int64
	// Prose mirrors CommandAskData.Prose: delivery types text instead of picker keystrokes.
	Prose bool
	// Wait records that a `wsh ask --wait` caller is blocked on this ask, which is what makes it
	// undurable: the delivery is an in-memory channel, so a restored copy could only be a question
	// nobody is listening to. DurableHook's implementation reads this to decide what to persist.
	Wait bool
	// the fields below are set only for an ask raised by a dag child. They live in memory only:
	// DurableHook does not store them, and a dag child's ask never survives a restart to need them.
	Owner string
	// Deadline is the UnixMilli past which a lead-owned ask moves to the user.
	Deadline int64
	// Note says why the ask is with its owner: the lead's forward note, a missed deadline, a failed delivery.
	Note string
	// Misses counts typed answers the agent never cleared.
	Misses    int
	ChannelId string
	// RunId is the dag's owning run, the one the lead works in.
	RunId  string
	TaskId string
	DagOID string
}

// DurableHook mirrors every registry mutation to durable storage: pending != nil is an upsert,
// pending == nil is a forget. It is a package-level indirection rather than a store import so that
// this package's tests exercise the in-memory semantics without a database — nil (the default) keeps
// the registry purely in memory, and DurableHook is wired at server startup.
//
// It is called while the registry lock is held, so the implementation must not call back into the
// registry, and must treat its own failures as its own to log: the in-memory map is authoritative for
// this process, and a failed disk write must never fail the ask it describes.
var DurableHook func(oref string, pending *PendingAsk)

type Registry struct {
	lock    sync.Mutex
	pending map[string]PendingAsk
	// clears holds typed dag answers waiting for the agent's clear, keyed by oref.
	clears map[string]sentAnswer
	waits  waiters
}

// sentAnswer is a claimed ask whose answer was typed but not yet confirmed.
type sentAnswer struct {
	pending PendingAsk
	sentAt  int64
}

func MakeRegistry() *Registry {
	return &Registry{pending: make(map[string]PendingAsk), clears: make(map[string]sentAnswer)}
}

// GlobalRegistry is the process-wide instance used by the wsh server handlers.
var GlobalRegistry = MakeRegistry()

func (r *Registry) Set(oref string, p PendingAsk) {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.pending[oref] = p
	if DurableHook != nil {
		DurableHook(oref, &p)
	}
}

func (r *Registry) Get(oref string) (PendingAsk, bool) {
	r.lock.Lock()
	defer r.lock.Unlock()
	p, ok := r.pending[oref]
	return p, ok
}

// List returns every pending ask, keyed by the block ORef it is registered under. The returned map is a
// copy, so a caller may hold it after the lock is released.
func (r *Registry) List() map[string]PendingAsk {
	r.lock.Lock()
	defer r.lock.Unlock()
	out := make(map[string]PendingAsk, len(r.pending))
	for k, v := range r.pending {
		out[k] = v
	}
	return out
}

func (r *Registry) Drop(oref string) {
	r.lock.Lock()
	defer r.lock.Unlock()
	delete(r.pending, oref)
	// unconditionally, even when nothing was pending: a clear can legitimately arrive with no entry in
	// memory (a repeat PostToolUse clear, or the first clear after a restart that did not restore the
	// ask) and the stored row still has to go.
	if DurableHook != nil {
		DurableHook(oref, nil)
	}
}

// Claim atomically removes and returns the pending ask for oref, making "who delivers it" a single
// decision. It returns (_, false) WITHOUT deleting when no ask is pending, or when askid != "" and the
// pending ask's AskId differs (a stale answer for an ask that was replaced). Otherwise it deletes the
// entry and returns (pending, true) — only the first caller for a given pending ask wins.
func (r *Registry) Claim(oref, askid string) (PendingAsk, bool) {
	r.lock.Lock()
	defer r.lock.Unlock()
	p, ok := r.pending[oref]
	if !ok {
		return PendingAsk{}, false
	}
	if askid != "" && p.AskId != askid {
		return PendingAsk{}, false
	}
	delete(r.pending, oref)
	if DurableHook != nil {
		DurableHook(oref, nil)
	}
	return p, true
}

// Update edits a pending ask in place. It skips DurableHook because it exists for the queue fields,
// which are not stored; callers must not use it to change a stored field. It returns false when
// nothing is pending, or when askId != "" and no longer matches.
func (r *Registry) Update(oref, askId string, fn func(*PendingAsk)) bool {
	r.lock.Lock()
	defer r.lock.Unlock()
	p, ok := r.pending[oref]
	if !ok || (askId != "" && p.AskId != askId) {
		return false
	}
	fn(&p)
	r.pending[oref] = p
	return true
}

func (r *Registry) awaitClear(oref string, p PendingAsk, now int64) {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.clears[oref] = sentAnswer{pending: p, sentAt: now}
}

// ConfirmClear ends the wait on a typed answer. The agent clearing its ask is the only proof the
// keystrokes reached the picker.
func (r *Registry) ConfirmClear(oref string) bool {
	r.lock.Lock()
	defer r.lock.Unlock()
	_, ok := r.clears[oref]
	delete(r.clears, oref)
	return ok
}

// ExpireClears puts back every typed answer the agent did not clear within timeout, keyed by oref.
// The ask returns to its owner with the failure noted, and to the user on the second miss. A block
// that already holds a new ask moved on, so its answer did land and nothing is restored.
func (r *Registry) ExpireClears(now int64, timeout time.Duration) map[string]PendingAsk {
	r.lock.Lock()
	defer r.lock.Unlock()
	restored := make(map[string]PendingAsk)
	for oref, s := range r.clears {
		if now-s.sentAt < timeout.Milliseconds() {
			continue
		}
		delete(r.clears, oref)
		if _, live := r.pending[oref]; live {
			continue
		}
		p := s.pending
		p.Misses++
		p.Note = AnswerUnconfirmedNote
		if p.Misses >= maxDeliveryMisses {
			p.Owner = AskOwner_User
		}
		r.pending[oref] = p
		if DurableHook != nil {
			DurableHook(oref, &p)
		}
		restored[oref] = p
	}
	return restored
}
