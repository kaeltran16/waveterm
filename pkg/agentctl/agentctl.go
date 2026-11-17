// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package agentctl holds the command streams of agent sessions whose harness mod can run a prompt itself,
// so the engine need not type into their terminals.
package agentctl

import "sync"

// queueSize bounds what a stream holds unread; Send refuses past it, and the caller types instead.
const queueSize = 16

// Msg is one thing for a session to do: run Text as a prompt, or compact with Compact as the instructions,
// which wins when both are set. MidTurn asks for Text to join the turn the session is running, as typed
// text would, instead of waiting for it to end. Queue marks Text as the person's own message, which the
// mod reports as held. TakeBack, set alone, asks the mod to hand back what it holds, naming the request.
type Msg struct {
	Text     string
	Compact  string
	MidTurn  bool
	Queue    bool
	TakeBack string
}

var (
	lock    sync.Mutex
	streams = make(map[string]chan Msg)
)

// Register opens blockId's stream and returns it with its close. A second stream for the block replaces
// the first: a mod reload starts its new stream while the old process is still going away. Closing the
// block's current stream loses what its mod held; closing a replaced one leaves that to the newer mod's report.
func Register(blockId string) (<-chan Msg, func()) {
	ch := make(chan Msg, queueSize)
	lock.Lock()
	streams[blockId] = ch
	lock.Unlock()
	return ch, func() {
		lock.Lock()
		defer lock.Unlock()
		if streams[blockId] == ch {
			delete(streams, blockId)
			// under lock, so a stream registering now cannot have its first report lost with the old list
			endQueue(blockId)
		}
	}
}

// Has reports whether blockId's session has a stream open.
func Has(blockId string) bool {
	lock.Lock()
	defer lock.Unlock()
	return streams[blockId] != nil
}

// Send hands msg to blockId's session and reports whether its stream took it.
func Send(blockId string, msg Msg) bool {
	lock.Lock()
	defer lock.Unlock()
	ch := streams[blockId]
	if ch == nil {
		return false
	}
	select {
	case ch <- msg:
		return true
	default:
		return false
	}
}
