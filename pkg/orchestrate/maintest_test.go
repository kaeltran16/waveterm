// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"os"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// TestMain points the wave data dir at a throwaway temp dir and initializes the wstore SQLite DB so
// the ScheduleOnce tests have a real store. Mirrors pkg/jarvis's TestMain; the pure-function tests in
// this package are unaffected by the extra init.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "orchestrate-test-*")
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
	// fixtures store worker tabs no controller runs; only the tests that script a dead one should see it stall
	workerControllerGone = func(context.Context, *waveobj.Run) bool { return false }
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}
