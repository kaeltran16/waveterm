// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package keyedmutex

import "sync"

// Mutex serializes operations that share a key while letting different keys run concurrently.
// Per-key entries are reference-counted and removed once no goroutine holds or is waiting on them, so
// the map stays bounded by the number of keys in flight rather than every key ever seen.
type Mutex struct {
	mu    sync.Mutex
	locks map[string]*entry
}

type entry struct {
	mu   sync.Mutex
	refs int
}

func New() *Mutex {
	return &Mutex{locks: make(map[string]*entry)}
}

func (m *Mutex) Lock(key string) {
	m.mu.Lock()
	e := m.locks[key]
	if e == nil {
		e = &entry{}
		m.locks[key] = e
	}
	e.refs++
	m.mu.Unlock()
	e.mu.Lock()
}

// TryLock takes the key's lock only if it is free, reporting whether it did. For work with nothing to
// gain by queueing behind a long holder: a progress publish that waits out the holder is worse than one
// that skips a beat, because it delays whatever its own caller does next.
func (m *Mutex) TryLock(key string) bool {
	m.mu.Lock()
	e := m.locks[key]
	if e == nil {
		e = &entry{}
		m.locks[key] = e
	}
	e.refs++
	m.mu.Unlock()
	if e.mu.TryLock() {
		return true
	}
	m.dropRef(key)
	return false
}

func (m *Mutex) Unlock(key string) {
	m.dropRef(key).mu.Unlock()
}

// dropRef releases the caller's claim on the key's entry and returns it, removing it from the map once
// nobody holds or waits on it. The entry is returned because a caller unlocking it still needs it after
// it has left the map.
func (m *Mutex) dropRef(key string) *entry {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.locks[key]
	e.refs--
	if e.refs == 0 {
		delete(m.locks, key)
	}
	return e
}
