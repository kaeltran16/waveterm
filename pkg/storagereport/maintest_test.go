// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package storagereport

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// TestMain points the wave data dir at a throwaway temp dir and initializes the wstore SQLite DB, so tests can
// store the runs a scan reads. Mirrors pkg/orchestrate's TestMain.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "storagereport-test-*")
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
	// a backstop for a test that makes trees without its own root: none may land in the real user cache dir
	restore := orchestrate.UseWorktreeRootForTest(filepath.Join(dir, "arc-wt"))
	code := m.Run()
	restore()
	os.RemoveAll(dir)
	os.Exit(code)
}
