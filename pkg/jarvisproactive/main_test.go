// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisproactive

import (
	"os"
	"testing"
)

// TestMain isolates the git-backed fixture vault from the developer's/CI machine's ambient git config
// so commits are deterministic regardless of any global user.name / user.email. Mirrors
// pkg/wavevault/main_test.go and pkg/jarvisdossier/main_test.go.
func TestMain(m *testing.M) {
	os.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	os.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)
	os.Exit(m.Run())
}
