// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"os"
	"testing"
)

// TestMain isolates the git-backed tests from the developer's/CI machine's ambient git config so the
// vault's own fallback identity (Wave User) is deterministic regardless of any global user.name /
// user.email. It intentionally does NOT set GIT_AUTHOR_*/GIT_COMMITTER_* — those would override the
// `-c user.name=Jarvis` that Commit uses to author machine changes.
func TestMain(m *testing.M) {
	os.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	os.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)
	os.Exit(m.Run())
}
