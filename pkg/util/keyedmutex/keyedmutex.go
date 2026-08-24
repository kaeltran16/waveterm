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

func (m *Mutex) Unlock(key string) {
	m.mu.Lock()
	e := m.locks[key]
	e.refs--
	if e.refs == 0 {
		delete(m.locks, key)
	}
	m.mu.Unlock()
	e.mu.Unlock()
}
