// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"sync"
)

// scanManager tracks in-flight scans by report ID so a scan can be cancelled and a second scan for
// the same report rejected. It owns only live process control; the persisted RadarReport is the
// source of truth. Mirrors pkg/jarvis/watcher.go's inflight pattern.
type scanManager struct {
	mu       sync.Mutex
	inflight map[string]context.CancelFunc
}

func newScanManager() *scanManager {
	return &scanManager{inflight: map[string]context.CancelFunc{}}
}

// register creates a cancellable context for reportId. Returns (ctx, false) if a scan is already
// in flight for that report.
func (m *scanManager) register(reportId string) (context.Context, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, dup := m.inflight[reportId]; dup {
		return nil, false
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.inflight[reportId] = cancel
	return ctx, true
}

// cancel cancels and forgets an in-flight scan. Returns false if none was in flight.
func (m *scanManager) cancel(reportId string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	cancel, ok := m.inflight[reportId]
	if !ok {
		return false
	}
	cancel()
	delete(m.inflight, reportId)
	return true
}

// done forgets a finished scan without cancelling (deferred at goroutine end).
func (m *scanManager) done(reportId string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.inflight, reportId)
}

func (m *scanManager) active(reportId string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.inflight[reportId]
	return ok
}

// mgr is the package-level manager owned by wavesrv.
var mgr = newScanManager()
