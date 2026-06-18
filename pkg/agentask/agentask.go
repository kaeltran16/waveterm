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
}

type Registry struct {
	lock    sync.Mutex
	pending map[string]PendingAsk
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

func (r *Registry) Drop(oref string) {
	r.lock.Lock()
	defer r.lock.Unlock()
	delete(r.pending, oref)
}
