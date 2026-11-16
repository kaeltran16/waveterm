// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package claudemod

import (
	"os"
	"path/filepath"
	"testing"
)

// Windows PowerShell 5's Set-Content -Encoding UTF8 starts the file with a BOM
func TestReadSettingsSkipsAUTF8BOM(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(path, []byte("\xEF\xBB\xBF"+`{"model":"opus"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := ReadSettings(path)
	if err != nil {
		t.Fatal(err)
	}
	if got["model"] != "opus" {
		t.Fatalf("got %v", got)
	}
}
