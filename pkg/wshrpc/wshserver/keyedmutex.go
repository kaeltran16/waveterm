// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import "sync"

// keyedMutex serializes operations that share a key while letting different keys run concurrently.
// Per-key entries are reference-counted and removed once no goroutine holds or is waiting on them, so
// the map stays bounded by the number of keys in flight rather than every key ever seen.
type keyedMutex struct {
	mu    sync.Mutex
	locks map[string]*keyedMutexEntry
}

type keyedMutexEntry struct {
	mu   sync.Mutex
	refs int
}

func newKeyedMutex() *keyedMutex {
	return &keyedMutex{locks: make(map[string]*keyedMutexEntry)}
}

func (k *keyedMutex) Lock(key string) {
	k.mu.Lock()
	e, ok := k.locks[key]
	if !ok {
		e = &keyedMutexEntry{}
		k.locks[key] = e
	}
	e.refs++ // count the waiter before releasing k.mu so Unlock can't delete a live entry
	k.mu.Unlock()
	e.mu.Lock()
}

func (k *keyedMutex) Unlock(key string) {
	k.mu.Lock()
	e := k.locks[key]
	e.refs--
	if e.refs == 0 {
		delete(k.locks, key)
	}
	k.mu.Unlock()
	e.mu.Unlock()
}
