// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisstate

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/effortstore"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// TestMain points the wave data dir at a throwaway temp dir and initializes the wstore SQLite DB so
// fetch tests can exercise FetchWorkState against a real, empty store.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "jarvisstate-test-*")
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
	defer effortstore.UseRootForTest(filepath.Join(dir, "vault"))()
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}
