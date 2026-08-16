// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// DAG-spawned children run directly in their worktree (run.ProjectPath) and never
// populate phase workerorefs — workerCwd must resolve via ProjectPath for them,
// otherwise the liveness probe finds no session and flags active children stalled.
func TestWorkerCwdResolvesDagChildWorktree(t *testing.T) {
	run := &waveobj.Run{
		DagORef:     "dag:8eb04fc3-eddc-47ff-a518-f03319d03d7f",
		ProjectPath: `C:\Users\cktra\Projects\waveterm\.waveterm\worktrees\847eb8a7-77f2-4bb4-a78c-92a5a914a8de-t-ev-1`,
	}
	got := workerCwd(run)
	if got != run.ProjectPath {
		t.Fatalf("dag child: want %q, got %q", run.ProjectPath, got)
	}
}
