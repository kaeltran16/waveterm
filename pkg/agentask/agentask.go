// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package agentask holds the in-memory registry of pending agent ask requests.
// AskCommand registers a pending ask keyed by the block's ORef; AnswerAgentCommand
// looks it up to encode + inject the answer; the clear path drops it. Keyed by ORef
// because an agent blocks on one AskUserQuestion at a time (at most one pending ask per block).
package agentask

import (
	"sync"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

// PendingAsk is the question set currently awaiting an answer for a block.
type PendingAsk struct {
	AskId     string
	BlockId   string
	Questions []baseds.AgentAskQuestion
	// Ts is the UnixMilli the ask was raised, copied from AgentAskData.Ts. Drives the "waiting 41m"
	// age in the attention list; without it the list can say what is waiting but not for how long.
	Ts int64
}

type Registry struct {
	lock    sync.Mutex
	pending map[string]PendingAsk
	waits   waiters
}

func MakeRegistry() *Registry {
	return &Registry{pending: make(map[string]PendingAsk)}
}

// GlobalRegistry is the process-wide instance used by the wsh server handlers.
var GlobalRegistry = MakeRegistry()

func (r *Registry) Set(oref string, p PendingAsk) {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.pending[oref] = p
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
	return p, true
}
