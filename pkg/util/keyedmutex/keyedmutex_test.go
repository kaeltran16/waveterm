// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package keyedmutex

import (
	"sync"
	"testing"
	"time"
)

func TestMutexSameKeySerializes(t *testing.T) {
	m := New()
	m.Lock("a")
	entered := make(chan struct{})
	go func() {
		m.Lock("a")
		close(entered)
		m.Unlock("a")
	}()
	select {
	case <-entered:
		t.Fatalf("second Lock on the same key must block until Unlock")
	case <-time.After(50 * time.Millisecond):
		// still blocked as required
	}
	m.Unlock("a")
	select {
	case <-entered:
		// proceeded after Unlock
	case <-time.After(time.Second):
		t.Fatalf("second Lock did not proceed after Unlock")
	}
}

func TestMutexDifferentKeysConcurrent(t *testing.T) {
	m := New()
	m.Lock("a")
	defer m.Unlock("a")
	done := make(chan struct{})
	go func() {
		m.Lock("b")
		m.Unlock("b")
		close(done)
	}()
	select {
	case <-done:
		// a different key did not block on "a"
	case <-time.After(time.Second):
		t.Fatalf("Lock on a different key must not block")
	}
}

func TestMutexMutualExclusionUnderLoad(t *testing.T) {
	m := New()
	var active, maxActive int
	var mu sync.Mutex
	var wg sync.WaitGroup
	const n = 20
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			m.Lock("k")
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
			m.Unlock("k")
		}()
	}
	wg.Wait()
	if maxActive != 1 {
		t.Fatalf("max concurrent holders of one key = %d, want 1", maxActive)
	}
}

func TestMutexCleansUpIdleKeys(t *testing.T) {
	m := New()
	m.Lock("a")
	m.Unlock("a")

	m.mu.Lock()
	count := len(m.locks)
	m.mu.Unlock()
	if count != 0 {
		t.Fatalf("idle key not cleaned up: %d entries remain", count)
	}
}
