// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// OpenVault builds a fresh *Vault per call, so Vault.mu cannot serialize across callers; rootLocks
// holds one mutex per vault root for Sync, Commit and effort-store writes.
var (
	rootLocksMu sync.Mutex
	rootLocks   = map[string]*sync.Mutex{}
)

func lockKey(root string) string {
	key := filepath.Clean(root)
	if runtime.GOOS == "windows" {
		key = strings.ToLower(key) // paths are case-insensitive there
	}
	return key
}

// LockRoot takes the package-level lock for a vault root and returns its release. Not reentrant.
func LockRoot(root string) (unlock func()) {
	key := lockKey(root)
	rootLocksMu.Lock()
	m, ok := rootLocks[key]
	if !ok {
		m = &sync.Mutex{}
		rootLocks[key] = m
	}
	rootLocksMu.Unlock()
	m.Lock()
	return m.Unlock
}

// pokeCh carries "the vault changed, sync soon" to the sync loop; buffered(1) so pokes coalesce.
var pokeCh = make(chan struct{}, 1)

// Poke asks the sync loop to push soon. Never blocks; safe with no loop running.
func Poke() {
	select {
	case pokeCh <- struct{}{}:
	default:
	}
}

// PokedForTest drains a pending poke and reports whether there was one. For sibling-package tests
// that assert a write poked sync.
func PokedForTest() bool {
	select {
	case <-pokeCh:
		return true
	default:
		return false
	}
}
