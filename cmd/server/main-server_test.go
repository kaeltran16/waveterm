// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"errors"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

func TestStartConfigWatcherReturnsInitializationError(t *testing.T) {
	sentinel := errors.New("watcher unavailable")
	original := initConfigWatcher
	initConfigWatcher = func() (*wconfig.Watcher, error) {
		return nil, sentinel
	}
	t.Cleanup(func() { initConfigWatcher = original })

	err := startConfigWatcher()
	if !errors.Is(err, sentinel) {
		t.Fatalf("error = %v, want sentinel", err)
	}
}
