// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"os"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// TestMain points the wave data dir at a throwaway temp dir and initializes the wstore SQLite DB
// (running the embedded migrations) so the many DB-backed reporadar tests have a real store. It
// also redirects the home dir at the temp dir so the transcript (~/.claude/projects) and memory
// (vault) collectors read an empty, hermetic tree instead of the developer's real home.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "reporadar-test-*")
	if err != nil {
		panic(err)
	}
	// isolate os.UserHomeDir() (Windows: USERPROFILE, Unix: HOME) so home-scanning collectors
	// are hermetic and fast.
	os.Setenv("USERPROFILE", dir)
	os.Setenv("HOME", dir)
	wavebase.DataHome_VarCache = dir
	if err := wavebase.EnsureWaveDBDir(); err != nil {
		panic(err)
	}
	if err := wstore.InitWStore(); err != nil {
		panic(err)
	}
	// never spend the real claude CLI/tokens in tests: default the scan's model runner to a fake
	// that returns an empty-findings result. Tests needing specific findings override via withFakeSynth.
	synthStreamFn = func(ctx context.Context, prompt string) ([]string, error) {
		return []string{`{"type":"result","subtype":"success","result":"{\"findings\":[]}"}`}, nil
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}
