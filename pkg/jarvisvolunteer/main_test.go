// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import (
	"os"
	"testing"
)

// TestMain isolates the git-backed fixture vault from the machine's ambient git config so commits are
// deterministic. Mirrors pkg/jarvisproactive/main_test.go.
func TestMain(m *testing.M) {
	os.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	os.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)
	os.Exit(m.Run())
}
