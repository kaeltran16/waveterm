// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wconfig

import (
	"path/filepath"
	"slices"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// only the map-valued config parts get a watched subdirectory: settings is a file, and the
// configfile:"-" fields are never read from disk
func TestGetConfigSubdirs(t *testing.T) {
	prev := wavebase.ConfigHome_VarCache
	t.Cleanup(func() { wavebase.ConfigHome_VarCache = prev })
	dir := t.TempDir()
	wavebase.ConfigHome_VarCache = dir

	want := []string{filepath.Join(dir, "connections"), filepath.Join(dir, "projects")}
	if got := GetConfigSubdirs(); !slices.Equal(got, want) {
		t.Fatalf("GetConfigSubdirs() = %v, want %v", got, want)
	}
}
