// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"sync"
	"testing"
	"time"
)

func TestKeyedMutex_SameKeySerializes(t *testing.T) {
	km := newKeyedMutex()
	km.Lock("a")
	entered := make(chan struct{})
	go func() {
		km.Lock("a")
		close(entered)
		km.Unlock("a")
	}()
	select {
	case <-entered:
		t.Fatalf("second Lock on the same key must block until Unlock")
	case <-time.After(50 * time.Millisecond):
		// still blocked as required
	}
	km.Unlock("a")
	select {
	case <-entered:
		// proceeded after Unlock
	case <-time.After(time.Second):
		t.Fatalf("second Lock did not proceed after Unlock")
	}
}

func TestKeyedMutex_DifferentKeysConcurrent(t *testing.T) {
	km := newKeyedMutex()
	km.Lock("a")
	defer km.Unlock("a")
	done := make(chan struct{})
	go func() {
		km.Lock("b")
		km.Unlock("b")
		close(done)
	}()
	select {
	case <-done:
		// a different key did not block on "a"
	case <-time.After(time.Second):
		t.Fatalf("Lock on a different key must not block")
	}
}

func TestKeyedMutex_MutualExclusionUnderLoad(t *testing.T) {
	km := newKeyedMutex()
	var active, maxActive int
	var mu sync.Mutex
	var wg sync.WaitGroup
	const n = 20
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			km.Lock("k")
			mu.Lock()
			active++
			if active > maxActive {
				maxActive = active
			}
			mu.Unlock()
			time.Sleep(time.Millisecond)
			mu.Lock()
			active--
			mu.Unlock()
			km.Unlock("k")
		}()
	}
	wg.Wait()
	if maxActive != 1 {
		t.Fatalf("max concurrent holders of one key = %d, want 1", maxActive)
	}
}

func TestKeyedMutex_CleansUpIdleKeys(t *testing.T) {
	km := newKeyedMutex()
	km.Lock("a")
	km.Unlock("a")
	km.mu.Lock()
	n := len(km.locks)
	km.mu.Unlock()
	if n != 0 {
		t.Fatalf("idle key not cleaned up: %d entries remain", n)
	}
}
