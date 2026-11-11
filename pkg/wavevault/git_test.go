// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"context"
	"testing"
	"time"
)

// a timed-out git is killed, but a helper it started (ssh, git-remote-https; here a shell alias) can
// hold its output pipe open; the call must still return near the timeout, not when the helper exits
func TestGitTimeoutBoundsCallWhenChildHoldsPipe(t *testing.T) {
	old := gitWaitDelay
	gitWaitDelay = 200 * time.Millisecond
	t.Cleanup(func() { gitWaitDelay = old })
	dir := t.TempDir()
	start := time.Now()
	_, err := runGitSync(context.Background(), dir, 500*time.Millisecond, "-c", "alias.slow=!sleep 10", "slow")
	if err == nil {
		t.Fatal("the timed-out command succeeded")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("returned after %v: the helper's pipe, not the timeout, bounded the call", elapsed)
	}
}
