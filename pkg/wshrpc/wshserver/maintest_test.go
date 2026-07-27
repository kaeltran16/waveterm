// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"os"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// TestMain points the wave data dir at a throwaway temp dir and initializes the wstore SQLite DB
// (running the embedded migrations) so the resolver/dispatch tests can exercise routing to the
// DB-backed resolvers against a real, empty store. Mirrors pkg/wstore/wstore_maintest_test.go.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "wshserver-test-*")
	if err != nil {
		panic(err)
	}
	wavebase.DataHome_VarCache = dir
	if err := wavebase.EnsureWaveDBDir(); err != nil {
		panic(err)
	}
	if err := wstore.InitWStore(); err != nil {
		panic(err)
	}
	// seal evidence inline in tests: deterministic, and no seal goroutine outlives a test to touch the
	// shared package-level store. Tests that assert on the dispatch itself override sealAsync locally.
	sealAsync = func(fn func()) { fn() }
	// Continuity capture opens the real vault + calls a model; keep it out of the package's run tests.
	// The dedicated wiring test overrides this locally to observe the dispatch.
	captureAsync = func(fn func()) {}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}
