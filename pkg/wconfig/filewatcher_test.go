// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wconfig

import (
	"errors"
	"testing"

	"github.com/fsnotify/fsnotify"
)

func TestNewWatcherReturnsConstructionError(t *testing.T) {
	sentinel := errors.New("watcher unavailable")
	watcher, err := newWatcher(func() (*fsnotify.Watcher, error) {
		return nil, sentinel
	})
	if watcher != nil {
		t.Fatal("failed construction must not return a watcher")
	}
	if !errors.Is(err, sentinel) {
		t.Fatalf("error = %v, want sentinel", err)
	}
}
